import Foundation

/// A conversation (GET /api/chat/threads lists them without messages).
public struct ChatThread: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var title: String?
  public var alias: String?
  public var createdAt: Date
  public var updatedAt: Date?
  public var savedAt: Date?
  public var voiceCall: Bool?
  public var messages: [ChatMessage]

  public init(id: String, title: String?, createdAt: Date, updatedAt: Date? = nil, voiceCall: Bool? = nil, messages: [ChatMessage] = []) {
    self.id = id; self.title = title; self.createdAt = createdAt; self.updatedAt = updatedAt; self.voiceCall = voiceCall; self.messages = messages
  }

  /// What the list shows: the alias the owner gave it, else Mercury's title.
  public var displayTitle: String {
    let t = (alias?.isEmpty == false ? alias : title) ?? ""
    return t.isEmpty ? "New chat" : t
  }

  public var lastActivity: Date { updatedAt ?? createdAt }
}

public struct ChatMessage: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var role: String
  public var kind: String?
  public var content: String
  public var timestamp: Date
}

/// One line of GET /api/chat/activity: what a conversation is doing now.
public struct ActivityEvent: Decodable, Sendable {
  public enum Kind: String, Decodable, Sendable { case started, needs_you, resolved, done, stopped, failed, research }
  public var kind: Kind
  public var sessionId: String
  public var title: String?
  public var prompt: String?
  public var message: String?
}

extension JSONDecoder {
  /// Mercury's dates are ISO 8601 with milliseconds.
  static let mercury: JSONDecoder = {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .custom { dec in
      let s = try dec.singleValueContainer().decode(String.self)
      if let date = ISO8601DateFormatter.withFractions.date(from: s) ?? ISO8601DateFormatter().date(from: s) { return date }
      throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "Not a date: \(s)"))
    }
    return d
  }()
}

extension MercuryClient {
  func decode<T: Decodable>(_ type: T.Type, _ r: URLRequest) async throws -> T {
    let (data, res) = try await send(r)
    switch res.statusCode {
    case 200..<300: return try JSONDecoder.mercury.decode(T.self, from: data)
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(res.statusCode, Self.message(data))
    }
  }

  public func threads() async throws -> [ChatThread] {
    struct List: Decodable { var threads: [ChatThread] }
    return try await decode(List.self, request("GET", "/api/chat/threads")).threads
  }

  public func thread(_ id: String) async throws -> ChatThread {
    try await decode(ChatThread.self, request("GET", "/api/chat/threads/\(id)"))
  }

  public func deleteThread(_ id: String) async throws {
    _ = try await send(request("POST", "/api/chat/threads/\(id)/delete", body: ["confirmSessionId": id]))
  }
}
