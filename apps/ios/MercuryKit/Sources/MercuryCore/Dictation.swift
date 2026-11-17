import Foundation

/// What this Mercury's voice can do from the phone (GET /api/mobile/voice/capabilities,
/// src/web/api/mobile-voice.ts): live calls, and live dictation in the message box.
/// The route only looks at which keys are set; it never calls a provider.
public struct VoiceCapabilities: Sendable, Equatable {
  public var call: Bool
  public var callEngine: String?
  /// "OpenAI Realtime", "Gemini Live" (newer Mercurys).
  public var callEngineName: String?
  public var callSetup: String?
  public var dictation: Bool
  public var dictationEngine: String?
  /// "OpenAI", "Gemini", "Deepgram", "ElevenLabs Scribe" (newer Mercurys).
  public var dictationEngineName: String?
  /// What to add for dictation, in plain words, when it isn't available.
  public var dictationSetup: String?
  /// "device": this Mercury has no speech service, so the phone dictates with its own speech recognition.
  public var dictationFallback: String?

  public init(call: Bool, callEngine: String? = nil, callEngineName: String? = nil, callSetup: String? = nil, dictation: Bool, dictationEngine: String? = nil, dictationEngineName: String? = nil, dictationSetup: String? = nil, dictationFallback: String? = nil) {
    self.call = call; self.callEngine = callEngine; self.callEngineName = callEngineName; self.callSetup = callSetup
    self.dictation = dictation; self.dictationEngine = dictationEngine; self.dictationEngineName = dictationEngineName; self.dictationSetup = dictationSetup
    self.dictationFallback = dictationFallback
  }

  /// "Gemini Live", for "Calls use: …"; nil when calls aren't set up.
  public var callName: String? { call ? (callEngineName ?? callEngine.map { $0 == "gemini" ? "Gemini Live" : Self.engineName($0) }) : nil }
  /// "Deepgram", for "Dictation uses: …"; nil when dictation isn't set up.
  public var dictationName: String? { dictation ? (dictationEngineName ?? dictationEngine.map(Self.engineName)) : nil }

  public static func engineName(_ id: String) -> String {
    switch id {
    case "openai": "OpenAI"
    case "gemini": "Gemini"
    case "deepgram": "Deepgram"
    case "elevenlabs": "ElevenLabs"
    default: id
    }
  }

  /// The setup line when the Mercury didn't send one.
  public static let defaultDictationSetup = "Dictation uses this phone's own speech recognition. For better dictation, add a Gemini, OpenAI, Deepgram or ElevenLabs key in Settings → Voice."
  /// A Mercury from before the route: no dictation (calls fall back on their own).
  public static let tooOld = VoiceCapabilities(call: false, dictation: false,
    dictationSetup: "Live dictation needs a newer Mercury. Update Mercury on your computer, then try again.")

  /// What to tell the owner about dictation without a speech service.
  public var setupLine: String { dictationSetup ?? Self.defaultDictationSetup }

  /// The route's answer: 200 JSON, or a Mercury without the route (404).
  public static func decode(status: Int, data: Data) throws -> VoiceCapabilities {
    switch status {
    case 200:
      return .from((try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
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
  /// No speech service on this Mercury (the phone uses its own): what to add, in plain words.
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

/// Who listens when the owner taps the mic: the speech service Mercury uses (the owner's voice
/// choice, the same one Desktop's voice typing uses), or, when Mercury has none or is too old to
/// say, this phone's own speech recognition. The mic is never greyed out for want of a key.
public enum DictationRoute: Sendable, Equatable {
  /// Mercury mints a token for its speech service ("Gemini", "OpenAI", …; nil when not yet known).
  case server(name: String?)
  /// The phone's speech recognition (on the device when it can).
  case device
  /// Nothing can listen: why, in plain words.
  case unavailable(String)

  public static let deviceName = "On this phone"
  public static let duringCall = "Dictation is off during a voice call."
  public static let noSpeech = "This phone can't recognise speech right now, and Mercury has no speech service. Add a Gemini, OpenAI, Deepgram or ElevenLabs key in Settings → Voice, or allow Speech Recognition in Settings → Mercury."

  /// - caps: GET /api/mobile/voice/capabilities (nil: not known yet, so Mercury is asked first).
  /// - deviceAvailable: the phone's recogniser is there and not refused.
  public static func decide(caps: VoiceCapabilities?, deviceAvailable: Bool, callRunning: Bool = false) -> DictationRoute {
    if callRunning { return .unavailable(duringCall) }
    guard let caps else { return .server(name: nil) }
    if caps.dictation { return .server(name: caps.dictationName) }
    return deviceAvailable ? .device : .unavailable(noSpeech)
  }

  /// Mercury couldn't start its speech service (none set up, an older Mercury, or offline).
  public static func afterServerRefused(_ why: String, deviceAvailable: Bool) -> DictationRoute {
    deviceAvailable ? .device : .unavailable(why)
  }

  /// The box's placeholder while listening: "Listening · Gemini", "Listening · On this phone".
  public var listeningLabel: String {
    switch self {
    case .server(let name?): "Listening · \(name)"
    case .device: "Listening · \(Self.deviceName)"
    default: "Listening…"
    }
  }
}
