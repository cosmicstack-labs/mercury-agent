import SwiftUI
import AVFoundation
import MercuryCore
import MercuryVoice
#if canImport(UIKit)
import UIKit
#endif

/// A voice call with Mercury from the phone, as a real phone call (CallKit).
///
/// Live: Mercury's shared Rust voice engine (MercuryVoice, the links Optimus runs on the desktop)
/// with a short-lived token from the Mercury (POST /api/mobile/voice/session). The phone streams
/// the microphone to the voice and plays what comes back; CallBrain answers the voice's tools
/// through the call's chat thread. Turn by turn, only when the Mercury can't do live voice (the
/// route says so with 409, or it doesn't exist yet): the phone hears one thing at a time, Mercury
/// transcribes and answers in the thread, the phone reads the answer aloud. The screen says why.
///
/// Starting is parallel, and each step is timed (CallTimeline): the screen shows at once; the
/// token, CallKit's call and audio session, and the audio graph (echo cancellation) come up together;
/// the voice engine starts the moment the token is in and says hello as soon as it connects.
@MainActor @Observable
final class VoiceCallModel {
  enum Phase: Equatable { case starting, listening, hearing, sending, working, speaking, ended }
  enum Mode: Equatable { case live, turns }

  var mode: Mode = .live
  /// Why the call is turn by turn, in plain words.
  var notice: String?
  var error: String?
  /// Set when the call is over.
  var endedNote: String?
  var isEnded = false
  var endedAt: Date?
  /// When the call connected (the timer counts from here).
  var startedAt: Date?
  var speaker = false
  /// The owner tapped Speaker: their choice holds; otherwise the proximity sensor decides.
  @ObservationIgnored private var manualRoute = false
  @ObservationIgnored private var proximityObserver: NSObjectProtocol?
  let conversation: ConversationModel
  let callId: String
  /// Started from Chats, with no conversation screen under it.
  var ownsConversation = false

  // Live
  private(set) var brain: CallBrain?
  /// Keeps Mercury's own voice from interrupting it (live calls).
  @ObservationIgnored var echoGuard: CallEchoGuard?
  @ObservationIgnored let meter: CallMeter
  @ObservationIgnored private var voice: VoiceLink?
  @ObservationIgnored private var audio: CallAudioEngine?
  @ObservationIgnored private var chat: CallChat?
  @ObservationIgnored private var ticker: Task<Void, Never>?
  @ObservationIgnored private var startTask: Task<Void, Never>?
  @ObservationIgnored private var routeObserver: NSObjectProtocol?
  @ObservationIgnored private var usingCallKit = false
  @ObservationIgnored private var sessionActive = false
  @ObservationIgnored private var heldMute = false
  @ObservationIgnored let timeline: CallTimeline
  @ObservationIgnored let haptics = CallHaptics()

  // Turn by turn
  var turnPhase: Phase = .starting
  var turnMuted = false
  /// The last thing said: yours in quotes while Mercury works, then Mercury's answer.
  var caption: String?
  var level: Float = 0
  var support: SpeechSupport?
  @ObservationIgnored var turnAudio: CallAudio?
  /// Bumped whenever the call moves on, so a listen or a reading that was overtaken stops quietly.
  @ObservationIgnored var turn = 0

  /// Mercury rang this phone and the owner answered (ADR-046): the session starts with why it called.
  let ring: RingInvite?

  init(conversation: ConversationModel, meter: CallMeter = CallMeter(), tappedAt: Date = .now, ring: RingInvite? = nil) {
    self.conversation = conversation
    self.ring = ring
    self.meter = meter
    callId = UUID().uuidString.lowercased()
    timeline = CallTimeline(start: tappedAt)
  }

  var client: MercuryClient { conversation.client }

  // MARK: What the screen shows

  var phase: Phase {
    if isEnded { return .ended }
    switch mode {
    case .turns: return turnPhase
    case .live:
      guard let brain, brain.connected else { return .starting }
      if brain.mercuryAudible { return .speaking }
      if brain.ownerSpeaking { return .hearing }
      if !brain.asks.isEmpty || brain.awaiting != nil || chat?.working == true { return .working }
      return .listening
    }
  }

  var muted: Bool { mode == .live ? brain?.muted ?? false : turnMuted }

  /// What Mercury is doing while it works ("Searching the web…"), or nil.
  var activity: String? {
    switch mode {
    case .live:
      guard let brain, !brain.asks.isEmpty || chat?.working == true else { return nil }
      if brain.awaiting != nil { return "Needs your OK" }
      return (chat?.activity ?? "Thinking") + "…"
    case .turns:
      guard turnPhase == .working else { return nil }
      if !conversation.prompts.isEmpty { return "Needs your OK" }
      if conversation.queued != nil { return "Waiting for another chat to finish…" }
      if let s = conversation.steps.last(where: { !$0.done }) { return "\(s.label)…" }
      return "Thinking…"
    }
  }

  /// One line under the orb: what's happening now.
  var status: String {
    if let error { return error }
    switch phase {
    case .starting: return "Getting Mercury on the line…"
    case .listening: return muted ? "Muted" : "Listening"
    case .hearing: return "Listening…"
    case .sending: return "Got it"
    case .working: return activity ?? "Thinking…"
    case .speaking: return "Mercury is speaking · tap to interrupt"
    case .ended: return endedNote ?? "Call ended"
    }
  }

  /// The last thing the owner said, and what Mercury is saying (or last said).
  var ownerLine: String? { mode == .live ? brain?.ownerLine : nil }
  var mercuryLine: String? { mode == .live ? brain?.mercuryLine : caption }

  /// The approval to show on screen with Allow and Deny.
  var approval: CallApproval? {
    switch mode {
    case .live: return brain?.awaiting?.approval ?? chat?.approvals.first
    case .turns:
      return conversation.prompts.first { $0.kind == "permission_request" || $0.kind == "permission_continue" }
        .map { CallApproval(id: $0.id, text: $0.text, targetId: $0.targetId) }
    }
  }

  var canInterrupt: Bool { phase == .speaking || (mode == .turns && phase == .working) }

  // MARK: Starting

  /// Starts the call (once). The screen is already up: this runs everything else.
  func start() async {
    CallLog.note("— call starting —")
    guard startTask == nil, !isEnded else { return }
    timeline.mark(.screen)
    let t = Task { await self.run() }
    startTask = t
    await t.value
  }

  private func run() async {
    haptics.prepare()
    guard await CallMic.allowed() else {
      return fail("Mercury can't hear you. Allow the microphone in Settings → Mercury.")
    }
    timeline.mark(.mic)
    // The audio graph with echo cancellation, off the main thread, while the rest comes up.
    let engine = CallAudioEngine(meter: meter)
    audio = engine
    engine.prepare()
    // The token, in parallel with CallKit's call and its audio session.
    async let session = fetchSession()
    await startCallKit()
    let result = await session
    timeline.mark(.token)
    guard !isEnded else { return }
    switch result {
    case .success(.live(let s)):
      startLive(s, engine: engine)
    case .success(.fallback(let why)):
      audio = nil
      engine.stop()
      notice = why
      mode = .turns
      await waitForAudioSession()
      guard !isEnded else { return }
      if usingCallKit { CallKitCall.shared.connected() }
      await startTurns()
    case .failure(let e):
      fail(e.localizedDescription)
    }
  }

  private func fetchSession() async -> Result<VoiceSessionResult, Error> {
    do { return .success(try await client.voiceSession(ring: ring)) } catch { return .failure(error) }
  }

  /// CallKit's outgoing call; without it (it refused, or not on iOS) the app runs the audio itself.
  private func startCallKit() async {
    let ck = CallKitCall.shared
    ck.onActivate = { [weak self] in self?.audioSessionActivated() }
    ck.onDeactivate = { [weak self] in self?.sessionActive = false }
    ck.onEndedOutside = { [weak self] in self?.endedOutside() }
    ck.onMute = { [weak self] on in self?.setMuted(on) }
    ck.onHold = { [weak self] on in self?.held(on) }
    do {
      try await ck.start()
      usingCallKit = true
      timeline.mark(.callKit)
    } catch {
      CallTimeline.log.notice("call: CallKit unavailable (\(error.localizedDescription, privacy: .public)), running in the app")
      usingCallKit = false
      do {
        try CallAudioEngine.activateSession()
        audioSessionActivated()
      } catch {
        fail("Couldn't open the microphone.")
      }
    }
    if !isEnded { observeRoute() }
  }

  /// The audio session is live: the microphone and player start (the engine may still be connecting).
  private func audioSessionActivated() {
    sessionActive = true
    timeline.mark(.audioSession)
    guard mode == .live, !isEnded, let audio else { return }
    audio.start { [weak self] error in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self else { return }
          if error != nil { self.fail("Couldn't open the microphone.") } else { self.timeline.mark(.audioRunning) }
        }
      }
    }
    updateRoute()
  }

  private func waitForAudioSession() async {
    for _ in 0..<60 where !sessionActive && !isEnded { try? await Task.sleep(for: .milliseconds(50)) }
  }

  private func startLive(_ s: VoiceSession, engine: CallAudioEngine) {
    let config = VoiceConfig(engine: s.engine, token: s.token, ephemeral: s.ephemeral, url: s.url, model: s.model, voice: s.voice,
                             instructions: s.instructions, toolsJson: s.toolsJSON)
    let listener = CallListener(model: self, audio: engine, meter: meter)
    CallLog.note("live engine=\(s.engine) model=\(s.model ?? "-") voice=\(s.voice ?? "-")")
    let call: VoiceCall
    do { call = try VoiceCall.start(config: config, listener: listener) } catch {
      return fail("Couldn't start the voice: \(Self.plain(error))")
    }
    // Barge-ins while Mercury speaks are judged on the phone's own microphone level (OpenAI
    // Realtime leaves interrupting to the phone on a phone call; Gemini Live cuts in by itself).
    let gate = CallBargeIn(enabled: CallBargeIn.judges(engine: s.engine))
    gate.mercuryAudible = { [weak engine] in engine?.isPlaying ?? false }
    gate.onDue = { [weak self] in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.brain?.bargeInDue() } }
    }
    // While Mercury is audible, its own voice coming back into the mic must not count as the
    // caller talking (it made Mercury stop itself mid-word): the echo guard sends silence in its
    // place until a near voice is heard. When Mercury is quiet every frame goes up untouched.
    let echo = CallEchoGuard()
    let judge = CallTalkOverJudge(echo: echo, gate: CallBargeIn.judges(engine: s.engine) ? gate : nil)
    echo.mercuryAudible = { [weak engine] in engine?.isPlaying ?? false }
    echo.ownerTalking = { [judge] in judge.ownerTalking }
    echo.onOpened = { [weak self] in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.brain?.bargeInDue() } }
    }
    echoGuard = echo
    engine.onFrame { [call, gate, echo] data in
      for frame in echo.filter(data) { call.pushAudio(pcm16: frame) }
      gate.frame(data)
    }
    engine.onPlayback { [weak self] on in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.brain?.playbackChanged(on) } }
    }
    useLive(link: call, chat: ConversationCallChat(conversation: conversation, callId: callId), playback: engine)
    brain?.bargeIn = judge
    brain?.logExtra = { [echo] in echo.summary() }
    brain?.begin()
  }

  /// Puts a brain on the call: the engine (or a fake), the chat and playback. Tests and the gallery use it too.
  func useLive(link: VoiceLink, chat: CallChat, playback: CallPlayback) {
    mode = .live
    voice = link
    self.chat = chat
    let b = CallBrain(link: link, chat: chat, playback: playback, haptic: { [weak self] in self?.haptics.play($0) })
    b.onEnd = { [weak self] end in self?.liveEnded(end) }
    b.onMuted = { [weak self] on in
      guard let self else { return }
      (self.audio)?.setMuted(on)
      if self.usingCallKit { CallKitCall.shared.setMuted(on) }
    }
    brain = b
    if conversation.threadId != nil && !conversation.loaded { Task { await conversation.load() } }
    ticker?.cancel()
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard let self, !self.isEnded else { return }
        self.brain?.tick()
      }
    }
  }

  /// An engine event, on the main thread (audio and levels never come here).
  func voiceEvent(_ e: VoiceEvent) {
    if case .connected = e {
      timeline.mark(.connected)
      startedAt = .now
      if usingCallKit { CallKitCall.shared.connected() }
    }
    brain?.handle(e)
  }

  func firstAudio() { timeline.mark(.firstAudio) }

  // MARK: Controls

  func toggleMute() { setMuted(!muted) }

  func setMuted(_ on: Bool) {
    guard !isEnded, on != muted else { return }
    if mode == .live { brain?.setMuted(on); return }
    turnMuted = on
    haptics.play(.muteToggled)
    if usingCallKit { CallKitCall.shared.setMuted(on) }
    if on {
      turnAudio?.stopListening()
      if turnPhase == .listening || turnPhase == .hearing { turn += 1; turnPhase = .listening }
    } else if turnPhase == .listening {
      listenNext()
    }
  }

  private func held(_ on: Bool) {
    if on { heldMute = !muted; if heldMute { setMuted(true) } }
    else if heldMute { heldMute = false; setMuted(false) }
  }

  func toggleSpeaker() {
    // The owner chose: keep it until the call ends, whatever the phone's position.
    manualRoute = true
    speaker.toggle()
    haptics.play(.muteToggled)
    CallAudioEngine.setSpeaker(speaker)
    updateRoute()
  }

  /// Cuts Mercury off: stops its voice (and, turn by turn, the work it's doing).
  func interrupt() async {
    if mode == .live { brain?.interrupt(); return }
    switch turnPhase {
    case .speaking:
      turn += 1
      turnAudio?.stopPlaying()
      haptics.play(.bargeIn)
      listenNext()
    case .working, .sending:
      await conversation.stop()
    default:
      break
    }
  }

  func answerApproval(_ a: CallApproval, approved: Bool) {
    if mode == .live { brain?.answerOnScreen(a, approved: approved); return }
    guard let p = conversation.prompts.first(where: { $0.id == a.id }) else { return }
    Task {
      await conversation.answer(p, approved ? "yes" : "no")
      haptics.play(.approvalAnswered(approved: approved))
    }
  }

  // MARK: Ending

  /// Hangs up. Work Mercury already started keeps going and lands in the chat.
  func end() {
    guard !isEnded else { return }
    if let brain, brain.ended == nil { brain.finish(.owner); return }
    finish(note: nil, failed: false, hangUpCallKit: true)
  }

  private func endedOutside() {
    guard !isEnded else { return }
    usingCallKit = false // CallKit already ended it
    if let brain, brain.ended == nil { brain.finish(.owner); return }
    finish(note: nil, failed: false, hangUpCallKit: false)
  }

  private func liveEnded(_ end: CallBrain.End) {
    switch end {
    case .owner: finish(note: nil, failed: false, hangUpCallKit: true)
    case .goodbye: finish(note: "Mercury said goodbye.", failed: false, hangUpCallKit: false)
    case .idle: finish(note: "Ended after a minute of quiet.", failed: false, hangUpCallKit: false)
    case .timeLimit: finish(note: "Calls end after 30 minutes.", failed: false, hangUpCallKit: false)
    case .dropped(let reason):
      if error == nil { error = brain?.connected == true ? "The call dropped: \(reason)." : "Couldn't connect to the voice: \(reason)." }
      finish(note: nil, failed: true, hangUpCallKit: false)
    }
  }

  private func fail(_ message: String) {
    CallLog.note("call failed: \(message.prefix(300))")
    guard !isEnded else { return }
    error = message
    if let brain, brain.ended == nil { brain.finish(.dropped(message)); return }
    finish(note: nil, failed: true, hangUpCallKit: false)
  }

  private func finish(note: String?, failed: Bool, hangUpCallKit: Bool) {
    guard !isEnded else { return }
    isEnded = true
    endedAt = .now
    endedNote = note
    haptics.play(failed ? .failed : .ended)
    ticker?.cancel(); ticker = nil
    audio?.stop(); audio = nil
    voice = nil
    (chat as? ConversationCallChat)?.detach()
    // Turn by turn
    turn += 1
    conversation.callId = nil
    conversation.onTurnEnd = { _ in }
    turnAudio?.deactivate(); turnAudio = nil
    level = 0
    meter.reset()
    if usingCallKit {
      if hangUpCallKit { CallKitCall.shared.end() } else { CallKitCall.shared.reportEnded(failed: failed) }
    } else {
      CallAudioEngine.deactivateSession()
    }
    usingCallKit = false
    if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    routeObserver = nil
    if let proximityObserver { NotificationCenter.default.removeObserver(proximityObserver) }
    proximityObserver = nil
    manualRoute = false
    setProximity(false)
    if ownsConversation { conversation.listener?.cancel() }
    conversation.onChange()
    CallTimeline.log.info("call ended: \(note ?? self.error ?? "by the owner", privacy: .public)")
  }

  // MARK: Route, proximity, screen

  /// Loudspeaker by default; the earpiece only while the phone is held to the ear (the proximity
  /// sensor says so), back to the loudspeaker when it comes away. Headphones, AirPods or a car
  /// always win, and once the owner taps Speaker their choice holds for the rest of the call.
  private func observeRoute() {
    #if os(iOS)
    guard routeObserver == nil else { return }
    routeObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
      let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
      MainActor.assumeIsolated {
        // Headphones unplugged or AirPods gone: fall back to the phone's own choice.
        if reason == .oldDeviceUnavailable { self?.autoRoute() } else { self?.updateRoute() }
      }
    }
    proximityObserver = NotificationCenter.default.addObserver(forName: UIDevice.proximityStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.autoRoute() }
    }
    autoRoute()
    #endif
  }

  /// Picks speaker or earpiece from where the phone is, unless something external or the owner decided.
  private func autoRoute() {
    guard !isEnded else { return }
    #if os(iOS)
    if !CallAudioEngine.onExternal && !manualRoute {
      setProximity(true)
      CallAudioEngine.setSpeaker(!UIDevice.current.proximityState)
    }
    #endif
    updateRoute()
  }

  private func updateRoute() {
    guard !isEnded else { return }
    speaker = CallAudioEngine.onSpeaker
    // The sensor stays on with the phone's own speakers (so lifting it to the ear switches);
    // with headphones or a car it's off, so the screen never goes dark by accident.
    setProximity(!CallAudioEngine.onExternal)
  }

  /// At the ear the screen goes dark; the screen never sleeps during a call.
  private func setProximity(_ on: Bool) {
    #if os(iOS)
    UIDevice.current.isProximityMonitoringEnabled = on
    UIApplication.shared.isIdleTimerDisabled = on || !isEnded
    #endif
  }

  static func plain(_ error: Error) -> String {
    if let v = error as? VoiceError, case .Config(let reason) = v { return reason }
    return error.localizedDescription
  }

  // MARK: Turn by turn (the fallback)

  func startTurns() async {
    do {
      let s = try await client.speechSupport()
      support = s
      guard s.listen else {
        return fail("Calls need a speech service on your Mercury. Add one in Mercury Desktop: Settings → Voice.")
      }
    } catch {
      return fail(error.localizedDescription)
    }
    let a = CallAudio()
    a.onLevel = { [weak self] l in self?.level = l; self?.meter.setMic(l) }
    a.onSpeech = { [weak self] in if self?.turnPhase == .listening { self?.turnPhase = .hearing } }
    do { try a.activate() } catch {
      return fail("Couldn't open the microphone.")
    }
    turnAudio = a
    conversation.callId = callId
    conversation.onTurnEnd = { [weak self] reply in Task { await self?.answered(reply) } }
    if conversation.threadId != nil && !conversation.loaded { await conversation.load() }
    startedAt = .now
    haptics.play(.connected)
    updateRoute()
    listenNext()
  }

  /// Hears the next thing said and sends it.
  func listenNext() {
    guard !isEnded, let audio = turnAudio else { return }
    turn += 1
    let mine = turn
    turnPhase = .listening
    guard !turnMuted else { return }
    Task {
      do {
        guard let recording = try await audio.listen(), mine == turn else { return }
        turnPhase = .sending
        let heard = try await client.transcribe(recording, mime: "audio/wav").trimmingCharacters(in: .whitespacesAndNewlines)
        guard mine == turn, !isEnded else { return }
        guard !heard.isEmpty else { listenNext(); return }
        error = nil
        caption = "“\(heard)”"
        conversation.draft = heard
        await conversation.send()
        guard mine == turn, !isEnded else { return }
        if let e = conversation.error {
          error = e
          conversation.draft = ""
          listenNext()
        } else if turnPhase == .sending {
          turnPhase = .working
        }
      } catch {
        guard mine == turn, !isEnded else { return }
        self.error = error.localizedDescription
        try? await Task.sleep(for: .seconds(1.5))
        if mine == turn { self.error = nil; listenNext() }
      }
    }
  }

  /// Mercury finished a turn: read the spoken part of the answer aloud, then listen again.
  func answered(_ reply: ChatMessage?) async {
    guard !isEnded, let audio = turnAudio else { return }
    turn += 1
    let mine = turn
    audio.stopListening()
    let text = reply.map { Spoken.text(Spoken.split($0.content).spoken) } ?? ""
    if !text.isEmpty { caption = text }
    if !text.isEmpty, support?.speak == true {
      turnPhase = .speaking
      haptics.play(.mercurySpeaks)
      // Short first part so the voice starts quickly; the next part is made while one plays.
      let parts = Spoken.parts(text, max: min(support?.maxChars ?? 4000, 600))
      var next: Task<Data?, Never>? = Task { [client] in try? await client.speak(parts[0]) }
      for i in parts.indices {
        let data = await next?.value
        next = i + 1 < parts.count ? Task { [client] in try? await client.speak(parts[i + 1]) } : nil
        guard mine == turn, turnPhase == .speaking else { next?.cancel(); return }
        guard let data else { continue }
        if !(await audio.play(data)) { break }
      }
      next?.cancel()
    }
    if mine == turn { listenNext() }
  }
}

/// The engine's events, from its own thread: Mercury's audio goes straight to the player;
/// everything else goes to the model on the main thread, in order (a barge-in included: the brain
/// decides whether it's the owner before Mercury's voice stops).
final class CallListener: VoiceListener, @unchecked Sendable {
  private weak var model: VoiceCallModel?
  private let audio: CallAudioEngine
  private let meter: CallMeter
  private let lock = NSLock()
  private var heardAudio = false

  init(model: VoiceCallModel, audio: CallAudioEngine, meter: CallMeter) {
    self.model = model; self.audio = audio; self.meter = meter
  }

  func onEvent(event: VoiceEvent) {
    switch event {
    case .audio(let pcm):
      CallLog.count("event.audio")
      audio.play(pcm)
      lock.lock(); let first = !heardAudio; heardAudio = true; lock.unlock()
      if first { main { $0.firstAudio() } }
    case .levels(let mic, let voice):
      meter.setEngine(mic: mic, voice: voice)
    default:
      main { $0.voiceEvent(event) }
    }
  }

  private func main(_ f: @escaping @MainActor (VoiceCallModel) -> Void) {
    DispatchQueue.main.async { [weak model] in
      MainActor.assumeIsolated { if let model { f(model) } }
    }
  }
}

/// The microphone permission: asked once early (when Chats first shows), so a call never waits on it.
enum CallMic {
  @MainActor private static var asked = false

  /// Asks now if it was never asked (no prompt otherwise).
  @MainActor static func askEarly() {
    #if os(iOS)
    guard !asked else { return }
    asked = true
    guard AVAudioApplication.shared.recordPermission == .undetermined else { return }
    Task { _ = await AVAudioApplication.requestRecordPermission() }
    #endif
  }

  static func allowed() async -> Bool {
    #if os(iOS)
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return true
    case .denied: return false
    default: return await AVAudioApplication.requestRecordPermission()
    }
    #else
    return true
    #endif
  }
}
