import Foundation

/// Whether this Mercury can hear and speak (it uses a speech service the owner set up there).
public struct SpeechSupport: Sendable, Equatable {
  public var listen: Bool
  public var speak: Bool
  /// The most text one /api/speak call takes.
  public var maxChars: Int

  public init(listen: Bool, speak: Bool, maxChars: Int) {
    self.listen = listen; self.speak = speak; self.maxChars = maxChars
  }
}

extension MercuryClient {
  /// GET /api/transcribe and /api/speak.
  public func speechSupport() async throws -> SpeechSupport {
    struct Listen: Decodable { var available: Bool }
    struct Speak: Decodable { var available: Bool; var maxChars: Int? }
    async let l = decode(Listen.self, request("GET", "/api/transcribe"))
    async let s = decode(Speak.self, request("GET", "/api/speak"))
    let (listen, speak) = try await (l, s)
    return SpeechSupport(listen: listen.available, speak: speak.available, maxChars: speak.maxChars ?? 4000)
  }

  /// POST /api/transcribe: a recording in, what was said out.
  public func transcribe(_ audio: Data, mime: String) async throws -> String {
    var r = try request("POST", "/api/transcribe", timeout: 60)
    r.setValue(mime, forHTTPHeaderField: "Content-Type")
    r.httpBody = audio
    struct Heard: Decodable { var text: String }
    return try await decode(Heard.self, r).text
  }

  /// POST /api/speak: text in, audio (mp3, or wav from Gemini) out.
  public func speak(_ text: String) async throws -> Data {
    let (data, res) = try await send(request("POST", "/api/speak", body: ["text": text], timeout: 60))
    switch res.statusCode {
    case 200: return data
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(res.statusCode, Self.message(data))
    }
  }
}

/// Turns a reply into what's read aloud.
public enum Spoken {
  /// Drops Markdown that sounds wrong out loud: code, links' addresses, emphasis marks, headings, bullets.
  public static func text(_ markdown: String) -> String {
    var s = markdown
    s = s.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " ", options: .regularExpression)
    s = s.replacingOccurrences(of: #"!\[[^\]]*\]\([^)]*\)"#, with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
    s = s.replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: #"(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+"#, with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: #"[*_~`|]+"#, with: "", options: .regularExpression)
    s = s.replacingOccurrences(of: #"\s*\n+\s*"#, with: " ", options: .regularExpression)
    s = s.replacingOccurrences(of: #" {2,}"#, with: " ", options: .regularExpression)
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Splits text into parts of at most `max` characters at sentence ends (then spaces),
  /// so the first part plays while the next is made.
  public static func parts(_ text: String, max: Int) -> [String] {
    var out: [String] = []
    var rest = Substring(text)
    while !rest.isEmpty {
      if rest.count <= max { out.append(String(rest)); break }
      let window = rest.prefix(max)
      let cut = window.lastIndex(where: { ".!?".contains($0) }).map { rest.index(after: $0) }
        ?? window.lastIndex(of: " ")
        ?? window.endIndex
      out.append(String(rest[..<cut]).trimmingCharacters(in: .whitespaces))
      rest = rest[cut...].drop(while: { $0 == " " })
    }
    return out.filter { !$0.isEmpty }
  }
}

/// A live voice call's start: a short-lived token for Mercury's shared voice engine
/// (POST /api/mobile/voice/session, src/web/api/mobile-voice.ts). API keys stay on the computer.
public struct VoiceSession: Sendable, Equatable {
  /// "openai" or "gemini".
  public var engine: String
  public var token: String
  public var ephemeral: Bool
  public var expiresAt: Date?
  public var model: String?
  public var voice: String?
  public var url: String?
  public var instructions: String
  /// The tools for the voice (ask_mercury, end_conversation, answer_approval), as a JSON array.
  public var toolsJSON: String

  public init(engine: String, token: String, ephemeral: Bool = true, expiresAt: Date? = nil, model: String? = nil, voice: String? = nil,
              url: String? = nil, instructions: String = "", toolsJSON: String = "[]") {
    self.engine = engine; self.token = token; self.ephemeral = ephemeral; self.expiresAt = expiresAt
    self.model = model; self.voice = voice; self.url = url; self.instructions = instructions; self.toolsJSON = toolsJSON
  }
}

/// What the session route answered.
public enum VoiceSessionResult: Sendable, Equatable {
  case live(VoiceSession)
  /// No live voice on this Mercury: the call goes turn by turn, and `reason` says why in plain words.
  case fallback(reason: String)
}

extension MercuryClient {
  /// The fallback's reason when this Mercury has no session route (it predates `voice.mobile`).
  public static let voiceSessionMissing = "Your Mercury is too old for live calls, so this call goes turn by turn: talk, pause, and Mercury answers. Update Mercury on your computer for live calls."

  /// POST /api/mobile/voice/session: a token for a live call, or why there can't be one.
  /// A call Mercury placed (ADR-046) passes the ring it answered, so Mercury starts by saying why it called.
  public func voiceSession(engine: String? = nil, ring: RingInvite? = nil) async throws -> VoiceSessionResult {
    var body: [String: Any] = engine.map { ["engine": $0] } ?? [:]
    if let ring { body["callInviteId"] = ring.id; body["reason"] = ring.reason }
    let (data, res) = try await send(request("POST", "/api/mobile/voice/session", body: body, timeout: 12))
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch res.statusCode {
    case 200:
      guard let engine = json["engine"] as? String, let token = json["token"] as? String, !token.isEmpty else {
        throw MercuryError.server(200, "Mercury didn't send a voice token.")
      }
      let tools = (json["tools"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
      return .live(VoiceSession(
        engine: engine, token: token, ephemeral: json["ephemeral"] as? Bool ?? true, expiresAt: Self.date(json["expiresAt"]),
        model: json["model"] as? String, voice: json["voice"] as? String, url: json["url"] as? String,
        instructions: json["instructions"] as? String ?? "", toolsJSON: tools))
    case 401: throw MercuryError.unauthorized
    case 404: return .fallback(reason: Self.voiceSessionMissing)
    case 409:
      let why = (json["error"] as? String).map { "\($0) Until then, this call goes turn by turn." }
      return .fallback(reason: why ?? "Live voice isn't available on your Mercury, so this call goes turn by turn.")
    default: throw MercuryError.server(res.statusCode, json["error"] as? String)
    }
  }
}

extension Spoken {
  /// A call answer's two parts (src/plugins/channel-bridge.ts spokenPart/chatPart): what's said,
  /// everything before a final "For the chat:" line, and the details after it, kept in the chat.
  public static func split(_ answer: String) -> (spoken: String, chat: String) {
    let pattern = #"(^|\n)\s*\**\s*for the chat\s*:?\**\s*:?"#
    guard let r = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
          let m = r.firstMatch(in: answer, range: NSRange(answer.startIndex..., in: answer)),
          let range = Range(m.range, in: answer) else {
      return (answer.trimmingCharacters(in: .whitespacesAndNewlines), "")
    }
    return (String(answer[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines),
            String(answer[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines))
  }
}
