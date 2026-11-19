import Foundation

// Ask Me / Allow All: whether Mercury asks before anything risky, or acts without asking. One
// setting for the whole Mercury, the same one Desktop's composer picker and status bar switch
// (apps/desktop/src/app/permission.ts is the reference).

public enum PermissionMode: String, Sendable, Equatable, CaseIterable {
  case askMe = "ask-me"
  case allowAll = "allow-all"

  public init(allowAll: Bool) { self = allowAll ? .allowAll : .askMe }
  public var allowAll: Bool { self == .allowAll }

  public var title: String {
    switch self {
    case .askMe: "Ask Me"
    case .allowAll: "Allow All"
    }
  }

  public var detail: String {
    switch self {
    case .askMe: "Mercury asks before anything risky"
    case .allowAll: "Mercury acts without asking"
    }
  }

  /// GET/PUT /api/chat/settings: `permissionMode` when the Mercury sends it, else `bypassPermissions`.
  public static func decode(_ data: Data) -> PermissionMode? {
    guard let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    if let m = (j["permissionMode"] as? String).flatMap(PermissionMode.init(rawValue:)) { return m }
    return (j["bypassPermissions"] as? Bool).map(PermissionMode.init(allowAll:))
  }

  /// The runtime's live `status` event (`permission: "allow-all" | "ask-me"`), nil when it doesn't say.
  public static func fromStatus(_ data: [String: Any]) -> PermissionMode? {
    (data["permission"] as? String).flatMap(PermissionMode.init(rawValue:))
  }
}

extension MercuryClient {
  /// GET /api/chat/settings: Ask Me or Allow All.
  public func permissionMode() async throws -> PermissionMode {
    let (data, res) = try await send(request("GET", "/api/chat/settings"))
    switch res.statusCode {
    case 200..<300:
      guard let m = PermissionMode.decode(data) else { throw MercuryError.server(res.statusCode, "Mercury didn't say how it asks.") }
      return m
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(res.statusCode, Self.message(data))
    }
  }

  /// PUT /api/chat/settings { bypassPermissions }. A current Mercury switches at once for a paired
  /// device; an older one answers 428 for Allow All (run it through an OwnerGate, `approval` then
  /// carries the owner's go-ahead). Returns the mode Mercury now has.
  public func setPermissionMode(_ mode: PermissionMode, approval: String? = nil) async throws -> PermissionMode {
    let (data, res) = try await send(gated("PUT", "/api/chat/settings", body: ["bypassPermissions": mode.allowAll], approval: approval))
    switch res.statusCode {
    case 200..<300: return PermissionMode.decode(data) ?? mode
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
}
