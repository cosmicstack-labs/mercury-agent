import Foundation

/*
 The live feed's model: raw bot events → one card per run. A port of Mercury Desktop's
 apps/desktop/src/views/bots/live-runs.ts and the store's mergeLive (apps/desktop/src/app/store.ts);
 keep them in step.

 A run's state is worked out from its latest event, so it can't drift: an answered question or a
 finished run clears itself. "Waiting for you" comes only from a pending approval for that very
 run, never from wording. A run with no ending event whose bot is no longer running (the runtime
 restarted mid-run) is shown as ended, not "working" forever.
 */

public enum RunState: String, Sendable, CaseIterable {
  case queued, working, waiting, done, failed, stopped, paused, ended

  public var label: String {
    switch self {
    case .queued: "Queued"
    case .working: "Working"
    case .waiting: "Waiting for you"
    case .done: "Done"
    case .failed: "Failed"
    case .stopped: "Stopped"
    case .paused: "Paused"
    case .ended: "Ended"
    }
  }

  /// Still going (or about to): shows elapsed time to now and no Reply.
  public var isActive: Bool { self == .working || self == .waiting || self == .queued }
}

public struct LiveStep: Hashable, Sendable {
  /// running, done, error or note
  public var label: String
  public var status: String
  public var detail: String?
  public var at: Double
  public init(label: String, status: String, detail: String? = nil, at: Double) { self.label = label; self.status = status; self.detail = detail; self.at = at }
}

public struct LiveRun: Identifiable, Hashable, Sendable {
  public var jobId: String
  public var botId: String
  public var botName: String
  public var trigger: String?
  public var prompt: String?
  public var fromBot: String?
  public var startedAt: Double
  public var updatedAt: Double
  public var steps: [LiveStep]
  /// Steps the model took (its step counter).
  public var stepCount: Int
  /// The reply as it is being written (a rolling tail).
  public var text: String?
  public var reasoning: String?
  public var state: RunState
  /// How it ended, in the runtime's words ("completed", "failed: …").
  public var endLabel: String?

  public var id: String { jobId }
}

public enum LiveRuns {
  /// How many live events the app keeps (the whole fleet).
  public static let cap = 2000

  /// Steps that only count ("step 4 · 12.3k tok in") rather than say something.
  static func isCounter(_ label: String) -> Bool {
    guard label.hasPrefix("step ") else { return false }
    return label.dropFirst(5).first?.isASCII == true && label.dropFirst(5).first?.isNumber == true
  }

  static func endState(_ e: BotActivityEvent) -> RunState {
    let l = e.label.lowercased()
    if l.hasPrefix("paused") { return .paused }
    if l.hasPrefix("stopped") || l == "halted" { return .stopped }
    if e.status == "error" || l.hasPrefix("failed") { return .failed }
    return .done
  }

  /// Runs from events (oldest first in, oldest first out). `running` is the set of bots the
  /// runtime says are running now; `approvals` the questions waiting; `now` in ms. Deliveries
  /// outside a run join the bot's latest run.
  public static func runsFrom(_ events: [BotActivityEvent], running: Set<String>? = nil, approvals: [BotApproval] = [], now: Double = Date().timeIntervalSince1970 * 1000) -> [LiveRun] {
    var runs: [LiveRun] = []
    var byJob: [String: Int] = [:]
    var latestOf: [String: Int] = [:]
    for e in events {
      let at = e.at ?? now
      let job = e.jobId ?? ""
      var index = job.isEmpty ? latestOf[e.botId] : byJob[job]
      if index == nil {
        if job.isEmpty && e.kind != "tool" { continue }
        let id = job.isEmpty ? "loose-\(e.botId)-\(Int64(at))" : job
        runs.append(LiveRun(jobId: id, botId: e.botId, botName: e.botName ?? e.botId, startedAt: at, updatedAt: at,
                            steps: [], stepCount: 0, state: e.kind == "queued" ? .queued : .working))
        index = runs.count - 1
        byJob[id] = index
      }
      let i = index!
      if !job.isEmpty { latestOf[e.botId] = i }
      var run = runs[i]
      run.updatedAt = max(run.updatedAt, at)
      if let n = e.botName, !n.isEmpty { run.botName = n }
      switch e.kind {
      case "queued":
        if run.prompt == nil { run.prompt = e.prompt }
        if run.trigger == nil { run.trigger = e.trigger }
      case "turn-start":
        run.prompt = e.prompt ?? run.prompt ?? e.label
        run.trigger = e.trigger ?? run.trigger
        run.fromBot = e.fromBot ?? run.fromBot
        run.state = .working
      case "tool":
        let status = e.status == "error" ? "error" : e.status == "running" ? "running" : "done"
        if status != "running", let open = run.steps.lastIndex(where: { $0.label == e.label && $0.status == "running" }) {
          run.steps[open].status = status; run.steps[open].detail = e.detail; run.steps[open].at = at
        } else {
          run.steps.append(LiveStep(label: e.label, status: status, detail: (e.detail?.isEmpty == false) ? e.detail : nil, at: at))
        }
        if run.state == .queued { run.state = .working }
      case "step":
        if isCounter(e.label) { run.stepCount = max(run.stepCount, e.stepIndex ?? 0) }
        else if run.steps.last?.label != e.label { run.steps.append(LiveStep(label: e.label, status: "note", at: at)) }
        if run.state == .queued { run.state = .working }
      case "thinking":
        if let t = e.textTail, !t.isEmpty { run.text = t }
        if let r = e.reasoningTail, !r.isEmpty { run.reasoning = r }
      case "turn-end":
        run.state = endState(e)
        run.endLabel = e.label
        // Nothing still "running" in a finished run.
        for s in run.steps.indices where run.steps[s].status == "running" { run.steps[s].status = run.state == .done ? "done" : "error" }
      default:
        break
      }
      runs[i] = run
    }
    let waiting = Set(approvals.map(\.runId))
    for i in runs.indices {
      if waiting.contains(runs[i].jobId) && (runs[i].state == .working || runs[i].state == .queued) { runs[i].state = .waiting }
      // No ending event, and the bot isn't running any more: it ended without telling us (a restart).
      if runs[i].state == .working, let running, !running.contains(runs[i].botId), now - runs[i].updatedAt > 60_000 { runs[i].state = .ended }
    }
    // Oldest first; ties keep the order they arrived in.
    return runs.enumerated().sorted { $0.element.startedAt != $1.element.startedAt ? $0.element.startedAt < $1.element.startedAt : $0.offset < $1.offset }.map(\.element)
  }

  /// One key per distinct event: the same event from history and the stream counts once.
  public static func key(_ e: BotActivityEvent) -> String {
    "\(e.jobId ?? "")|\(e.kind)|\(e.stepIndex ?? 0)|\(e.label)|\(e.status ?? "")|\(Int64(e.at ?? 0))"
  }

  /// Merge events into the feed: dedupe, keep only the latest thinking preview per run, sort by time, cap.
  public static func merge(_ current: [BotActivityEvent], _ incoming: [BotActivityEvent], cap: Int = cap) -> [BotActivityEvent] {
    var seen = Set(current.map(key))
    var next = current
    for e in incoming {
      let k = key(e)
      if seen.contains(k) { continue }
      seen.insert(k)
      if e.kind == "thinking" { next.removeAll { $0.kind == "thinking" && $0.jobId == e.jobId && ($0.at ?? 0) <= (e.at ?? 0) } }
      next.append(e)
    }
    next = next.enumerated().sorted { ($0.element.at ?? 0) != ($1.element.at ?? 0) ? ($0.element.at ?? 0) < ($1.element.at ?? 0) : $0.offset < $1.offset }.map(\.element)
    return next.count > cap ? Array(next.suffix(cap)) : next
  }

  /// Who started a run, in words.
  public static func startedBy(_ r: LiveRun, nameOf: (String) -> String? = { _ in nil }) -> String {
    switch r.trigger {
    case "api", "web", "chat": return "You"
    case "telegram": return "You · Telegram"
    case "cloud": return "You · Cloud"
    case "cron": return "Schedule"
    case "mailbox": return r.fromBot.map { "From \(nameOf($0) ?? $0)" } ?? "From the fleet"
    case let t?: return t.isEmpty ? "Run" : t.prefix(1).uppercased() + t.dropFirst()
    case nil: return "Run"
    }
  }

  /// Reply on a finished run: the draft that answers it with the run quoted.
  public static func replyDraft(_ r: LiveRun) -> String {
    let said = (r.text ?? r.endLabel ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
    let tail = String(said.suffix(160))
    let asked = String((r.prompt ?? "").prefix(60))
    return "Re your run \"\(asked)\"" + (tail.isEmpty ? "" : " (you said: \"…\(tail)\")") + ":\n"
  }

  /// "4s", "2m 5s", "1h 3m"
  public static func duration(_ ms: Double) -> String {
    let s = Int((ms / 1000).rounded())
    if s < 60 { return "\(s)s" }
    let m = s / 60
    return m < 60 ? "\(m)m \(s % 60)s" : "\(m / 60)h \(m % 60)m"
  }
}
