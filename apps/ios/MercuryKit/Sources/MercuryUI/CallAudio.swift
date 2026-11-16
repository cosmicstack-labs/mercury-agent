import AVFoundation

/// The phone's side of a voice call: hears one thing said at a time, and plays Mercury's voice.
/// Half duplex: the mic is off while Mercury speaks, so it never hears itself.
@MainActor
final class CallAudio {
  /// The mic level, 0 to 1, about 40 times a second while listening.
  var onLevel: (Float) -> Void = { _ in }
  /// Someone started talking.
  var onSpeech: () -> Void = {}

  private let engine = AVAudioEngine()
  private var take: Take?
  private var player: AVAudioPlayer?
  private var finished: PlaybackEnd?

  static func permission() async -> Bool {
    #if os(iOS)
    await AVAudioApplication.requestRecordPermission()
    #else
    await AVCaptureDevice.requestAccess(for: .audio)
    #endif
  }

  func activate() throws {
    #if os(iOS)
    let s = AVAudioSession.sharedInstance()
    try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try s.setActive(true)
    #endif
  }

  func deactivate() {
    stopListening(); stopPlaying()
    #if os(iOS)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    #endif
  }

  // MARK: Listening

  /// Waits for speech, then records until the person has been quiet for a moment.
  /// Returns the recording as WAV, or nil when stopped first.
  func listen() async throws -> Data? {
    stopListening()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    let url = FileManager.default.temporaryDirectory.appending(path: "call-\(UUID().uuidString).wav")
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
      AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
    ]
    let take = try Take(file: AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved), sampleRate: format.sampleRate)
    self.take = take
    take.onLevel = { [weak self] l in Task { @MainActor in self?.onLevel(l) } }
    take.onSpeech = { [weak self] in Task { @MainActor in self?.onSpeech() } }

    let heard: Bool = await withCheckedContinuation { c in
      take.done = { c.resume(returning: $0) }
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buf, _ in take.add(buf) }
      engine.prepare()
      do { try engine.start() } catch { take.finish(false) }
    }
    input.removeTap(onBus: 0)
    engine.stop()
    if self.take === take { self.take = nil }
    onLevel(0)
    defer { try? FileManager.default.removeItem(at: url) }
    guard heard else { return nil }
    take.close()
    return try Data(contentsOf: url)
  }

  func stopListening() { take?.finish(false) }

  // MARK: Speaking

  /// Plays one part of Mercury's answer; returns when it ends or is stopped (false when stopped).
  @discardableResult
  func play(_ audio: Data) async -> Bool {
    stopPlaying()
    guard let p = try? AVAudioPlayer(data: audio) else { return true }
    let end = PlaybackEnd()
    p.delegate = end
    player = p; finished = end
    return await withCheckedContinuation { c in
      end.done = { c.resume(returning: $0) }
      if !p.play() { end.finish(true) }
    }
  }

  func stopPlaying() {
    player?.stop()
    finished?.finish(false)
    player = nil; finished = nil
  }
}

/// One utterance being recorded, fed from the audio thread. It learns the room's noise
/// while nobody talks, starts keeping audio when the level rises well above it (with a
/// short lead-in so the first word isn't clipped), and ends after `quiet` seconds of calm.
final class Take: @unchecked Sendable {
  var onLevel: (Float) -> Void = { _ in }
  var onSpeech: () -> Void = {}
  var done: ((Bool) -> Void)?

  private let lock = NSLock()
  private var file: AVAudioFile?
  private let sampleRate: Double
  private var floor: Float = -60
  private var speaking = false
  private var calm: Double = 0
  private var length: Double = 0
  private var lead: [AVAudioPCMBuffer] = []
  private var over = false

  static let quiet = 0.9
  static let longest = 60.0

  init(file: AVAudioFile, sampleRate: Double) { self.file = file; self.sampleRate = sampleRate }

  func add(_ buf: AVAudioPCMBuffer) {
    lock.lock(); defer { lock.unlock() }
    guard !over else { return }
    let db = Self.decibels(buf)
    let seconds = Double(buf.frameLength) / sampleRate
    onLevel(max(0, min(1, (db + 60) / 50)))
    if !speaking {
      floor = floor * 0.95 + db * 0.05
      lead.append(buf); if lead.count > 8 { lead.removeFirst() }
      guard db > max(floor + 12, -48) else { return }
      speaking = true
      onSpeech()
      for b in lead { try? file?.write(from: b) }
      lead = []
      return
    }
    try? file?.write(from: buf)
    length += seconds
    calm = db < floor + 6 ? calm + seconds : 0
    if calm >= Self.quiet || length >= Self.longest { end(true) }
  }

  func finish(_ heard: Bool) {
    lock.lock(); defer { lock.unlock() }
    end(heard)
  }

  /// Closes the file so the WAV header is written (AVAudioFile does it on release).
  func close() { lock.lock(); file = nil; lead = []; lock.unlock() }

  private func end(_ heard: Bool) {
    guard !over else { return }
    over = true
    let d = done; done = nil
    d?(heard && speaking)
  }

  static func decibels(_ buf: AVAudioPCMBuffer) -> Float {
    guard let ch = buf.floatChannelData, buf.frameLength > 0 else { return -100 }
    let n = Int(buf.frameLength)
    var sum: Float = 0
    for i in 0..<n { sum += ch[0][i] * ch[0][i] }
    return 10 * log10(max(sum / Float(n), 1e-10))
  }
}

final class PlaybackEnd: NSObject, AVAudioPlayerDelegate, @unchecked Sendable {
  var done: ((Bool) -> Void)?
  func finish(_ ended: Bool) { let d = done; done = nil; d?(ended) }
  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { finish(true) }
  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { finish(true) }
}
