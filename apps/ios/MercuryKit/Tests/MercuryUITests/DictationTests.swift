import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore
import MercuryVoice

struct DictationTextTests {
  @Test func partialsThenFinalsGoAfterWhatWasTyped() {
    var t = DictationText(draft: "Note:")
    var box = t.partial("remind me", draft: "Note:")
    #expect(box == "Note: remind me")
    box = t.partial("Remind me to call", draft: box)
    #expect(box == "Note: Remind me to call")
    box = t.final("Remind me to call the plumber.", draft: box)
    #expect(box == "Note: Remind me to call the plumber.")
    box = t.partial("And book", draft: box)
    #expect(box == "Note: Remind me to call the plumber. And book")
    box = t.final("And book a table.", draft: box)
    #expect(box == "Note: Remind me to call the plumber. And book a table.")
    // An empty partial (the engine cleared it) leaves the finals.
    #expect(t.partial("", draft: box) == box)
  }

  @Test func anEmptyBoxAndSpacing() {
    var t = DictationText(draft: "")
    #expect(t.partial("hello", draft: "") == "hello")
    var n = DictationText(draft: "List:\n")
    #expect(n.final("milk", draft: "List:\n") == "List:\nmilk")
    var p = DictationText(draft: "Hi ")
    #expect(p.partial("there", draft: "Hi ") == "Hi there")
    #expect(DictationText.join("call me", ", please") == "call me, please")
    #expect(DictationText.join("call me", "later") == "call me later")
  }

  @Test func theOwnersEditsWin() {
    var t = DictationText(draft: "")
    var box = t.final("Book a table.", draft: "")
    box = t.partial("for four", draft: box)
    #expect(box == "Book a table. for four")
    // They fix a word while talking; the live words carry on after their text.
    let edited = "Book a table at Roma. for four"
    box = t.partial("for four people", draft: edited)
    #expect(box == "Book a table at Roma. for four people")
    // They clear the box: dictation starts again from empty.
    box = t.final("Thanks.", draft: "")
    #expect(box == "Thanks.")
  }
}

@MainActor
struct DictationModelTests {
  func conversation(_ caps: VoiceCapabilities?) -> ConversationModel {
    // Its own address: other suites' saved keys (VoiceCapabilities.changed) are for theirs. Nothing listens on port 9.
    let c = ConversationModel(client: MercuryClient(baseURL: URL(string: "http://127.0.0.1:9")!), thread: nil)
    c.dictation.capabilities = caps
    return c
  }

  @Test func neverGreyedOutForWantOfAKey() async throws {
    let on = conversation(VoiceCapabilities(call: true, dictation: true, dictationEngine: "gemini", dictationEngineName: "Gemini"))
    on.dictation.deviceSpeech = { false }
    #expect(on.dictation.available)
    #expect(on.dictation.route == .server(name: "Gemini"))
    #expect(on.dictation.unavailableReason == nil)

    // No speech key on the Mercury: the phone's own recogniser listens.
    let none = conversation(VoiceCapabilities(call: false, dictation: false, dictationFallback: "device"))
    none.dictation.deviceSpeech = { true }
    #expect(none.dictation.available)
    #expect(none.dictation.route == .device)

    // Not known yet: usable (Mercury is asked on the tap).
    let unknown = conversation(nil)
    unknown.dictation.deviceSpeech = { false }
    #expect(unknown.dictation.available)

    // Nothing can listen (no key, and the phone's recogniser off or refused): greyed out, and says why.
    let off = conversation(VoiceCapabilities(call: true, callEngine: "gemini", dictation: false))
    off.dictation.deviceSpeech = { false }
    #expect(!off.dictation.available)
    #expect(off.dictation.unavailableReason == DictationRoute.noSpeech)
    off.dictation.tap()
    #expect(off.dictation.phase == .idle)
    // It asks the Mercury whether it can set up voice first (no Mercury here: it can't, so the line shows).
    for _ in 0..<100 where off.dictation.notice == nil { try await Task.sleep(for: .milliseconds(50)) }
    #expect(off.voiceSetup == nil)
    #expect(off.dictation.notice == DictationRoute.noSpeech)
    #expect(off.dictation.haptics.played == [.failed])
  }

  @Test func saysWhoIsListening() {
    let c = conversation(VoiceCapabilities(call: true, dictation: true, dictationEngine: "gemini"))
    #expect(c.dictation.listeningLabel == "Listening…")
    c.dictation.show(.listening, listening: .server(name: "Gemini"))
    #expect(c.dictation.listeningLabel == "Listening · Gemini")
    c.dictation.show(.listening, listening: .device)
    #expect(c.dictation.listeningLabel == "Listening · On this phone")
    c.dictation.cancel()
    #expect(c.dictation.listening == nil)
  }

  @Test func offDuringACall() {
    let c = conversation(VoiceCapabilities(call: true, dictation: true))
    c.dictation.deviceSpeech = { true }
    c.callId = "call-1"
    #expect(!c.dictation.available)
    #expect(c.dictation.unavailableReason == "Dictation is off during a voice call.")
  }

  @Test func eventsStreamIntoTheBoxAfterTypedText() {
    let c = conversation(VoiceCapabilities(call: true, dictation: true))
    c.draft = "Todo:"
    let d = c.dictation
    d.show(.starting)
    let g = d.currentGeneration
    d.handle(.connected, g)
    #expect(d.phase == .listening)
    d.handle(.partial(text: "call the"), g)
    #expect(c.draft == "Todo: call the")
    d.handle(.partial(text: "call the plumber"), g)
    d.handle(.final(text: "Call the plumber."), g)
    #expect(c.draft == "Todo: Call the plumber.")
    // A stale event from an earlier dictation is ignored.
    d.handle(.partial(text: "old"), g - 1)
    #expect(c.draft == "Todo: Call the plumber.")
    d.handle(.closed(reason: "stopped"), g)
    #expect(d.phase == .idle)
    #expect(d.notice == nil)
    #expect(c.draft == "Todo: Call the plumber.")
  }

  @Test func aDroppedStreamSaysWhy() {
    let c = conversation(VoiceCapabilities(call: true, dictation: true))
    let d = c.dictation
    d.show(.listening)
    d.handle(.closed(reason: "OpenAI disconnected"), d.currentGeneration)
    #expect(d.phase == .idle)
    #expect(d.notice == "Dictation stopped: OpenAI disconnected.")
  }

  @Test func sendingEndsDictation() async {
    let c = conversation(VoiceCapabilities(call: true, dictation: true))
    c.dictation.show(.listening, draft: "Hello")
    c.dictation.cancel()
    #expect(c.dictation.phase == .idle)
    #expect(c.draft == "Hello")
  }
}
