import Foundation

/// "Set up voice": what the phone does when the owner taps a call entry or the dictation mic and this
/// Mercury can't do it yet. Decided here, apart from the screens, so tests cover every case (Android
/// has the same rules in core/VoiceSetup.kt).
///
/// - The feature works: go ahead (start the call, start dictating).
/// - A Mercury from before `voice.providers`: what the phone did before (the call starts and falls
///   back on its own; the mic says what to add).
/// - Otherwise: the setup sheet, with the voices that can do what was asked first.
public enum VoiceSetup {
  /// What opened it.
  public enum Trigger: String, Sendable, Hashable, Identifiable {
    /// The top phone button, the composer's waveform, the side panel's Call Mercury, the Home Screen action.
    case call
    /// The composer's mic.
    case dictation
    /// Settings → Voice.
    case settings
    public var id: String { rawValue }
  }

  public enum Decision: Equatable, Sendable {
    /// It works: start it.
    case proceed
    /// An older Mercury: today's behaviour.
    case legacy
    /// Show "Set up voice".
    case setup
  }

  /// Whether the feature the trigger asks for is there.
  public static func available(_ trigger: Trigger, _ caps: VoiceCapabilities) -> Bool {
    switch trigger {
    case .call, .settings: caps.call
    case .dictation: caps.dictation
    }
  }

  /// `supported`: the Mercury's /api/health lists `voice.providers`. `caps`: nil when they couldn't be read.
  public static func decide(_ trigger: Trigger, supported: Bool, caps: VoiceCapabilities?) -> Decision {
    if let caps, available(trigger, caps) { return .proceed }
    guard supported else { return .legacy }
    // Couldn't read what it can do: let the call or mic try (and say why it can't) rather than guess.
    guard caps != nil else { return .legacy }
    return .setup
  }

  /// One voice on the sheet.
  public struct Choice: Equatable, Sendable, Identifiable {
    public enum State: Equatable, Sendable {
      /// Set and usable for what was asked: "Ready · uses your OpenAI key".
      case ready
      /// Tap to paste a key.
      case add
      /// Can't be set from the phone (set on the computer): tap explains.
      case locked
    }
    public var provider: VoiceProvider
    public var state: State
    public var id: String { provider.id }

    /// The one line under the name.
    public var line: String {
      switch state {
      case .ready:
        switch provider.source {
        case "provider": return "Ready · uses your OpenAI key"
        case "env": return "Ready · set on your computer"
        default: return provider.hint.map { "Ready · key ••••\($0)" } ?? "Ready"
        }
      case .locked: return "Set on your computer"
      case .add: return VoiceSetup.blurb(provider.id)
      }
    }
  }

  public struct Plan: Equatable, Sendable {
    public var trigger: Trigger
    /// Voices that do what was asked, the ones that can also take calls first.
    public var choices: [Choice]
    /// "More options": dictation-only voices, when the mic opened it (or Settings).
    public var more: [Choice]
    /// A voice that's already set: "Start talking" with no steps.
    public var ready: Choice? { (choices + more).first { $0.state == .ready } }
  }

  static func serves(_ p: VoiceProvider, _ trigger: Trigger) -> Bool {
    switch trigger {
    case .call, .settings: p.uses.contains("calls")
    case .dictation: p.uses.contains("dictation")
    }
  }

  static func choice(_ p: VoiceProvider, for trigger: Trigger) -> Choice {
    if p.set && serves(p, trigger) { return Choice(provider: p, state: .ready) }
    if p.id == "openai" || p.canEdit { return Choice(provider: p, state: .add) }
    return Choice(provider: p, state: .locked)
  }

  /// The sheet's rows from GET /api/voice/providers. Calls: OpenAI Realtime, Gemini Live. The mic:
  /// the call voices that also dictate (OpenAI), then Deepgram and ElevenLabs under More options.
  /// Settings: the call voices, dictation-only ones under More options.
  public static func plan(_ trigger: Trigger, providers: [VoiceProvider]) -> Plan {
    let calls = providers.filter { $0.uses.contains("calls") }
    let dictationOnly = providers.filter { $0.uses.contains("dictation") && !$0.uses.contains("calls") }
    let order = { (a: VoiceProvider, b: VoiceProvider) in rank(a.id) < rank(b.id) }
    switch trigger {
    case .call:
      return Plan(trigger: trigger, choices: calls.sorted(by: order).map { choice($0, for: trigger) }, more: [])
    case .dictation:
      return Plan(trigger: trigger, choices: calls.filter { serves($0, .dictation) }.sorted(by: order).map { choice($0, for: trigger) },
                  more: dictationOnly.sorted(by: order).map { choice($0, for: trigger) })
    case .settings:
      return Plan(trigger: trigger, choices: calls.sorted(by: order).map { choice($0, for: trigger) },
                  more: dictationOnly.sorted(by: order).map { choice($0, for: .dictation) })
    }
  }

  private static func rank(_ id: String) -> Int {
    ["openai", "gemini", "deepgram", "elevenlabs"].firstIndex(of: id) ?? 99
  }

  /// Settings → Voice shows "Set up voice" at the top when no voice the phone uses is set.
  public static func settingsOffersSetup(_ v: VoiceProviders) -> Bool {
    !v.providers.contains { $0.forPhone && $0.set }
  }

  /// What happens once a key is saved and Mercury sent its new capabilities.
  public enum Next: Equatable, Sendable {
    case startCall
    case startDictation
    /// From Settings: just "Voice is ready".
    case done
    /// Saved, but what was asked still isn't there (that voice can't do it): say so, back to the list.
    case stillMissing(String)
  }

  public static func next(after trigger: Trigger, caps: VoiceCapabilities?) -> Next {
    guard let caps else { return trigger == .settings ? .done : .stillMissing("Saved. Mercury couldn't say yet whether it works; try again in a moment.") }
    switch trigger {
    case .settings: return caps.call || caps.dictation ? .done : .stillMissing(caps.callSetup ?? "Saved, but calls still aren't set up.")
    case .call: return caps.call ? .startCall : .stillMissing(caps.callSetup ?? "Saved, but that voice can't take calls. Pick another one.")
    case .dictation: return caps.dictation ? .startDictation : .stillMissing(caps.setupLine)
    }
  }

  /// One line per voice, plain.
  public static func blurb(_ id: String) -> String {
    switch id {
    case "openai": "Natural, quick replies. Calls and dictation."
    case "gemini": "Google's live voice. Calls and dictation."
    case "deepgram": "Fast speech to text. Dictation."
    case "elevenlabs": "Accurate speech to text. Dictation."
    default: "Voice"
    }
  }

  /// Where to get a key: each provider's own key page.
  public static func keyPage(_ id: String) -> URL? {
    switch id {
    case "openai": URL(string: "https://platform.openai.com/api-keys")
    case "gemini": URL(string: "https://aistudio.google.com/apikey")
    case "deepgram": URL(string: "https://console.deepgram.com")
    case "elevenlabs": URL(string: "https://elevenlabs.io/app/developers/api-keys")
    default: nil
    }
  }

  public static let title = "Talk to Mercury"
  public static let subtitle = "Pick the voice Mercury talks with. Your key stays on your computer."
}

extension MercuryClient {
  /// Whether this Mercury's health lists `voice.providers` (false when it can't be asked).
  public func hasVoiceProviders() async -> Bool {
    ((try? await health())?.features?.contains(Self.voiceProvidersFeature)) == true
  }

  /// The OpenAI key is the OpenAI model provider's (Settings → Models): checked live, then saved
  /// and switched on through the provider routes. Same place Models saves it; nothing new stored.
  /// Throws the provider's reason when it's rejected; 428 goes through the OwnerGate like any change.
  public func setOpenAIVoiceKey(_ apiKey: String, approval: String? = nil) async throws -> VoiceKeySaved {
    if approval == nil {
      let check = try await checkProvider("openai", apiKey: apiKey)
      guard check.ok else { throw MercuryError.server(400, check.error ?? "OpenAI didn't accept that key.") }
    }
    let r = try await saveProvider("openai", apiKey: apiKey, enabled: true, approval: approval)
    if let e = r.error { throw MercuryError.server(400, e) }
    let v = try? await voiceProviders()
    if let caps = v?.capabilities {
      let url = baseURL
      await MainActor.run { NotificationCenter.default.post(name: VoiceCapabilities.changed, object: caps, userInfo: ["baseURL": url]) }
    }
    return VoiceKeySaved(verified: true, message: nil, provider: v?.providers.first { $0.id == "openai" }, capabilities: v?.capabilities)
  }
}

extension OwnerQuestion {
  /// Snapshots and tests outside MercuryCore.
  public static func waiting(code: String, where_: String = "this computer") -> OwnerQuestion {
    OwnerQuestion(id: "preview", code: code, where_: where_, message: "Waiting for the owner.")
  }
}
