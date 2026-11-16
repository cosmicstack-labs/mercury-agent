import Foundation

// The settings Mercury Desktop manages, read and changed over the same API
// (apps/desktop/src/api/*.ts is the reference for every shape here).

// MARK: Owner approval

/// A change a remote device asked for that the owner must allow first (src/web/owner-gate.ts):
/// approve it with `code` on `where`, then repeat the call with this `id`.
public struct OwnerQuestion: Equatable, Sendable, Identifiable {
  public var id: String
  public var code: String
  public var where_: String
  public var message: String
}

public enum ApprovalStatus: String, Sendable { case pending, allowed, denied, expired }

extension MercuryClient {
  /// GET /api/security/approvals/:id/status: this device's own question.
  public func approvalStatus(_ id: String) async throws -> ApprovalStatus {
    struct S: Decodable { var status: String }
    let (data, _) = try await send(request("GET", "/api/security/approvals/\(id)/status"))
    return (try? JSONDecoder().decode(S.self, from: data)).flatMap { ApprovalStatus(rawValue: $0.status) } ?? .expired
  }

  /// A request that may need the owner's go-ahead, carrying it once it was given.
  func gated(_ method: String, _ path: String, body: [String: Any]? = nil, approval: String?) throws -> URLRequest {
    var r = try request(method, path, body: body)
    if let approval { r.setValue(approval, forHTTPHeaderField: "X-Mercury-Approval") }
    return r
  }
}

// MARK: Models

public struct ProviderInfo: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var label: String
  public var kind: String
  public var blurb: String
  public var needsKey: Bool
  public var needsBaseUrl: Bool
  public var signInOnly: Bool
  public var keyUrl: String?
  public var keyHint: String?
  /// Masked ("sk-a••••b3c4"); never sent back.
  public var apiKey: String
  public var hasKey: Bool
  public var baseUrl: String
  public var model: String
  public var enabled: Bool
  public var configured: Bool
  public var isDefault: Bool
  public var recommended: Bool
}

public struct ProviderSettings: Decodable, Sendable {
  public struct Default: Decodable, Sendable { public var provider: String; public var model: String }
  public struct Roles: Decodable, Sendable { public var learning: String?; public var crew: String? }
  public var providers: [ProviderInfo]
  public var `default`: Default
  public var roles: Roles
}

public struct ProviderCheck: Decodable, Sendable {
  public var ok: Bool
  public var models: [String]?
  public var recommendedModel: String?
  public var error: String?
  public var field: String?
}

public struct SaveResult: Decodable, Sendable {
  public var success: Bool?
  public var applied: Bool?
  public var restarting: Bool?
  public var restartRequired: Bool?
  public var error: String?
}

extension MercuryClient {
  public func providerSettings() async throws -> ProviderSettings {
    try await decode(ProviderSettings.self, request("GET", "/api/providers/settings"))
  }

  /// A live check of what's typed; an omitted key means the saved one. Lists the models it offers.
  public func checkProvider(_ id: String, apiKey: String? = nil, baseUrl: String? = nil) async throws -> ProviderCheck {
    var body: [String: Any] = [:]
    if let apiKey { body["apiKey"] = apiKey }
    if let baseUrl { body["baseUrl"] = baseUrl }
    return try await decode(ProviderCheck.self, request("POST", "/api/providers/\(id)/check", body: body))
  }

  public func saveProvider(_ id: String, apiKey: String? = nil, baseUrl: String? = nil, model: String? = nil, enabled: Bool? = nil, approval: String? = nil) async throws -> SaveResult {
    var body: [String: Any] = [:]
    if let apiKey { body["apiKey"] = apiKey }
    if let baseUrl { body["baseUrl"] = baseUrl }
    if let model { body["model"] = model }
    if let enabled { body["enabled"] = enabled }
    return try await decode(SaveResult.self, gated("POST", "/api/providers/\(id)", body: body, approval: approval))
  }

  public func forgetProviderKey(_ id: String, approval: String? = nil) async throws -> SaveResult {
    try await decode(SaveResult.self, gated("DELETE", "/api/providers/\(id)/key", approval: approval))
  }

  /// The default model, and which provider learning and bot crews use (nil = same as default).
  public func setModelRoles(defaultProvider: String? = nil, model: String? = nil, learning: String?? = nil, crew: String?? = nil, approval: String? = nil) async throws -> SaveResult {
    var body: [String: Any] = [:]
    if let defaultProvider { body["default"] = model.map { ["provider": defaultProvider, "model": $0] } ?? ["provider": defaultProvider] }
    if let learning { body["learning"] = learning ?? NSNull() }
    if let crew { body["crew"] = crew ?? NSNull() }
    return try await decode(SaveResult.self, gated("PUT", "/api/providers/roles", body: body, approval: approval))
  }
}

// MARK: Plugin settings (Voice is Optimus's)

/// One setting a plugin declares, with when it applies.
public struct PluginField: Decodable, Identifiable, Sendable {
  public var key: String
  public var type: String
  public var label: String?
  public var description: String?
  public var options: [String]?
  public var optionLabels: [String: String]?
  public var value: JSONValue?
  public var isSet: Bool?
  public var group: String?
  public var when: [[String: JSONValue]]?

  public var id: String { key }

  enum CodingKeys: String, CodingKey { case key, type, label, description, options, optionLabels, value, isSet, group, when }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    type = try c.decode(String.self, forKey: .type)
    label = try c.decodeIfPresent(String.self, forKey: .label)
    description = try c.decodeIfPresent(String.self, forKey: .description)
    options = try c.decodeIfPresent([String].self, forKey: .options)
    optionLabels = try c.decodeIfPresent([String: String].self, forKey: .optionLabels)
    value = try c.decodeIfPresent(JSONValue.self, forKey: .value)
    isSet = try c.decodeIfPresent(Bool.self, forKey: .isSet)
    group = try c.decodeIfPresent(String.self, forKey: .group)
    // One condition or several (any of them).
    if let one = try? c.decodeIfPresent([String: JSONValue].self, forKey: .when) { when = [one] }
    else { when = try c.decodeIfPresent([[String: JSONValue]].self, forKey: .when) }
  }

  /// Does it apply, given the current values? (Mirrors the runtime's `whenMatches`.)
  public func applies(_ values: [String: JSONValue]) -> Bool {
    guard let when, !when.isEmpty else { return true }
    return when.contains { cond in
      cond.allSatisfy { key, want in
        let v = values[key]?.text ?? ""
        if case .array(let list) = want { return list.contains { $0.text == v } }
        return want.text == v
      }
    }
  }
}

public struct PluginDetail: Decodable, Sendable {
  public struct Group: Decodable, Sendable, Identifiable { public var id: String; public var label: String; public var description: String?; public var ready: Bool }
  public struct Missing: Decodable, Sendable { public var key: String; public var needs: String; public var fix: String }
  public var id: String
  public var name: String
  public var enabled: Bool
  public var running: Bool
  public var installedVersion: String?
  public var settings: [PluginField]?
  public var settingGroups: [Group]?
  public var missing: [Missing]?
}

public struct VoiceKeyCheck: Decodable, Sendable { public var ok: Bool; public var verified: Bool; public var message: String }

extension MercuryClient {
  /// GET /api/plugins/:id; nil when it isn't installed.
  public func plugin(_ id: String) async throws -> PluginDetail? {
    struct R: Decodable { var plugin: PluginDetail? }
    do { return try await decode(R.self, request("GET", "/api/plugins/\(id)")).plugin }
    catch MercuryError.server(404, _) { return nil }
  }

  public func setPluginSetting(_ id: String, key: String, value: Any, approval: String? = nil) async throws {
    struct R: Decodable { var ok: Bool? }
    _ = try await decode(R.self, gated("POST", "/api/plugins/\(id)/settings", body: ["key": key, "value": value], approval: approval))
  }

  /// POST /api/voice/check: is this voice key good? With no key, checks the saved one.
  public func checkVoiceKey(vendor: String, key: String? = nil) async throws -> VoiceKeyCheck {
    var body: [String: Any] = ["vendor": vendor]
    if let key { body["key"] = key }
    return try await decode(VoiceKeyCheck.self, request("POST", "/api/voice/check", body: body))
  }
}

// MARK: Channels

public struct ChannelPerson: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var detail: String?
  public var role: String?
  public var code: String?
}

public struct ChannelInfo: Decodable, Identifiable, Sendable {
  public struct Access: Decodable, Sendable { public var admins: [ChannelPerson]; public var members: [ChannelPerson]; public var pending: [ChannelPerson] }
  public var type: String
  public var label: String
  public var enabled: Bool
  public var configured: Bool
  public var running: Bool
  /// Keys masked; has<Key> says whether one is saved.
  public var settings: [String: JSONValue]
  public var access: Access
  public var id: String { type }
}

public struct ChannelCheck: Decodable, Sendable { public var ok: Bool; public var identity: String?; public var message: String; public var field: String? }

extension MercuryClient {
  public func channels() async throws -> [ChannelInfo] {
    struct R: Decodable { var channels: [ChannelInfo] }
    return try await decode(R.self, request("GET", "/api/channels")).channels
  }

  public func checkChannel(_ type: String, draft: [String: Any]) async throws -> ChannelCheck {
    try await decode(ChannelCheck.self, request("POST", "/api/channels/\(type)/check", body: draft))
  }

  public func saveChannel(_ type: String, patch: [String: Any], approval: String? = nil) async throws -> ChannelInfo {
    struct R: Decodable { var channel: ChannelInfo; var error: String? }
    return try await decode(R.self, gated("PUT", "/api/channels/\(type)", body: patch, approval: approval)).channel
  }

  /// approve · reject · remove · promote · demote, for one person.
  public func channelAccess(_ type: String, action: String, id: String, approval: String? = nil) async throws -> ChannelInfo {
    struct R: Decodable { var channel: ChannelInfo }
    return try await decode(R.self, gated("POST", "/api/channels/\(type)/access", body: ["action": action, "id": id], approval: approval)).channel
  }
}

// MARK: Budgets

public struct BudgetState: Decodable, Sendable, Equatable {
  public struct Daily: Decodable, Sendable, Equatable { public var budget: Int; public var used: Int; public var remaining: Int; public var percentage: Double }
  public struct Saver: Decodable, Sendable, Equatable { public var state: String; public var autoEnabled: Bool; public var autoThreshold: Int; public var savedToday: Int; public var savedLifetime: Int }
  public struct Bots: Decodable, Sendable, Equatable { public var enabled: Bool; public var perBot: Int; public var fleet: Int }
  public var daily: Daily
  public var saver: Saver
  public var bots: Bots
}

extension MercuryClient {
  public func budget() async throws -> BudgetState { try await decode(BudgetState.self, request("GET", "/api/budget")) }

  /// dailyBudget · saver { manual, autoEnabled, autoThreshold } · bots { perBot, fleet }
  public func setBudget(_ patch: [String: Any], approval: String? = nil) async throws -> BudgetState {
    try await decode(BudgetState.self, gated("PUT", "/api/budget", body: patch, approval: approval))
  }
}

// MARK: Activity

public struct UsageDay: Decodable, Identifiable, Sendable, Equatable {
  public var date: String
  public var tokens: Int
  public var inputTokens: Int
  public var outputTokens: Int
  public var requests: Int
  public var id: String { date }
}

extension MercuryClient {
  public func usageHistory(days: Int) async throws -> [UsageDay] {
    struct R: Decodable { var days: [UsageDay] }
    return try await decode(R.self, request("GET", "/api/usage/history?days=\(days)")).days
  }
}

// MARK: Paired devices

public struct PairedDevice: Decodable, Identifiable, Sendable, Equatable {
  public var id: String
  public var name: String
  public var platform: String
  public var createdAt: Date
  public var lastSeenAt: Date?
}

extension MercuryClient {
  /// Every device with a token, and which one is asking.
  public func pairedDevices() async throws -> (devices: [PairedDevice], current: String?) {
    struct R: Decodable { var devices: [PairedDevice]; var current: String? }
    let r = try await decode(R.self, request("GET", "/api/auth/devices"))
    return (r.devices, r.current)
  }

  public func revokeDevice(_ id: String, approval: String? = nil) async throws {
    struct R: Decodable { var success: Bool? }
    _ = try await decode(R.self, gated("DELETE", "/api/auth/devices/\(id)", approval: approval))
  }
}

// MARK: JSON values

/// Any JSON value (plugin settings and channel settings are loosely typed).
public enum JSONValue: Decodable, Hashable, Sendable {
  case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null

  public init(from d: Decoder) throws {
    let c = try d.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  /// As text, the way a setting compares and shows ("true", "60", "gemini").
  public var text: String {
    switch self {
    case .string(let s): s
    case .number(let n): n.rounded() == n ? String(Int(n)) : String(n)
    case .bool(let b): b ? "true" : "false"
    case .null: ""
    case .array, .object: ""
    }
  }

  public var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
  public var number: Double? { if case .number(let n) = self { n } else { nil } }
}
