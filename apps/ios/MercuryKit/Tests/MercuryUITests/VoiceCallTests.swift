import Testing
import Foundation
import AVFoundation
@testable import MercuryUI
@testable import MercuryCore

struct TakeTests {
  let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!

  func buffer(_ amplitude: Float, seconds: Double = 0.1) -> AVAudioPCMBuffer {
    let n = AVAudioFrameCount(16_000 * seconds)
    let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n)!
    b.frameLength = n
    for i in 0..<Int(n) { b.floatChannelData![0][i] = amplitude * (i % 2 == 0 ? 1 : -1) }
    return b
  }

  func take() throws -> (Take, URL) {
    let url = FileManager.default.temporaryDirectory.appending(path: "take-\(UUID().uuidString).wav")
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    return (Take(file: file, sampleRate: 16_000), url)
  }

  @Test func speechThenQuietEndsTheTake() throws {
    let (t, url) = try take()
    defer { try? FileManager.default.removeItem(at: url) }
    var heard: Bool?
    var spoke = false
    t.done = { heard = $0 }
    t.onSpeech = { spoke = true }
    for _ in 0..<20 { t.add(buffer(0.001)) }   // a quiet room
    #expect(!spoke)
    for _ in 0..<10 { t.add(buffer(0.3)) }     // someone talks
    #expect(spoke && heard == nil)
    for _ in 0..<10 { t.add(buffer(0.001)) }   // a second of calm
    #expect(heard == true)
    t.close()
    #expect(try Data(contentsOf: url).count > 44)
  }

  @Test func stoppingBeforeAnyoneTalksHearsNothing() throws {
    let (t, url) = try take()
    defer { try? FileManager.default.removeItem(at: url) }
    var heard: Bool?
    t.done = { heard = $0 }
    for _ in 0..<5 { t.add(buffer(0.001)) }
    t.finish(true)
    #expect(heard == false)
  }
}

@MainActor
struct VoiceCallTests {
  func call() -> VoiceCallModel {
    let m = ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: ChatThread(id: "s1", title: "Call", createdAt: .now))
    return VoiceCallModel(conversation: m)
  }

  @Test func aFinishedTurnHandsOverTheReply() {
    let c = call()
    var got: ChatMessage??
    c.conversation.onTurnEnd = { got = $0 }
    c.conversation.agent = .thinking
    c.conversation.handle("text_done", #"{"fullText":"It's sunny."}"#)
    #expect(got??.content == "It's sunny.")
  }

  @Test func theStatusFollowsWhatMercuryIsDoing() {
    let c = call()
    c.phase = .working
    #expect(c.status == "Thinking…")
    c.conversation.handle("step_start", #"{"tool":"web_search","step":1}"#)
    #expect(c.status == "Searching the web…")
    c.conversation.handle("permission_request", #"{"id":"p1","prompt":"Run it?","options":["yes","no"]}"#)
    #expect(c.status == "Needs your OK")
    c.phase = .listening; c.muted = true
    #expect(c.status == "Muted")
  }

  @Test func theClockCountsMinutesAndSeconds() {
    let start = Date(timeIntervalSince1970: 0)
    #expect(VoiceCallView.elapsed(from: start, to: start.addingTimeInterval(134)) == "02:14")
    #expect(VoiceCallView.elapsed(from: nil, to: start) == "00:00")
  }
}
