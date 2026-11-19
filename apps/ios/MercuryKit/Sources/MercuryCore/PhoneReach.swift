import Foundation

/// Calls and notifications from Mercury to this phone (ADR-046, src/reach). They arrive only over
/// the live activity stream the app keeps open (/api/chat/activity): `ring`, `ring_end` and
/// `notify` events. Nothing reaches the phone through a push service; what it missed while it
/// wasn't connected waits on the server (GET /api/devices/me/missed).

/// Mercury is ringing this phone.
public struct RingInvite: Sendable, Equatable, Hashable {
  public var id: String
  /// Always "Mercury" for now.
  public var caller: String
  /// Why Mercury is calling: its first words when the call is answered.
  public var reason: String
  public var urgency: String
  public var expiresAt: Date?

  public init(id: String, caller: String = "Mercury", reason: String, urgency: String = "normal", expiresAt: Date? = nil) {
    self.id = id; self.caller = caller; self.reason = reason; self.urgency = urgency; self.expiresAt = expiresAt
  }
}

/// A notification from Mercury, shown as a local notification.
public struct ReachNotice: Sendable, Equatable {
  public var id: String
  public var title: String
  public var body: String
  public var kind: String
  public var urgency: String
  public var threadId: String?
  /// Quiet hours: show it without a sound.
  public var silent: Bool

  public init(id: String, title: String, body: String, kind: String = "info", urgency: String = "normal", threadId: String? = nil, silent: Bool = false) {
    self.id = id; self.title = title; self.body = body; self.kind = kind; self.urgency = urgency; self.threadId = threadId; self.silent = silent
  }
}

/// A call nobody answered or a notification no phone was connected for.
public struct MissedItem: Sendable, Equatable, Identifiable {
  public var id: String
  /// "call" or "notification".
  public var kind: String
  public var title: String
  public var body: String
  public var threadId: String?
  public var at: Date?
}

public enum RingOutcome: String, Sendable { case answered, declined, missed }

/// One reach event from the activity stream.
public enum ReachEvent: Sendable, Equatable {
  case ring(RingInvite)
  /// The ring stopped elsewhere: "answered_elsewhere", "declined" or "missed".
  case ringEnd(id: String, outcome: String)
  case notify(ReachNotice)

  /// Parses a `ring`, `ring_end` or `notify` event; nil for any other event or a malformed one.
  public static func parse(name: String, data: String) -> ReachEvent? {
    guard ["ring", "ring_end", "notify"].contains(name),
          let d = data.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let id = j["id"] as? String, !id.isEmpty else { return nil }
    switch name {
    case "ring":
      return .ring(RingInvite(id: id, caller: j["caller"] as? String ?? "Mercury", reason: j["reason"] as? String ?? "",
                              urgency: j["urgency"] as? String ?? "normal", expiresAt: MercuryClient.date(j["expiresAt"])))
    case "ring_end":
      return .ringEnd(id: id, outcome: j["outcome"] as? String ?? "missed")
    default:
      return .notify(ReachNotice(id: id, title: j["title"] as? String ?? "Mercury", body: j["body"] as? String ?? "",
                                 kind: j["kind"] as? String ?? "info", urgency: j["urgency"] as? String ?? "normal",
                                 threadId: j["threadId"] as? String, silent: j["silent"] as? Bool ?? false))
    }
  }
}

/// The owner's settings for calls from Mercury (the part the app shows; src/reach/settings.ts).
public struct ReachSettings: Sendable, Equatable {
  public var calls = true
  public var notifications = true
  public var quietHours = false
  /// "HH:MM", local time on the computer Mercury runs on.
  public var quietStart = "22:00"
  public var quietEnd = "07:00"
  public var maxCallsPerHour = 4

  public init() {}

  init(json j: [String: Any]) {
    calls = j["calls"] as? Bool ?? true
    notifications = j["notifications"] as? Bool ?? true
    let q = j["quietHours"] as? [String: Any] ?? [:]
    quietHours = q["enabled"] as? Bool ?? false
    quietStart = q["start"] as? String ?? "22:00"
    quietEnd = q["end"] as? String ?? "07:00"
    maxCallsPerHour = j["maxCallsPerHour"] as? Int ?? 4
  }

  /// The body for PUT /api/reach/settings.
  public var patch: [String: Any] {
    ["calls": calls, "notifications": notifications, "quietHours": ["enabled": quietHours, "start": quietStart, "end": quietEnd]]
  }
}

extension MercuryClient {
  /// PUT /api/devices/me/reach: tells Mercury this is an iPhone and whether to ring it.
  public func registerReach(ring: Bool, notify: Bool, appVersion: String, capabilities: [String]) async throws {
    let body: [String: Any] = ["platform": "ios", "appVersion": appVersion, "ring": ring, "notify": notify, "capabilities": capabilities]
    let (data, res) = try await send(request("PUT", "/api/devices/me/reach", body: body))
    try Self.reachCheck(data, res)
  }

  /// POST /api/devices/me/ring/:id: what happened to a ring.
  public func reportRing(_ id: String, _ outcome: RingOutcome) async throws {
    let path = "/api/devices/me/ring/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
    let (data, res) = try await send(request("POST", path, body: ["outcome": outcome.rawValue]))
    try Self.reachCheck(data, res)
  }

  /// POST /api/devices/me/test-ring: Mercury rings this phone now.
  public func testRing() async throws {
    let (data, res) = try await send(request("POST", "/api/devices/me/test-ring", body: [:]))
    try Self.reachCheck(data, res)
  }

  /// GET /api/devices/me/missed: what came while no phone was connected.
  public func missed() async throws -> [MissedItem] {
    let (data, res) = try await send(request("GET", "/api/devices/me/missed"))
    try Self.reachCheck(data, res)
    let items = ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["items"] as? [[String: Any]]) ?? []
    return items.compactMap { j in
      guard let id = j["id"] as? String else { return nil }
      return MissedItem(id: id, kind: j["kind"] as? String ?? "notification", title: j["title"] as? String ?? "Mercury",
                        body: j["body"] as? String ?? "", threadId: j["threadId"] as? String, at: Self.date(j["at"]))
    }
  }

  /// POST /api/devices/me/missed/ack: they were shown (for every phone).
  public func ackMissed(_ ids: [String]) async throws {
    guard !ids.isEmpty else { return }
    let (data, res) = try await send(request("POST", "/api/devices/me/missed/ack", body: ["ids": ids]))
    try Self.reachCheck(data, res)
  }

  public func reachSettings() async throws -> ReachSettings {
    let (data, res) = try await send(request("GET", "/api/reach/settings"))
    try Self.reachCheck(data, res)
    return ReachSettings(json: ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["settings"] as? [String: Any]) ?? [:])
  }

  public func updateReachSettings(_ s: ReachSettings) async throws -> ReachSettings {
    let (data, res) = try await send(request("PUT", "/api/reach/settings", body: s.patch))
    try Self.reachCheck(data, res)
    return ReachSettings(json: ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["settings"] as? [String: Any]) ?? [:])
  }

  static func reachCheck(_ data: Data, _ res: HTTPURLResponse) throws {
    if res.statusCode == 401 { throw MercuryError.unauthorized }
    guard (200..<300).contains(res.statusCode) else { throw MercuryError.server(res.statusCode, message(data)) }
  }
}
