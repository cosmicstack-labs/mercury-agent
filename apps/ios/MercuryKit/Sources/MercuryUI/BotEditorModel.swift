import SwiftUI
import MercuryCore

/// The fields a bot is made of, shared by the new-bot form and a bot's Edit screen.
struct BotFields: Equatable {
  var name = ""
  var description = ""
  var persona = ""
  var tier = "readonly"
  var schedules: [BotSchedule] = []
  var model: BotModelRef?
  var budget = String(BotForms.defaultBudget)
}

/// A new bot (desktop CreateBot.tsx, made for a phone): say what it should do in plain words and
/// Mercury drafts it (the persona builder writes the instructions, the plan says one bot or a team,
/// the schedule and permission level are read from your words), or fill it in yourself. You review
/// every field; nothing exists until Create.
@MainActor @Observable
final class NewBotModel {
  enum Step { case describe, form }
  enum Busy: Equatable { case drafting, structuring, planning, creating }

  var step: Step = .describe
  /// What you said the bot should do.
  var ask = ""
  var fields = BotFields()
  /// Mercury's proposal, once asked for: one bot or a fleet, and why.
  var plan: BotPlan?
  /// Make a fleet: this bot leads `crew`.
  var asFleet = false
  var crew: [CrewSpec] = []
  var maxCrew = 6
  /// The instructions before the persona builder rewrote them (one tap undoes it).
  var personaBefore: String?
  var busy: Busy?
  var error: String?
  /// Something worth knowing that isn't an error ("the persona builder isn't available…").
  var note: String?
  /// Set once the bot exists (even if a later step failed).
  var createdId: String?
  var tiers: [String] = BotTiers.ids
  var catalog: ModelCatalog?

  let client: MercuryClient
  let existingIds: [String]

  init(client: MercuryClient, existingIds: [String]) { self.client = client; self.existingIds = existingIds }

  var id: String { BotForms.uniqueId(BotForms.slugify(fields.name.isEmpty ? "bot" : fields.name), taken: existingIds) }
  var problem: String? { BotForms.problem(name: fields.name, persona: fields.persona, budget: fields.budget, schedules: fields.schedules) }

  func loadChoices() async {
    if let t = try? await client.botTiers() { tiers = t }
    if catalog == nil { catalog = try? await client.modelCatalog() }
  }

  /// From your words to a reviewed draft: name, line, schedule and level here; the instructions from
  /// the persona builder; one bot or a team from Mercury's plan. Each part that fails falls back to
  /// your words, said plainly; the form opens either way.
  func draft() async {
    let text = ask.trimmed
    guard text.count >= 10 else { error = "Say a little more about what it should do."; return }
    busy = .drafting; error = nil; note = nil
    defer { busy = nil }
    let name = BotDraft.name(from: text)
    fields.name = name.isEmpty ? "New bot" : name
    fields.description = BotDraft.description(from: text)
    fields.tier = BotDraft.tier(from: text)
    fields.schedules = BotDraft.schedule(from: text).map { [$0] } ?? []
    do {
      fields.persona = try await client.buildPersona(text, name: fields.name)
    } catch {
      fields.persona = text
      note = "The persona builder didn't answer (\(error.localizedDescription)) so your words are its instructions. You can try again below."
    }
    if let r = try? await client.planBot(name: fields.name, description: fields.description, persona: fields.persona) {
      plan = r.plan; maxCrew = r.maxCrew
      asFleet = r.plan.isFleet
      crew = r.plan.crew
    }
    step = .form
  }

  /// Skip the draft: an empty form (what you said, if anything, goes into its instructions).
  func manual() {
    if fields.persona.isEmpty { fields.persona = ask.trimmed }
    if fields.name.isEmpty, !ask.trimmed.isEmpty { fields.name = BotDraft.name(from: ask) }
    error = nil
    step = .form
  }

  /// The persona builder over the instructions box: keeps what you wrote, adds structure.
  func structure() async {
    busy = .structuring; error = nil
    defer { busy = nil }
    do {
      let built = try await client.buildPersona(fields.persona, name: fields.name)
      personaBefore = fields.persona
      fields.persona = built
      note = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  func undoStructure() {
    if let b = personaBefore { fields.persona = b; personaBefore = nil }
  }

  /// "Make it a team": Mercury designs a crew for this bot.
  func askForTeam() async {
    if let p = problem { error = p; return }
    busy = .planning; error = nil
    defer { busy = nil }
    do {
      let r = try await client.planBot(name: fields.name.trimmed, description: fields.description.trimmed, persona: fields.persona.trimmed, fleet: true)
      maxCrew = r.maxCrew
      guard r.plan.isFleet, !r.plan.crew.isEmpty else {
        error = "Mercury couldn't design a team for this right now. Try again, or add the crew yourself."
        return
      }
      plan = r.plan; crew = r.plan.crew; asFleet = true
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Makes it: the bot, then (a fleet) its crew, then its schedules (as Desktop does, through the
  /// editor's path so they're registered with the scheduler at once). Returns the new id.
  @discardableResult
  func create(gate: OwnerGate) async -> String? {
    let team = crew.filter { !$0.name.trimmed.isEmpty }
    if let p = problem ?? (asFleet ? BotForms.crewProblem(team) : nil) { error = p; return nil }
    if asFleet && team.isEmpty { error = "Add at least one crew member, or make it one bot."; return nil }
    guard let budget = BotForms.parseBudget(fields.budget) else { return nil }
    busy = .creating; error = nil
    defer { busy = nil }
    let new = NewBot(id: id, name: fields.name, description: fields.description, persona: fields.persona, tier: fields.tier,
                     model: fields.model, dailyTokenBudget: budget)
    let made: BotManifest
    do {
      made = try await gate.run { [client] approval in try await client.createBot(new, approval: approval) }
    } catch {
      self.error = error.localizedDescription
      return nil
    }
    createdId = made.id
    do {
      if asFleet {
        try await client.promoteBot(made.id)
        var taken = existingIds + [made.id]
        for c in team {
          let crewId = BotForms.uniqueId(BotForms.slugify(c.name), taken: taken)
          taken.append(crewId)
          try await client.addCrew(made.id, CrewSpec(id: crewId, name: c.name, description: c.description, persona: c.persona))
        }
      }
      if !fields.schedules.isEmpty {
        var c = BotChanges()
        c.schedules = fields.schedules.map { BotSchedule(name: $0.name, cron: $0.cron.trimmed, prompt: $0.prompt.trimmed) }
        try await client.updateBot(made.id, c)
      }
    } catch {
      self.error = "\(made.name) was made, but not all of it: \(error.localizedDescription) Finish it from its Edit screen."
    }
    return made.id
  }
}

/// A bot's Edit screen (desktop BotSettings.tsx): everything the owner decides, saved together.
/// Only what changed is sent: PATCH for the settings, PUT for the instructions and the level.
@MainActor @Observable
final class EditBotModel {
  var bot: BotManifest?
  var persona = ""
  /// The level the roster reports ("custom" when its permissions file was edited by hand).
  var tier: String?
  var fields = BotFields()
  var personaBefore: String?
  var loaded = false
  var busy = false
  var structuring = false
  var avatarBusy = false
  var error: String?
  var saved = false
  var tiers: [String] = BotTiers.ids
  var catalog: ModelCatalog?

  let client: MercuryClient
  let id: String

  init(client: MercuryClient, id: String, tier: String?) { self.client = client; self.id = id; self.tier = tier }

  func load() async {
    do {
      async let b = client.botManifest(id)
      async let p = client.botPersona(id)
      let (bot, persona) = try await (b, p)
      self.bot = bot; self.persona = persona
      fields = BotFields(name: bot.name, description: bot.description, persona: persona, tier: tier ?? "readonly",
                         schedules: bot.schedules, model: bot.model, budget: bot.dailyTokenBudget.map(String.init) ?? "")
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
    if let t = try? await client.botTiers() { tiers = t }
    if catalog == nil { catalog = try? await client.modelCatalog() }
  }

  var changes: BotChanges? {
    bot.map { BotChanges.between($0, name: fields.name, description: fields.description, model: fields.model, schedules: fields.schedules, budget: fields.budget) }
  }
  var personaChanged: Bool { fields.persona.trimmed != persona.trimmed }
  var tierChanged: Bool { fields.tier != (tier ?? "readonly") && fields.tier != "custom" }
  var dirty: Bool { (changes.map { !$0.isEmpty } ?? false) || personaChanged || tierChanged }
  var problem: String? { BotForms.editProblem(name: fields.name, persona: fields.persona, budget: fields.budget, schedules: fields.schedules) }

  /// Saves what changed. A level that runs commands (or more) waits for the owner's approval.
  func save(gate: OwnerGate) async -> Bool {
    if let p = problem { error = p; return false }
    guard let changes else { return false }
    busy = true; error = nil
    defer { busy = false }
    do {
      if !changes.isEmpty, let b = try await client.updateBot(id, changes) { bot = b }
      if personaChanged { try await client.setBotPersona(id, fields.persona); persona = fields.persona }
      if tierChanged {
        let t = fields.tier
        try await gate.run { [client, id] approval in try await client.setBotTier(id, t, approval: approval) }
        tier = t
      }
      saved = true
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }

  func structure() async {
    structuring = true; error = nil
    defer { structuring = false }
    do {
      let built = try await client.buildPersona(fields.persona, name: fields.name)
      personaBefore = fields.persona
      fields.persona = built
    } catch {
      self.error = error.localizedDescription
    }
  }

  func undoStructure() {
    if let b = personaBefore { fields.persona = b; personaBefore = nil }
  }

  /// A photo for its face: made a small JPEG first (the runtime takes 2 MB at most).
  func setAvatar(_ data: Data) async -> Bool {
    guard let jpeg = ImagePrep.jpeg(data, maxSide: 512) else { error = "That photo's format isn't supported."; return false }
    avatarBusy = true; error = nil
    defer { avatarBusy = false }
    do {
      try await client.setBotAvatar(id, image: jpeg)
      BotAvatarCache.shared.images[id] = nil
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }

  /// Back to the face drawn from its id.
  func removeAvatar() async -> Bool {
    avatarBusy = true; error = nil
    defer { avatarBusy = false }
    do {
      try await client.removeBotAvatar(id)
      BotAvatarCache.shared.images[id] = nil
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
}

// MARK: - Managing bots from the Bots screens

extension BotsModel {
  enum Control: Equatable { case runNow, stop, start, turnOn, turnOff, makeFleet, suggestCrew }

  /// One of a bot's controls. Returns what to tell the owner, or nil when there's nothing to say.
  func control(_ c: Control, _ id: String) async -> String? {
    do {
      var said: String?
      switch c {
      case .runNow:
        let r = try await client.runBotNow(id)
        said = r.accepted ? "Started a run." : BotWords.refused(r.reasonCode)
      case .stop: said = try await client.stopBot(id).message ?? "Stopped."
      case .start: said = try await client.startBot(id).message ?? "Started."
      case .turnOn: try await client.setBotEnabled(id, true); said = "Turned on."
      case .turnOff: try await client.setBotEnabled(id, false); said = "Turned off. It won't run until you turn it on."
      case .makeFleet: try await client.promoteBot(id); said = "It now leads a fleet. Add crew, or let Mercury suggest some."
      case .suggestCrew:
        try await client.autoCrew(id)
        said = "Mercury is designing crew for this fleet (a minute or two). They appear here as they're made."
      }
      await load()
      return said
    } catch {
      return error.localizedDescription
    }
  }

  /// Retires a bot (a lead takes its crew). Returns why it couldn't, or nil.
  func delete(_ id: String) async -> String? {
    do {
      try await client.deleteBot(id)
      bots.removeAll { $0.id == id || $0.parent == id }
      await load()
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  /// Stop all / Start all. Returns what happened, in words.
  func all(stop: Bool) async -> String {
    do {
      if stop { try await client.stopAllBots() } else { try await client.startAllBots() }
      await load()
      return stop ? "Every bot is stopped. Queued work is held until you start them." : "Every bot is started."
    } catch {
      return error.localizedDescription
    }
  }

  /// A crew member written on the phone joins a lead's fleet.
  func addCrew(_ leadId: String, _ member: CrewSpec) async -> String? {
    if let p = BotForms.crewProblem([member]) { return p }
    do {
      let id = BotForms.uniqueId(BotForms.slugify(member.name), taken: bots.map(\.id))
      try await client.addCrew(leadId, CrewSpec(id: id, name: member.name, description: member.description, persona: member.persona))
      await load()
      return nil
    } catch {
      return error.localizedDescription
    }
  }
}
