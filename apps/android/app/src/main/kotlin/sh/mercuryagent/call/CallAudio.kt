package sh.mercuryagent.call

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.MicrophoneDirection
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The phone's side of a live call (iOS: CallAudioEngine): the microphone (AudioRecord, the
 * voice-communication source with the phone's echo canceller, noise suppressor and gain control
 * when it has them, aimed at the owner) as 60 ms frames of 16 kHz PCM16 for the voice engine, and Mercury's voice played as it
 * arrives (AudioTrack, voice-communication usage) with nothing buffered beyond what the engine
 * sent. A barge-in or an interrupt flushes playback at once. Dictation uses the microphone half only.
 */
class CallAudio(
  private val meter: CallMeter,
  /** MediaRecorder.AudioSource: VOICE_COMMUNICATION for calls, VOICE_RECOGNITION for dictation. */
  private val source: Int = MediaRecorder.AudioSource.VOICE_COMMUNICATION,
  private val withPlayback: Boolean = true,
) : CallPlayback {
  /** Each 60 ms microphone frame (PCM16 LE), on the microphone thread. */
  @Volatile var frameSink: ((ByteArray) -> Unit)? = null
  /** Mercury became audible (true) or went quiet (false), on the playback thread (or the flusher's). */
  @Volatile var playbackSink: ((Boolean) -> Unit)? = null

  @Volatile private var running = false
  @Volatile private var muted = false
  private var record: AudioRecord? = null
  private var track: AudioTrack? = null
  private val effects = mutableListOf<AudioEffect>()
  private var micThread: Thread? = null
  private var playThread: Thread? = null

  // Playback, guarded by `lock`.
  private val lock = Any()
  private class Chunk(val generation: Int, val pcm: ByteArray)
  private val queue = LinkedBlockingQueue<Chunk>()
  private var generation = 0
  /** Until when (elapsed ms) what's been written keeps playing. */
  private var playUntil = 0L
  private var playing = false

  /** Opens the microphone (and the player) and starts them. False when the microphone can't open. */
  @SuppressLint("MissingPermission") // The call and dictation ask for RECORD_AUDIO before they start.
  fun start(): Boolean {
    if (running) return true
    val minIn = AudioRecord.getMinBufferSize(Pcm.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val r = try {
      AudioRecord(source, Pcm.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minIn, Pcm.FRAME * 2 * 4))
    } catch (e: Exception) {
      Log.w(TAG, "mic: ${e.message}"); return false
    }
    if (r.state != AudioRecord.STATE_INITIALIZED) { r.release(); return false }
    // The phone's own echo cancellation, noise suppression and gain control on this recording's
    // session, where it has them (VOICE_COMMUNICATION often inserts them already; enabling is harmless).
    effects += listOfNotNull(
      effect("echo canceller", AcousticEchoCanceler.isAvailable()) { AcousticEchoCanceler.create(r.audioSessionId) },
      effect("noise suppressor", NoiseSuppressor.isAvailable()) { NoiseSuppressor.create(r.audioSessionId) },
    )
    // Calls only (dictation's recognition source stays as it was): a steady level, aimed at the owner.
    if (source == MediaRecorder.AudioSource.VOICE_COMMUNICATION) {
      effect("gain control", AutomaticGainControl.isAvailable()) { AutomaticGainControl.create(r.audioSessionId) }?.let { effects += it }
      preferNearUser(r)
    }
    try { r.startRecording() } catch (e: Exception) { Log.w(TAG, "mic start: ${e.message}") }
    if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) { releaseEffects(); r.release(); return false }
    record = r
    if (withPlayback) track = makeTrack()?.also { runCatching { it.play() } }
    running = true
    micThread = Thread({ captureLoop(r) }, "mercury-call-mic").also { it.start() }
    if (track != null) playThread = Thread({ playLoop() }, "mercury-call-play").also { it.start() }
    return true
  }

  fun stop() {
    if (!running && record == null) return
    running = false
    flush()
    micThread?.join(500); playThread?.join(500)
    micThread = null; playThread = null
    record?.let { runCatching { it.stop() }; it.release() }
    record = null
    synchronized(lock) { track?.let { runCatching { it.stop() }; it.release() }; track = null }
    releaseEffects()
    meter.reset()
  }

  fun setMuted(on: Boolean) {
    muted = on
    if (on) meter.setMic(0f)
  }

  /** Creates and enables one of the phone's audio effects, and logs what this phone has. */
  private fun effect(name: String, available: Boolean, create: () -> AudioEffect?): AudioEffect? {
    if (!available) { Log.i(TAG, "mic: no $name on this phone"); return null }
    val e = runCatching { create() }.getOrNull()
    if (e == null) { Log.i(TAG, "mic: $name couldn't be created"); return null }
    val was = runCatching { e.enabled }.getOrDefault(false)
    val status = runCatching { e.setEnabled(true) }.getOrDefault(AudioEffect.ERROR)
    val on = runCatching { e.enabled }.getOrDefault(false)
    Log.i(TAG, "mic: $name ${if (on) "on" else "off (status $status)"}${if (was) ", already on by default" else ""}")
    return e
  }

  /**
   * A call is spoken into the phone from the front: ask for the microphone side facing the owner
   * and a somewhat narrower pickup (Android 10+, honoured where the phone's audio supports it), so
   * people and noise around carry less. A gentle zoom: an owner holding the phone off-axis is still heard.
   */
  private fun preferNearUser(r: AudioRecord) {
    val dir = runCatching { r.setPreferredMicrophoneDirection(MicrophoneDirection.MIC_DIRECTION_TOWARDS_USER) }.getOrDefault(false)
    val zoom = runCatching { r.setPreferredMicrophoneFieldDimension(NEAR_ZOOM) }.getOrDefault(false)
    Log.i(TAG, "mic: towards the owner ${if (dir) "set" else "not supported"}, narrower pickup ${if (zoom) "set" else "not supported"}")
  }

  private fun releaseEffects() { effects.forEach { runCatching { it.release() } }; effects.clear() }

  private fun makeTrack(): AudioTrack? = try {
    val minOut = AudioTrack.getMinBufferSize(Pcm.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    AudioTrack.Builder()
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setAudioFormat(AudioFormat.Builder().setSampleRate(Pcm.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
      .setBufferSizeInBytes(maxOf(minOut, Pcm.RATE * 2 / 5)) // ~200 ms
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
      .takeIf { it.state == AudioTrack.STATE_INITIALIZED }
  } catch (e: Exception) {
    Log.w(TAG, "player: ${e.message}"); null
  }

  // MARK: Up: the owner's voice

  private fun captureLoop(r: AudioRecord) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val framer = PcmFramer()
    val buf = ShortArray(Pcm.RATE / 50) // 20 ms reads
    while (running) {
      val n = r.read(buf, 0, buf.size)
      if (n <= 0) { if (n < 0) SystemClock.sleep(10); continue }
      for (f in framer.append(buf, n)) {
        if (!muted) meter.setMic(Pcm.display(Pcm.peak(f)))
        frameSink?.invoke(f)
      }
    }
  }

  // MARK: Down: Mercury's voice

  override val isPlaying: Boolean
    get() = synchronized(lock) { playing || queue.isNotEmpty() }

  /** Plays engine audio (16 kHz mono PCM16 LE) right after what's already queued. */
  fun play(pcm: ByteArray) {
    if (pcm.size < 2 || !withPlayback) return
    val sink: ((Boolean) -> Unit)?
    synchronized(lock) {
      queue.put(Chunk(generation, pcm))
      sink = if (!playing) { playing = true; playbackSink } else null
    }
    sink?.invoke(true)
  }

  override fun flush() {
    val sink: ((Boolean) -> Unit)?
    synchronized(lock) {
      generation++
      queue.clear()
      track?.let { t -> runCatching { t.pause(); t.flush(); if (running) t.play() } }
      playUntil = 0
      sink = if (playing) { playing = false; playbackSink } else null
    }
    meter.setVoice(0f)
    sink?.invoke(false)
  }

  private fun playLoop() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val piece = Pcm.RATE / 50 * 2 // write 20 ms at a time, so a flush cuts in quickly
    while (running) {
      val chunk = queue.poll(40, TimeUnit.MILLISECONDS)
      if (chunk == null) {
        // Nothing queued: once what was written has played, Mercury is quiet.
        val sink = synchronized(lock) {
          if (playing && queue.isEmpty() && SystemClock.elapsedRealtime() > playUntil + LATENCY_MS) { playing = false; playbackSink } else null
        }
        if (sink != null) { meter.setVoice(0f); sink(false) }
        continue
      }
      var off = 0
      while (off < chunk.pcm.size && running) {
        val len = minOf(piece, chunk.pcm.size - off)
        val wrote = synchronized(lock) {
          if (chunk.generation != generation) return@synchronized -1
          val t = track ?: return@synchronized -1
          val w = t.write(chunk.pcm, off, len, AudioTrack.WRITE_NON_BLOCKING)
          if (w > 0) playUntil = maxOf(playUntil, SystemClock.elapsedRealtime()) + Pcm.millis(w)
          w
        }
        if (wrote < 0) break
        if (wrote == 0) { SystemClock.sleep(10); continue }
        meter.setVoice(Pcm.display(Pcm.peak(chunk.pcm, off, wrote)))
        off += wrote
      }
    }
  }

  private companion object {
    const val TAG = "MercuryCall"
    /** The player's own buffer, on top of what's been written. */
    const val LATENCY_MS = 150L
    /** Microphone field dimension: -1 wide, 0 normal, 1 narrowest. */
    const val NEAR_ZOOM = 0.5f
  }
}
