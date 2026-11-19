import Foundation

// Making and changing bots from the phone, over the routes Mercury Desktop uses
// (apps/desktop/src/views/bots/CreateBot.tsx, BotSettings.tsx, BotForms.tsx; src/web/api/bots.ts).
// The pure parts (ids, schedules in words, the form's rules, request bodies) live here so both the
// screens and the tests use them. Android: core/BotEditing.kt, the same rules.

/// One routine: when (cron) and what to do each time.
public struct BotSchedule: Hashable, Sendable {
  public var name: String
  public var cron: String
  public var prompt: String
  public init(name: String, cron: String, prompt: String) { self.name = name; self.cron = cron; self.prompt = prompt }

  var json: [String: Any] { ["name": name, "cron": cron, "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines)] }
}

/// The model a bot thinks with; nil everywhere means Mercury's default.
public struct BotModelRef: Hashable, Sendable {
  public var provider: String
  public var model: String?
  public init(provider: String, model: String?) { self.provider = provider; self.model = model }
  var json: [String: Any] { model.map { ["provider": provider, "model": $0] } ?? ["provider": provider] }
}

/// A bot's settings (GET /api/bots/:id `bot`): what the edit screen shows and changes.
public struct BotManifest: Hashable, Sendable {
  public var id: String
  public var name: String
  public var description: String
  public var enabled: Bool
  public var model: BotModelRef?
  public var schedules: [BotSchedule]
  /// Every autonomy limit as the runtime has it (all numbers), so a save keeps the ones the phone doesn't show.
  public var autonomy: [String: Double]
  public var fleetRole: String?
  public var parent: String?

  public init(id: String, name: String, description: String = "", enabled: Bool = true, model: BotModelRef? = nil,
              schedules: [BotSchedule] = [], autonomy: [String: Double] = [:], fleetRole: String? = nil, parent: String? = nil) {
    self.id = id; self.name = name; self.description = description; self.enabled = enabled; self.model = model
    self.schedules = schedules; self.autonomy = autonomy; self.fleetRole = fleetRole; self.parent = parent
  }

  public var dailyTokenBudget: Int? { autonomy["dailyTokenBudget"].map { Int($0) } }

  /// From the manifest object; nil without an id.
  public static func from(_ j: [String: Any]) -> BotManifest? {
    guard let id = j["id"] as? String, !id.isEmpty else { return nil }
    var model: BotModelRef?
    if let m = j["model"] as? [String: Any], let p = m["provider"] as? String, !p.isEmpty {
      model = BotModelRef(provider: p, model: (m["model"] as? String).flatMap { $0.isEmpty ? nil : $0 })
    }
    let schedules = (j["schedules"] as? [[String: Any]] ?? []).compactMap { s -> BotSchedule? in
      guard let name = s["name"] as? String, let cron = s["cron"] as? String else { return nil }
      return BotSchedule(name: name, cron: cron, prompt: s["prompt"] as? String ?? "")
    }
    var autonomy: [String: Double] = [:]
    for (k, v) in j["autonomy"] as? [String: Any] ?? [:] {
      if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { autonomy[k] = n.doubleValue }
    }
    return BotManifest(id: id, name: j["name"] as? String ?? id, description: j["description"] as? String ?? "",
                       enabled: j["enabled"] as? Bool ?? true, model: model, schedules: schedules, autonomy: autonomy,
                       fleetRole: j["fleetRole"] as? String, parent: j["parent"] as? String)
  }
}

/// A crew member, written by you or proposed by Mercury.
public struct CrewSpec: Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var description: String
  public var persona: String
  public init(id: String = "", name: String = "", description: String = "", persona: String = "") {
    self.id = id; self.name = name; self.description = description; self.persona = persona
  }
}

/// "Let Mercury decide" (POST /api/bots/plan): one bot or a fleet, why, and the crew it proposes.
public struct BotPlan: Hashable, Sendable {
  public var shape: String
  public var reason: String
  public var crew: [CrewSpec]
  public var isFleet: Bool { shape == "fleet" }
  public init(shape: String, reason: String, crew: [CrewSpec] = []) { self.shape = shape; self.reason = reason; self.crew = crew }

  public static func from(_ j: [String: Any]) -> BotPlan {
    let crew = (j["crew"] as? [[String: Any]] ?? []).map {
      CrewSpec(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "", description: $0["description"] as? String ?? "",
               persona: $0["persona"] as? String ?? "")
    }
    return BotPlan(shape: j["shape"] as? String ?? "solo", reason: j["reason"] as? String ?? "", crew: crew)
  }
}

// MARK: - Permissions in plain words

public enum BotTiers {
  public struct Words: Hashable, Sendable { public var title: String; public var can: String; public var cant: String }

  /// readonly, builder, operator, full: least to most.
  public static let ids = ["readonly", "builder", "operator", "full"]

  /// What each level can and can't do (desktop BotForms.tsx TIER_WORDS).
  public static func words(_ id: String) -> Words? {
    switch id {
    case "readonly": Words(title: "Read only", can: "Browse the web, search, read files, message other bots, report back.", cant: "Can't write files or run commands.")
    case "builder": Words(title: "Writes files", can: "Everything in Read only, plus create and edit files in its own folder.", cant: "Can't run commands or delete anything.")
    case "operator": Words(title: "Runs commands", can: "Everything in Writes files, plus run commands inside its own folder.", cant: "Can't delete files or touch the rest of your computer.")
    case "full": Words(title: "Full access", can: "Everything, including deleting files and reading and writing your whole home folder.", cant: "Only for automation you fully trust.")
    default: nil
    }
  }

  public static func title(_ id: String?) -> String {
    guard let id else { return "Not set" }
    if id == "custom" { return "Custom (edited by hand)" }
    return words(id)?.title ?? id
  }

  /// From another device these need the owner's go-ahead (src/web/api/bots.ts POWERFUL_TIERS).
  public static func needsOwner(_ id: String) -> Bool { id == "operator" || id == "full" }
}

// MARK: - The form's rules (desktop BotForms.tsx, CreateBot.tsx)

public enum BotForms {
  /// A bot id from its name: lowercase, dashes, at most 30 characters, starting with a letter.
  public static func slugify(_ name: String) -> String {
    let folded = name.lowercased().folding(options: [.diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    var kept = ""
    for ch in folded.unicodeScalars {
      if CharacterSet.alphanumerics.contains(ch) && ch.isASCII { kept.unicodeScalars.append(ch) }
      else if ch == "_" || ch == "-" || CharacterSet.whitespaces.contains(ch) { kept.unicodeScalars.append(ch) }
    }
    var s = kept.trimmingCharacters(in: .whitespaces)
      .replacingOccurrences(of: "[\\s_]+", with: "-", options: .regularExpression)
      .replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
    s = String(s.prefix(30))
    while s.hasPrefix("-") { s.removeFirst() }
    while s.hasSuffix("-") { s.removeLast() }
    if let f = s.unicodeScalars.first, ("a"..."z").contains(f) { return s }
    return "bot-" + (s.isEmpty ? "new" : s)
  }

  /// `base`, or `base-2`, `base-3`… when it's taken.
  public static func uniqueId(_ base: String, taken: [String]) -> String {
    let set = Set(taken)
    if !set.contains(base) { return base }
    var i = 2
    while set.contains("\(base)-\(i)") { i += 1 }
    return "\(base)-\(i)"
  }

  /// Common schedules, in words. Anything else is a custom cron.
  public static let presets: [(label: String, cron: String)] = [
    ("Every hour", "0 * * * *"),
    ("Every 4 hours", "0 */4 * * *"),
    ("Every morning at 9", "0 9 * * *"),
    ("Weekdays at 9", "0 9 * * 1-5"),
    ("Every evening at 6", "0 18 * * *"),
    ("Mondays at 9", "0 9 * * 1"),
  ]

  public static func describeCron(_ cron: String) -> String {
    let c = cron.trimmingCharacters(in: .whitespaces)
    return presets.first { $0.cron == c }?.label ?? cron
  }

  /// Runs more often than every 15 minutes are slowed to that by Mercury.
  public static func tooFrequent(_ cron: String) -> Bool {
    let minute = cron.trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
    if minute == "*" { return true }
    if minute.hasPrefix("*/"), let n = Int(minute.dropFirst(2)) { return n < 15 }
    return false
  }

  /// "routine", then "routine-2", … : a name no other schedule of the bot has.
  public static func nextRoutineName(_ list: [BotSchedule]) -> String {
    var i = 1
    while true {
      let name = i == 1 ? "routine" : "routine-\(i)"
      if !list.contains(where: { $0.name == name }) { return name }
      i += 1
    }
  }

  /// "1,000,000", "1 000 000" and "1_000_000" are all a million; nil when it isn't a number.
  public static func parseBudget(_ s: String) -> Int? {
    let digits = s.replacingOccurrences(of: "[,\\s_]", with: "", options: .regularExpression)
    guard !digits.isEmpty, let n = Double(digits), n.isFinite else { return nil }
    return Int(n.rounded())
  }

  public static let defaultBudget = 1_000_000
  public static let minBudget = 10_000

  /// What's missing before a bot can be made, in the order the form shows it; nil when it's ready.
  public static func problem(name: String, persona: String, budget: String, schedules: [BotSchedule],
                             manualFleet: Bool = false, crew: [CrewSpec] = []) -> String? {
    if name.trimmed.isEmpty { return "Give it a name." }
    if persona.trimmed.isEmpty { return "Say how it should work (its instructions)." }
    guard let b = parseBudget(budget), b >= minBudget else { return "The daily budget must be at least 10,000 tokens." }
    if schedules.contains(where: { $0.prompt.trimmed.isEmpty }) { return "Every schedule needs instructions." }
    if manualFleet && !crew.contains(where: { !$0.name.trimmed.isEmpty }) { return "Add at least one crew member, or pick another option." }
    return nil
  }

  public static func crewProblem(_ crew: [CrewSpec]) -> String? {
    crew.contains { $0.name.trimmed.isEmpty || $0.persona.trimmed.isEmpty } ? "Every crew member needs a name and instructions." : nil
  }

  /// The edit screen's rules: a name, instructions, a budget when one is set, and instructions on every schedule.
  public static func editProblem(name: String, persona: String, budget: String, schedules: [BotSchedule]) -> String? {
    if name.trimmed.isEmpty { return "Give it a name." }
    if persona.trimmed.isEmpty { return "Its instructions can't be empty." }
    if !budget.trimmed.isEmpty {
      guard let b = parseBudget(budget), b >= minBudget else { return "The daily budget must be at least 10,000 tokens." }
    }
    if let s = schedules.first(where: { !ScheduleRule.isValid($0.cron) }) { return "“\(s.cron)” isn't a schedule Mercury understands." }
    if schedules.contains(where: { $0.prompt.trimmed.isEmpty }) { return "Every schedule needs instructions." }
    return nil
  }
}

extension String {
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

// MARK: - Schedules, picked in words

/// A schedule the way a person picks one, and the cron Mercury stores. Anything the picker can't
/// say stays a custom cron, unchanged.
public enum ScheduleRule: Hashable, Sendable {
  case everyMinutes(Int)
  case everyHours(Int)
  case daily(hour: Int, minute: Int)
  case weekdays(hour: Int, minute: Int)
  /// day: 0 Sunday … 6 Saturday
  case weekly(day: Int, hour: Int, minute: Int)
  case custom(String)

  public static let minuteSteps = [15, 20, 30]
  public static let hourSteps = [1, 2, 3, 4, 6, 8, 12]
  public static let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

  public var cron: String {
    switch self {
    case .everyMinutes(let n): "*/\(n) * * * *"
    case .everyHours(let n): n <= 1 ? "0 * * * *" : "0 */\(n) * * *"
    case .daily(let h, let m): "\(m) \(h) * * *"
    case .weekdays(let h, let m): "\(m) \(h) * * 1-5"
    case .weekly(let d, let h, let m): "\(m) \(h) * * \(d)"
    case .custom(let c): c.trimmed
    }
  }

  public static func from(cron: String) -> ScheduleRule {
    let f = cron.trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
    guard f.count == 5 else { return .custom(cron.trimmed) }
    let (mi, ho, dom, mon, dow) = (f[0], f[1], f[2], f[3], f[4])
    guard dom == "*", mon == "*" else { return .custom(cron.trimmed) }
    if ho == "*", dow == "*", mi.hasPrefix("*/"), let n = Int(mi.dropFirst(2)), n > 0, n < 60 { return .everyMinutes(n) }
    if mi == "0", dow == "*" {
      if ho == "*" { return .everyHours(1) }
      if ho.hasPrefix("*/"), let n = Int(ho.dropFirst(2)), n > 0, n < 24 { return .everyHours(n) }
    }
    guard let m = Int(mi), (0..<60).contains(m), let h = Int(ho), (0..<24).contains(h) else { return .custom(cron.trimmed) }
    switch dow {
    case "*": return .daily(hour: h, minute: m)
    case "1-5": return .weekdays(hour: h, minute: m)
    default:
      if let d = Int(dow), (0...7).contains(d) { return .weekly(day: d % 7, hour: h, minute: m) }
      return .custom(cron.trimmed)
    }
  }

  /// "Every 30 minutes", "Every day at 9:00", "Weekdays at 7:30", "Mondays at 9:00", or the cron.
  public var words: String {
    switch self {
    case .everyMinutes(let n): "Every \(n) minutes"
    case .everyHours(let n): n <= 1 ? "Every hour" : "Every \(n) hours"
    case .daily(let h, let m): "Every day at \(Self.time(h, m))"
    case .weekdays(let h, let m): "Weekdays at \(Self.time(h, m))"
    case .weekly(let d, let h, let m): "\(Self.dayNames[d % 7])s at \(Self.time(h, m))"
    case .custom(let c): c.isEmpty ? "Custom" : "Custom: \(c)"
    }
  }

  public static func time(_ h: Int, _ m: Int) -> String { String(format: "%d:%02d", h, m) }

  /// The kinds the picker offers, in order.
  public enum Kind: String, CaseIterable, Sendable {
    case minutes = "Every few minutes", hours = "Every few hours", daily = "Every day", weekdays = "Weekdays", weekly = "Once a week", custom = "Custom (cron)"
  }

  public var kind: Kind {
    switch self {
    case .everyMinutes: .minutes
    case .everyHours: .hours
    case .daily: .daily
    case .weekdays: .weekdays
    case .weekly: .weekly
    case .custom: .custom
    }
  }

  public var hour: Int {
    switch self { case .daily(let h, _), .weekdays(let h, _), .weekly(_, let h, _): h; default: 9 }
  }
  public var minute: Int {
    switch self { case .daily(_, let m), .weekdays(_, let m), .weekly(_, _, let m): m; default: 0 }
  }

  /// Switching kind keeps the time of day when there is one.
  public func with(kind: Kind) -> ScheduleRule {
    switch kind {
    case .minutes: if case .everyMinutes = self { return self }; return .everyMinutes(30)
    case .hours: if case .everyHours = self { return self }; return .everyHours(1)
    case .daily: return .daily(hour: hour, minute: minute)
    case .weekdays: return .weekdays(hour: hour, minute: minute)
    case .weekly: if case .weekly = self { return self }; return .weekly(day: 1, hour: hour, minute: minute)
    case .custom: return .custom(cron)
    }
  }

  /// Five fields, each a number, a range, a list, a step or *: a cron Mercury will take.
  public static func isValid(_ cron: String) -> Bool {
    let f = cron.trimmed.split(whereSeparator: \.isWhitespace)
    guard f.count == 5 else { return false }
    return f.allSatisfy { $0.range(of: "^[0-9*,/\\-]+$", options: .regularExpression) != nil }
  }
}

// MARK: - A first draft from what you said

/// From "Watch Hacker News for Rust posts every morning at 7" to a first draft: a name, a line, a
/// schedule, a permission level. The persona comes from the server's persona builder; these are
/// the parts it doesn't draft, guessed plainly and shown for review before anything is made.
public enum BotDraft {
  /// A short name from the first words of the job: "Watch Hacker News".
  public static func name(from text: String) -> String {
    var s = text.trimmed
    for lead in ["i want a bot that", "i want a bot to", "i need a bot that", "i need a bot to", "a bot that", "a bot to", "bot that", "bot to", "please", "can you", "make a bot that", "make a bot to", "create a bot that", "create a bot to"] {
      if s.lowercased().hasPrefix(lead + " ") { s = String(s.dropFirst(lead.count + 1)) }
    }
    let stops: Set<String> = ["for", "and", "every", "each", "daily", "weekly", "hourly", "at", "then", "when", "on", "to", "about", "in", "with", "from", "that", "and,", "if"]
    var words: [String] = []
    for raw in s.split(whereSeparator: { $0.isWhitespace }) {
      let w = raw.trimmingCharacters(in: .punctuationCharacters)
      if w.isEmpty { continue }
      if !words.isEmpty && stops.contains(w.lowercased()) { break }
      words.append(w)
      if words.count == 4 || raw.last.map({ ".,;:!?".contains($0) }) == true { break }
    }
    let name = words.map { w in w.first!.isLowercase ? w.prefix(1).uppercased() + w.dropFirst() : w }.joined(separator: " ")
    return String(name.prefix(40))
  }

  /// The first sentence, as the one line the bot list shows.
  public static func description(from text: String) -> String {
    let t = text.trimmed.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    let first = t.range(of: "[.!?](\\s|$)", options: .regularExpression).map { String(t[..<$0.lowerBound]) } ?? t
    return first.count > 120 ? String(first.prefix(117)) + "…" : first
  }

  /// A schedule when the words ask for one ("every morning", "hourly", "weekdays at 7:30", "every 2 hours").
  public static func schedule(from text: String) -> BotSchedule? {
    let t = " " + text.lowercased() + " "
    func has(_ p: String) -> Bool { t.range(of: p, options: .regularExpression) != nil }
    func number(_ p: String) -> Int? {
      guard let r = t.range(of: p, options: .regularExpression) else { return nil }
      return Int(t[r].filter(\.isNumber))
    }
    let at = time(in: t)
    var rule: ScheduleRule?
    if let n = number("every \\d+ ?(minutes|mins|min)\\b") { rule = .everyMinutes(max(15, min(n, 59))) }
    else if let n = number("every \\d+ ?(hours|hrs|h)\\b") { rule = .everyHours(max(1, min(n, 23))) }
    else if has("\\b(hourly|every hour|each hour)\\b") { rule = .everyHours(1) }
    else if has("\\b(weekdays|every weekday|each weekday|workdays)\\b") { rule = .weekdays(hour: at?.0 ?? 9, minute: at?.1 ?? 0) }
    else if let d = ScheduleRule.dayNames.firstIndex(where: { has("\\b(every|each|on) \($0.lowercased())s?\\b") || has("\\b\($0.lowercased())s\\b") }) {
      rule = .weekly(day: d, hour: at?.0 ?? 9, minute: at?.1 ?? 0)
    }
    else if has("\\b(weekly|every week|once a week)\\b") { rule = .weekly(day: 1, hour: at?.0 ?? 9, minute: at?.1 ?? 0) }
    else if has("\\b(every|each) (evening|night)\\b") || has("\\bnightly\\b") { rule = .daily(hour: at?.0 ?? 18, minute: at?.1 ?? 0) }
    else if has("\\b(every|each) (morning|day)\\b") || has("\\bdaily\\b") || at != nil && has("\\bevery\\b") { rule = .daily(hour: at?.0 ?? 9, minute: at?.1 ?? 0) }
    guard let rule else { return nil }
    return BotSchedule(name: "routine", cron: rule.cron, prompt: description(from: text))
  }

  /// "at 7", "at 7:30", "at 7am", "at 6 pm", "at 18:00".
  static func time(in t: String) -> (Int, Int)? {
    guard let r = t.range(of: "\\bat (\\d{1,2})(:(\\d{2}))? ?(am|pm|a\\.m\\.|p\\.m\\.)?", options: .regularExpression) else { return nil }
    let s = String(t[r]).dropFirst(3)
    let digits = s.split(whereSeparator: { !$0.isNumber })
    guard var h = digits.first.flatMap({ Int($0) }) else { return nil }
    let m = digits.count > 1 ? Int(digits[1]) ?? 0 : 0
    if s.contains("p"), h < 12 { h += 12 }
    if s.contains("a"), h == 12 { h = 0 }
    guard (0..<24).contains(h), (0..<60).contains(m) else { return nil }
    return (h, m)
  }

  /// Read only, unless the job is to make files (a draft, a document, a saved report): then Writes files.
  /// Running commands or full access is never guessed; you choose that yourself.
  public static func tier(from text: String) -> String {
    let t = " " + text.lowercased() + " "
    let writes = ["\\bfiles?\\b", "\\bsaves?\\b", "\\bdrafts?\\b", "\\bdocuments?\\b", "\\bwrites?\\b", "\\bmarkdown\\b", "\\.md\\b", "\\bspreadsheets?\\b", "\\bcsv\\b"]
    return writes.contains { t.range(of: $0, options: .regularExpression) != nil } ? "builder" : "readonly"
  }
}

// MARK: - Request bodies

/// POST /api/bots: what a new bot starts with.
public struct NewBot: Hashable, Sendable {
  public var id: String
  public var name: String
  public var description: String
  public var persona: String
  public var tier: String
  public var model: BotModelRef?
  public var dailyTokenBudget: Int

  public init(id: String, name: String, description: String = "", persona: String, tier: String = "readonly",
              model: BotModelRef? = nil, dailyTokenBudget: Int = BotForms.defaultBudget) {
    self.id = id; self.name = name; self.description = description; self.persona = persona; self.tier = tier
    self.model = model; self.dailyTokenBudget = dailyTokenBudget
  }

  public var body: [String: Any] {
    var manifest: [String: Any] = ["autonomy": ["dailyTokenBudget": dailyTokenBudget]]
    if let model { manifest["model"] = model.json }
    var b: [String: Any] = ["id": id, "name": name.trimmed, "persona": persona.trimmed, "tier": tier, "manifest": manifest]
    if !description.trimmed.isEmpty { b["description"] = description.trimmed }
    return b
  }
}

/// PATCH /api/bots/:id: only what changed. `model` nil-of-nil clears it (back to Mercury's default).
public struct BotChanges: Sendable {
  public var name: String?
  public var description: String?
  public var model: BotModelRef??
  public var schedules: [BotSchedule]?
  public var autonomy: [String: Double]?
  public init() {}

  public var isEmpty: Bool { name == nil && description == nil && model == nil && schedules == nil && autonomy == nil }

  public var body: [String: Any] {
    var b: [String: Any] = [:]
    if let name { b["name"] = name }
    if let description { b["description"] = description }
    if let model { b["model"] = model.map { $0.json as Any } ?? NSNull() }
    if let schedules { b["schedules"] = schedules.map(\.json) }
    if let autonomy { b["autonomy"] = autonomy.mapValues { $0.rounded() == $0 ? Int($0) as Any : $0 as Any } }
    return b
  }

  /// What the edit screen changed against what the bot has.
  public static func between(_ bot: BotManifest, name: String, description: String, model: BotModelRef?,
                             schedules: [BotSchedule], budget: String) -> BotChanges {
    var c = BotChanges()
    if name.trimmed != bot.name { c.name = name.trimmed }
    if description.trimmed != bot.description { c.description = description.trimmed }
    if model != bot.model { c.model = .some(model) }
    let cleaned = schedules.map { BotSchedule(name: $0.name, cron: $0.cron.trimmed, prompt: $0.prompt.trimmed) }
    if cleaned != bot.schedules { c.schedules = cleaned }
    let newBudget = budget.trimmed.isEmpty ? nil : BotForms.parseBudget(budget).map(Double.init)
    if newBudget != bot.autonomy["dailyTokenBudget"] {
      var a = bot.autonomy
      a["dailyTokenBudget"] = newBudget
      c.autonomy = a
    }
    return c
  }
}
