import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// /api/health with or without `voice.providers`.
final class CannedHealth: URLProtocol {
  nonisolated(unsafe) static var features: [String] = []
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let body = try! JSONSerialization.data(withJSONObject: ["ok": true, "features": Self.features])
    let res = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

/// "Set up voice": when it shows, what's on it, and what happens after a key is saved.
@MainActor
struct VoiceSetupTests {
  nonisolated static func p(_ id: String, _ uses: [String], set: Bool = false, source: String? = nil, canEdit: Bool = true, hint: String? = nil) -> VoiceProvider {
    VoiceProvider(id: id, name: id.capitalized, uses: uses, set: set, source: source, hint: hint, canEdit: canEdit)
  }

  nonisolated static func list(openai: VoiceProvider = p("openai", ["calls", "dictation", "optimus"], canEdit: false),
                   gemini: VoiceProvider = p("gemini", ["calls", "optimus"])) -> [VoiceProvider] {
    [openai, gemini, p("elevenlabs", ["dictation", "optimus"]), p("deepgram", ["dictation", "optimus"]), p("cartesia", ["optimus"])]
  }

  let none = VoiceCapabilities(call: false, dictation: false)
  let callOnly = VoiceCapabilities(call: true, callEngine: "gemini", dictation: false)
  let both = VoiceCapabilities(call: true, callEngine: "openai", dictation: true, dictationEngine: "openai")

  // MARK: Which screen

  @Test func aWorkingFeatureJustStarts() {
    #expect(VoiceSetup.decide(.call, supported: true, caps: both) == .proceed)
    #expect(VoiceSetup.decide(.dictation, supported: true, caps: both) == .proceed)
    // Even on an old Mercury.
    #expect(VoiceSetup.decide(.call, supported: false, caps: callOnly) == .proceed)
  }

  @Test func anOldMercuryKeepsTodaysBehaviour() {
    #expect(VoiceSetup.decide(.call, supported: false, caps: none) == .legacy)
    #expect(VoiceSetup.decide(.dictation, supported: false, caps: none) == .legacy)
    #expect(VoiceSetup.decide(.call, supported: false, caps: .tooOld) == .legacy)
  }

  @Test func unknownCapabilitiesLetTheCallTry() {
    #expect(VoiceSetup.decide(.call, supported: true, caps: nil) == .legacy)
  }

  @Test func nothingSetShowsSetup() {
    #expect(VoiceSetup.decide(.call, supported: true, caps: none) == .setup)
    #expect(VoiceSetup.decide(.dictation, supported: true, caps: none) == .setup)
    // An older Mercury where Gemini only takes calls: the mic asks to set up.
    #expect(VoiceSetup.decide(.dictation, supported: true, caps: callOnly) == .setup)
  }

  // MARK: What's on it

  @Test func callsListOpenAIThenGeminiOnly() {
    let plan = VoiceSetup.plan(.call, providers: Self.list())
    #expect(plan.choices.map(\.id) == ["openai", "gemini"])
    #expect(plan.more.isEmpty)
    #expect(plan.choices.allSatisfy { $0.state == .add })
    #expect(plan.ready == nil)
  }

  @Test func theMicListsOpenAIThenDictationOnlyUnderMore() {
    let plan = VoiceSetup.plan(.dictation, providers: Self.list())
    #expect(plan.choices.map(\.id) == ["openai"])
    #expect(plan.more.map(\.id) == ["deepgram", "elevenlabs"])
  }

  @Test func settingsListsCallVoicesThenDictationOnly() {
    let plan = VoiceSetup.plan(.settings, providers: Self.list())
    #expect(plan.choices.map(\.id) == ["openai", "gemini"])
    #expect(plan.more.map(\.id) == ["deepgram", "elevenlabs"])
  }

  @Test func openAIFromTheModelIsReadyWithNoSteps() {
    let openai = Self.p("openai", ["calls", "dictation", "optimus"], set: true, source: "provider", canEdit: false, hint: "wxyz")
    let plan = VoiceSetup.plan(.call, providers: Self.list(openai: openai))
    #expect(plan.ready?.id == "openai")
    #expect(plan.ready?.line == "Ready · uses your OpenAI key")
    let mic = VoiceSetup.plan(.dictation, providers: Self.list(openai: openai))
    #expect(mic.ready?.id == "openai")
  }

  @Test func aKeySetOnTheComputerIsReadyOrLocked() {
    // Set in .env and it serves the trigger: ready.
    let geminiEnv = Self.p("gemini", ["calls", "optimus"], set: true, source: "env", canEdit: false)
    let plan = VoiceSetup.plan(.call, providers: Self.list(gemini: geminiEnv))
    #expect(plan.choices.first { $0.id == "gemini" }?.state == .ready)
    #expect(plan.ready?.line == "Ready · set on your computer")
    // Can't be edited and isn't set: locked (explains, offers another voice).
    let locked = Self.p("gemini", ["calls", "optimus"], set: false, canEdit: false)
    #expect(VoiceSetup.plan(.call, providers: Self.list(gemini: locked)).choices.first { $0.id == "gemini" }?.state == .locked)
    // OpenAI is never editable here but can always be added (through the model provider).
    #expect(VoiceSetup.plan(.call, providers: Self.list()).choices.first?.state == .add)
  }

  @Test func settingsOffersSetupOnlyWhenNoPhoneVoiceIsSet() {
    #expect(VoiceSetup.settingsOffersSetup(VoiceProviders(providers: Self.list(), capabilities: none)))
    let deepgram = Self.list().map { $0.id == "deepgram" ? Self.p("deepgram", ["dictation"], set: true, source: "store") : $0 }
    #expect(!VoiceSetup.settingsOffersSetup(VoiceProviders(providers: deepgram, capabilities: none)))
  }

  @Test func keyPagesAreTheProvidersOwn() {
    #expect(VoiceSetup.keyPage("openai")?.absoluteString == "https://platform.openai.com/api-keys")
    #expect(VoiceSetup.keyPage("gemini")?.absoluteString == "https://aistudio.google.com/apikey")
    #expect(VoiceSetup.keyPage("deepgram")?.absoluteString == "https://console.deepgram.com")
    #expect(VoiceSetup.keyPage("elevenlabs")?.absoluteString == "https://elevenlabs.io/app/developers/api-keys")
  }

  // MARK: After saving

  @Test func afterSavingItCarriesOnWithWhatWasAsked() {
    #expect(VoiceSetup.next(after: .call, caps: callOnly) == .startCall)
    #expect(VoiceSetup.next(after: .dictation, caps: both) == .startDictation)
    #expect(VoiceSetup.next(after: .settings, caps: callOnly) == .done)
    if case .stillMissing = VoiceSetup.next(after: .dictation, caps: callOnly) {} else { Issue.record("calls only: dictation still missing") }
    if case .stillMissing = VoiceSetup.next(after: .call, caps: nil) {} else { Issue.record("unknown caps") }
  }

  @Test func readyContinuesOnItsOwnAfterAMoment() async throws {
    let m = VoiceSetupModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), trigger: .call)
    var got: [VoiceSetup.Next] = []
    m.onContinue = { got.append($0) }
    m.finished(.startCall, name: "Gemini")
    #expect(m.stage == .ready(name: "Gemini", next: .startCall))
    #expect(got.isEmpty)
    try await Task.sleep(for: .milliseconds(1100))
    #expect(got == [.startCall])
  }

  @Test func closingTheSheetStopsTheContinuation() async throws {
    let m = VoiceSetupModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), trigger: .dictation)
    var got: [VoiceSetup.Next] = []
    m.onContinue = { got.append($0) }
    m.finished(.startDictation, name: "Deepgram")
    m.cancel()
    try await Task.sleep(for: .milliseconds(1100))
    #expect(got.isEmpty)
  }

  @Test func fromSettingsReadyWaitsForDone() async throws {
    let m = VoiceSetupModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), trigger: .settings)
    var got: [VoiceSetup.Next] = []
    m.onContinue = { got.append($0) }
    m.finished(.done, name: "Gemini")
    try await Task.sleep(for: .milliseconds(1000))
    #expect(got.isEmpty)
    m.finished(.stillMissing("Nope"), name: "Gemini")
    #expect(m.stage == .missing("Nope"))
  }

  @Test func pickingARowGoesToTheRightStep() {
    let m = VoiceSetupModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), trigger: .call)
    var got: [VoiceSetup.Next] = []
    m.onContinue = { got.append($0) }
    let gemini = Self.p("gemini", ["calls"])
    m.pick(VoiceSetup.Choice(provider: gemini, state: .add))
    #expect(m.stage == .key(gemini))
    let env = Self.p("gemini", ["calls"], canEdit: false)
    m.pick(VoiceSetup.Choice(provider: env, state: .locked))
    if case .locked = m.stage {} else { Issue.record("locked") }
    m.pick(VoiceSetup.Choice(provider: Self.p("openai", ["calls"], set: true, source: "provider"), state: .ready))
    #expect(got == [.startCall])
  }

  // MARK: The mic's gate

  func micConversation(features: [String]) -> ConversationModel {
    CannedHealth.features = features
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CannedHealth.self]
    // Its own address: other suites post VoiceCapabilities.changed for mercury.test.
    let client = MercuryClient(baseURL: URL(string: "http://voice-setup.test")!, token: "t", session: URLSession(configuration: config))
    let c = ConversationModel(client: client, thread: nil)
    c.dictation.capabilities = none
    // The phone's own recogniser can't listen either, so the mic is gated (with it, the phone listens).
    c.dictation.deviceSpeech = { false }
    return c
  }

  @Test(.serialized, arguments: [true, false])
  func theMicOpensSetupOnlyOnAMercuryThatHasIt(_ has: Bool) async throws {
    let c = micConversation(features: has ? ["voice.providers"] : [])
    c.dictation.tap()
    for _ in 0..<100 where c.voiceSetup == nil && c.dictation.notice == nil { try await Task.sleep(for: .milliseconds(20)) }
    if has {
      #expect(c.voiceSetup == .dictation)
      #expect(c.dictation.notice == nil)
      #expect(c.dictation.haptics.played.isEmpty)
    } else {
      #expect(c.voiceSetup == nil)
      #expect(c.dictation.notice == DictationRoute.noSpeech)
      #expect(c.dictation.haptics.played == [.failed])
    }
  }
}
