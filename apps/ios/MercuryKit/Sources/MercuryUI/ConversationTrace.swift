import Foundation
import MercuryCore

/// A turn as it happened, in order: thinking, the tools it ran, the answer as it streams, notes
/// ("Checking my work…", hidden-instruction warnings). Pure value logic, so the event handler, the
/// stop button and the history loader build the same shape (apps/desktop/src/app/trace.ts).
/// `items` is the order; `steps` holds each tool call's state, and a step item points at its step.
struct TurnTrace: Equatable {
  enum Status: String, Equatable { case running, done, error, stopped }

  /// What a media tool is making: kind image, video, music or speech.
  struct MediaShape: Equatable {
    var kind: String
    var aspect: String?
    var count: Int?
    var prompt: String?

    init(kind: String, aspect: String? = nil, count: Int? = nil, prompt: String? = nil) {
      self.kind = kind; self.aspect = aspect; self.count = count; self.prompt = prompt
    }

    init?(_ json: Any?) {
      guard let d = json as? [String: Any], let k = d["kind"] as? String else { return nil }
      self.init(kind: k, aspect: d["aspect"] as? String, count: d["count"] as? Int, prompt: d["prompt"] as? String)
    }
  }

  struct Step: Identifiable, Equatable {
    var key: String
    var number: Int
    var tool: String
    /// "Read src/x.ts", "Run npm test" (the runtime's words), when it sent some.
    var title: String?
    var status: Status
    var startedAt: Date
    var endedAt: Date?
    var summary: String?
    var media: MediaShape?
    var id: String { key }

    /// What a row says: the runtime's title, else the tool in words.
    var label: String {
      if let t = title?.trimmed, !t.isEmpty, t != tool { return t }
      return ConversationModel.label(tool)
    }

    func duration(now: Date) -> TimeInterval? {
      if let endedAt { return endedAt.timeIntervalSince(startedAt) }
      return status == .running ? now.timeIntervalSince(startedAt) : nil
    }

    /// A picture or a voice being made: its placeholder stands in for the row while it runs.
    var isMaking: Bool {
      guard let m = media, m.kind == "image" || m.kind == "speech" else { return false }
      return status != .error && status != .stopped
    }
  }

  enum Item: Equatable {
    case reasoning(text: String, startedAt: Date, endedAt: Date?)
    case step(String)
    case text(String)
    case note(String)
  }

  static let maxItems = 300

  var items: [Item] = []
  var steps: [Step] = []
  var startedAt: Date
  var endedAt: Date?
  /// The turn was stopped by you, not finished.
  var stopped = false
  var lastEventAt: Date
  /// What the runtime says it's doing between tools ("Checking my work").
  var phase: String?

  init(startedAt: Date = .now) { self.startedAt = startedAt; lastEventAt = startedAt }

  // MARK: Building

  mutating func touch(_ now: Date = .now) { lastEventAt = now }

  mutating func addReasoning(_ text: String, now: Date = .now) {
    guard !text.isEmpty else { return }
    if case .reasoning(let t, let s, nil)? = items.last { items[items.count - 1] = .reasoning(text: t + text, startedAt: s, endedAt: nil) }
    else { items.append(.reasoning(text: text, startedAt: now, endedAt: nil)) }
    cap(); lastEventAt = now; phase = nil
  }

  /// The current thinking block ended (the answer, a tool or a new step began).
  mutating func endReasoning(_ now: Date = .now) {
    if case .reasoning(let t, let s, nil)? = items.last { items[items.count - 1] = .reasoning(text: t, startedAt: s, endedAt: now) }
    lastEventAt = now
  }

  mutating func startTool(key: String?, tool: String, title: String?, number: Int?, media: MediaShape?, now: Date = .now) {
    endReasoning(now)
    let k = (key?.isEmpty == false ? key! : "\(tool):\(now.timeIntervalSince1970):\(steps.count)")
    guard !steps.contains(where: { $0.key == k }) else { return }
    steps.append(Step(key: k, number: number ?? steps.count + 1, tool: tool, title: title, status: .running, startedAt: now, media: media))
    items.append(.step(k))
    cap(); lastEventAt = now; phase = nil
  }

  mutating func finishTool(key: String?, tool: String, failed: Bool, summary: String?, durationMs: Double?, now: Date = .now) {
    lastEventAt = now
    var i = key.flatMap { k in steps.firstIndex { $0.key == k } }
    // Older runtimes: no call id, so the latest running step of that tool.
    if i == nil { i = steps.lastIndex { $0.status == .running && $0.tool == tool } }
    guard let i else { return }
    let d = durationMs.map { $0 / 1000 } ?? now.timeIntervalSince(steps[i].startedAt)
    steps[i].status = failed ? .error : .done
    steps[i].summary = summary
    steps[i].endedAt = steps[i].startedAt.addingTimeInterval(d)
  }

  /// Answer text as it streams, in order with the tools around it.
  mutating func addText(_ text: String, now: Date = .now) {
    guard !text.isEmpty else { return }
    endReasoning(now)
    if case .text(let t)? = items.last { items[items.count - 1] = .text(t + text) } else { items.append(.text(text)) }
    cap(); lastEventAt = now; phase = nil
  }

  mutating func addNote(_ text: String, now: Date = .now) {
    guard !text.trimmed.isEmpty else { return }
    endReasoning(now)
    items.append(.note(text))
    cap(); lastEventAt = now
  }

  mutating func setPhase(_ p: String, now: Date = .now) { phase = p; lastEventAt = now }

  /// Stop pressed: what was running shows as stopped straight away.
  mutating func markStopped(_ now: Date = .now) {
    for i in steps.indices where steps[i].status == .running { steps[i].status = .stopped; steps[i].endedAt = now }
  }

  /// The trace kept on the finished reply: no streamed text (the reply has it), every step ended.
  func finished(stopped: Bool = false, now: Date = .now) -> TurnTrace {
    var t = self
    t.endReasoning(now)
    t.endedAt = now
    t.stopped = stopped
    t.phase = nil
    t.items = t.items.filter { if case .text = $0 { return false }; return true }
    for i in t.steps.indices where t.steps[i].status == .running { t.steps[i].status = stopped ? .stopped : .done; t.steps[i].endedAt = now }
    return t
  }

  private mutating func cap() { if items.count > Self.maxItems { items.removeFirst(items.count - Self.maxItems) } }

  // MARK: Reading

  var runningStep: Step? { steps.last { $0.status == .running } }

  /// Did the turn think or run anything worth keeping above the answer?
  var hasProcess: Bool {
    !steps.isEmpty || items.contains { if case .reasoning(let t, _, _) = $0 { return !t.trimmed.isEmpty }; if case .note = $0 { return true }; return false }
  }

  func step(_ key: String) -> Step? { steps.first { $0.key == key } }

  /// Hidden-instruction warnings Mercury itself raised in this turn (🛡 notes, ADR-044).
  var securityNotes: [String] {
    items.compactMap { if case .note(let t) = $0, Self.isSecurity(t) { return t }; return nil }
  }

  static func isSecurity(_ note: String) -> Bool { note.hasPrefix("🛡") }

  /// "Thought for 12s", "Worked for 1m 05s · 6 steps · 1 failed", "Stopped after 9s · 2 steps".
  var summary: String {
    let took = Self.duration((endedAt ?? lastEventAt).timeIntervalSince(startedAt))
    let n = steps.count
    let failed = steps.filter { $0.status == .error }.count
    let s = n > 0 ? " · \(n) step\(n == 1 ? "" : "s")" : ""
    if stopped { return "Stopped after \(took)\(s)" }
    return "\(n > 0 ? "Worked" : "Thought") for \(took)\(s)\(failed > 0 ? " · \(failed) failed" : "")"
  }

  // MARK: History

  /// A reply's trace as the runtime keeps it → this shape. `live`: a running reply's snapshot,
  /// where thinking may still stream and a tool may still run.
  static func from(_ stored: StoredTrace, live: Bool = false, now: Date = .now) -> TurnTrace? {
    let start = stored.startedAt.map(date) ?? now
    var t = TurnTrace(startedAt: start)
    t.endedAt = live ? nil : (stored.endedAt.map(date) ?? start)
    for it in stored.items {
      if it.kind == "reasoning", let text = it.text, !text.trimmed.isEmpty {
        let end = it.endedAt.map(date) ?? (live ? nil : start)
        t.items.append(.reasoning(text: text, startedAt: it.startedAt.map(date) ?? start, endedAt: end))
      } else if it.kind == "tool", let id = it.id {
        let title = it.title ?? ""
        let at = it.startedAt.map(date) ?? start
        let status: Status = it.status == "error" ? .error : (it.status == "running" && live) ? .running : .done
        let end = it.durationMs.map { at.addingTimeInterval($0 / 1000) } ?? it.endedAt.map(date)
        t.steps.append(Step(key: id, number: t.steps.count + 1, tool: title.components(separatedBy: " ").first.flatMap { $0.isEmpty ? nil : $0 } ?? "tool",
                            title: title, status: status, startedAt: at, endedAt: status == .running ? nil : end, summary: it.summary))
        t.items.append(.step(id))
      }
    }
    t.lastEventAt = live ? now : (t.endedAt ?? start)
    return t.items.isEmpty && !live ? nil : t
  }

  /// A reply still being worked on (GET /api/chat/threads/:id/live), ready for live events to carry on.
  static func live(_ s: LiveSnapshot, now: Date = .now) -> TurnTrace {
    let start = s.startedAt.map(date) ?? now
    var t = s.trace.flatMap { from($0, live: true, now: now) } ?? TurnTrace(startedAt: start)
    t.startedAt = start
    if let text = s.text, !text.isEmpty { t.items.append(.text(text)) }
    if let a = s.activity {
      let p = a.replacingOccurrences(of: #"^[^\p{L}\p{N}]+"#, with: "", options: .regularExpression).trimmed
      t.phase = p.isEmpty ? nil : p
    }
    t.lastEventAt = now
    return t
  }

  static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

  /// "0.4s", "12s", "1m 05s", "1h 02m".
  static func duration(_ seconds: TimeInterval) -> String {
    if seconds < 1 { return String(format: "%.1fs", max(0.1, seconds)) }
    let s = Int(seconds.rounded())
    if s < 60 { return "\(s)s" }
    let m = s / 60
    if m < 60 { return "\(m)m \(String(format: "%02d", s % 60))s" }
    return "\(m / 60)h \(String(format: "%02d", m % 60))m"
  }
}

// MARK: - Media being made

/// Pictures (or a voice) a running turn is making, as one group: "make five images" is often
/// several calls (4 + 1, or 5 × 1), and they all land in one grid.
struct MediaBatch: Equatable, Identifiable {
  var id: String
  var shape: TurnTrace.MediaShape
  var startedAt: Date
  var done: Int
  var total: Int
}

extension TurnTrace {
  /// Every picture in the turn is one batch; each voice its own. Failed or stopped calls leave it.
  var liveMedia: [MediaBatch] {
    let making = steps.filter(\.isMaking)
    var out: [MediaBatch] = []
    let images = making.filter { $0.media?.kind == "image" }
    if !images.isEmpty {
      let size = { (s: Step) in max(s.media?.count ?? 1, 1) }
      let total = images.reduce(0) { $0 + size($1) }
      let done = images.filter { $0.status == .done }.reduce(0) { $0 + size($1) }
      let prompts = Array(Set(images.compactMap { $0.media?.prompt?.isEmpty == false ? $0.media?.prompt : nil }))
      out.append(MediaBatch(id: "images", shape: MediaShape(kind: "image", aspect: images[0].media?.aspect, count: total, prompt: prompts.count == 1 ? prompts[0] : nil),
                            startedAt: images.map(\.startedAt).min()!, done: done, total: total))
    }
    for s in making where s.media?.kind == "speech" {
      out.append(MediaBatch(id: s.key, shape: s.media!, startedAt: s.startedAt, done: s.status == .done ? 1 : 0, total: 1))
    }
    return out
  }
}

enum MediaText {
  /// What it says while working: changes every few seconds so a long wait never reads as stuck.
  static func phase(_ kind: String, _ elapsed: TimeInterval) -> String {
    let list: [String]
    switch kind {
    case "video": list = ["Setting up the shot", "Blocking the scene", "Animating", "Adding sound", "Rendering frames", "Finishing"]
    case "music": list = ["Finding the groove", "Writing the melody", "Arranging", "Mixing", "Mastering"]
    case "speech": list = ["Warming up the voice", "Speaking", "Polishing"]
    default: list = ["Composing", "Sketching shapes", "Adding light and colour", "Adding detail", "Refining"]
    }
    let step: TimeInterval = kind == "video" || kind == "music" ? 12 : 5
    return list[min(Int(max(0, elapsed) / step), list.count - 1)]
  }

  /// "Creating 5 images · 4 of 5 ready · Adding detail" for the turn's status line.
  static func describe(_ b: MediaBatch, now: Date) -> String {
    let what = b.shape.kind == "image" && b.total > 1 ? "Creating \(b.total) images" : "Creating \(word(b.shape.kind))"
    let ready = b.total > 1 && b.done > 0 ? " · \(b.done) of \(b.total) ready" : ""
    let phase = b.done >= b.total ? "Almost there" : self.phase(b.shape.kind, now.timeIntervalSince(b.startedAt))
    return "\(what)\(ready) · \(phase)"
  }

  /// What it is called in "Creating …" (Mercury Desktop's KIND_WORD).
  static func word(_ kind: String) -> String {
    switch kind { case "video": "video"; case "music": "music"; case "speech": "voice"; default: "image" }
  }

  /// The shape a placeholder takes, width / height, so nothing jumps when the real thing lands:
  /// a batch is square tiles (what the finished grid shows); one picture keeps its shape.
  static func ratio(_ s: TurnTrace.MediaShape, tiles: Int = 1) -> CGFloat {
    if s.kind == "video" { return s.aspect == "portrait" ? 9.0 / 16 : 16.0 / 9 }
    if tiles > 1 { return 1 }
    switch s.aspect { case "landscape": return 3.0 / 2; case "portrait": return 2.0 / 3; default: return 1 }
  }

  /// How a batch is laid out, waiting and finished alike, so nothing jumps when they land:
  /// one large, two or four in pairs, three or five and more in rows of three.
  static func columns(_ n: Int) -> Int { n <= 1 ? 1 : (n == 2 || n == 4) ? 2 : 3 }

  /// The most tiles a batch shows (the rest are counted on the last one).
  static let maxTiles = 9
}
