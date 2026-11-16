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
  /// The list's one line of the last user or assistant message (runtimes from 1.6 on; nil before).
  public var preview: String?
  /// Who wrote that line: "user" or "assistant".
  public var lastRole: String?
  public var messages: [ChatMessage]

  enum CodingKeys: String, CodingKey { case id, title, alias, createdAt, updatedAt, savedAt, voiceCall, preview, lastRole, messages }

  public init(id: String, title: String?, createdAt: Date, updatedAt: Date? = nil, savedAt: Date? = nil, voiceCall: Bool? = nil,
              preview: String? = nil, lastRole: String? = nil, messages: [ChatMessage] = []) {
    self.id = id; self.title = title; self.createdAt = createdAt; self.updatedAt = updatedAt; self.savedAt = savedAt
    self.voiceCall = voiceCall; self.preview = preview; self.lastRole = lastRole; self.messages = messages
  }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decodeIfPresent(String.self, forKey: .title)
    alias = try c.decodeIfPresent(String.self, forKey: .alias)
    createdAt = try c.decode(Date.self, forKey: .createdAt)
    updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt)
    savedAt = try c.decodeIfPresent(Date.self, forKey: .savedAt)
    voiceCall = try c.decodeIfPresent(Bool.self, forKey: .voiceCall)
    preview = try c.decodeIfPresent(String.self, forKey: .preview)
    lastRole = try c.decodeIfPresent(String.self, forKey: .lastRole)
    // The list sends no messages (and older lists may leave the key out).
    messages = try c.decodeIfPresent([ChatMessage].self, forKey: .messages) ?? []
  }

  /// What the list shows: its title, as Mercury Desktop does. The alias is a code Mercury makes
  /// up for each session ("brave-otter-x1z"), so it's never shown; until the first message names
  /// the thread its title is the placeholder "New session".
  public var displayTitle: String {
    let t = title?.trimmingCharacters(in: .whitespaces) ?? ""
    return t.isEmpty || t == "New session" ? "New chat" : t
  }

  public var lastActivity: Date { updatedAt ?? createdAt }
}

public struct ChatMessage: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var role: String
  public var kind: String?
  public var content: String
  public var timestamp: Date
  public var artifacts: [ArtifactRef]?
  /// This turn was stopped; content is whatever was written before that.
  public var stopped: Bool?
  /// A reply's tokens, steps and time (runtimes from #296 on). ChatModels.swift.
  public var usage: ReplyUsage?
  /// A reply's thought process as the runtime keeps it (ADR-041). ChatModels.swift.
  public var trace: StoredTrace?
  /// Files the person sent with this message.
  public var attachments: [SentAttachment]?

  public init(id: String = UUID().uuidString, role: String, content: String, timestamp: Date = .now, artifacts: [ArtifactRef]? = nil, stopped: Bool? = nil) {
    self.id = id; self.role = role; self.content = content; self.timestamp = timestamp; self.artifacts = artifacts; self.stopped = stopped
  }

  /// A message a person reads (user, assistant or a system note), not a stored tool call.
  public var isShown: Bool {
    (role == "user" || role == "assistant" || role == "system") && (kind == nil || kind == "message") && !content.isEmpty
  }
}

/// A file a turn made (image, PDF, report…). The file is at GET /api/artifacts/:id/file.
public struct ArtifactRef: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var kind: String?
  public var mime: String?
  public var size: Int?
  /// The tool that made it ("generate_image"…): media models' work is shown large and playable.
  public var tool: String?
  /// What the media model was asked for.
  public var prompt: String?
  /// Made together with others (a batch of images).
  public var batch: String?

  public init(id: String, name: String, kind: String?, mime: String?, size: Int?, tool: String? = nil, prompt: String? = nil, batch: String? = nil) {
    self.id = id; self.name = name; self.kind = kind; self.mime = mime; self.size = size; self.tool = tool; self.prompt = prompt; self.batch = batch
  }
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
    case 428:
      let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
      if let id = j["approvalId"] as? String, let code = j["code"] as? String {
        throw MercuryError.needsOwner(OwnerQuestion(id: id, code: code, where_: j["where"] as? String ?? "this computer", message: j["error"] as? String ?? "Waiting for the owner."))
      }
      throw MercuryError.server(428, j["error"] as? String)
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

  public func createThread(title: String? = nil) async throws -> ChatThread {
    try await decode(ChatThread.self, request("POST", "/api/chat/threads", body: title.map { ["title": $0] } ?? [:]))
  }

  /// POST /api/chat/send. The reply doesn't come back here: it streams on /api/chat/events.
  /// `voiceCall` is the call's id when this was said on a voice call: Mercury answers it for the ear.
  public func send(_ content: String, sessionId: String, voiceCall: String? = nil) async throws {
    struct Sent: Decodable { var sent: Bool }
    var body: [String: Any] = ["content": content, "sessionId": sessionId]
    if let voiceCall { body["voiceCall"] = voiceCall }
    _ = try await decode(Sent.self, request("POST", "/api/chat/send", body: body))
  }

  /// Stops whatever Mercury is doing.
  public func stop() async throws {
    _ = try await send(request("POST", "/api/chat/stop", body: [:]))
  }

  /// Answers a permission or choice prompt: "yes", "always", "no" or a choice's value.
  public func answer(promptId: String, action: String, targetId: String?) async throws {
    var body: [String: Any] = ["action": action]
    if let targetId { body["targetId"] = targetId }
    _ = try await send(request("POST", "/api/chat/permission/\(promptId)", body: body))
  }

  public func artifactURL(_ id: String) -> URL { baseURL.appending(path: "/api/artifacts/\(id)/file") }

  /// POST /api/chat/threads/:id/save: a bookmark to come back to, kept by Mercury (Desktop shares it).
  /// Returns when it was saved, nil once unsaved.
  public func setThreadSaved(_ id: String, saved: Bool) async throws -> Date? {
    struct R: Decodable { var savedAt: Date? }
    return try await decode(R.self, request("POST", "/api/chat/threads/\(Self.q(id))/save", body: ["saved": saved])).savedAt
  }

  public func deleteThread(_ id: String) async throws {
    _ = try await send(request("POST", "/api/chat/threads/\(id)/delete", body: ["confirmSessionId": id]))
  }
}
