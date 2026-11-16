import AVFoundation

/// What the call brain needs from playback: is Mercury audible right now, and cut it off.
protocol CallPlayback: AnyObject {
  var isPlaying: Bool { get }
  /// Drops everything queued and stops at once (barge-in, interrupt).
  func flush()
}

/// Voice levels, 0…1, for the orb: written from the audio threads (and the engine's `levels`
/// events), read every frame by the orb. Not observable on purpose: nothing re-renders per level.
final class CallMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var mic: Float = 0, voice: Float = 0
  private var micAt = Date.distantPast, voiceAt = Date.distantPast
  private var engineMic: Float = 0, engineVoice: Float = 0, engineAt = Date.distantPast
  /// Fixed levels (snapshots and previews).
  private let fixed: (mic: Float, voice: Float)?

  init(fixed: (mic: Float, voice: Float)? = nil) { self.fixed = fixed }

  func setMic(_ v: Float) { lock.lock(); mic = v; micAt = .now; lock.unlock() }
  func setVoice(_ v: Float) { lock.lock(); voice = v; voiceAt = .now; lock.unlock() }
  func setEngine(mic m: Float, voice v: Float) { lock.lock(); engineMic = m; engineVoice = v; engineAt = .now; lock.unlock() }
  func reset() { lock.lock(); mic = 0; voice = 0; engineMic = 0; engineVoice = 0; lock.unlock() }

  /// The latest levels: the phone's own meters, else the engine's; stale readings fade to 0.
  func read(now: Date = .now) -> (mic: Float, voice: Float) {
    if let fixed { return fixed }
    lock.lock(); defer { lock.unlock() }
    func fresh(_ v: Float, _ at: Date) -> Float { now.timeIntervalSince(at) < 0.25 ? v : 0 }
    let engineFresh = now.timeIntervalSince(engineAt) < 0.3
    return (max(fresh(mic, micAt), engineFresh ? PCM.display(engineMic) : 0),
            max(fresh(voice, voiceAt), engineFresh ? PCM.display(engineVoice) : 0))
  }
}

/// The phone's side of a live call: the microphone, with the phone's echo cancellation (voice
/// processing), as 60 ms frames of 16 kHz PCM16 for the voice engine, and Mercury's voice played
/// as it arrives through one player node with nothing buffered beyond what the engine sent.
/// All setup runs on its own queue, never the main thread (voice processing takes a moment).
final class CallAudioEngine: CallPlayback, @unchecked Sendable {
  let meter: CallMeter
  private let queue = DispatchQueue(label: "sh.mercuryagent.call.audio", qos: .userInteractive)
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let lock = NSLock()
  // Guarded by `lock`.
  private var frameSink: (@Sendable (Data) -> Void)?
  private var playbackSink: (@Sendable (Bool) -> Void)?
  private var scheduled = 0
  private var generation = 0
  private var attached = false
  private var running = false
  private var muted = false
  // Audio thread only (the input tap).
  private var resampler: MicResampler?
  private var framer = PCMFramer()
  private var configObserver: NSObjectProtocol?

  init(meter: CallMeter = CallMeter()) {
    self.meter = meter
  }

  deinit {
    if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
  }

  /// Each 60 ms microphone frame (PCM16 LE), on the audio thread.
  func onFrame(_ f: @escaping @Sendable (Data) -> Void) { lock.lock(); frameSink = f; lock.unlock() }
  /// Mercury became audible (true) or went quiet (false), on an audio thread.
  func onPlayback(_ f: @escaping @Sendable (Bool) -> Void) { lock.lock(); playbackSink = f; lock.unlock() }

  // MARK: Session (iOS)

  /// The call's audio session: play and record for a voice chat, Bluetooth headsets allowed,
  /// the earpiece by default. Set before CallKit activates it (CallKit does the activating).
  static func configureSession() throws {
    #if os(iOS)
    let s = AVAudioSession.sharedInstance()
    try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
    try? s.setPreferredIOBufferDuration(0.02)
    #endif
  }

  /// Without CallKit the app activates the session itself.
  static func activateSession() throws {
    #if os(iOS)
    try configureSession()
    try AVAudioSession.sharedInstance().setActive(true)
    #endif
  }

  static func deactivateSession() {
    #if os(iOS)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }

  /// Speaker or earpiece (a headset, when one is connected, wins either way).
  static func setSpeaker(_ on: Bool) {
    #if os(iOS)
    try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
    #endif
  }

  /// Is the sound coming out of the phone's loudspeaker right now?
  static var onSpeaker: Bool {
    #if os(iOS)
    AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    #else
    true
    #endif
  }

  /// Headphones, AirPods, a car or AirPlay: the call stays there, whatever the phone's position.
  static var onExternal: Bool {
    #if os(iOS)
    AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType != .builtInSpeaker && $0.portType != .builtInReceiver }
    #else
    false
    #endif
  }

  /// Is it on the earpiece (so the proximity sensor should darken the screen at the ear)?
  static var onEarpiece: Bool {
    #if os(iOS)
    AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInReceiver }
    #else
    false
    #endif
  }

  // MARK: Life cycle

  /// Builds the graph with echo cancellation, ahead of the session going live. Safe to call twice.
  func prepare(_ done: @escaping @Sendable (Error?) -> Void = { _ in }) {
    queue.async {
      do { try self.prepareNow(); done(nil) } catch { done(error) }
    }
  }

  /// Starts the microphone and the player. Call once the audio session is active.
  func start(_ done: @escaping @Sendable (Error?) -> Void) {
    queue.async {
      do {
        try self.prepareNow()
        try self.run()
        done(nil)
      } catch {
        done(error)
      }
    }
  }

  func stop() {
    flush()
    queue.async {
      self.lock.lock(); self.running = false; self.lock.unlock()
      self.engine.inputNode.removeTap(onBus: 0)
      self.engine.mainMixerNode.removeTap(onBus: 0)
      self.player.stop()
      self.engine.stop()
      self.meter.reset()
    }
  }

  func setMuted(_ on: Bool) {
    lock.lock(); muted = on; lock.unlock()
    if on { meter.setMic(0) }
  }

  private func prepareNow() throws {
    lock.lock(); let done = attached; lock.unlock()
    guard !done else { return }
    #if os(iOS)
    try engine.inputNode.setVoiceProcessingEnabled(true)
    #endif
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: PCM.playFormat)
    lock.lock(); attached = true; lock.unlock()
    if configObserver == nil {
      // A headset plugged in or the route changed: the hardware format may have too.
      configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
        self?.queue.async { self?.rewire() }
      }
    }
  }

  private func run() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0, let r = MicResampler(input: format) else {
      throw CallAudioError.noMicrophone
    }
    resampler = r
    framer.reset()
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate * 0.02), format: format) { [weak self] buf, _ in
      self?.captured(buf)
    }
    let mixer = engine.mainMixerNode
    mixer.removeTap(onBus: 0)
    mixer.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buf, _ in
      guard let self, let ch = buf.floatChannelData, buf.frameLength > 0 else { return }
      let audible = self.isPlaying
      self.meter.setVoice(audible ? PCM.display(PCM.peak(UnsafeBufferPointer(start: ch[0], count: Int(buf.frameLength)))) : 0)
    }
    engine.prepare()
    try engine.start()
    player.play()
    lock.lock(); running = true; lock.unlock()
  }

  /// After a configuration change the engine has stopped: start it again with the new format.
  private func rewire() {
    lock.lock(); let wasRunning = running; lock.unlock()
    guard wasRunning else { return }
    try? run()
  }

  // MARK: Up: the owner's voice

  private func captured(_ buf: AVAudioPCMBuffer) {
    guard let resampler else { return }
    let samples = resampler.convert(buf)
    guard !samples.isEmpty else { return }
    let frames = framer.append(samples)
    guard !frames.isEmpty else { return }
    lock.lock(); let sink = frameSink; let quiet = muted; lock.unlock()
    for f in frames {
      if !quiet {
        let peak = f.withUnsafeBytes { raw in raw.bindMemory(to: Int16.self).reduce(Int32(0)) { max($0, abs(Int32(Int16(littleEndian: $1)))) } }
        meter.setMic(PCM.display(Float(peak) / 32768))
      }
      sink?(f)
    }
  }

  // MARK: Down: Mercury's voice

  var isPlaying: Bool { lock.lock(); defer { lock.unlock() }; return scheduled > 0 }

  /// Plays engine audio (16 kHz mono PCM16 LE) right after what's already queued.
  func play(_ data: Data) {
    guard let buf = PCM.playBuffer(data) else { return }
    lock.lock()
    guard attached else { lock.unlock(); return }
    let gen = generation
    scheduled += 1
    let first = scheduled == 1
    let sink = playbackSink
    let live = running
    lock.unlock()
    if first { sink?(true) }
    player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in self?.played(gen) }
    if live && !player.isPlaying { player.play() }
  }

  private func played(_ gen: Int) {
    lock.lock()
    guard gen == generation, scheduled > 0 else { lock.unlock(); return }
    scheduled -= 1
    let ended = scheduled == 0
    let sink = playbackSink
    lock.unlock()
    if ended { sink?(false) }
  }

  func flush() {
    lock.lock()
    generation += 1
    let had = scheduled > 0
    scheduled = 0
    let sink = playbackSink
    let live = running
    let ready = attached
    lock.unlock()
    guard ready else { return }
    // Stopping calls the dropped buffers' completions (ignored: their generation is gone).
    player.stop()
    if live { player.play() }
    meter.setVoice(0)
    if had { sink?(false) }
  }
}

enum CallAudioError: LocalizedError {
  case noMicrophone
  var errorDescription: String? { "Couldn't open the microphone." }
}
