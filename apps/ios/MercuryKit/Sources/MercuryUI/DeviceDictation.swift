import Foundation
import AVFoundation
import Speech
import MercuryVoice

/// Dictation with the phone's own speech recognition, for when Mercury has no speech service (no
/// voice key at all) or is too old to dictate. `SFSpeechRecognizer`, on the device when it can
/// (`requiresOnDeviceRecognition`), fed the same microphone frames as the live engine (16 kHz mono
/// PCM16 from CallAudioEngine), reporting the same `DictationEvent`s, so DictationModel treats it
/// like the Rust `Dictation`.
///
/// Partial text is the recognition so far; when the recogniser finishes a stretch by itself (a
/// long pause) that text becomes final and a new stretch starts, so dictation carries on.
final class DeviceDictation: DictationProtocol, @unchecked Sendable {
  private let lock = NSLock()
  private let emit: @Sendable (DictationEvent) -> Void
  private let recognizer: SFSpeechRecognizer
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  /// The current stretch's text so far.
  private var text = ""
  private var stopping = false
  private var closed = false
  private var peak: Int16 = 0
  private var lastLevels = Date.distantPast

  static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!

  /// The phone can recognise speech now: a recogniser for its language that isn't refused.
  static func available(locale: Locale = .current) -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .denied, .restricted: return false
    default: return (SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer())?.isAvailable ?? false
    }
  }

  /// Asks once for Speech Recognition (NSSpeechRecognitionUsageDescription).
  static func authorize() async -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return true
    case .notDetermined:
      return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
    default: return false
    }
  }

  /// Starts recognising; `Connected` follows at once on the listener.
  init?(locale: Locale = .current, listener: @escaping @Sendable (DictationEvent) -> Void) {
    guard let r = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(), r.isAvailable else { return nil }
    recognizer = r
    emit = listener
    begin()
    emit(.connected)
  }

  /// A new stretch: a fresh request and task.
  private func begin() {
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    if #available(iOS 16, macOS 13, *) { req.addsPunctuation = true }
    lock.lock()
    request = req
    text = ""
    lock.unlock()
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      self?.handle(req, result, error)
    }
  }

  private func handle(_ req: SFSpeechAudioBufferRecognitionRequest, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
    lock.lock()
    guard !closed, req === request else { lock.unlock(); return }
    if let result {
      text = result.bestTranscription.formattedString
    }
    let now = text
    let done = result?.isFinal == true || error != nil
    let stopping = self.stopping
    if done && stopping { closed = true }
    lock.unlock()

    if !done {
      emit(.partial(text: now))
      return
    }
    if !now.isEmpty { emit(.final(text: now)) }
    if stopping {
      emit(.closed(reason: "stopped"))
    } else if let error, now.isEmpty, !Self.noSpeech(error) {
      lock.lock(); closed = true; lock.unlock()
      emit(.closed(reason: "this phone's speech recognition stopped (\(error.localizedDescription))"))
    } else {
      // The recogniser ended a stretch by itself: carry on listening.
      begin()
    }
  }

  /// "No speech detected" ends a stretch; it isn't a failure.
  private static func noSpeech(_ error: Error) -> Bool {
    let e = error as NSError
    return e.domain == "kAFAssistantErrorDomain" && [203, 1110].contains(e.code)
  }

  func pushAudio(pcm16: Data) {
    let count = pcm16.count / 2
    guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(count)) else { return }
    buffer.frameLength = AVAudioFrameCount(count)
    var loud: Int16 = 0
    pcm16.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      let out = buffer.floatChannelData![0]
      for i in 0..<count {
        let v = Int16(littleEndian: samples[i])
        out[i] = Float(v) / 32768
        let a = v == .min ? Int16.max : abs(v)
        if a > loud { loud = a }
      }
    }
    lock.lock()
    let req = closed || stopping ? nil : request
    peak = max(peak, loud)
    var level: Float?
    if Date.now.timeIntervalSince(lastLevels) >= 0.08 {
      level = peak > 300 ? Float(peak) / 32768 : 0
      peak = 0
      lastLevels = .now
    }
    lock.unlock()
    req?.append(buffer)
    if let level { emit(.levels(mic: level)) }
  }

  /// Stop listening: the last words are finalised, then `Closed("stopped")`.
  func stop() {
    lock.lock()
    guard !closed, !stopping else { lock.unlock(); return }
    stopping = true
    let req = request
    lock.unlock()
    req?.endAudio()
    // The recogniser normally answers within a second; don't wait for ever.
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [weak self] in self?.finishNow() }
  }

  private func finishNow() {
    lock.lock()
    guard !closed else { lock.unlock(); return }
    closed = true
    let rest = text
    lock.unlock()
    task?.cancel()
    if !rest.isEmpty { emit(.final(text: rest)) }
    emit(.closed(reason: "stopped"))
  }

  /// Stop now, dropping what isn't final.
  func cancel() {
    lock.lock()
    guard !closed else { lock.unlock(); return }
    closed = true
    lock.unlock()
    task?.cancel()
    emit(.closed(reason: "cancelled"))
  }
}
