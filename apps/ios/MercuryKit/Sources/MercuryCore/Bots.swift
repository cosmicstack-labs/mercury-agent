import Foundation

// Mercury's bots (ADR-012) as the runtime reports them: GET /api/bots, /api/bots/activity,
// /api/bots/approvals, /api/bots/inbox, /api/bots/:id/journal, /api/bots/:id/runs/:runId and
// the /api/bots/events stream (src/web/api/bots.ts). Times are milliseconds since 1970.

/// One bot in the roster, with its live state.
public struct BotStatus: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var enabled: Bool
  /// disabled, idle, queued, running or paused
  public var state: String
  public var activity: String?
  public var lastRunAt: Double?
  public var lastRunState: String?
  public var needsYou: Bool
  /// lead or crew
  public var fleetRole: String?
  public var parent: String?
  public var crewWorking: Int?
  public var hasAvatar: Bool?
  /// Unread inbox entries from this bot.
  public var unread: Int?
  public var tier: String?
  /// Stopped by the owner; stays stopped until Start.
  public var stopped: Bool?
  public var description: String?

  public init(id: String, name: String, enabled: Bool = true, state: String = "idle", needsYou: Bool = false,
              fleetRole: String? = nil, parent: String? = nil, unread: Int? = nil, description: String? = nil, activity: String? = nil) {
    self.id = id; self.name = name; self.enabled = enabled; self.state = state; self.needsYou = needsYou
    self.fleetRole = fleetRole; self.parent = parent; self.unread = unread; self.description = description; self.activity = activity
  }

  enum CodingKeys: String, CodingKey {
    case id, name, enabled, state, activity, lastRunAt, lastRunState, needsYou, fleetRole, parent, crewWorking, hasAvatar, unread, tier, stopped, description
  }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
    enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    state = try c.decodeIfPresent(String.self, forKey: .state) ?? "idle"
    activity = try c.decodeIfPresent(String.self, forKey: .activity)
    lastRunAt = try c.decodeIfPresent(Double.self, forKey: .lastRunAt)
    lastRunState = try c.decodeIfPresent(String.self, forKey: .lastRunState)
    needsYou = try c.decodeIfPresent(Bool.self, forKey: .needsYou) ?? false
    fleetRole = try c.decodeIfPresent(String.self, forKey: .fleetRole)
    parent = try c.decodeIfPresent(String.self, forKey: .parent)
    crewWorking = try c.decodeIfPresent(Int.self, forKey: .crewWorking)
    hasAvatar = try c.decodeIfPresent(Bool.self, forKey: .hasAvatar)
    unread = try c.decodeIfPresent(Int.self, forKey: .unread)
    tier = try c.decodeIfPresent(String.self, forKey: .tier)
    stopped = try c.decodeIfPresent(Bool.self, forKey: .stopped)
    description = try c.decodeIfPresent(String.self, forKey: .description)
  }

  public var isRunning: Bool { state == "running" }
  public var isOff: Bool { !enabled || state == "disabled" || stopped == true }
}

/// GET /api/bots
public struct BotRoster: Decodable, Sendable {
  public var bots: [BotStatus]
  public var available: Bool
  public var unread: Int?
  public init(bots: [BotStatus], available: Bool = true, unread: Int? = nil) { self.bots = bots; self.available = available; self.unread = unread }
  enum CodingKeys: String, CodingKey { case bots, available, unread }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    bots = try c.decodeIfPresent([BotStatus].self, forKey: .bots) ?? []
    available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? true
    unread = try c.decodeIfPresent(Int.self, forKey: .unread)
  }
}

/// One thing a bot did, as the live feed sees it (the stream's `bot_activity`, and the recent past).
public struct BotActivityEvent: Codable, Hashable, Sendable {
  public var botId: String
  /// The run (job); "" or nil for events outside a run (a delivery).
  public var jobId: String?
  /// turn-start, step, tool, turn-end, thinking or queued
  public var kind: String
  public var label: String
  public var detail: String?
  public var stepIndex: Int?
  public var elapsedMs: Double?
  /// running, done or error
  public var status: String?
  public var reasoningTail: String?
  public var textTail: String?
  public var at: Double?
  public var botName: String?
  /// What started the run: api (you), cron (a schedule), mailbox (another bot), …
  public var trigger: String?
  public var prompt: String?
  public var fromBot: String?

  public init(botId: String, jobId: String? = nil, kind: String, label: String, detail: String? = nil, stepIndex: Int? = nil,
              status: String? = nil, reasoningTail: String? = nil, textTail: String? = nil, at: Double? = nil, botName: String? = nil,
              trigger: String? = nil, prompt: String? = nil, fromBot: String? = nil) {
    self.botId = botId; self.jobId = jobId; self.kind = kind; self.label = label; self.detail = detail; self.stepIndex = stepIndex
    self.status = status; self.reasoningTail = reasoningTail; self.textTail = textTail; self.at = at; self.botName = botName
    self.trigger = trigger; self.prompt = prompt; self.fromBot = fromBot
  }

  enum CodingKeys: String, CodingKey {
    case botId, jobId, kind, label, detail, stepIndex, elapsedMs, status, reasoningTail, textTail, at, botName, trigger, prompt, fromBot
  }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    botId = try c.decode(String.self, forKey: .botId)
    jobId = try c.decodeIfPresent(String.self, forKey: .jobId)
    kind = try c.decode(String.self, forKey: .kind)
    label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
    detail = try c.decodeIfPresent(String.self, forKey: .detail)
    // A number either way: tolerate 3 and 3.0.
    if let i = try? c.decodeIfPresent(Int.self, forKey: .stepIndex) { stepIndex = i }
    else if let d = try? c.decodeIfPresent(Double.self, forKey: .stepIndex) { stepIndex = Int(d) }
    else { stepIndex = nil }
    elapsedMs = try? c.decodeIfPresent(Double.self, forKey: .elapsedMs)
    status = try c.decodeIfPresent(String.self, forKey: .status)
    reasoningTail = try c.decodeIfPresent(String.self, forKey: .reasoningTail)
    textTail = try c.decodeIfPresent(String.self, forKey: .textTail)
    at = try? c.decodeIfPresent(Double.self, forKey: .at)
    botName = try c.decodeIfPresent(String.self, forKey: .botName)
    trigger = try c.decodeIfPresent(String.self, forKey: .trigger)
    prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
    fromBot = try c.decodeIfPresent(String.self, forKey: .fromBot)
  }
}

/// A bot asking the owner mid-run (GET /api/bots/approvals).
public struct BotApproval: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var botId: String
  public var botName: String
  public var runId: String
  /// "Run command: …", "Write to file: …", "Read file: …"
  public var prompt: String
  public var at: Double
  public var expiresAt: Double

  public init(id: String, botId: String, botName: String, runId: String, prompt: String, at: Double, expiresAt: Double) {
    self.id = id; self.botId = botId; self.botName = botName; self.runId = runId; self.prompt = prompt; self.at = at; self.expiresAt = expiresAt
  }
}

/// One thing a bot did for you (GET /api/bots/inbox).
public struct BotInboxEntry: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var botId: String
  public var botName: String
  public var runId: String?
  /// result, failed or needs-you
  public var kind: String
  public var title: String
  public var summary: String
  public var files: [String]
  public var complete: Bool?
  public var reasonCode: String?
  public var approvalId: String?
  public var at: Double
  public var read: Bool

  public init(id: String, botId: String, botName: String, kind: String, title: String, summary: String, files: [String] = [],
              complete: Bool? = nil, reasonCode: String? = nil, at: Double, read: Bool) {
    self.id = id; self.botId = botId; self.botName = botName; self.kind = kind; self.title = title; self.summary = summary
    self.files = files; self.complete = complete; self.reasonCode = reasonCode; self.at = at; self.read = read
  }

  enum CodingKeys: String, CodingKey { case id, botId, botName, runId, kind, title, summary, files, complete, reasonCode, approvalId, at, read }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    botId = try c.decode(String.self, forKey: .botId)
    botName = try c.decodeIfPresent(String.self, forKey: .botName) ?? botId
    runId = try c.decodeIfPresent(String.self, forKey: .runId)
    kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "result"
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
    files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
    complete = try c.decodeIfPresent(Bool.self, forKey: .complete)
    reasonCode = try c.decodeIfPresent(String.self, forKey: .reasonCode)
    approvalId = try c.decodeIfPresent(String.self, forKey: .approvalId)
    at = try c.decodeIfPresent(Double.self, forKey: .at) ?? 0
    read = try c.decodeIfPresent(Bool.self, forKey: .read) ?? false
  }
}

/// One finished run (GET /api/bots/:id/journal).
public struct BotRunRecord: Decodable, Identifiable, Hashable, Sendable {
  public var runId: String
  public var botId: String
  public var trigger: String
  public var state: String
  public var startedAt: Double
  public var durationMs: Double
  public var tokensIn: Int
  public var tokensOut: Int
  public var summary: String?
  public var error: String?
  public var reasonCode: String?
  public var steps: Int?
  public var toolCalls: Int?
  /// deliverable, message, action, delegated, quiet, failed or none
  public var outcome: String?
  /// result, no_update or failure
  public var report: String?
  public var complete: Bool?
  public var deliverables: [String]?

  public var id: String { "\(botId)/\(runId)" }

  public init(runId: String, botId: String, trigger: String, state: String, startedAt: Double, durationMs: Double,
              tokensIn: Int = 0, tokensOut: Int = 0, summary: String? = nil, error: String? = nil, outcome: String? = nil, complete: Bool? = nil) {
    self.runId = runId; self.botId = botId; self.trigger = trigger; self.state = state; self.startedAt = startedAt; self.durationMs = durationMs
    self.tokensIn = tokensIn; self.tokensOut = tokensOut; self.summary = summary; self.error = error; self.outcome = outcome; self.complete = complete
  }

  enum CodingKeys: String, CodingKey {
    case runId, botId, trigger, state, startedAt, durationMs, tokensIn, tokensOut, summary, error, reasonCode, steps, toolCalls, outcome, report, complete, deliverables
  }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    runId = try c.decode(String.self, forKey: .runId)
    botId = try c.decode(String.self, forKey: .botId)
    trigger = try c.decodeIfPresent(String.self, forKey: .trigger) ?? ""
    state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
    startedAt = try c.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0
    durationMs = try c.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0
    tokensIn = Int(try c.decodeIfPresent(Double.self, forKey: .tokensIn) ?? 0)
    tokensOut = Int(try c.decodeIfPresent(Double.self, forKey: .tokensOut) ?? 0)
    summary = try c.decodeIfPresent(String.self, forKey: .summary)
    error = try c.decodeIfPresent(String.self, forKey: .error)
    reasonCode = try c.decodeIfPresent(String.self, forKey: .reasonCode)
    steps = try c.decodeIfPresent(Int.self, forKey: .steps)
    toolCalls = try c.decodeIfPresent(Int.self, forKey: .toolCalls)
    outcome = try c.decodeIfPresent(String.self, forKey: .outcome)
    report = try c.decodeIfPresent(String.self, forKey: .report)
    complete = try c.decodeIfPresent(Bool.self, forKey: .complete)
    deliverables = try c.decodeIfPresent([String].self, forKey: .deliverables)
  }

  /// A run in words: how the bot closed it when it did, else what it did (desktop Activity.tsx runLabel).
  public var label: String {
    if state == "failed" { return "failed" }
    switch outcome {
    case "failed": return "couldn't do it"
    case "quiet": return "nothing new"
    case "deliverable": return complete == true ? "delivered · done" : "delivered"
    case "message": return complete == true ? "reported · done" : "reported"
    case "action": return "acted"
    case "delegated": return "delegated"
    case "none" where state == "completed": return "no result"
    default: return state
    }
  }
}

/// One run, read back (GET /api/bots/:id/runs/:runId): what was asked, each tool call, what it concluded.
public struct BotRunTranscript: Decodable, Sendable {
  public struct Step: Decodable, Hashable, Sendable {
    public var name: String
    public var ok: Bool
    public var arg: String?
  }
  public var record: BotRunRecord
  public var prompt: String
  public var output: String
  public var trace: [Step]
}

/// Sending a message to a bot: accepted (with its job), or why not.
public struct BotMessageResult: Sendable, Equatable {
  public var accepted: Bool
  public var jobId: String?
  public var reasonCode: String?
  public init(accepted: Bool, jobId: String? = nil, reasonCode: String? = nil) { self.accepted = accepted; self.jobId = jobId; self.reasonCode = reasonCode }
}

// MARK: - Fleets

/// A lead with its crew.
public struct BotFleet: Identifiable, Hashable, Sendable {
  public var lead: BotStatus
  public var crew: [BotStatus]
  public var id: String { lead.id }
  public var members: [BotStatus] { [lead] + crew }
  public var working: Int { members.filter(\.isRunning).count }
  public init(lead: BotStatus, crew: [BotStatus]) { self.lead = lead; self.crew = crew }
}

public enum BotRosterLayout {
  /// The roster the way the bots work: each fleet is a lead with its crew underneath; the rest on
  /// their own. Both sorted by name. (desktop BotsView.tsx `organise`)
  public static func organise(_ bots: [BotStatus]) -> (fleets: [BotFleet], solo: [BotStatus]) {
    let ids = Set(bots.map(\.id))
    var crewOf: [String: [BotStatus]] = [:]
    func isCrew(_ b: BotStatus) -> Bool { b.fleetRole == "crew" && b.parent.map(ids.contains) == true }
    for b in bots where isCrew(b) { crewOf[b.parent!, default: []].append(b) }
    var fleets: [BotFleet] = []
    var solo: [BotStatus] = []
    for b in bots where !isCrew(b) {
      if b.fleetRole == "lead" || crewOf[b.id] != nil {
        fleets.append(BotFleet(lead: b, crew: (crewOf[b.id] ?? []).sorted { $0.name.localizedCompare($1.name) == .orderedAscending }))
      } else {
        solo.append(b)
      }
    }
    fleets.sort { $0.lead.name.localizedCompare($1.lead.name) == .orderedAscending }
    solo.sort { $0.name.localizedCompare($1.name) == .orderedAscending }
    return (fleets, solo)
  }
}

// MARK: - Questions

public enum BotQuestion {
  /// After reading something untrusted there is nothing to "always" allow: once, or no.
  /// (desktop Approvals.tsx `botQuestionItems`)
  public static func isInjectionWarning(_ prompt: String) -> Bool {
    prompt.hasPrefix("⚠ Possible prompt injection") || prompt.hasPrefix("Mercury read content from outside")
  }

  /// The answers a bot's question offers: value and label, the main one first.
  public static func options(for a: BotApproval) -> [(value: String, label: String)] {
    isInjectionWarning(a.prompt)
      ? [("yes", "Allow once"), ("no", "Deny")]
      : [("yes", "Allow once"), ("always", "Always allow for \(a.botName)"), ("no", "Deny")]
  }

  /// Whole minutes the bot still waits before it takes the silence as a no.
  public static func minutesLeft(_ a: BotApproval, now: Double) -> Int {
    max(0, Int(((a.expiresAt - now) / 60_000).rounded(.up)))
  }

  public static func waits(_ a: BotApproval, now: Double) -> String {
    let m = minutesLeft(a, now: now)
    return "\(a.botName) waits \(m) min, then it's a no"
  }
}
