import SwiftUI
import MercuryCore
import MercuryVoice

/// Live dictation in the message box: the owner talks and the words appear as they speak.
///
/// The microphone is the call's (CallAudioEngine: echo-cancelled, 60 ms frames of 16 kHz PCM16);
/// the speech-to-text is Mercury's shared Rust engine (MercuryVoice `Dictation`) with a short-lived
/// token from the Mercury (POST /api/mobile/voice/dictation). The mic starts on the tap, while the
/// token and the stream come up; what's said meanwhile is kept and sent once the stream is open.
/// Partial text shows as it's heard and is replaced by the final text; both go after what was
/// already typed (DictationText). Tap again to stop; sending, a call, or 60 s of quiet stop it too.
@MainActor @Observable
final class DictationModel {
  enum Phase: Equatable { case idle, starting, listening, stopping }

  private(set) var phase: Phase = .idle
  /// From GET /api/mobile/voice/capabilities; nil until known.
  var capabilities: VoiceCapabilities?
  /// Shown under the composer: why the mic is greyed out, or why dictation stopped.
  var notice: String?
  @ObservationIgnored let meter: CallMeter
  @ObservationIgnored weak var conversation: ConversationModel?
  @ObservationIgnored let haptics = CallHaptics()
  @ObservationIgnored private var text: DictationText?
  @ObservationIgnored private var audio: CallAudioEngine?
  @ObservationIgnored private var relay: DictationRelay?
  @ObservationIgnored private var session: Dictation?
  @ObservationIgnored private var prefetched: DictationSession?
  @ObservationIgnored private var watchdog: Task<Void, Never>?
  @ObservationIgnored private var lastHeard = Date.now
  @ObservationIgnored private var stoppingSince = Date.now
  /// Bumped on every start and stop, so a late token or event from an earlier dictation is ignored.
  @ObservationIgnored private var generation = 0

  /// Quiet this long while listening stops dictation.
  static let silenceLimit: TimeInterval = 60

  @ObservationIgnored private var keysObserver: NSObjectProtocol?

  init(meter: CallMeter = CallMeter()) {
    self.meter = meter
    // A voice key saved in Settings → Voice: the mic enables (or greys out) at once.
    keysObserver = NotificationCenter.default.addObserver(forName: VoiceCapabilities.changed, object: nil, queue: .main) { [weak self] n in
      guard let caps = n.object as? VoiceCapabilities else { return }
      let url = n.userInfo?["baseURL"] as? URL
      MainActor.assumeIsolated { self?.voiceKeysChanged(caps, at: url) }
    }
  }

  deinit {
    if let keysObserver { NotificationCenter.default.removeObserver(keysObserver) }
  }

  /// What this Mercury can do changed (a key was saved or removed): use it, and get a fresh token ready.
  func voiceKeysChanged(_ caps: VoiceCapabilities, at url: URL?) {
    if let url, let mine = client?.baseURL, url != mine { return }
    capabilities = caps
    prefetched = nil
    if caps.dictation { notice = nil }
    Task { await load() }
  }

  var client: MercuryClient? { conversation?.client }
  var active: Bool { phase != .idle }
  /// A voice call runs (this chat's or another): the mic belongs to it.
  var callRunning: Bool { conversation?.callId != nil || CallKitCall.shared.active }
  /// The mic button works: this Mercury can dictate and no call has the mic.
  var available: Bool { capabilities?.dictation == true && !callRunning }

  /// Why the mic is greyed out, in plain words (nil while it isn't known yet).
  var unavailableReason: String? {
    if callRunning { return "Dictation is off during a voice call." }
    guard let c = capabilities, !c.dictation else { return nil }
    return c.setupLine
  }

  /// Asks the Mercury once what it can do, and gets a token ready so the first tap starts at once.
  func load() async {
    guard let client else { return }
    if capabilities == nil {
      capabilities = (try? await client.voiceCapabilities()) ?? nil
    }
    if capabilities?.dictation == true, prefetched?.fresh() != true {
      if case .live(let s)? = try? await client.dictationSession() { prefetched = s }
    }
  }

  // MARK: The button

  func tap() {
    if active { stop(); return }
    guard available else {
      // No speech service yet, on a Mercury that can set one up: "Set up voice" instead of the line.
      if !callRunning, let caps = capabilities, !caps.dictation, let client, let conversation {
        Task {
          if VoiceSetup.decide(.dictation, supported: await client.hasVoiceProviders(), caps: caps) == .setup {
            notice = nil
            conversation.voiceSetup = .dictation
          } else {
            unavailable()
          }
        }
        return
      }
      unavailable()
      return
    }
    start()
  }

  /// The mic can't be used: say why.
  func unavailable() {
    notice = unavailableReason ?? VoiceCapabilities.defaultDictationSetup
    haptics.play(.failed)
  }

  func start() {
    guard phase == .idle, let conversation else { return }
    generation += 1
    let gen = generation
    notice = nil
    phase = .starting
    haptics.prepare()
    haptics.play(.dictationStarted)
    text = DictationText(draft: conversation.draft)
    lastHeard = .now
    let relay = DictationRelay()
    self.relay = relay
    let engine = CallAudioEngine(meter: meter)
    audio = engine
    engine.onFrame { data in relay.push(data) }
    Task {
      guard await CallMic.allowed() else { return self.fail("Mercury can't hear you. Allow the microphone in Settings → Mercury.", gen) }
      guard gen == self.generation, self.phase == .starting else { return }
      do { try CallAudioEngine.activateSession() } catch { return self.fail("Couldn't open the microphone.", gen) }
      engine.start { error in
        guard error != nil else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { self.fail("Couldn't open the microphone.", gen) } }
      }
    }
    Task { await self.connect(gen, relay: relay) }
    watch(gen)
  }

  /// Stop listening: the last words are finalised, then the mic button is ready again.
  func stop() {
    guard active, phase != .stopping else { return }
    haptics.play(.dictationStopped)
    stopAudio()
    relay?.finishInput()
    phase = .stopping
    stoppingSince = .now
    // Without a stream yet, it stops as soon as it's open: what was said is still transcribed.
    session?.stop()
  }

  /// Stop at once, keeping what's in the box as it is (sending, a call starting, leaving the chat).
  func cancel() {
    guard active else { return }
    session?.cancel()
    relay?.close()
    stopAudio()
    end()
  }

  // MARK: Engine

  private func connect(_ gen: Int, relay: DictationRelay) async {
    guard let client else { return }
    let s: DictationSession
    if let p = prefetched, p.fresh() {
      prefetched = nil
      s = p
    } else {
      do {
        switch try await client.dictationSession() {
        case .live(let fresh): s = fresh
        case .unavailable(let setup):
          capabilities?.dictation = false
          capabilities?.dictationSetup = setup
          return fail(setup, gen)
        }
      } catch {
        return fail("Dictation couldn't start: \(error.localizedDescription)", gen)
      }
    }
    guard gen == generation, phase == .starting || phase == .stopping else { return }
    let config = DictationConfig(engine: s.engine, token: s.token, ephemeral: s.ephemeral, url: s.url, model: s.model, language: s.language)
    do {
      let d = try Dictation.start(config: config, listener: DictationListenerBox { [weak self] e in
        DispatchQueue.main.async { MainActor.assumeIsolated { self?.handle(e, gen) } }
      })
      session = d
      relay.attach(d)
      if phase == .stopping { d.stop() }
    } catch {
      fail("Dictation couldn't start: \(error.localizedDescription)", gen)
    }
  }

  func handle(_ e: DictationEvent, _ gen: Int) {
    guard gen == generation else { return }
    switch e {
    case .connected:
      if phase == .starting { phase = .listening }
    case .partial(let t):
      apply { $0.partial(t, draft: $1) }
      if !t.isEmpty { lastHeard = .now }
    case .final(let t):
      apply { $0.final(t, draft: $1) }
      lastHeard = .now
    case .levels(let mic):
      meter.setEngine(mic: mic, voice: 0)
      if mic > 0.05 { lastHeard = .now }
    case .closed(let reason):
      if reason != "stopped" && reason != "cancelled" { notice = "Dictation stopped: \(reason)." }
      stopAudio()
      end()
    }
  }

  /// Puts the live text into the box, after what the owner typed (their edits since win).
  private func apply(_ f: (inout DictationText, String) -> String) {
    guard var t = text, let conversation else { return }
    conversation.draft = f(&t, conversation.draft)
    text = t
  }

  private func watch(_ gen: Int) {
    watchdog?.cancel()
    watchdog = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard let self, gen == self.generation, self.active else { return }
        if self.callRunning { self.cancel(); return }
        // The engine never confirmed the stop: give up waiting.
        if self.phase == .stopping, Date.now.timeIntervalSince(self.stoppingSince) > 10 { self.cancel(); return }
        if self.phase == .listening, Date.now.timeIntervalSince(self.lastHeard) >= Self.silenceLimit {
          self.notice = "Dictation stopped after a minute of quiet."
          self.stop()
        }
      }
    }
  }

  private func fail(_ message: String, _ gen: Int) {
    guard gen == generation, active else { return }
    notice = message
    haptics.play(.failed)
    session?.cancel()
    relay?.close()
    stopAudio()
    end()
  }

  private func stopAudio() {
    guard let audio else { return }
    audio.onFrame { _ in }
    audio.stop()
    self.audio = nil
    CallAudioEngine.deactivateSession()
  }

  private func end() {
    generation += 1
    watchdog?.cancel(); watchdog = nil
    session = nil
    relay = nil
    text = nil
    meter.reset()
    phase = .idle
  }

  /// Gallery and tests: a dictation in a given state, with no audio or engine.
  func show(_ phase: Phase, draft: String? = nil) {
    if let draft { conversation?.draft = draft }
    self.phase = phase
    text = phase == .idle ? nil : DictationText(draft: conversation?.draft ?? "")
  }

  /// The current dictation's events are accepted with this (tests).
  var currentGeneration: Int { generation }
}

/// What dictation puts in the message box: what was there before, the finished text, then the
/// live partial (replaced as it's heard). If the owner edits the box while talking, their text
/// becomes the new start and the dictation carries on after it.
struct DictationText: Equatable {
  private(set) var base: String
  private(set) var finals = ""
  private(set) var live = ""
  /// The last text this put in the box.
  private(set) var written: String

  init(draft: String) {
    base = draft
    written = draft
  }

  var text: String { Self.join(base, Self.join(finals, live)) }

  /// New partial text (all of what isn't final yet); returns the box's new text.
  mutating func partial(_ t: String, draft: String) -> String {
    adopt(draft)
    live = t.trimmingCharacters(in: .whitespacesAndNewlines)
    written = text
    return written
  }

  /// Finished text: it replaces the partial it came from.
  mutating func final(_ t: String, draft: String) -> String {
    adopt(draft)
    finals = Self.join(finals, t.trimmingCharacters(in: .whitespacesAndNewlines))
    live = ""
    written = text
    return written
  }

  private mutating func adopt(_ draft: String) {
    guard draft != written else { return }
    var d = draft
    // The owner's edit kept the partial at the end: it'll come again, final.
    if !live.isEmpty, d.hasSuffix(live) { d = String(d.dropLast(live.count)) }
    base = d.hasSuffix(" ") ? String(d.dropLast()) : d
    finals = ""
    live = ""
  }

  /// Joins two pieces with one space, none before punctuation or after a space or new line.
  static func join(_ a: String, _ b: String) -> String {
    guard let last = a.last else { return b }
    guard let first = b.first else { return a }
    if last.isWhitespace || first.isWhitespace || ",.!?;:)".contains(first) { return a + b }
    return a + " " + b
  }
}

/// Hands microphone frames to the dictation stream, keeping them while it connects
/// (on the audio thread; the stream keeps its own copy while it opens, too).
final class DictationRelay: @unchecked Sendable {
  private let lock = NSLock()
  private var held: [Data] = []
  private var target: Dictation?
  private var closed = false
  /// The mic stopped: frames already kept still go to the stream when it opens.
  private var inputDone = false
  /// 15 s of 60 ms frames.
  static let maxHeld = 250

  func push(_ frame: Data) {
    lock.lock()
    if closed || inputDone { lock.unlock(); return }
    if let target { lock.unlock(); target.pushAudio(pcm16: frame); return }
    if held.count == Self.maxHeld { held.removeFirst() }
    held.append(frame)
    lock.unlock()
  }

  func attach(_ d: Dictation) {
    lock.lock()
    let early = held
    held = []
    target = closed ? nil : d
    lock.unlock()
    for f in early { d.pushAudio(pcm16: f) }
  }

  func finishInput() {
    lock.lock(); inputDone = true; lock.unlock()
  }

  func close() {
    lock.lock(); closed = true; target = nil; held = []; lock.unlock()
  }
}

final class DictationListenerBox: DictationListener, @unchecked Sendable {
  private let f: @Sendable (DictationEvent) -> Void
  init(_ f: @escaping @Sendable (DictationEvent) -> Void) { self.f = f }
  func onEvent(event: DictationEvent) { f(event) }
}
