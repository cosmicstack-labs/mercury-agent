import Foundation

/// A voice provider's key, as Mercury shows it (GET /api/voice/providers, src/web/api/voice-providers.ts).
/// Keys live on the computer, in the same store the Optimus plugin uses; the phone only ever sees
/// whether one is set, where it comes from and its last four characters.
public struct VoiceProvider: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  /// The env name the key is stored under (shared with Optimus); nil for OpenAI (the model's key).
  public var env: String?
  /// "calls", "dictation", "optimus".
  public var uses: [String]
  public var set: Bool
  /// "env" (set on the computer), "store" (saved from an app), "provider" (the OpenAI model's key), or nil.
  public var source: String?
  public var hint: String?
  public var canEdit: Bool
  public var note: String?

  public init(id: String, name: String, env: String? = nil, uses: [String], set: Bool, source: String? = nil, hint: String? = nil, canEdit: Bool, note: String? = nil) {
    self.id = id; self.name = name; self.env = env; self.uses = uses; self.set = set
    self.source = source; self.hint = hint; self.canEdit = canEdit; self.note = note
  }

  /// "Calls · Dictation", "Computer voice".
  public var usedFor: String {
    let words = uses.compactMap { u -> String? in
      switch u {
      case "calls": "Calls"
      case "dictation": "Dictation"
      default: nil
      }
    }
    return words.isEmpty ? "Computer voice (Optimus)" : words.joined(separator: " · ")
  }

  /// Used by the phone (calls or dictation), not only by Optimus on the computer.
  public var forPhone: Bool { uses.contains("calls") || uses.contains("dictation") }

  /// "Not set", "Set · ••••1234", "Set on the computer", "From your OpenAI model".
  public var status: String {
    guard set else { return "Not set" }
    switch source {
    case "env": return "Set on the computer"
    case "provider": return "From your OpenAI model"
    default: return hint.map { "Set · ••••\($0)" } ?? "Set"
    }
  }
}

public struct VoiceProviders: Sendable, Equatable {
  public var providers: [VoiceProvider]
  public var capabilities: VoiceCapabilities

  public init(providers: [VoiceProvider], capabilities: VoiceCapabilities) {
    self.providers = providers; self.capabilities = capabilities
  }
}

/// What saving a key did.
public struct VoiceKeySaved: Sendable, Equatable {
  public var verified: Bool
  public var message: String?
  public var provider: VoiceProvider?
  public var capabilities: VoiceCapabilities?
}

extension VoiceCapabilities {
  /// Posted (object: the new VoiceCapabilities, userInfo["baseURL"]: the Mercury's address) after a voice key changes, so the dictation mic and
  /// call button re-check what this Mercury can do at once.
  public static let changed = Notification.Name("MercuryVoiceCapabilitiesChanged")

  static func from(_ j: [String: Any]) -> VoiceCapabilities {
    VoiceCapabilities(
      call: j["call"] as? Bool ?? false, callEngine: j["callEngine"] as? String, callEngineName: j["callEngineName"] as? String,
      callSetup: j["callSetup"] as? String,
      dictation: j["dictation"] as? Bool ?? false, dictationEngine: j["dictationEngine"] as? String,
      dictationEngineName: j["dictationEngineName"] as? String, dictationSetup: j["dictationSetup"] as? String)
  }
}

extension MercuryClient {
  /// The api-contract flag for the routes below.
  public static let voiceProvidersFeature = "voice.providers"

  /// The providers when this Mercury has them (its /api/health lists `voice.providers`), else nil.
  public func voiceProvidersIfSupported() async throws -> VoiceProviders? {
    guard try await health().features?.contains(Self.voiceProvidersFeature) == true else { return nil }
    return try await voiceProviders()
  }

  /// GET /api/voice/providers; nil on a Mercury from before it.
  public func voiceProviders() async throws -> VoiceProviders? {
    let (data, res) = try await send(request("GET", "/api/voice/providers", timeout: 10))
    return try Self.decodeVoiceProviders(status: res.statusCode, data: data)
  }

  static func decodeVoiceProviders(status: Int, data: Data) throws -> VoiceProviders? {
    switch status {
    case 200:
      struct R: Decodable { var providers: [VoiceProvider] }
      let list = try JSONDecoder().decode(R.self, from: data).providers
      let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
      return VoiceProviders(providers: list, capabilities: .from(j["capabilities"] as? [String: Any] ?? [:]))
    case 404: return nil
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(status, message(data))
    }
  }

  /// PUT /api/voice/providers/:id: save a key (nil removes it). Mercury checks it with the provider
  /// first; a rejected key throws with the provider's reason. From a remote device the owner approves
  /// (428: run it through an OwnerGate). Posts `VoiceCapabilities.changed` when it worked.
  @discardableResult
  public func setVoiceKey(_ id: String, apiKey: String?, approval: String? = nil) async throws -> VoiceKeySaved {
    let body: [String: Any] = ["apiKey": apiKey.map { $0 as Any } ?? NSNull()]
    var r = try gated("PUT", "/api/voice/providers/\(id)", body: body, approval: approval)
    r.timeoutInterval = 25
    let (data, res) = try await send(r)
    let saved = try Self.decodeVoiceKeySaved(status: res.statusCode, data: data)
    if let caps = saved.capabilities {
      let url = baseURL
      await MainActor.run { NotificationCenter.default.post(name: VoiceCapabilities.changed, object: caps, userInfo: ["baseURL": url]) }
    }
    return saved
  }

  static func decodeVoiceKeySaved(status: Int, data: Data) throws -> VoiceKeySaved {
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch status {
    case 200..<300:
      struct P: Decodable { var provider: VoiceProvider? }
      let provider = (try? JSONDecoder().decode(P.self, from: data))?.provider
      return VoiceKeySaved(verified: j["verified"] as? Bool ?? false, message: j["message"] as? String, provider: provider,
                           capabilities: (j["capabilities"] as? [String: Any]).map(VoiceCapabilities.from))
    case 401: throw MercuryError.unauthorized
    case 428:
      if let id = j["approvalId"] as? String, let code = j["code"] as? String {
        throw MercuryError.needsOwner(OwnerQuestion(id: id, code: code, where_: j["where"] as? String ?? "this computer", message: j["error"] as? String ?? "Waiting for the owner."))
      }
      throw MercuryError.server(428, j["error"] as? String)
    case 404 where j["error"] == nil: throw MercuryError.server(404, "This Mercury can't set voice keys yet. Update Mercury on your computer.")
    default: throw MercuryError.server(status, j["error"] as? String)
    }
  }
}
