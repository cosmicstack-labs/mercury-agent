import Foundation

// Chat models added for parity with Mercury Desktop 1.5.2 (apps/desktop/src/api/types.ts).
// Everything the runtime may leave out is optional, and the pieces that ride on a stored
// message decode tolerantly: an odd value never stops a whole conversation from loading.

// MARK: Reply usage

/// One reply's tokens, steps, time and model (text_done's `usage`, and stored replies).
public struct ReplyUsage: Decodable, Hashable, Sendable {
  public var inputTokens: Int
  /// Of the input, how much the provider served from its prompt cache.
  public var cachedInputTokens: Int
  public var outputTokens: Int
  public var steps: Int?
  public var elapsedMs: Double?
  public var provider: String?
  public var model: String?

  public init(inputTokens: Int, cachedInputTokens: Int = 0, outputTokens: Int, steps: Int? = nil, elapsedMs: Double? = nil, provider: String? = nil, model: String? = nil) {
    self.inputTokens = inputTokens; self.cachedInputTokens = cachedInputTokens; self.outputTokens = outputTokens
    self.steps = steps; self.elapsedMs = elapsedMs; self.provider = provider; self.model = model
  }

  enum Keys: String, CodingKey { case inputTokens, cachedInputTokens, outputTokens, steps, elapsedMs, provider, model }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    func n(_ k: Keys) -> Double? { (try? c.decodeIfPresent(Double.self, forKey: k)).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil } }
    guard let i = n(.inputTokens), let o = n(.outputTokens) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "usage without tokens"))
    }
    inputTokens = Int(i); outputTokens = Int(o)
    cachedInputTokens = Int(n(.cachedInputTokens) ?? 0)
    steps = n(.steps).map(Int.init)
    elapsedMs = n(.elapsedMs)
    provider = try? c.decodeIfPresent(String.self, forKey: .provider)
    model = try? c.decodeIfPresent(String.self, forKey: .model)
  }

  /// From an event's raw JSON (text_done), or nil when it isn't a usage.
  public init?(json: Any?) {
    guard let d = json as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: d),
          let u = try? JSONDecoder().decode(ReplyUsage.self, from: data) else { return nil }
    self = u
  }

  /// "14k tokens · 82% cached · 6 steps · 12s", as Mercury Desktop writes it under a reply.
  public var short: String {
    var parts = ["\(Self.compact(inputTokens + outputTokens)) tokens"]
    if cachedInputTokens > 0, inputTokens > 0 { parts.append("\(Int((Double(cachedInputTokens) / Double(inputTokens) * 100).rounded()))% cached") }
    if let s = steps, s > 1 { parts.append("\(s) steps") }
    if let ms = elapsedMs, ms >= 1000 { parts.append("\(Int((ms / 1000).rounded()))s") }
    return parts.joined(separator: " · ")
  }

  /// "20,765 in (18,649 from cache) · 16 out" and the model, for the details.
  public var detail: [String] {
    let f = NumberFormatter(); f.numberStyle = .decimal
    let s = { (n: Int) in f.string(from: NSNumber(value: n)) ?? String(n) }
    var lines = ["\(s(inputTokens)) in (\(s(cachedInputTokens)) from cache) · \(s(outputTokens)) out"]
    if let model { lines.append((provider.map { "\($0) · " } ?? "") + model) }
    return lines
  }

  /// 950 → "950", 14_200 → "14k", 1_250_000 → "1.3M".
  public static func compact(_ n: Int) -> String {
    switch n {
    case ..<1000: return String(n)
    case ..<10_000: return String(format: "%.1fk", Double(n) / 1000).replacingOccurrences(of: ".0k", with: "k")
    case ..<1_000_000: return "\(Int((Double(n) / 1000).rounded()))k"
    default: return String(format: "%.1fM", Double(n) / 1_000_000).replacingOccurrences(of: ".0M", with: "M")
    }
  }
}

// MARK: Stored trace

/// A reply's thought process as the runtime keeps it: `{ startedAt, endedAt, items }`, where an
/// item is thinking (`reasoning`) or a tool call (`tool`). Times are milliseconds since 1970.
public struct StoredTrace: Decodable, Hashable, Sendable {
  public struct Item: Decodable, Hashable, Sendable {
    public var kind: String
    public var text: String?
    public var id: String?
    public var title: String?
    public var status: String?
    public var startedAt: Double?
    public var endedAt: Double?
    public var durationMs: Double?
    public var summary: String?

    public init(kind: String, text: String? = nil, id: String? = nil, title: String? = nil, status: String? = nil, startedAt: Double? = nil, endedAt: Double? = nil, durationMs: Double? = nil, summary: String? = nil) {
      self.kind = kind; self.text = text; self.id = id; self.title = title; self.status = status
      self.startedAt = startedAt; self.endedAt = endedAt; self.durationMs = durationMs; self.summary = summary
    }

    enum Keys: String, CodingKey { case kind, text, id, title, status, startedAt, endedAt, durationMs, summary }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: Keys.self)
      kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
      text = try? c.decodeIfPresent(String.self, forKey: .text)
      id = try? c.decodeIfPresent(String.self, forKey: .id)
      title = try? c.decodeIfPresent(String.self, forKey: .title)
      status = try? c.decodeIfPresent(String.self, forKey: .status)
      startedAt = try? c.decodeIfPresent(Double.self, forKey: .startedAt)
      endedAt = try? c.decodeIfPresent(Double.self, forKey: .endedAt)
      durationMs = try? c.decodeIfPresent(Double.self, forKey: .durationMs)
      summary = try? c.decodeIfPresent(String.self, forKey: .summary)
    }
  }

  public var startedAt: Double?
  public var endedAt: Double?
  public var items: [Item]

  public init(startedAt: Double?, endedAt: Double?, items: [Item]) {
    self.startedAt = startedAt; self.endedAt = endedAt; self.items = items
  }

  enum Keys: String, CodingKey { case startedAt, endedAt, items }
  public init(from decoder: Decoder) throws {
    guard let c = try? decoder.container(keyedBy: Keys.self) else { startedAt = nil; endedAt = nil; items = []; return }
    startedAt = try? c.decodeIfPresent(Double.self, forKey: .startedAt)
    endedAt = try? c.decodeIfPresent(Double.self, forKey: .endedAt)
    items = ((try? c.decodeIfPresent([Lossy<Item>].self, forKey: .items)) ?? []).compactMap(\.value)
  }

  /// From raw JSON (the /live snapshot), or nil.
  public init?(json: Any?) {
    guard let d = json as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: d),
          let t = try? JSONDecoder().decode(StoredTrace.self, from: data) else { return nil }
    self = t
  }
}

/// Decodes one element of an array, or nothing, without failing the array.
struct Lossy<T: Decodable>: Decodable {
  var value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// A file the person sent with a message (`/api/chat/uploads/…`, served back to them).
public struct SentAttachment: Decodable, Hashable, Sendable {
  public var name: String
  /// image, pdf or document
  public var kind: String?
  public var mime: String?
  public var url: String?

  public init(name: String, kind: String? = nil, mime: String? = nil, url: String? = nil) {
    self.name = name; self.kind = kind; self.mime = mime; self.url = url
  }

  public var isImage: Bool { kind == "image" || mime?.hasPrefix("image/") == true }
}

// MARK: Sending

/// A file to send with a message, as base64 (POST /api/chat/send `attachments`).
public struct OutgoingAttachment: Identifiable, Hashable, Sendable {
  public var id = UUID()
  public var name: String
  public var mime: String
  public var data: Data

  public init(name: String, mime: String, data: Data) { self.name = name; self.mime = mime; self.data = data }

  public var isImage: Bool { mime.hasPrefix("image/") }
  public var isText: Bool { mime.hasPrefix("text/") }

  /// "PDF", "MD", "TXT", "IMG": the short tag a chip shows.
  public var tag: String {
    if isImage { return "IMG" }
    if mime == "application/pdf" { return "PDF" }
    return mime == "text/markdown" ? "MD" : "TXT"
  }

  /// The most a message carries, and each kind's limit (the server's, src/web/api/uploads.ts).
  public static let maxFiles = 4
  public static let maxImageBytes = 8 * 1024 * 1024
  public static let maxPDFBytes = 15 * 1024 * 1024
  public static let maxTextBytes = 256 * 1024

  /// What a file is, from its name and bytes, or why it can't be sent.
  public static func make(name: String, data: Data) -> Result<OutgoingAttachment, AttachmentProblem> {
    let ext = (name as NSString).pathExtension.lowercased()
    let mime: String
    if let sniffed = sniffImage(data) { mime = sniffed }
    else if data.starts(with: [0x25, 0x50, 0x44, 0x46]) { mime = "application/pdf" }
    else if ["txt", "md", "markdown"].contains(ext) { mime = ext == "txt" ? "text/plain" : "text/markdown" }
    else { return .failure(.unsupported(name)) }
    let limit = mime.hasPrefix("text/") ? maxTextBytes : mime.hasPrefix("image/") ? maxImageBytes : maxPDFBytes
    if data.count > limit { return .failure(.tooLarge(name, limit)) }
    if mime.hasPrefix("text/"), String(data: data, encoding: .utf8) == nil { return .failure(.notText(name)) }
    return .success(OutgoingAttachment(name: name, mime: mime, data: data))
  }

  /// png, jpeg, gif or webp (what the server takes); nil for anything else.
  public static func sniffImage(_ d: Data) -> String? {
    let b = [UInt8](d.prefix(12))
    if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
    if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    if b.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
    if b.count >= 12, b.starts(with: [0x52, 0x49, 0x46, 0x46]), Array(b[8..<12]) == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
    return nil
  }

  var json: [String: Any] { ["name": name, "data": data.base64EncodedString(), "mime": mime] }
}

public enum AttachmentProblem: Error, Equatable, LocalizedError {
  case unsupported(String)
  case tooLarge(String, Int)
  case notText(String)
  case tooMany

  public var errorDescription: String? {
    switch self {
    case .unsupported(let n): "\(n): attach an image, PDF, TXT or Markdown file."
    case .tooLarge(let n, let limit): "\(n) is too large (the limit is \(ByteCountFormatter.string(fromByteCount: Int64(limit), countStyle: .file)))."
    case .notText(let n): "\(n) isn't UTF-8 text."
    case .tooMany: "Up to \(OutgoingAttachment.maxFiles) files per message."
    }
  }
}

/// The composer's Create switch (ADR-042): the next message asks for an image, a video or music.
public struct MediaIntent: Hashable, Sendable {
  public enum Kind: String, Sendable, CaseIterable { case image, video, music }
  public enum Aspect: String, Sendable, CaseIterable { case square, landscape, portrait }
  public var kind: Kind
  public var aspect: Aspect?

  public init(kind: Kind, aspect: Aspect? = nil) { self.kind = kind; self.aspect = aspect }

  var json: [String: Any] { aspect.map { ["kind": kind.rawValue, "aspect": $0.rawValue] } ?? ["kind": kind.rawValue] }

  /// "Image 3:2", "Video 9:16", "Music": short, so the chip stays on one line.
  public var label: String {
    let k = kind.rawValue.capitalized
    guard let aspect, kind != .music else { return k }
    switch (kind, aspect) {
    case (_, .square): return "\(k) 1:1"
    case (.video, .landscape): return "\(k) 16:9"
    case (.video, .portrait): return "\(k) 9:16"
    case (_, .landscape): return "\(k) 3:2"
    case (_, .portrait): return "\(k) 2:3"
    }
  }
}

// MARK: New chat suggestions

/// What the owner might want next, for a new chat (GET /api/suggestions).
public struct Suggestion: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var title: String
  public var prompt: String
  public var why: String?
  /// continue, create, plan, check, learn or explore
  public var kind: String?

  public init(id: String, title: String, prompt: String, why: String? = nil, kind: String? = nil) {
    self.id = id; self.title = title; self.prompt = prompt; self.why = why; self.kind = kind
  }
}

public struct SuggestionPick: Decodable, Hashable, Sendable {
  public var greeting: String?
  public var subtitle: String?
  public var items: [Suggestion]

  public init(greeting: String?, subtitle: String?, items: [Suggestion]) { self.greeting = greeting; self.subtitle = subtitle; self.items = items }

  enum Keys: String, CodingKey { case greeting, subtitle, items }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    greeting = (try? c.decodeIfPresent(String.self, forKey: .greeting)).flatMap { $0?.isEmpty == false ? $0 : nil }
    subtitle = (try? c.decodeIfPresent(String.self, forKey: .subtitle)).flatMap { $0?.isEmpty == false ? $0 : nil }
    items = ((try? c.decodeIfPresent([Lossy<Suggestion>].self, forKey: .items)) ?? []).compactMap(\.value)
      .filter { !$0.title.isEmpty && !$0.prompt.isEmpty }
  }
}

// MARK: Thinking effort (ADR-041, #188)

/// The effort a chat's requests carry, and where it comes from.
public struct ChatEffort: Decodable, Hashable, Sendable {
  /// auto, off, low, medium, high, xhigh or max
  public var effective: String
  /// chat, model or auto
  public var source: String
  public var modelDefault: String
  /// This chat's own pick, if any.
  public var chat: String?
  public var chatUnsupported: Bool?

  public init(effective: String, source: String, modelDefault: String, chat: String?, chatUnsupported: Bool? = nil) {
    self.effective = effective; self.source = source; self.modelDefault = modelDefault; self.chat = chat; self.chatUnsupported = chatUnsupported
  }

  public static func label(_ level: String) -> String {
    switch level {
    case "auto": "Auto"
    case "off": "Off"
    case "low": "Low"
    case "medium": "Medium"
    case "high": "High"
    case "xhigh": "Extra high"
    case "max": "Max"
    default: level.capitalized
    }
  }

  public static func hint(_ level: String) -> String? {
    switch level {
    case "auto": "The model decides"
    case "off": "Answer straight away"
    case "low": "Quick, light thinking"
    case "high": "Thinks it through"
    case "xhigh": "For hard coding and agent work"
    case "max": "Slowest, most thorough"
    default: nil
    }
  }
}

/// The model this chat uses (GET /api/chat/models `current`): its name and the efforts it takes.
public struct ChatModelInfo: Decodable, Hashable, Sendable {
  public var name: String
  public var model: String
  public var label: String?
  public var reasoning: String?
  public var reasoningLevels: [String]?
  public var effort: ChatEffort?

  public init(name: String, model: String, label: String? = nil, reasoning: String? = nil, reasoningLevels: [String]? = nil, effort: ChatEffort? = nil) {
    self.name = name; self.model = model; self.label = label; self.reasoning = reasoning; self.reasoningLevels = reasoningLevels; self.effort = effort
  }

  /// The effort shown; older runtimes report only the model's level.
  public var currentEffort: ChatEffort {
    effort ?? ChatEffort(effective: reasoning ?? "auto", source: (reasoning ?? "auto") == "auto" ? "auto" : "model", modelDefault: reasoning ?? "auto", chat: nil)
  }
}

/// Which kinds of media this Mercury can make (GET /api/media/models).
public struct MediaAvailability: Hashable, Sendable {
  public var image: Bool
  public var video: Bool
  public var music: Bool
  /// The model each kind uses ("GPT Image 2"), when one is known.
  public var using: [MediaIntent.Kind: String]

  public init(image: Bool, video: Bool, music: Bool, using: [MediaIntent.Kind: String] = [:]) {
    self.image = image; self.video = video; self.music = music; self.using = using
  }

  public static let unknown = MediaAvailability(image: true, video: true, music: true)
  public var any: Bool { image || video || music }
  public func has(_ k: MediaIntent.Kind) -> Bool { k == .image ? image : k == .video ? video : music }
}

// MARK: Plans

public struct PlanStep: Decodable, Hashable, Sendable {
  public var label: String
  /// pending, active or done
  public var status: String
  public init(label: String, status: String) { self.label = label; self.status = status }
}

/// The plan Mercury works through in a chat. `state` is set by the runtime when its turn ended
/// unfinished: paused (a reply came first) or stopped (stopped, or failed).
public struct ChatPlan: Decodable, Hashable, Sendable {
  public var steps: [PlanStep]
  public var updatedAt: Double?
  public var state: String?
  public init(steps: [PlanStep], updatedAt: Double? = nil, state: String? = nil) { self.steps = steps; self.updatedAt = updatedAt; self.state = state }
}

// MARK: Turns (ADR-037)

/// Which chats are working now and which wait (GET /api/chat/running).
public struct TurnsInfo: Decodable, Sendable {
  public struct Running: Decodable, Sendable { public var sessionId: String?; public var channelId: String?; public var activity: String? }
  public struct Waiting: Decodable, Sendable { public var sessionId: String?; public var channelId: String?; public var position: Int? }
  public var running: [Running]
  public var waiting: [Waiting]
}

/// The reply a chat is working on now (GET /api/chat/threads/:id/live).
public struct LiveSnapshot: Sendable {
  public var running: Bool
  public var startedAt: Double?
  public var activity: String?
  public var trace: StoredTrace?
  public var text: String?
}

/// A video or song being made in the background for a chat (arrives with media_ready).
public struct PendingMedia: Decodable, Hashable, Sendable, Identifiable {
  public var jobId: String
  /// video or music
  public var kind: String
  public var aspect: String?
  public var prompt: String?
  public var startedAt: Double?
  public var id: String { jobId }

  public init(jobId: String, kind: String, aspect: String? = nil, prompt: String? = nil, startedAt: Double? = nil) {
    self.jobId = jobId; self.kind = kind; self.aspect = aspect; self.prompt = prompt; self.startedAt = startedAt
  }
}
