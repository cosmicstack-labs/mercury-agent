package sh.mercuryagent.call

import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sqrt

/** The voice engine's audio: 16 kHz mono PCM16, little-endian, both ways (iOS: CallPCM.swift). */
object Pcm {
  const val RATE = 16_000
  /** 60 ms at 16 kHz: the frame the voice links use. */
  const val FRAME = 960

  /** Samples to PCM16 LE bytes. */
  fun bytes(samples: ShortArray, from: Int = 0, count: Int = samples.size - from): ByteArray {
    val out = ByteArray(count * 2)
    for (i in 0 until count) {
      val s = samples[from + i].toInt()
      out[2 * i] = (s and 0xFF).toByte()
      out[2 * i + 1] = ((s shr 8) and 0xFF).toByte()
    }
    return out
  }

  /** PCM16 LE bytes to samples (an odd trailing byte is ignored). */
  fun samples(data: ByteArray): ShortArray {
    val n = data.size / 2
    return ShortArray(n) { i -> ((data[2 * i].toInt() and 0xFF) or (data[2 * i + 1].toInt() shl 8)).toShort() }
  }

  /** Float samples (-1…1, clipped) to PCM16. */
  fun fromFloats(samples: FloatArray): ShortArray = ShortArray(samples.size) { i ->
    val v = samples[i].coerceIn(-1f, 1f)
    (if (v < 0) v * 32768f else v * 32767f).toInt().toShort()
  }

  /** The loudest sample, 0…1. */
  fun peak(samples: ShortArray, from: Int = 0, count: Int = samples.size - from): Float {
    var p = 0
    for (i in from until from + count) p = maxOf(p, abs(samples[i].toInt()))
    return min(p / 32768f, 1f)
  }

  /** The loudest sample of PCM16 LE bytes, 0…1. */
  fun peak(data: ByteArray, from: Int = 0, length: Int = data.size - from): Float {
    var p = 0
    var i = from
    val end = from + length - 1
    while (i < end) {
      p = maxOf(p, abs(((data[i].toInt() and 0xFF) or (data[i + 1].toInt() shl 8)).toShort().toInt()))
      i += 2
    }
    return min(p / 32768f, 1f)
  }

  /** A peak as the orb shows it: speech peaks sit around 0.1–0.5, so it's lifted and capped. */
  fun display(peak: Float): Float = min(1f, sqrt(maxOf(0f, peak)) * 1.25f)

  /** How long PCM16 bytes play, in milliseconds. */
  fun millis(bytes: Int): Long = bytes / 2 * 1000L / RATE
}

/** Collects microphone samples and hands them on in whole 60 ms frames. */
class PcmFramer(val frame: Int = Pcm.FRAME) {
  private var pending = ShortArray(frame * 4)
  private var count = 0

  val pendingCount: Int get() = count

  /** The whole frames now ready, as PCM16 LE; the remainder waits for more. */
  fun append(samples: ShortArray, n: Int = samples.size): List<ByteArray> {
    if (count + n > pending.size) pending = pending.copyOf(maxOf(pending.size * 2, count + n))
    System.arraycopy(samples, 0, pending, count, n)
    count += n
    if (count < frame) return emptyList()
    val out = ArrayList<ByteArray>(count / frame)
    var start = 0
    while (count - start >= frame) {
      out += Pcm.bytes(pending, start, frame)
      start += frame
    }
    System.arraycopy(pending, start, pending, 0, count - start)
    count -= start
    return out
  }

  fun reset() { count = 0 }
}

/**
 * Voice levels, 0…1, for the orb: written from the audio threads (and the engine's `levels`
 * events), read every frame by the orb. Not Compose state on purpose: nothing recomposes per level.
 */
class CallMeter(private val clock: () -> Long = { System.nanoTime() / 1_000_000 }) {
  private var mic = 0f; private var voice = 0f
  private var micAt = Long.MIN_VALUE / 2; private var voiceAt = Long.MIN_VALUE / 2
  private var engineMic = 0f; private var engineVoice = 0f; private var engineAt = Long.MIN_VALUE / 2

  @Synchronized fun setMic(v: Float) { mic = v; micAt = clock() }
  @Synchronized fun setVoice(v: Float) { voice = v; voiceAt = clock() }
  @Synchronized fun setEngine(mic: Float, voice: Float) { engineMic = mic; engineVoice = voice; engineAt = clock() }
  @Synchronized fun reset() { mic = 0f; voice = 0f; engineMic = 0f; engineVoice = 0f }

  /** The latest levels: the phone's own meters, else the engine's; stale readings fade to 0. */
  @Synchronized fun read(): Pair<Float, Float> {
    val now = clock()
    fun fresh(v: Float, at: Long) = if (now - at < 250) v else 0f
    val engineFresh = now - engineAt < 300
    return maxOf(fresh(mic, micAt), if (engineFresh) Pcm.display(engineMic) else 0f) to
      maxOf(fresh(voice, voiceAt), if (engineFresh) Pcm.display(engineVoice) else 0f)
  }
}
