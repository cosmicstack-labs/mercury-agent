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
