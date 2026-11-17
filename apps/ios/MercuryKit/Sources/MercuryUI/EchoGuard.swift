import Foundation

/// Keeps Mercury's own voice from interrupting itself. On a speakerphone call some of Mercury's
/// voice comes back into the microphone even after echo cancellation; a live voice service hears
/// it as the caller starting to talk and stops Mercury mid-word (a call log showed 22 of these in a
/// few calls, 0.2–1 s after Mercury began). So, only while Mercury is audible, a microphone frame
/// goes up only when it's clearly a near voice; otherwise silence goes up in its place.
///
/// - When Mercury isn't audible, every frame goes up untouched: the caller is never gated.
/// - A near voice for `openAfter` (about 180 ms) opens the way: the frames held back go up first
///   (no lost words), Mercury is told to stop (`opened`), and it stays open while the caller talks
///   and for `hangover` after.
/// - Near: at least `aboveFloor` dB over the room's noise floor (learned while Mercury is quiet),
///   at least `minLevel` dBFS, and, once the caller's level is known, not far below it.
/// Pure and clocked by the caller, so it's tested without audio. Android: EchoGuard.kt.
struct EchoGuard {
  struct Tuning {
    var aboveFloor: Float = 12
    var minLevel: Float = -40
    var belowOwner: Float = 14
    var openAfter: TimeInterval = 0.18
    var hangover: TimeInterval = 0.8
    var floorFall: TimeInterval = 0.15
    var floorRise: TimeInterval = 5
    var held: Int = 6
  }
  enum Out: Equatable {
    /// Send these frames (the held-back ones, then this one).
    case send([Data])
    /// Send silence of this many bytes.
    case silence(Int)
  }

  var tuning = Tuning()
  private(set) var floor: Float?
  private(set) var owner: Float?
  private(set) var openUntil: TimeInterval?
  private var nearSince: TimeInterval?
  private var heldFrames: [Data] = []
  /// Loudest frame heard while Mercury was audible and the way stayed shut (for the call log).
  private(set) var loudestShut: Float = -100
  init(tuning: Tuning = Tuning()) { self.tuning = tuning }

  /// One microphone frame (`level` dBFS, `duration` s, ending `at`). `opened` is true when this
  /// frame opened the way while Mercury was audible (the caller is talking over Mercury).
  mutating func frame(_ data: Data, level rawLevel: Float, duration: TimeInterval, at: TimeInterval,
                      mercuryAudible: Bool, ownerTalking: Bool) -> (out: Out, opened: Bool) {
    let level = max(-100, min(0, rawLevel))
    if !mercuryAudible {
      // The room's floor and the caller's level are learned only while Mercury is quiet.
      if let f = floor {
        let tau = level < f ? tuning.floorFall : tuning.floorRise
        floor = f + (level - f) * Float(min(1, duration / tau))
      } else {
        floor = level
      }
      if ownerTalking, let f = floor, level >= f + tuning.aboveFloor {
        owner = owner.map { $0 + (level - $0) * 0.1 } ?? level
      }
      nearSince = nil
      heldFrames.removeAll()
      openUntil = nil
      return (.send([data]), false)
    }
    // Mercury is audible.
    let near = isNear(level)
    if let until = openUntil, at <= until {
      if near { openUntil = at + tuning.hangover }
      return (.send([data]), false)
    }
    openUntil = nil
    if near {
      if nearSince == nil { nearSince = at - duration }
      heldFrames.append(data)
      if heldFrames.count > tuning.held { heldFrames.removeFirst() }
      if let since = nearSince, at - since >= tuning.openAfter {
        openUntil = at + tuning.hangover
        let out = heldFrames
        heldFrames.removeAll(); nearSince = nil
        return (.send(out), true)
      }
      return (.silence(data.count), false)
    }
    nearSince = nil
    heldFrames.removeAll()
    loudestShut = max(loudestShut, level)
    return (.silence(data.count), false)
  }

  func isNear(_ level: Float) -> Bool {
    guard level >= tuning.minLevel else { return false }
    if let f = floor, level < f + tuning.aboveFloor { return false }
    if let o = owner, level < o - tuning.belowOwner { return false }
    return true
  }

  /// Reads and resets the loudest shut-out level (for the call log).
  mutating func takeLoudestShut() -> Float { defer { loudestShut = -100 }; return loudestShut }
}

/// The guard on a live call: fed every microphone frame on the audio thread.
final class CallEchoGuard: @unchecked Sendable {
  private let lock = NSLock()
  private var guardState = EchoGuard()
  private let clock: () -> TimeInterval
  var mercuryAudible: () -> Bool = { false }
  var ownerTalking: () -> Bool = { false }
  /// The caller started talking over Mercury (on the audio thread).
  var onOpened: (@Sendable () -> Void)?

  init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) { self.clock = clock }

  /// What to send up for this frame (16 kHz mono PCM16 LE).
  func filter(_ pcm16: Data) -> [Data] {
    let level = BargeInGate.level(pcm16: pcm16)
    let duration = Double(pcm16.count / 2) / 16_000
    let audible = mercuryAudible()
    let talking = ownerTalking()
    lock.lock()
    let (out, opened) = guardState.frame(pcm16, level: level, duration: duration, at: clock(), mercuryAudible: audible, ownerTalking: talking)
    lock.unlock()
    if opened { CallLog.note(String(format: "echo guard opened at %.1f dBFS (caller talking over Mercury)", level)); onOpened?() }
    switch out {
    case .send(let frames): return frames
    case .silence(let n): CallLog.count("mic.shut"); return [Data(count: n)]
    }
  }

  /// For the call log: the room floor, the caller's level and the loudest echo kept out.
  func summary() -> String {
    lock.lock(); defer { lock.unlock() }
    let loud = guardState.takeLoudestShut()
    return String(format: "floor=%.0f owner=%@ echoMax=%.0f", guardState.floor ?? -100, guardState.owner.map { String(format: "%.0f", $0) } ?? "-", loud)
  }
}

extension CallEchoGuard {
  /// The way is open now (the caller is talking over Mercury).
  var isOpen: Bool { lock.lock(); defer { lock.unlock() }; return guardState.openUntil.map { clock() <= $0 } ?? false }
}

/// Decides a "the caller started talking" while Mercury is audible: the echo guard must have heard
/// the near voice (Gemini Live), and on OpenAI calls the level gate must agree too. It also tells
/// both whether the caller is talking (for learning their level).
final class CallTalkOverJudge: BargeInJudge, @unchecked Sendable {
  private let echo: CallEchoGuard
  private let gate: CallBargeIn?
  private let lock = NSLock()
  private var talking = false
  init(echo: CallEchoGuard, gate: CallBargeIn?) { self.echo = echo; self.gate = gate }
  var ownerTalking: Bool { lock.lock(); defer { lock.unlock() }; return talking }
  func admits() -> Bool { echo.isOpen && (gate?.admits() ?? true) }
  func hold() { gate?.hold() }
  func release() { gate?.release() }
  func setOwnerTalking(_ on: Bool) { lock.lock(); talking = on; lock.unlock(); gate?.setOwnerTalking(on) }
}
