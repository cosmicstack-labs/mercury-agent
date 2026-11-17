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


// MARK: - Live calls: fakes

/// The voice engine, recording what the call asked of it.
final class FakeLink: VoiceLink, @unchecked Sendable {
  var instructions: [String] = []
  var results: [(id: String, output: String)] = []
  var interrupts = 0
  var stopped = false
  var muted: Bool?
  func pushAudio(pcm16: Data) {}
  func setMuted(muted: Bool) { self.muted = muted }
  func interrupt() { interrupts += 1 }
  func stop() { stopped = true }
  func toolResult(id: String, output: String) { results.append((id, output)) }
  func say(text: String) {}
  func instruct(text: String) { instructions.append(text) }
}

final class FakePlayback: CallPlayback {
  var isPlaying = false
  var flushes = 0
  func flush() { flushes += 1; isPlaying = false }
}

@MainActor
final class FakeChat: CallChat {
  var activity: String?
  var working = false
  var approvals: [CallApproval] = []
  var asked: [String] = []
  var answered: [(id: String, approved: Bool)] = []
  var stops = 0
  private var waiting: [String: CheckedContinuation<CallAnswer, Never>] = [:]

  func ask(_ question: String) async -> CallAnswer {
    asked.append(question)
    working = true
    return await withCheckedContinuation { waiting[question] = $0 }
  }
  func reply(_ question: String, _ a: CallAnswer) {
    working = false
    waiting.removeValue(forKey: question)?.resume(returning: a)
  }
  func answer(_ approval: CallApproval, approved: Bool) async throws {
    answered.append((approval.id, approved))
    approvals.removeAll { $0.id == approval.id }
  }
  func stopWork() async { stops += 1 }
}

final class Clock: @unchecked Sendable {
  var now = Date(timeIntervalSince1970: 1_000_000)
  func advance(_ s: TimeInterval) { now += s }
}

/// Waits (briefly) for work the call started in a Task.
@MainActor
func eventually(_ cond: () -> Bool) async {
  for _ in 0..<400 where !cond() { try? await Task.sleep(for: .milliseconds(5)) }
}

@MainActor
struct CallSetup {
  let link = FakeLink()
  let chat = FakeChat()
  let playback = FakePlayback()
  let clock = Clock()
  var haptics: [CallHaptic] { recorder.played }
  let recorder = HapticRecorder()
  let brain: CallBrain

  init() {
    let r = recorder, c = clock
    brain = CallBrain(link: link, chat: chat, playback: playback, haptic: { r.played.append($0) }, now: { c.now })
    brain.handle(.connected)
  }
}

@MainActor
final class HapticRecorder { var played: [CallHaptic] = [] }

// MARK: - The call brain

@MainActor @Suite
struct CallBrainTests {
  @Test func helloIsSentBeforeTheSessionOpens() {
    let s = CallSetup()
    s.brain.begin()
    #expect(s.link.instructions.first?.contains("Say a very short hello") == true)
    #expect(s.brain.responding)
    #expect(s.haptics == [.connected])
  }

  @Test func askMercuryGoesToTheChatAndTheSpokenPartComesBack() async {
    let s = CallSetup()
    s.brain.handle(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"What's the weather in Srinagar?"}"#))
    await eventually { !s.chat.asked.isEmpty }
    #expect(s.chat.asked == ["What's the weather in Srinagar?"])
    #expect(s.brain.asks["c1"] != nil)
    s.chat.reply("What's the weather in Srinagar?", .reply("**Sunny**, 24 degrees.\nFor the chat:\n- https://weather.example/srinagar"))
    await eventually { !s.link.results.isEmpty }
    #expect(s.link.results.first?.id == "c1")
    let out = s.link.results.first?.output ?? ""
    #expect(out.hasPrefix("Sunny, 24 degrees."))
    #expect(!out.contains("https://"))
    #expect(out.contains("in the user's Mercury chat"))
    #expect(s.brain.asks.isEmpty)
  }

  @Test func anAnswerWaitsWhileTheVoiceIsTalking() async {
    let s = CallSetup()
    s.brain.handle(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"Q"}"#))
    await eventually { !s.chat.asked.isEmpty }
    s.brain.handle(.responseStarted)
    s.chat.reply("Q", .reply("Done it."))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(s.link.results.isEmpty)
    s.brain.handle(.responseDone)
    #expect(s.link.results.map(\.output) == ["Done it."])
  }

  @Test func failedStepsAreNeverHidden() {
    let out = CallBrain.toolOutput(.reply("Sent the email.", failedSteps: ["Send email"]))
    #expect(out.contains("1 step(s) failed"))
    #expect(out.contains("Send email"))
    #expect(CallBrain.toolOutput(.reply("")) == "Done.")
    #expect(CallBrain.toolOutput(.timedOut).contains("didn't answer in time"))
  }

  @Test func whileMercuryWorksTheVoiceGetsUpdates() async {
    let s = CallSetup()
    s.chat.activity = "Searching the web"
    s.brain.handle(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"News?"}"#))
    await eventually { !s.chat.asked.isEmpty }
    s.clock.advance(5); s.brain.tick()
    #expect(s.link.instructions.isEmpty)
    s.clock.advance(4); s.brain.tick()
    #expect(s.link.instructions.last?.contains("Mercury is still searching the web") == true)
    s.brain.handle(.responseDone)
    // The next one waits 14 s, not 8.
    s.clock.advance(9); s.brain.tick()
    #expect(s.link.instructions.count == 1)
    s.clock.advance(6); s.brain.tick()
    #expect(s.link.instructions.count == 2)
    #expect(s.link.instructions.last?.contains("seconds Mercury is still searching the web") == true)
  }

  @Test func anApprovalIsAskedOutLoudAndOnlyTheOwnersYesCounts() async {
    let s = CallSetup()
    s.chat.approvals = [CallApproval(id: "p1", text: "Run command: npm run deploy\nDetails…", targetId: nil)]
    s.brain.tick()
    #expect(s.brain.awaiting?.approval.id == "p1")
    #expect(s.link.instructions.last?.contains("Mercury wants to: Run command: npm run deploy.") == true)
    #expect(s.haptics.contains(.approvalAsked))
    s.brain.handle(.responseDone)
    s.clock.advance(1)
    s.brain.handle(.userText(text: "Yes, go ahead."))
    s.brain.handle(.toolCall(id: "a1", name: "answer_approval", argsJson: #"{"approved":true}"#))
    await eventually { !s.link.results.isEmpty }
    #expect(s.chat.answered.count == 1 && s.chat.answered[0].approved)
    #expect(s.link.results.last?.output.hasPrefix("Approved.") == true)
    #expect(s.haptics.contains(.approvalAnswered(approved: true)))
    #expect(s.brain.awaiting == nil)
  }

  @Test func theVoicesOwnYesIsNotEnough() async {
    let s = CallSetup()
    s.chat.approvals = [CallApproval(id: "p1", text: "Delete the file", targetId: nil)]
    s.brain.tick()
    s.brain.handle(.responseDone)
    s.brain.handle(.toolCall(id: "a1", name: "answer_approval", argsJson: #"{"approved":true}"#))
    s.clock.advance(4)
    s.brain.tick()
    #expect(s.chat.answered.isEmpty)
    #expect(s.link.results.last?.output.hasPrefix("Not approved") == true)
  }

  @Test func aNoIsSentAsNo() async {
    let s = CallSetup()
    s.chat.approvals = [CallApproval(id: "p1", text: "Send it", targetId: nil)]
    s.brain.tick()
    s.brain.handle(.responseDone)
    s.brain.handle(.userText(text: "No, don't."))
    s.brain.handle(.toolCall(id: "a1", name: "answer_approval", argsJson: #"{"approved":false}"#))
    await eventually { !s.chat.answered.isEmpty }
    #expect(s.chat.answered[0].approved == false)
    await eventually { !s.link.results.isEmpty }
    #expect(s.link.results.last?.output.hasPrefix("Declined.") == true)
  }

  @Test func answeringNothingSaysSo() {
    let s = CallSetup()
    s.brain.handle(.toolCall(id: "a1", name: "answer_approval", argsJson: #"{"approved":true}"#))
    #expect(s.link.results.last?.output == "No approval is waiting right now.")
  }

  @Test func anApprovalAnsweredOnScreenIsToldToTheVoice() async {
    let s = CallSetup()
    s.chat.approvals = [CallApproval(id: "p1", text: "Send it", targetId: nil)]
    s.brain.tick()
    s.brain.handle(.responseDone)
    s.brain.answerOnScreen(s.chat.approvals[0], approved: true)
    await eventually { !s.chat.answered.isEmpty }
    #expect(s.chat.answered[0].approved)
    s.brain.tick()
    #expect(s.link.instructions.last?.contains("approved it on their screen") == true)
  }

  @Test func goodbyeEndsTheCallOnceTheVoiceIsQuiet() async {
    let s = CallSetup()
    var ended: CallBrain.End?
    s.brain.onEnd = { ended = $0 }
    s.playback.isPlaying = true
    s.brain.handle(.toolCall(id: "e1", name: "end_conversation", argsJson: "{}"))
    try? await Task.sleep(for: .milliseconds(150))
    #expect(ended == nil)
    s.playback.isPlaying = false
    await eventually { ended != nil }
    #expect(ended == .goodbye)
    #expect(s.link.stopped)
  }

  @Test func talkingOverMercuryStopsItsVoice() {
    let s = CallSetup()
    s.playback.isPlaying = true
    s.brain.playbackChanged(true)
    #expect(s.haptics.last == .mercurySpeaks)
    s.brain.handle(.speechStarted)
    #expect(s.playback.flushes == 1)
    #expect(s.link.interrupts == 1)
    #expect(s.brain.ownerSpeaking)
    #expect(s.haptics.last == .bargeIn)
  }

  @Test func speakingWhileMercuryIsQuietCutsNothing() {
    let s = CallSetup()
    s.brain.handle(.speechStarted)
    #expect(s.link.interrupts == 0)
    #expect(!s.haptics.contains(.bargeIn))
  }

  @Test func tappingTheOrbInterrupts() {
    let s = CallSetup()
    #expect(!s.brain.interrupt())
    s.playback.isPlaying = true
    #expect(s.brain.interrupt())
    #expect(s.link.interrupts == 1 && s.playback.flushes == 1)
  }

  @Test func sayingStopHaltsMercury() async {
    let s = CallSetup()
    s.brain.handle(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"Book it"}"#))
    await eventually { !s.chat.asked.isEmpty }
    s.brain.handle(.userText(text: "Stop!"))
    await eventually { s.chat.stops == 1 }
    #expect(s.link.instructions.last?.contains("Say only: 'Stopped.'") == true)
    s.chat.reply("Book it", .reply("Booked."))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(s.link.results.isEmpty) // the stopped question's answer is dropped
  }

  @Test func sayingMuteMutes() {
    let s = CallSetup()
    var synced: Bool?
    s.brain.onMuted = { synced = $0 }
    s.brain.handle(.userText(text: "Mute yourself"))
    #expect(s.brain.muted && s.link.muted == true && synced == true)
    #expect(s.haptics.last == .muteToggled)
  }

  @Test func silenceEndsTheCall() {
    let s = CallSetup()
    var ended: CallBrain.End?
    s.brain.onEnd = { ended = $0 }
    s.clock.advance(59); s.brain.tick()
    #expect(ended == nil)
    s.clock.advance(2); s.brain.tick()
    #expect(ended == .idle)
  }

  @Test func aDroppedSessionSaysWhy() {
    let s = CallSetup()
    var ended: CallBrain.End?
    s.brain.onEnd = { ended = $0 }
    s.brain.handle(.closed(reason: "the voice model disconnected"))
    #expect(ended == .dropped("the voice model disconnected"))
    s.brain.handle(.closed(reason: "again"))
    #expect(ended == .dropped("the voice model disconnected"))
  }

  @Test func captionsFollowWhatWasSaid() {
    let s = CallSetup()
    s.brain.handle(.userText(text: " What's on my calendar? "))
    s.brain.handle(.assistantText(text: "Two meetings after lunch."))
    #expect(s.brain.ownerLine == "What's on my calendar?")
    #expect(s.brain.mercuryLine == "Two meetings after lunch.")
    #expect(s.brain.transcript.map(\.role) == ["owner", "mercury"])
  }

  @Test func words() {
    #expect(CallBrain.isMute("Mute"))
    #expect(CallBrain.isMute("go on mute"))
    #expect(!CallBrain.isMute("unmute"))
    #expect(CallBrain.isStop("Cancel that"))
    #expect(CallBrain.isStop("ruko"))
    #expect(!CallBrain.isStop("stop listening"))
    #expect(!CallBrain.isStop("can you stop the deploy that is running on staging"))
    let t = Date()
    #expect(CallBrain.spokenVerdict([(t, "Yeah, do it")], since: t) == true)
    #expect(CallBrain.spokenVerdict([(t, "No, don't")], since: t) == false)
    #expect(CallBrain.spokenVerdict([(t.addingTimeInterval(-5), "yes")], since: t) == nil)
    #expect(CallBrain.doing("Searching the web…") == "searching the web")
    #expect(CallBrain.doing(nil) == "working on it")
  }
}

// MARK: - The chat side, through the app's chat API

/// Answers /api/chat/send, /api/chat/permission and /api/mobile/voice/session, and keeps what was asked.
final class CallServer: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var requests: [(path: String, body: [String: Any])] = []
  nonisolated(unsafe) static var sessionStatus = 200
  nonisolated(unsafe) static var sessionBody = Data()
  static let lock = NSLock()

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var body: [String: Any] = [:]
    if let s = request.httpBodyStream {
      s.open(); var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
      while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
      s.close()
      body = (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    } else if let d = request.httpBody {
      body = (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    }
    let path = request.url!.path
    Self.lock.lock(); Self.requests.append((path, body)); Self.lock.unlock()
    let (status, data): (Int, Data) = path == "/api/mobile/voice/session" ? (Self.sessionStatus, Self.sessionBody) : (200, Data(#"{"sent":true}"#.utf8))
    let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}

  static func client() -> MercuryClient {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [CallServer.self]
    return MercuryClient(baseURL: URL(string: "http://call.test")!, token: "t", session: URLSession(configuration: c))
  }
}

@MainActor @Suite(.serialized)
struct CallChatTests {
  func conversation() -> ConversationModel {
    ConversationModel(client: CallServer.client(), thread: ChatThread(id: "s1", title: "Voice call · 9:41 AM", createdAt: .now))
  }

  @Test func aQuestionIsSentIntoTheCallsThreadAndTheReplyComesBack() async {
    CallServer.requests = []
    let m = conversation()
    let chat = ConversationCallChat(conversation: m, callId: "call-1")
    let s = CallSetup()
    let brain = CallBrain(link: s.link, chat: chat, playback: s.playback)
    brain.handle(.connected)
    brain.handle(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"Is the deploy done?"}"#))
    await eventually { CallServer.requests.contains { $0.path == "/api/chat/send" } && m.agent != .idle }
    let sent = CallServer.requests.first { $0.path == "/api/chat/send" }
    #expect(sent?.body["content"] as? String == "Is the deploy done?")
    #expect(sent?.body["voiceCall"] as? String == "call-1")
    #expect(sent?.body["sessionId"] as? String == "s1")
    // The reply arrives on the thread's events.
    m.handle("step_start", #"{"tool":"web_search","step":1}"#)
    #expect(chat.activity == "Searching the web")
    m.handle("text_done", #"{"fullText":"Yes, it went out at noon.\nFor the chat:\nhttps://deploys.example/42"}"#)
    await eventually { !s.link.results.isEmpty }
    #expect(s.link.results.first?.id == "c1")
    #expect(s.link.results.first?.output.hasPrefix("Yes, it went out at noon.") == true)
    #expect(s.link.results.first?.output.contains("deploys.example") == false)
    chat.detach()
    #expect(m.callId == nil)
  }

  @Test func approvalsComeFromTheThreadAndAreAnsweredYesOrNo() async throws {
    CallServer.requests = []
    let m = conversation()
    let chat = ConversationCallChat(conversation: m, callId: "call-1")
    m.handle("permission_request", #"{"id":"p1","prompt":"Run command: ls","options":["yes","always","no"]}"#)
    m.handle("choice_prompt", #"{"id":"q1","question":"Which one?","options":["a","b"]}"#)
    #expect(chat.approvals == [CallApproval(id: "p1", text: "Run command: ls", targetId: nil)])
    try await chat.answer(chat.approvals[0], approved: true)
    let r = CallServer.requests.first { $0.path == "/api/chat/permission/p1" }
    #expect(r?.body["action"] as? String == "yes")
    #expect(chat.approvals.isEmpty)
  }

  @Test func aStoppedOrFailedTurnIsSaidPlainly() {
    let m = conversation()
    #expect(ConversationCallChat.answer(nil, conversation: m) == .stopped)
    m.messages.append(ChatMessage(role: "system", content: "The model is overloaded."))
    #expect(ConversationCallChat.answer(nil, conversation: m) == .failed("The model is overloaded."))
  }

  @Test func theSessionRouteGivesATokenOrTheFallbacksReason() async throws {
    CallServer.sessionStatus = 200
    CallServer.sessionBody = Data(#"{"engine":"openai","token":"ek_123","ephemeral":true,"expiresAt":"2026-11-15T10:00:00.000Z","model":"gpt-realtime-2.1","voice":"marin","url":"wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1","instructions":"You are Mercury","tools":[{"type":"function","name":"ask_mercury"}]}"#.utf8)
    guard case .live(let s) = try await CallServer.client().voiceSession() else { Issue.record("expected live"); return }
    #expect(s.engine == "openai" && s.token == "ek_123" && s.voice == "marin" && s.url?.hasPrefix("wss://") == true)
    #expect(s.toolsJSON.contains("ask_mercury") && s.expiresAt != nil)
    CallServer.sessionStatus = 409
    CallServer.sessionBody = Data(#"{"error":"Voice calls on the phone need an OpenAI key.","fallback":true}"#.utf8)
    #expect(try await CallServer.client().voiceSession() == .fallback(reason: "Voice calls on the phone need an OpenAI key. Until then, this call goes turn by turn."))
    CallServer.sessionStatus = 404
    CallServer.sessionBody = Data()
    #expect(try await CallServer.client().voiceSession() == .fallback(reason: MercuryClient.voiceSessionMissing))
  }
}

// MARK: - Spoken and chat parts, audio, haptics, the screen

struct SpokenSplitTests {
  @Test func textBeforeForTheChatIsSpoken() {
    let a = Spoken.split("It's sunny, 24 degrees.\nFor the chat:\n- https://weather.example")
    #expect(a.spoken == "It's sunny, 24 degrees.")
    #expect(a.chat == "- https://weather.example")
    let bold = Spoken.split("Sent.\n**For the chat:** the list")
    #expect(bold.spoken == "Sent." && bold.chat == "the list")
    let none = Spoken.split("  Just this.  ")
    #expect(none.spoken == "Just this." && none.chat.isEmpty)
    // Only at the start of a line.
    #expect(Spoken.split("I kept it for the chat: later").chat.isEmpty)
  }
}

struct PCMTests {
  @Test func floatsBecomeLittleEndianPCM16AndBack() {
    let samples: [Float] = [0, 1, -1, 0.5, 2, -3]
    let d = samples.withUnsafeBufferPointer { PCM.data(fromFloats: $0) }
    #expect(d.count == 12)
    #expect(Array(d[2...3]) == [0xFF, 0x7F]) // 32767, little-endian
    #expect(Array(d[4...5]) == [0x00, 0x80]) // -32768
    let back = PCM.floats(fromData: d)
    #expect(back.count == 6)
    #expect(abs(back[3] - 0.5) < 0.001)
    #expect(back[4] > 0.99 && back[5] == -1) // clipped
    #expect(PCM.floats(fromData: Data([1, 2, 3])).count == 1)
  }

  @Test func framesAreSixtyMilliseconds() {
    var f = PCMFramer()
    #expect(f.append([Int16](repeating: 1, count: 500)).isEmpty)
    let frames = f.append([Int16](repeating: 2, count: 1500))
    #expect(frames.count == 2)
    #expect(frames.allSatisfy { $0.count == 960 * 2 })
    #expect(f.pending.count == 80)
    #expect(PCM.floats(fromData: frames[0])[499] < PCM.floats(fromData: frames[0])[500])
  }

  @Test func theMicrophoneIsResampledTo16kHz() {
    let input = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    let r = MicResampler(input: input)!
    var total = 0
    for k in 0..<10 {
      let b = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: 960)!
      b.frameLength = 960
      for i in 0..<960 { b.floatChannelData![0][i] = 0.5 * sin(Float(k * 960 + i) * 2 * .pi * 440 / 48_000) }
      total += r.convert(b).count
    }
    // 9600 samples at 48 kHz are 3200 at 16 kHz (less a little filter latency).
    #expect(total > 3000 && total <= 3200)
  }

  @Test func playbackBuffersAreFloat16kHz() {
    let b = PCM.playBuffer(PCM.data(fromSamples: [0, 16384, -16384]))
    #expect(b?.frameLength == 3 && b?.format.sampleRate == 16_000)
    #expect(abs((b?.floatChannelData?[0][1] ?? 0) - 0.5) < 0.001)
    #expect(PCM.playBuffer(Data()) == nil)
  }

  @Test func theMeterFadesStaleLevels() {
    let m = CallMeter()
    m.setMic(0.8)
    #expect(m.read().mic == 0.8)
    #expect(m.read(now: .now.addingTimeInterval(1)).mic == 0)
    m.setEngine(mic: 0, voice: 0.25)
    #expect(m.read().voice > 0.5)
    #expect(CallMeter(fixed: (0.3, 0.6)).read() == (0.3, 0.6))
  }
}

struct CallHapticTests {
  @Test func eachMomentHasItsFeel() {
    #expect(CallHaptic.connected.feel == .success)
    #expect(CallHaptic.mercurySpeaks.feel == .soft)
    #expect(CallHaptic.bargeIn.feel == .light)
    #expect(CallHaptic.approvalAsked.feel == .warning)
    #expect(CallHaptic.approvalAnswered(approved: true).feel == .success)
    #expect(CallHaptic.approvalAnswered(approved: false).feel == .error)
    #expect(CallHaptic.muteToggled.feel == .selection)
    #expect(CallHaptic.ended.feel == .medium)
    #expect(CallHaptic.failed.feel == .error)
  }
}

@MainActor
struct VoiceCallModelTests {
  func model() -> (VoiceCallModel, CallSetup) {
    let m = VoiceCallModel(conversation: ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: nil))
    let s = CallSetup()
    m.useLive(link: s.link, chat: s.chat, playback: s.playback)
    return (m, s)
  }

  @Test func theScreenFollowsTheCall() async {
    let (m, s) = model()
    #expect(m.phase == .starting && m.status == "Getting Mercury on the line…" && m.orbState == .calling)
    m.voiceEvent(.connected)
    #expect(m.phase == .listening && m.startedAt != nil && m.orbState == .listening)
    m.voiceEvent(.speechStarted)
    #expect(m.orbState == .ownerSpeaking)
    m.voiceEvent(.userText(text: "Latest news?"))
    s.chat.activity = "Searching the web"
    m.voiceEvent(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"Latest news"}"#))
    #expect(m.phase == .working && m.activity == "Searching the web…" && m.status == "Searching the web…")
    s.playback.isPlaying = true
    m.brain?.playbackChanged(true)
    #expect(m.phase == .speaking && m.canInterrupt && m.orbState == .mercurySpeaking)
    m.toggleMute()
    #expect(m.muted && s.link.muted == true)
    #expect(m.haptics.played.contains(.muteToggled))
  }

  @Test func hangingUpEndsEverything() {
    let (m, s) = model()
    m.voiceEvent(.connected)
    m.end()
    #expect(m.isEnded && m.phase == .ended && s.link.stopped)
    #expect(m.haptics.played.last == .ended)
    #expect(m.conversation.callId == nil)
  }

  @Test func aDroppedCallSaysWhyInPlainWords() {
    let (m, _) = model()
    m.voiceEvent(.closed(reason: "the voice model disconnected"))
    #expect(m.isEnded && m.error == "Couldn't connect to the voice: the voice model disconnected.")
    #expect(m.haptics.played.last == .failed)
  }

  @Test func theClockCountsMinutesAndSeconds() {
    let start = Date(timeIntervalSince1970: 0)
    #expect(VoiceCallView.elapsed(from: start, to: start.addingTimeInterval(134)) == "02:14")
    #expect(VoiceCallView.elapsed(from: nil, to: start) == "00:00")
  }
}
