package sh.mercuryagent.call

import android.os.SystemClock
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Is a "the owner started talking" from the voice, while Mercury is speaking, really the owner
 * (close to the phone), or someone talking nearby, a TV, a clatter? Pure and clocked by the
 * caller (seconds), so it's tested without audio. iOS: BargeInGate.swift, the same rules.
 *
 * It only ever decides whether Mercury's voice stops: the owner's audio always goes to the voice
 * untouched, and when Mercury isn't speaking nothing is judged at all.
 *
 * - Noise floor: follows the quietest level the microphone hears (falls fast, rises slowly), from
 *   the call's first moments and continuously after.
 * - The owner's level: learned while the owner talks and Mercury is quiet.
 * - Near: the last ~300 ms are well above the floor and not far below the owner's usual level.
 * - Not near yet: the barge-in waits a moment ([Tuning.patience]); if the near voice shows up,
 *   Mercury stops then. When the gate can't tell (not calibrated, no recent audio), it lets the
 *   barge-in through.
 */
class BargeInGate(val tuning: Tuning = Tuning()) {
  data class Tuning(
    /** Audio heard before the floor is trusted (s). */
    val calibration: Double = 1.5,
    /** How much recent audio a decision looks at (s). */
    val window: Double = 0.3,
    /** Near speech is at least this far above the noise floor (dB)… */
    val aboveFloor: Float = 9f,
    /** …and no more than this far below the owner's usual speaking level (dB). */
    val belowOwner: Float = 12f,
    /** Owner speech heard before the owner's level is trusted (s). */
    val ownerLearning: Double = 0.5,
    /** How long a held barge-in waits for the near voice (s). */
    val patience: Double = 1.5,
    /** The floor's time constants, falling and rising (s). */
    val floorFall: Double = 0.15,
    val floorRise: Double = 5.0,
    /** Audio older than this is no evidence (s). */
    val stale: Double = 0.5,
  )

  /** The noise floor and the owner's usual level, dBFS. */
  var floor: Float? = null; private set
  var owner: Float? = null; private set
  private var ownerHeard = 0.0
  private var firstAt: Double? = null
  private var lastAt: Double? = null
  private val recent = ArrayDeque<Pair<Double, Float>>()
  /** A barge-in held until this time, waiting for the near voice. */
  var heldUntil: Double? = null; private set

  /**
   * One microphone frame of [duration] seconds ending at [at]. True when a held barge-in should
   * happen now (the near voice showed up).
   */
  fun observe(level: Float, at: Double, duration: Double, ownerTalking: Boolean, mercuryAudible: Boolean): Boolean {
    if (firstAt == null) firstAt = at - duration
    lastAt = at
    val l = level.coerceIn(-100f, 0f)
    val f = floor
    floor = if (f == null) l else f + (l - f) * min(1.0, duration / (if (l < f) tuning.floorFall else tuning.floorRise)).toFloat()
    recent.addLast(at to power(l))
    while (recent.isNotEmpty() && at - recent.first().first > tuning.window) recent.removeFirst()
    // The owner's level: their voice while Mercury is quiet, well above the floor.
    val fl = floor
    val w = windowLevel(at)
    if (ownerTalking && !mercuryAudible && fl != null && w != null && w >= fl + tuning.aboveFloor) {
      owner = owner?.let { it + (w - it) * 0.1f } ?: w
      ownerHeard += duration
    }
    val until = heldUntil ?: return false
    if (!mercuryAudible || at > until) { heldUntil = null; return false }
    if (admits(at)) { heldUntil = null; return true }
    return false
  }

  /** Should a barge-in at [at] stop Mercury now? (Asked when Mercury is speaking.) */
  fun admits(at: Double): Boolean {
    val first = firstAt ?: return true
    val fl = floor ?: return true
    val last = lastAt ?: return true
    if (at - first < tuning.calibration || at - last > tuning.stale) return true
    val w = windowLevel(at) ?: return true
    if (w < fl + tuning.aboveFloor) return false
    val o = owner
    if (o != null && ownerHeard >= tuning.ownerLearning && w < o - tuning.belowOwner) return false
    return true
  }

  /** Hold a barge-in the gate didn't admit: it happens if the near voice shows up soon. */
  fun hold(at: Double) { heldUntil = at + tuning.patience }
  fun release() { heldUntil = null }

  /** The recent audio's level, dBFS (power average), or null with none. */
  fun windowLevel(at: Double): Float? {
    val r = recent.filter { at - it.first <= tuning.window }
    if (r.isEmpty()) return null
    val p = r.sumOf { it.second.toDouble() } / r.size
    return if (p > 0) max(-100f, (10 * log10(p)).toFloat()) else -100f
  }

  companion object {
    private fun power(db: Float): Float = 10f.pow(db / 10f)

    /** Level of a frame of PCM16 LE bytes, dBFS (RMS; silence is -100). */
    fun level(pcm16: ByteArray, len: Int = pcm16.size): Float {
      val n = len / 2
      if (n == 0) return -100f
      var sum = 0.0
      for (i in 0 until n) {
        val s = ((pcm16[2 * i].toInt() and 0xFF) or (pcm16[2 * i + 1].toInt() shl 8)).toShort()
        val v = s / 32768.0
        sum += v * v
      }
      val rms = sqrt(sum / n)
      return if (rms > 0) max(-100f, (20 * log10(rms)).toFloat()) else -100f
    }
  }
}

/** What the call brain asks before it stops Mercury for a barge-in. */
interface BargeInJudge {
  /** Is the owner (close to the phone) the one talking? True when unsure. */
  fun admits(): Boolean
  /** Not admitted: watch for the near voice for a moment ([CallBrain.bargeInDue] follows if it shows). */
  fun hold()
  /** Stop watching (Mercury went quiet, or the barge-in happened). */
  fun release()
  fun setOwnerTalking(on: Boolean)
}

/**
 * The gate on a live call: fed every microphone frame from the microphone thread, asked by the
 * brain on the main thread. Off (everything admitted) for voices whose server already cut Mercury
 * off when it heard speech (Gemini Live): there's nothing left to save by waiting.
 */
class CallBargeIn(
  private val enabled: Boolean,
  private val clock: () -> Double = { SystemClock.elapsedRealtime() / 1000.0 },
) : BargeInJudge {
  private val gate = BargeInGate()
  @Volatile private var ownerTalking = false
  /** Is Mercury audible (the player has audio queued)? Read on the microphone thread. */
  @Volatile var mercuryAudible: () -> Boolean = { false }
  /** A held barge-in is due: the near voice showed up (on the microphone thread). */
  @Volatile var onDue: (() -> Unit)? = null

  /** A microphone frame: 16 kHz mono PCM16 LE. */
  fun frame(pcm16: ByteArray) {
    if (!enabled) return
    val level = BargeInGate.level(pcm16)
    val duration = pcm16.size / 2 / 16_000.0
    val audible = mercuryAudible()
    val due = synchronized(gate) { gate.observe(level, clock(), duration, ownerTalking, audible) }
    if (due) onDue?.invoke()
  }

  override fun admits(): Boolean = !enabled || synchronized(gate) { gate.admits(clock()) }
  override fun hold() { synchronized(gate) { gate.hold(clock()) } }
  override fun release() { synchronized(gate) { gate.release() } }
  override fun setOwnerTalking(on: Boolean) { ownerTalking = on }

  companion object {
    /** The engine whose server leaves interrupting to the phone (OpenAI Realtime on a phone call). */
    fun judges(engine: String): Boolean = engine == "openai"
  }
}
