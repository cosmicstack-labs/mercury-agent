import Testing
import Foundation
@testable import MercuryCore

struct VoiceCapabilitiesTests {
  func json(_ s: String) -> Data { Data(s.utf8) }

  @Test func decodesWhatTheMercuryCanDo() throws {
    let c = try VoiceCapabilities.decode(status: 200, data: json(#"{"call":true,"callEngine":"openai","dictation":true,"dictationEngine":"deepgram"}"#))
    #expect(c == VoiceCapabilities(call: true, callEngine: "openai", dictation: true, dictationEngine: "deepgram"))
  }

  @Test func geminiOnlyDictatesWithGemini() throws {
    let c = try VoiceCapabilities.decode(status: 200, data: json(#"{"call":true,"callEngine":"gemini","dictation":true,"dictationEngine":"gemini","dictationEngineName":"Gemini"}"#))
    #expect(c.dictation && c.dictationName == "Gemini")
    #expect(c.callName == "Gemini Live")
    #expect(DictationRoute.decide(caps: c, deviceAvailable: true) == .server(name: "Gemini"))
    #expect(DictationRoute.decide(caps: c, deviceAvailable: false).listeningLabel == "Listening · Gemini")
  }

  @Test func noSpeechKeyUsesThePhone() throws {
    let c = try VoiceCapabilities.decode(status: 200, data: json(#"{"call":false,"dictation":false,"dictationFallback":"device","dictationSetup":"Dictation uses this phone's own speech recognition."}"#))
    #expect(c.dictationFallback == "device")
    #expect(DictationRoute.decide(caps: c, deviceAvailable: true) == .device)
    #expect(DictationRoute.device.listeningLabel == "Listening · On this phone")
    // A Mercury from before dictation: the phone too.
    #expect(DictationRoute.decide(caps: .tooOld, deviceAvailable: true) == .device)
    // Not known yet: Mercury is asked, and a refusal hands over to the phone.
    #expect(DictationRoute.decide(caps: nil, deviceAvailable: false) == .server(name: nil))
    #expect(DictationRoute.afterServerRefused("no key", deviceAvailable: true) == .device)
    #expect(DictationRoute.afterServerRefused("no key", deviceAvailable: false) == .unavailable("no key"))
    // Nothing can listen, or a call has the mic.
    if case .unavailable = DictationRoute.decide(caps: c, deviceAvailable: false) {} else { Issue.record("should be unavailable") }
    #expect(DictationRoute.decide(caps: c, deviceAvailable: true, callRunning: true) == .unavailable(DictationRoute.duringCall))
    #expect(!VoiceCapabilities.defaultDictationSetup.contains("can't"))
  }

  @Test func missingFieldsAndOldMercurys() throws {
    let c = try VoiceCapabilities.decode(status: 200, data: json("{}"))
    #expect(!c.call && !c.dictation)
    #expect(c.setupLine == VoiceCapabilities.defaultDictationSetup)
    let old = try VoiceCapabilities.decode(status: 404, data: Data())
    #expect(!old.dictation)
    #expect(old.setupLine.contains("Update Mercury"))
    #expect(throws: MercuryError.self) { try VoiceCapabilities.decode(status: 401, data: Data()) }
  }
}

struct DictationStartTests {
  @Test func aToken() throws {
    let body = #"{"engine":"openai","token":"ek_1","ephemeral":true,"expiresAt":"2030-01-01T00:05:00.000Z","model":"gpt-live-transcribe","url":"wss://api.openai.com/v1/realtime?intent=transcription"}"#
    guard case .live(let s) = try DictationStart.decode(status: 200, data: Data(body.utf8)) else { Issue.record("not live"); return }
    #expect(s.engine == "openai" && s.token == "ek_1" && s.ephemeral)
    #expect(s.model == "gpt-live-transcribe")
    #expect(s.url == "wss://api.openai.com/v1/realtime?intent=transcription")
    #expect(s.language == nil)
    #expect(s.expiresAt != nil)
    #expect(s.fresh(at: s.expiresAt!.addingTimeInterval(-60)))
    #expect(!s.fresh(at: s.expiresAt!.addingTimeInterval(-5)))
  }

  @Test func noSpeechProviderSaysWhatToAdd() throws {
    let body = #"{"error":"x","fallback":true,"setup":"Live dictation needs a speech provider. Add an OpenAI key in Settings → Models."}"#
    #expect(try DictationStart.decode(status: 409, data: Data(body.utf8)) == .unavailable(setup: "Live dictation needs a speech provider. Add an OpenAI key in Settings → Models."))
    #expect(try DictationStart.decode(status: 409, data: Data("{}".utf8)) == .unavailable(setup: VoiceCapabilities.defaultDictationSetup))
    #expect(throws: MercuryError.self) { try DictationStart.decode(status: 200, data: Data(#"{"engine":"openai"}"#.utf8)) }
  }
}
