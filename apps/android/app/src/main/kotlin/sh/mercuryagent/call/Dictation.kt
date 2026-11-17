package sh.mercuryagent.call

import android.content.Context
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.mercury.voice.Dictation
import app.mercury.voice.DictationConfig
import app.mercury.voice.DictationEvent
import app.mercury.voice.DictationListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.mercuryagent.core.DictationSession
import sh.mercuryagent.core.DictationStart
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.VoiceCapabilities
import sh.mercuryagent.core.dictationSession

/**
 * Live dictation in the message box (iOS: DictationModel): the owner talks and the words appear as
 * they speak. The microphone is [CallAudio]'s (60 ms frames of 16 kHz PCM16); the speech to text is
 * Mercury's shared Rust engine (`Dictation`) with a short-lived token from the Mercury
 * (POST /api/mobile/voice/dictation). The mic starts on the tap, while the token and the stream
 * come up; what's said meanwhile is kept and sent once the stream is open. Partial text shows as
 * it's heard and is replaced by the final text; both go after what was already typed
 * ([DictationText]). Tap again to stop; sending, a call, or 60 s of quiet stop it too. Main thread only.
 */
class DictationModel(
  private val context: Context,
  private val client: MercuryClient,
  private val draft: TextFieldState,
  private val calls: CallManager,
  private val scope: CoroutineScope,
) {
  enum class Phase { Idle, Starting, Listening, Stopping }

  var phase by mutableStateOf(Phase.Idle); private set
  /** From GET /api/mobile/voice/capabilities; null until known. */
  var capabilities by mutableStateOf<VoiceCapabilities?>(null); private set
  /** Shown above the composer: why the mic is greyed out, or why dictation stopped. */
  var notice by mutableStateOf<String?>(null)
  val meter = CallMeter()

  private val haptics = CallHaptics(context)
  private val main = Handler(Looper.getMainLooper())
  private var text: DictationText? = null
  private var audio: CallAudio? = null
  private var relay: DictationRelay? = null
  private var session: Dictation? = null
  private var prefetched: DictationSession? = null
  private var watchdog: Job? = null
  private var lastHeard = 0L
  private var stoppingSince = 0L
  /** Bumped on every start and stop, so a late token or event from an earlier dictation is ignored. */
  private var generation = 0

  val active: Boolean get() = phase != Phase.Idle
  /** A voice call runs: the mic belongs to it. */
  val callRunning: Boolean get() = calls.running
  /** The mic button works: this Mercury can dictate and no call has the mic. */
  val available: Boolean get() = capabilities?.dictation == true && !callRunning

  /** Why the mic is greyed out, in plain words (null while it isn't known yet). */
  val unavailableReason: String?
    get() {
      if (callRunning) return "Dictation is off during a voice call."
      val c = capabilities ?: return null
      return if (c.dictation) null else c.setupLine
    }

  /** Asks the Mercury what it can do, and gets a token ready so the first tap starts at once. */
  suspend fun load() {
    capabilities = calls.capabilities(client) ?: capabilities
    if (capabilities?.dictation == true && prefetched?.fresh() != true) {
      (runCatching { client.dictationSession() }.getOrNull() as? DictationStart.Live)?.let { prefetched = it.session }
    }
  }

  // MARK: The button

  /** The mic was tapped (the microphone permission is granted). */
  fun tap() {
    if (active) { stop(); return }
    if (!available) {
      notice = unavailableReason ?: VoiceCapabilities.DEFAULT_DICTATION_SETUP
      haptics.play(CallHaptic.Failed)
      return
    }
    start()
  }

  fun start() {
    if (phase != Phase.Idle) return
    val gen = ++generation
    notice = null
    phase = Phase.Starting
    haptics.play(CallHaptic.DictationStarted)
    text = DictationText(draft.text.toString())
    lastHeard = SystemClock.elapsedRealtime()
    val relay = DictationRelay()
    this.relay = relay
    val engine = CallAudio(meter, MediaRecorder.AudioSource.VOICE_RECOGNITION, withPlayback = false)
    audio = engine
    engine.frameSink = { relay.push(it) }
    scope.launch {
      val ok = withContext(Dispatchers.Default) { engine.start() }
      if (!ok) fail("Couldn't open the microphone.", gen)
    }
    scope.launch { connect(gen, relay) }
    watch(gen)
  }

  /** Stop listening: the last words are finalised, then the mic button is ready again. */
  fun stop() {
    if (!active || phase == Phase.Stopping) return
    haptics.play(CallHaptic.DictationStopped)
    stopAudio()
    relay?.finishInput()
    phase = Phase.Stopping
    stoppingSince = SystemClock.elapsedRealtime()
    // Without a stream yet, it stops as soon as it's open: what was said is still transcribed.
    session?.stop()
  }

  /** Stop at once, keeping what's in the box as it is (sending, a call starting, leaving the chat). */
  fun cancel() {
    if (!active) return
    session?.cancel()
    relay?.close()
    stopAudio()
    end()
  }

  // MARK: Engine

  private suspend fun connect(gen: Int, relay: DictationRelay) {
    val s: DictationSession
    val p = prefetched
    if (p != null && p.fresh()) {
      prefetched = null
      s = p
    } else {
      val r = try { client.dictationSession() } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        return fail("Dictation couldn't start: ${e.message}", gen)
      }
      when (r) {
        is DictationStart.Live -> s = r.session
        is DictationStart.Unavailable -> {
          capabilities = capabilities?.copy(dictation = false, dictationSetup = r.setup)
          return fail(r.setup, gen)
        }
      }
    }
    if (gen != generation || (phase != Phase.Starting && phase != Phase.Stopping)) return
    val config = DictationConfig(engine = s.engine, token = s.token, ephemeral = s.ephemeral, url = s.url, model = s.model, language = s.language)
    try {
      val d = Dictation.start(config, object : DictationListener {
        override fun onEvent(event: DictationEvent) { main.post { handle(event, gen) } }
      })
      session = d
      relay.attach(d)
      if (phase == Phase.Stopping) d.stop()
    } catch (e: Throwable) {
      fail("Dictation couldn't start: ${(e as? app.mercury.voice.VoiceException.Config)?.reason ?: "the voice engine didn't load"}", gen)
    }
  }

  fun handle(e: DictationEvent, gen: Int) {
    if (gen != generation) return
    when (e) {
      is DictationEvent.Connected -> if (phase == Phase.Starting) phase = Phase.Listening
      is DictationEvent.Partial -> { apply { t, d -> t.partial(e.text, d) }; if (e.text.isNotEmpty()) lastHeard = SystemClock.elapsedRealtime() }
      is DictationEvent.Final -> { apply { t, d -> t.final(e.text, d) }; lastHeard = SystemClock.elapsedRealtime() }
      is DictationEvent.Levels -> { meter.setEngine(e.mic, 0f); if (e.mic > 0.05f) lastHeard = SystemClock.elapsedRealtime() }
      is DictationEvent.Closed -> {
        if (e.reason != "stopped" && e.reason != "cancelled") notice = "Dictation stopped: ${e.reason}."
        stopAudio()
        end()
      }
    }
  }

  /** Puts the live text into the box, after what the owner typed (their edits since win). */
  private fun apply(f: (DictationText, String) -> String) {
    val t = text ?: return
    val next = f(t, draft.text.toString())
    if (next != draft.text.toString()) draft.setTextAndPlaceCursorAtEnd(next)
  }

  private fun watch(gen: Int) {
    watchdog?.cancel()
    watchdog = scope.launch {
      while (isActive) {
        delay(1_000)
        if (gen != generation || !active) return@launch
        if (callRunning) { cancel(); return@launch }
        val now = SystemClock.elapsedRealtime()
        // The engine never confirmed the stop: give up waiting.
        if (phase == Phase.Stopping && now - stoppingSince > 10_000) { cancel(); return@launch }
        if (phase == Phase.Listening && now - lastHeard >= SILENCE_LIMIT_MS) {
          notice = "Dictation stopped after a minute of quiet."
          stop()
        }
      }
    }
  }

  private fun fail(message: String, gen: Int) {
    if (gen != generation || !active) return
    notice = message
    haptics.play(CallHaptic.Failed)
    session?.cancel()
    relay?.close()
    stopAudio()
    end()
  }

  private fun stopAudio() {
    val a = audio ?: return
    a.frameSink = null
    audio = null
    scope.launch(Dispatchers.Default) { a.stop() }
  }

  private fun end() {
    generation++
    watchdog?.cancel(); watchdog = null
    session = null
    relay = null
    text = null
    meter.reset()
    phase = Phase.Idle
  }

  companion object {
    /** Quiet this long while listening stops dictation. */
    const val SILENCE_LIMIT_MS = 60_000L
  }
}

/**
 * What dictation puts in the message box (pure, tested; iOS: DictationText): what was there before,
 * the finished text, then the live partial (replaced as it's heard). If the owner edits the box
 * while talking, their text becomes the new start and the dictation carries on after it.
 */
class DictationText(draft: String) {
  var base: String = draft; private set
  var finals: String = ""; private set
  var live: String = ""; private set
  /** The last text this put in the box. */
  var written: String = draft; private set

  val text: String get() = join(base, join(finals, live))

  /** New partial text (all of what isn't final yet); returns the box's new text. */
  fun partial(t: String, draft: String): String {
    adopt(draft)
    live = t.trim()
    written = text
    return written
  }

  /** Finished text: it replaces the partial it came from. */
  fun final(t: String, draft: String): String {
    adopt(draft)
    finals = join(finals, t.trim())
    live = ""
    written = text
    return written
  }

  private fun adopt(draft: String) {
    if (draft == written) return
    var d = draft
    // The owner's edit kept the partial at the end: it'll come again, final.
    if (live.isNotEmpty() && d.endsWith(live)) d = d.dropLast(live.length)
    base = if (d.endsWith(" ")) d.dropLast(1) else d
    finals = ""
    live = ""
  }

  companion object {
    /** Joins two pieces with one space, none before punctuation or after a space or new line. */
    fun join(a: String, b: String): String {
      if (a.isEmpty()) return b
      if (b.isEmpty()) return a
      val last = a.last(); val first = b.first()
      if (last.isWhitespace() || first.isWhitespace() || first in ",.!?;:)") return a + b
      return "$a $b"
    }
  }
}

/**
 * Hands microphone frames to the dictation stream, keeping them while it connects (on the audio
 * thread; the stream keeps its own copy while it opens, too).
 */
class DictationRelay(private val maxHeld: Int = 250) {
  private val held = ArrayDeque<ByteArray>()
  private var target: Dictation? = null
  private var closed = false
  /** The mic stopped: frames already kept still go to the stream when it opens. */
  private var inputDone = false

  fun push(frame: ByteArray) {
    val t: Dictation?
    synchronized(this) {
      if (closed || inputDone) return
      t = target
      if (t == null) {
        if (held.size == maxHeld) held.removeFirst()
        held.addLast(frame)
        return
      }
    }
    t?.pushAudio(frame)
  }

  fun attach(d: Dictation) {
    val early: List<ByteArray>
    synchronized(this) {
      early = held.toList()
      held.clear()
      target = if (closed) null else d
    }
    early.forEach { d.pushAudio(it) }
  }

  @Synchronized fun finishInput() { inputDone = true }

  @Synchronized fun close() { closed = true; target = null; held.clear() }

  @get:Synchronized val heldCount: Int get() = held.size
}
