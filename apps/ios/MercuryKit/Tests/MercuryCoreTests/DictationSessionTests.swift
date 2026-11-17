import Testing
import Foundation
@testable import MercuryCore

struct VoiceCapabilitiesTests {
  func json(_ s: String) -> Data { Data(s.utf8) }

  @Test func decodesWhatTheMercuryCanDo() throws {
    let c = try VoiceCapabilities.decode(status: 200, data: json(#"{"call":true,"callEngine":"openai","dictation":true,"dictationEngine":"deepgram"}"#))
    #expect(c == VoiceCapabilities(call: true, callEngine: "openai", dictation: true, dictationEngine: "deepgram"))
  }

  @Test func geminiOnlyHasNoDictationAndSaysWhatToAdd() throws {
    let c = try VoiceCapabilities.decode(status: 200, data: json(#"{"call":true,"callEngine":"gemini","dictation":false,"dictationSetup":"Live dictation needs a speech provider. Add an OpenAI key in Settings → Models, or a Deepgram or ElevenLabs key in Settings → Voice. Gemini can't do it: it only transcribes while it's also replying."}"#))
    #expect(c.call && !c.dictation)
    #expect(c.setupLine.hasPrefix("Live dictation needs a speech provider."))
    #expect(c.setupLine.contains("Settings → Voice"))
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
