import Foundation

/// What the bots stream (/api/bots/events) says.
public enum BotStreamEvent: Sendable {
  /// The roster changed (also sent first on every connect).
  case roster([BotStatus])
  /// A bot did something.
  case activity(BotActivityEvent)
  /// A bot asked, or its question was answered or timed out: reload the approvals.
  case approvalsChanged
  /// A new inbox entry (a result, a reported failure, or a run that needs you).
  case inbox(BotInboxEntry?)
}

extension MercuryClient {
  /// Bot ids are slugs; `request` percent-encodes the path itself (encoding here would double it).
  static func botPath(_ id: String) -> String { "/api/bots/" + id }

  /// A GET with a query, built here so it doesn't depend on how `request` treats a "?" in the path.
  func getting(_ path: String, _ query: [(String, String)]) throws -> URLRequest {
    var r = try request("GET", path)
    if let url = r.url, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) {
      c.percentEncodedQuery = query.map { "\($0.0)=\(Self.query($0.1))" }.joined(separator: "&")
      r.url = c.url ?? url
    }
    return r
  }

  static func query(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+,#"))) ?? s
  }

  /// GET /api/bots: the roster with live states and the inbox's unread count.
  public func bots() async throws -> BotRoster {
    try await decode(BotRoster.self, request("GET", "/api/bots"))
  }

  /// GET /api/bots/activity: the live feed's recent past for some bots (all when empty), oldest first.
  public func botActivity(_ ids: [String], limit: Int = 400) async throws -> [BotActivityEvent] {
    struct R: Decodable { var events: [BotActivityEvent] }
    return try await decode(R.self, getting("/api/bots/activity", [("bots", ids.joined(separator: ",")), ("limit", "\(limit)")])).events
  }

  /// GET /api/bots/approvals: every bot question waiting for an answer.
  public func botApprovals() async throws -> [BotApproval] {
    struct R: Decodable { var approvals: [BotApproval]? }
    return try await decode(R.self, request("GET", "/api/bots/approvals")).approvals ?? []
  }

  /// POST /api/bots/approvals/:id with yes, always or no. A question that's no longer waiting answers 409.
  public func answerBot(_ approvalId: String, _ answer: String) async throws {
    struct R: Decodable { var ok: Bool? }
    _ = try await decode(R.self, request("POST", "/api/bots/approvals/" + approvalId, body: ["answer": answer]))
  }

  /// POST /api/bots/:id/message. Queued durably: it runs now, or after the bot's current run.
  /// Refused (the bot is off, …) comes back as `accepted: false` with the reason, not as an error.
  public func messageBot(_ id: String, _ text: String) async throws -> BotMessageResult {
    let (data, res) = try await send(request("POST", Self.botPath(id) + "/message", body: ["message": text]))
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch res.statusCode {
    case 200..<300: return BotMessageResult(accepted: true, jobId: j["jobId"] as? String)
    case 409: return BotMessageResult(accepted: false, reasonCode: j["reasonCode"] as? String)
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(res.statusCode, j["error"] as? String)
    }
  }

  /// GET /api/bots/inbox: results, reported failures and runs that need you, newest first.
  public func botInbox(bot: String? = nil, unreadOnly: Bool = false, limit: Int = 100) async throws -> (entries: [BotInboxEntry], unread: Int) {
    struct R: Decodable { var entries: [BotInboxEntry]; var unread: Int? }
    var q = [("limit", "\(limit)")]
    if unreadOnly { q.append(("unread", "1")) }
    if let bot { q.append(("bot", bot)) }
    let r = try await decode(R.self, getting("/api/bots/inbox", q))
    return (r.entries, r.unread ?? 0)
  }

  /// POST /api/bots/inbox/read: some entries, or everything when `ids` is nil. Returns what's still unread.
  @discardableResult
  public func markBotInboxRead(_ ids: [String]?) async throws -> Int {
    struct R: Decodable { var unread: Int? }
    return try await decode(R.self, request("POST", "/api/bots/inbox/read", body: ids.map { ["ids": $0] } ?? [:])).unread ?? 0
  }

  /// GET /api/bots/:id/journal: its finished runs.
  public func botJournal(_ id: String, limit: Int = 60) async throws -> [BotRunRecord] {
    struct R: Decodable { var journal: [BotRunRecord] }
    return try await decode(R.self, getting(Self.botPath(id) + "/journal", [("limit", "\(limit)")])).journal
  }

  /// GET /api/bots/:id/runs/:runId: one run read back.
  public func botRun(_ id: String, _ runId: String) async throws -> BotRunTranscript {
    try await decode(BotRunTranscript.self, request("GET", Self.botPath(id) + "/runs/" + runId))
  }

  /// GET /api/bots/:id/avatar: the bot's own picture, when it has one.
  public func botAvatar(_ id: String) async throws -> Data {
    try await data(Self.botPath(id) + "/avatar")
  }

  /// The bots stream, decoded. Reconnects by itself; every connect starts with the roster.
  public func botEvents() -> AsyncStream<BotStreamEvent> {
    let raw = events("/api/bots/events")
    return AsyncStream { continuation in
      let task = Task {
        for await e in raw {
          if let ev = Self.botEvent(e) { continuation.yield(ev) }
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  static func botEvent(_ e: ServerEvent) -> BotStreamEvent? {
    let data = Data(e.data.utf8)
    switch e.name {
    case "bot_roster":
      struct R: Decodable { var bots: [BotStatus] }
      return (try? JSONDecoder().decode(R.self, from: data)).map { .roster($0.bots) }
    case "bot_activity":
      guard var ev = try? JSONDecoder().decode(BotActivityEvent.self, from: data) else { return nil }
      if ev.at == nil { ev.at = Date().timeIntervalSince1970 * 1000 }
      return .activity(ev)
    case "bot_approval": return .approvalsChanged
    case "bot_inbox": return .inbox(try? JSONDecoder().decode(BotInboxEntry.self, from: data))
    default: return nil
    }
  }
}
