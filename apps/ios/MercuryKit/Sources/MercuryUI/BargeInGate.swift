import Foundation

/// Is a "the owner started talking" from the voice, while Mercury is speaking, really the owner
/// (close to the phone), or someone talking nearby, a TV, a clatter? Pure and clocked by the
/// caller, so it's tested without audio. Android: BargeInGate.kt, the same rules.
///
/// It only ever decides whether Mercury's voice stops: the owner's audio always goes to the voice
/// untouched, and when Mercury isn't speaking nothing is judged at all.
///
/// - Noise floor: follows the quietest level the microphone hears (falls fast, rises slowly), from
///   the call's first moments and continuously after.
/// - The owner's level: learned while the owner talks and Mercury is quiet.
/// - Near: the last ~300 ms are well above the floor and not far below the owner's usual level.
/// - Not near yet: the barge-in waits a moment (`patience`); if the near voice shows up, Mercury
///   stops then. When the gate can't tell (not calibrated, no recent audio), it lets the barge-in through.
struct BargeInGate {
  struct Tuning {
    /// Audio heard before the floor is trusted.
    var calibration: TimeInterval = 1.5
    /// How much recent audio a decision looks at.
    var window: TimeInterval = 0.3
    /// Near speech is at least this far above the noise floor (dB).
    var aboveFloor: Float = 9
    /// …and no more than this far below the owner's usual speaking level (dB).
    var belowOwner: Float = 12
    /// Owner speech heard before the owner's level is trusted.
    var ownerLearning: TimeInterval = 0.5
    /// How long a held barge-in waits for the near voice.
    var patience: TimeInterval = 1.5
    /// The floor's time constants: falling, rising.
    var floorFall: TimeInterval = 0.15
    var floorRise: TimeInterval = 5
    /// Audio older than this is no evidence.
    var stale: TimeInterval = 0.5
  }

  var tuning = Tuning()
  /// The noise floor and the owner's usual level, dBFS.
  private(set) var floor: Float?
  private(set) var owner: Float?
  private var ownerHeard: TimeInterval = 0
  private var firstAt: TimeInterval?
  private var lastAt: TimeInterval?
  private var recent: [(at: TimeInterval, power: Float)] = []
  /// A barge-in held until this time, waiting for the near voice.
  private(set) var heldUntil: TimeInterval?

  init(tuning: Tuning = Tuning()) { self.tuning = tuning }

  /// Level of a frame of PCM16 samples, dBFS (RMS; silence is -100).
  static func level(_ samples: UnsafeBufferPointer<Int16>) -> Float {
    guard !samples.isEmpty else { return -100 }
    var sum: Double = 0
    for s in samples { let v = Double(s) / 32768; sum += v * v }
    let rms = (sum / Double(samples.count)).squareRoot()
    return rms > 0 ? max(-100, Float(20 * log10(rms))) : -100
  }

  static func level(pcm16 data: Data) -> Float {
    data.withUnsafeBytes { raw in
      let s = raw.bindMemory(to: Int16.self)
      return level(UnsafeBufferPointer(start: s.baseAddress, count: data.count / 2))
    }
  }

  /// One microphone frame of `duration` seconds ending at `at`. True when a held barge-in should
  /// happen now (the near voice showed up).
  mutating func observe(level: Float, at: TimeInterval, duration: TimeInterval, ownerTalking: Bool, mercuryAudible: Bool) -> Bool {
    if firstAt == nil { firstAt = at - duration }
    lastAt = at
    let l = max(-100, min(0, level))
    if let f = floor {
      let tau = l < f ? tuning.floorFall : tuning.floorRise
      floor = f + (l - f) * Float(min(1, duration / tau))
    } else {
      floor = l
    }
    recent.append((at, Self.power(l)))
    recent.removeAll { at - $0.at > tuning.window }
    // The owner's level: their voice while Mercury is quiet, well above the floor.
    if ownerTalking && !mercuryAudible, let f = floor, let w = windowLevel(at: at), w >= f + tuning.aboveFloor {
      owner = owner.map { $0 + (w - $0) * 0.1 } ?? w
      ownerHeard += duration
    }
    guard let until = heldUntil else { return false }
    if !mercuryAudible || at > until { heldUntil = nil; return false }
    if admits(at: at) { heldUntil = nil; return true }
    return false
  }

  /// Should a barge-in at `at` stop Mercury now? (Called when Mercury is speaking.)
  func admits(at: TimeInterval) -> Bool {
    guard let firstAt, let floor, let lastAt, at - firstAt >= tuning.calibration, at - lastAt <= tuning.stale,
          let w = windowLevel(at: at) else { return true }
    guard w >= floor + tuning.aboveFloor else { return false }
    if let owner, ownerHeard >= tuning.ownerLearning, w < owner - tuning.belowOwner { return false }
    return true
  }

  /// Hold a barge-in the gate didn't admit: it happens if the near voice shows up soon.
  mutating func hold(at: TimeInterval) { heldUntil = at + tuning.patience }
  mutating func release() { heldUntil = nil }

  /// The recent audio's level, dBFS (power average), or nil with none.
  func windowLevel(at: TimeInterval) -> Float? {
    let r = recent.filter { at - $0.at <= tuning.window }
    guard !r.isEmpty else { return nil }
    let p = r.reduce(Float(0)) { $0 + $1.power } / Float(r.count)
    return p > 0 ? max(-100, 10 * log10(p)) : -100
  }

  private static func power(_ db: Float) -> Float { pow(10, db / 10) }
}

/// The gate on a live call: fed every microphone frame from the audio thread, asked by the brain
/// on the main thread. Off (everything admitted) for voices whose server already cut Mercury off
/// when it heard speech (Gemini Live): there's nothing left to save by waiting.
final class CallBargeIn: @unchecked Sendable {
  private let lock = NSLock()
  private var gate = BargeInGate()
  private var ownerTalking = false
  private let enabled: Bool
  private let clock: () -> TimeInterval
  /// Is Mercury audible (the player has audio queued)? Read on the audio thread.
  var mercuryAudible: () -> Bool = { false }
  /// A held barge-in is due: the near voice showed up (on the audio thread).
  var onDue: (@Sendable () -> Void)?

  init(enabled: Bool, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.enabled = enabled
    self.clock = clock
  }

  /// The engine whose server leaves interrupting to the phone (OpenAI Realtime on a phone call).
  static func judges(engine: String) -> Bool { engine == "openai" }

  /// A microphone frame: 16 kHz mono PCM16 LE.
  func frame(_ pcm16: Data) {
    guard enabled else { return }
    let level = BargeInGate.level(pcm16: pcm16)
    let duration = Double(pcm16.count / 2) / 16_000
    let audible = mercuryAudible()
    lock.lock()
    let due = gate.observe(level: level, at: clock(), duration: duration, ownerTalking: ownerTalking, mercuryAudible: audible)
    lock.unlock()
    if due { onDue?() }
  }

  func setOwnerTalking(_ on: Bool) { lock.lock(); ownerTalking = on; lock.unlock() }
}

extension CallBargeIn: BargeInJudge {
  func admits() -> Bool {
    guard enabled else { return true }
    lock.lock(); defer { lock.unlock() }
    return gate.admits(at: clock())
  }

  func hold() { lock.lock(); gate.hold(at: clock()); lock.unlock() }
  func release() { lock.lock(); gate.release(); lock.unlock() }
}

/// What the call brain asks before it stops Mercury for a barge-in.
protocol BargeInJudge: AnyObject {
  /// Is the owner (close to the phone) the one talking? True when unsure.
  func admits() -> Bool
  /// Not admitted: watch for the near voice for a moment (`CallBrain.bargeInDue` follows if it shows).
  func hold()
  /// Stop watching (Mercury went quiet, or the barge-in happened).
  func release()
  func setOwnerTalking(_ on: Bool)
}
