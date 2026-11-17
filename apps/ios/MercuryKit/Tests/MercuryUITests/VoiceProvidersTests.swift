import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// Its own canned answer (SettingsTests' `Canned` runs in parallel with this suite).
final class CannedVoice: URLProtocol {
  nonisolated(unsafe) static var status = 200
  nonisolated(unsafe) static var body = Data()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let res = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Self.body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@Suite(.serialized)
struct VoiceProvidersTests {
  let listJSON = #"""
  {"providers":[
    {"id":"openai","name":"OpenAI","env":null,"uses":["calls","dictation","optimus"],"set":true,"source":"provider","hint":"wxyz","canEdit":false,"note":"From your OpenAI model."},
    {"id":"gemini","name":"Google Gemini","env":"GEMINI_API_KEY","uses":["calls","optimus"],"set":true,"source":"store","hint":"1234","canEdit":true},
    {"id":"elevenlabs","name":"ElevenLabs","env":"ELEVENLABS_API_KEY","uses":["dictation","optimus"],"set":true,"source":"env","canEdit":false},
    {"id":"deepgram","name":"Deepgram","env":"DEEPGRAM_API_KEY","uses":["dictation","optimus"],"set":false,"source":null,"canEdit":true},
    {"id":"cartesia","name":"Cartesia","env":"CARTESIA_API_KEY","uses":["optimus"],"set":false,"source":null,"canEdit":true}],
   "capabilities":{"call":true,"callEngine":"gemini","callEngineName":"Gemini Live","dictation":true,"dictationEngine":"elevenlabs","dictationEngineName":"ElevenLabs Scribe"}}
  """#

  func plugin(_ json: String) throws -> PluginDetail {
    try JSONDecoder().decode(PluginDetail.self, from: Data(json.utf8))
  }

  var providers: VoiceProviders { try! MercuryClient.decodeVoiceProviders(status: 200, data: Data(listJSON.utf8))! }

  @Test func decodesTheListAndSaysWhereEachKeyIs() throws {
    let v = providers
    #expect(v.providers.map(\.status) == ["From your OpenAI model", "Set · ••••1234", "Set on the computer", "Not set", "Not set"])
    #expect(v.providers.map(\.usedFor) == ["Calls · Dictation", "Calls", "Dictation", "Dictation", "Computer voice (Optimus)"])
    #expect(v.providers.filter(\.forPhone).count == 4)
    #expect(v.capabilities.callName == "Gemini Live")
    #expect(v.capabilities.dictationName == "ElevenLabs Scribe")
    #expect(try MercuryClient.decodeVoiceProviders(status: 404, data: Data()) == nil)
  }

  @Test func olderCapabilitiesStillName() {
    let c = VoiceCapabilities(call: true, callEngine: "openai", dictation: false)
    #expect(c.callName == "OpenAI")
    #expect(c.dictationName == nil)
  }

  // Settings → Voice is never blank.

  @Test func noOptimusCatalogEntryIsNotInstalled() throws {
    // What GET /api/plugins/optimus answers when Optimus is only in the catalog: this used to
    // render an empty form.
    let catalogOnly = try plugin(#"{"id":"optimus","name":"Optimus","enabled":false,"running":false}"#)
    #expect(!VoiceScreen.optimusInstalled(catalogOnly))
    #expect(VoiceScreen.content(loaded: true, providers: nil, providersError: nil, plugin: catalogOnly, pluginError: nil) == .loaded(providers: false, optimus: .notInstalled))
    #expect(VoiceScreen.content(loaded: true, providers: providers, providersError: nil, plugin: catalogOnly, pluginError: nil) == .loaded(providers: true, optimus: .notInstalled))
    #expect(VoiceScreen.content(loaded: true, providers: providers, providersError: nil, plugin: nil, pluginError: nil) == .loaded(providers: true, optimus: .notInstalled))
  }

  @Test func optimusInstalledShowsItsSettings() throws {
    let installed = try plugin(#"{"id":"optimus","name":"Optimus","enabled":true,"running":true,"installedVersion":"1.2.0","settings":[{"key":"voiceEngine","type":"enum","options":["openai","gemini"],"value":"openai"}]}"#)
    #expect(VoiceScreen.optimusInstalled(installed))
    #expect(VoiceScreen.content(loaded: true, providers: providers, providersError: nil, plugin: installed, pluginError: nil) == .loaded(providers: true, optimus: .settings))
    #expect(VoiceScreen.content(loaded: true, providers: nil, providersError: nil, plugin: installed, pluginError: nil) == .loaded(providers: false, optimus: .settings))
  }

  @Test func loadErrorsShowWithRetry() {
    #expect(VoiceScreen.content(loaded: false, providers: nil, providersError: nil, plugin: nil, pluginError: nil) == .loading)
    #expect(VoiceScreen.content(loaded: true, providers: nil, providersError: "Couldn't reach that Mercury.", plugin: nil, pluginError: "Couldn't reach that Mercury.") == .failed("Couldn't reach that Mercury."))
    #expect(VoiceScreen.content(loaded: true, providers: nil, providersError: nil, plugin: nil, pluginError: "boom") == .failed("boom"))
    // The providers still show when only Optimus failed.
    #expect(VoiceScreen.content(loaded: true, providers: providers, providersError: nil, plugin: nil, pluginError: "boom") == .loaded(providers: true, optimus: .failed("boom")))
  }

  // Saving a key.

  func client(_ status: Int, _ body: String) -> MercuryClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CannedVoice.self]
    CannedVoice.status = status
    CannedVoice.body = Data(body.utf8)
    return MercuryClient(baseURL: URL(string: "http://mercury.test")!, token: "t", session: URLSession(configuration: config))
  }

  @Test func savingAKeyReturnsTheNewCapabilities() async throws {
    let c = client(200, #"{"ok":true,"verified":true,"message":"Connected.","provider":{"id":"gemini","name":"Google Gemini","env":"GEMINI_API_KEY","uses":["calls"],"set":true,"source":"store","hint":"1234","canEdit":true},"capabilities":{"call":true,"callEngine":"gemini","callEngineName":"Gemini Live","dictation":false}}"#)
    let saved = try await c.setVoiceKey("gemini", apiKey: "AIza-test-key-000001234")
    #expect(saved.verified)
    #expect(saved.provider?.status == "Set · ••••1234")
    #expect(saved.capabilities?.callName == "Gemini Live")
  }

  @Test func aRejectedKeySaysWhy() async throws {
    let c = client(400, #"{"ok":false,"verified":true,"error":"Gemini rejected this key. Copy it again from Google AI Studio."}"#)
    do {
      try await c.setVoiceKey("gemini", apiKey: "AIza-bad")
      Issue.record("expected an error")
    } catch {
      #expect(error.localizedDescription.contains("rejected"))
    }
  }

  @Test func fromThePhoneTheOwnerApproves() async throws {
    let c = client(428, #"{"error":"Waiting for the owner to approve: Set the Google Gemini voice key.","approvalRequired":true,"approvalId":"ap9","code":"QX7K2","where":"this computer"}"#)
    do {
      try await c.setVoiceKey("gemini", apiKey: "AIza-test-key-000001234")
      Issue.record("expected the owner's question")
    } catch MercuryError.needsOwner(let q) {
      #expect(q.id == "ap9")
      #expect(q.code == "QX7K2")
    }
  }

  @MainActor @Test func theMicReChecksWhenAKeyIsSaved() async {
    let d = DictationModel()
    d.capabilities = VoiceCapabilities(call: false, dictation: false, dictationSetup: "Add a key.")
    NotificationCenter.default.post(name: VoiceCapabilities.changed, object: VoiceCapabilities(call: true, dictation: true, dictationEngine: "deepgram"),
                                    // An address of its own, so other suites' conversations ignore it.
                                    userInfo: ["baseURL": URL(string: "http://mic-recheck.test")!])
    #expect(d.capabilities?.dictation == true)
  }
}
