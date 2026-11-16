import Foundation

/// What this Mercury's voice can do from the phone (GET /api/mobile/voice/capabilities,
/// src/web/api/mobile-voice.ts): live calls, and live dictation in the message box.
/// The route only looks at which keys are set; it never calls a provider.
public struct VoiceCapabilities: Sendable, Equatable {
  public var call: Bool
  public var callEngine: String?
  public var callSetup: String?
  public var dictation: Bool
  public var dictationEngine: String?
  /// What to add for dictation, in plain words, when it isn't available.
  public var dictationSetup: String?

  public init(call: Bool, callEngine: String? = nil, callSetup: String? = nil, dictation: Bool, dictationEngine: String? = nil, dictationSetup: String? = nil) {
    self.call = call; self.callEngine = callEngine; self.callSetup = callSetup
    self.dictation = dictation; self.dictationEngine = dictationEngine; self.dictationSetup = dictationSetup
  }

  /// The setup line when the Mercury didn't send one.
  public static let defaultDictationSetup = "Live dictation needs a speech provider. Add an OpenAI key in Settings → Models, or a Deepgram or ElevenLabs key in Settings → Voice."
  /// A Mercury from before the route: no dictation (calls fall back on their own).
  public static let tooOld = VoiceCapabilities(call: false, dictation: false,
    dictationSetup: "Live dictation needs a newer Mercury. Update Mercury on your computer, then try again.")

  /// What to tell the owner when the mic is greyed out.
  public var setupLine: String { dictationSetup ?? Self.defaultDictationSetup }

  /// The route's answer: 200 JSON, or a Mercury without the route (404).
  public static func decode(status: Int, data: Data) throws -> VoiceCapabilities {
    switch status {
    case 200:
      let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
      return VoiceCapabilities(
        call: j["call"] as? Bool ?? false, callEngine: j["callEngine"] as? String, callSetup: j["callSetup"] as? String,
        dictation: j["dictation"] as? Bool ?? false, dictationEngine: j["dictationEngine"] as? String,
        dictationSetup: j["dictationSetup"] as? String)
    case 404: return .tooOld
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(status, MercuryClient.message(data))
    }
  }
}

/// A short-lived token for live dictation (POST /api/mobile/voice/dictation). API keys stay on the computer.
public struct DictationSession: Sendable, Equatable {
  /// "openai", "deepgram" or "elevenlabs".
  public var engine: String
  public var token: String
  public var ephemeral: Bool
  public var expiresAt: Date?
  public var model: String?
  public var url: String?
  public var language: String?

  public init(engine: String, token: String, ephemeral: Bool = true, expiresAt: Date? = nil, model: String? = nil, url: String? = nil, language: String? = nil) {
    self.engine = engine; self.token = token; self.ephemeral = ephemeral; self.expiresAt = expiresAt
    self.model = model; self.url = url; self.language = language
  }

  /// Still good to open a stream with (a little margin for the connection).
  public func fresh(at now: Date = .now) -> Bool {
    guard let expiresAt else { return false }
    return expiresAt.timeIntervalSince(now) > 15
  }
}

public enum DictationStart: Sendable, Equatable {
  case live(DictationSession)
  /// No dictation on this Mercury: what to add, in plain words.
  case unavailable(setup: String)

  public static func decode(status: Int, data: Data) throws -> DictationStart {
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch status {
    case 200:
      guard let engine = j["engine"] as? String, let token = j["token"] as? String, !token.isEmpty else {
        throw MercuryError.server(200, "Mercury didn't send a dictation token.")
      }
      return .live(DictationSession(engine: engine, token: token, ephemeral: j["ephemeral"] as? Bool ?? true,
                                    expiresAt: MercuryClient.date(j["expiresAt"]), model: j["model"] as? String,
                                    url: j["url"] as? String, language: j["language"] as? String))
    case 404: return .unavailable(setup: VoiceCapabilities.tooOld.setupLine)
    case 409: return .unavailable(setup: (j["setup"] as? String) ?? (j["error"] as? String) ?? VoiceCapabilities.defaultDictationSetup)
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(status, j["error"] as? String)
    }
  }
}

extension MercuryClient {
  /// GET /api/mobile/voice/capabilities: can this Mercury do live calls and live dictation?
  public func voiceCapabilities() async throws -> VoiceCapabilities {
    let (data, res) = try await send(request("GET", "/api/mobile/voice/capabilities", timeout: 8))
    return try VoiceCapabilities.decode(status: res.statusCode, data: data)
  }

  /// POST /api/mobile/voice/dictation: a token for live dictation, or what to add for it.
  public func dictationSession(engine: String? = nil) async throws -> DictationStart {
    let (data, res) = try await send(request("POST", "/api/mobile/voice/dictation", body: engine.map { ["engine": $0] } ?? [:], timeout: 10))
    return try DictationStart.decode(status: res.statusCode, data: data)
  }
}
