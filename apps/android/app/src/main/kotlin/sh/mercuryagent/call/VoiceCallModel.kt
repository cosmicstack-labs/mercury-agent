package sh.mercuryagent.call

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.mercury.voice.VoiceCall
import app.mercury.voice.VoiceConfig
import app.mercury.voice.VoiceEvent
import app.mercury.voice.VoiceException
import app.mercury.voice.VoiceListener
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.VoiceSession
import sh.mercuryagent.core.VoiceSessionResult
import sh.mercuryagent.core.voiceSession
import sh.mercuryagent.ui.conversation.ConversationViewModel

/** What the call screen shows, from the brain's state (pure, tested). */
object CallPhase {
  enum class Phase { Starting, Listening, Hearing, Working, Speaking, Ended }
  enum class Orb { Calling, Listening, OwnerSpeaking, MercurySpeaking, Working, Muted, Ended }

  fun of(ended: Boolean, connected: Boolean, mercuryAudible: Boolean, ownerSpeaking: Boolean, working: Boolean): Phase = when {
    ended -> Phase.Ended
    !connected -> Phase.Starting
    mercuryAudible -> Phase.Speaking
    ownerSpeaking -> Phase.Hearing
    working -> Phase.Working
    else -> Phase.Listening
  }

  fun orb(phase: Phase, muted: Boolean): Orb = when {
    phase == Phase.Starting -> Orb.Calling
    phase == Phase.Ended -> Orb.Ended
    phase == Phase.Speaking -> Orb.MercurySpeaking
    muted -> Orb.Muted
    phase == Phase.Hearing -> Orb.OwnerSpeaking
    phase == Phase.Working -> Orb.Working
    else -> Orb.Listening
  }

  /** One line under the orb: what's happening now. */
  fun status(phase: Phase, muted: Boolean, activity: String?, error: String?, endedNote: String?): String = error ?: when (phase) {
    Phase.Starting -> "Getting Mercury on the line…"
    Phase.Listening -> if (muted) "Muted" else "Listening"
    Phase.Hearing -> "Listening…"
    Phase.Working -> activity ?: "Thinking…"
    Phase.Speaking -> "Mercury is speaking · tap to interrupt"
    Phase.Ended -> endedNote ?: "Call ended"
  }

  /** "03:07" for a call's length. */
  fun elapsed(ms: Long): String {
    val s = maxOf(0L, ms / 1000)
    return "%02d:%02d".format(s / 60, s % 60)
  }

  /** The note when the call ended on its own. */
  fun endedNote(end: CallBrain.End): String? = when (end) {
    CallBrain.End.Goodbye -> "Mercury said goodbye."
    CallBrain.End.Idle -> "Ended after a minute of quiet."
    CallBrain.End.TimeLimit -> "Calls end after 30 minutes."
    else -> null
  }
}

/** The engine's VoiceCall as the brain's link. */
private class EngineLink(private val call: VoiceCall) : VoiceLink {
  override fun pushAudio(pcm16: ByteArray) = call.pushAudio(pcm16)
  override fun setMuted(muted: Boolean) = call.setMuted(muted)
  override fun interrupt() = call.interrupt()
  override fun stop() = call.stop()
  override fun toolResult(id: String, output: String) = call.toolResult(id, output)
  override fun say(text: String) = call.say(text)
  override fun instruct(text: String) = call.instruct(text)
}

/**
 * A voice call with Mercury from the phone (iOS: VoiceCallModel), as a real Android call (Telecom,
 * a phoneCall foreground service). Mercury's shared Rust voice engine (the `:voice` module, the
 * links Optimus runs on the desktop) with a short-lived token from the Mercury
 * (POST /api/mobile/voice/session): the phone streams the microphone to the voice and plays what
 * comes back; [CallBrain] answers the voice's tools through the call's chat thread.
 *
 * Starting is parallel: the screen shows at once; the token and Telecom's call come up together;
 * then the route, the microphone and the player; the voice engine starts the moment the token is in
 * and says hello as soon as it connects. Main thread only.
 */
class VoiceCallModel(
  private val context: Context,
  val conversation: ConversationViewModel,
  private val client: MercuryClient,
  private val scope: CoroutineScope,
  private val onFinished: (VoiceCallModel) -> Unit = {},
) {
  val callId: String = UUID.randomUUID().toString().lowercase()
  val meter = CallMeter()
  private val haptics = CallHaptics(context)
  private val main = Handler(Looper.getMainLooper())

  var error by mutableStateOf<String?>(null); private set
  var endedNote by mutableStateOf<String?>(null); private set
  var isEnded by mutableStateOf(false); private set
  /** When the call connected (elapsed ms; the timer counts from here), and when it ended. */
  var startedAt by mutableStateOf<Long?>(null); private set
  var endedAt by mutableStateOf<Long?>(null); private set
  /** The sound is on the loudspeaker. */
  var speaker by mutableStateOf(true); private set
  var brain by mutableStateOf<CallBrain?>(null); private set

  private var chat: ConversationCallChat? = null
  private var voice: VoiceLink? = null
  private var audio: CallAudio? = null
  private var router: CallRouter? = null
  private var telecom: CallTelecom? = null
  private var ticker: Job? = null
  private var startJob: Job? = null
  private var heldMute = false
  private val tapped = SystemClock.elapsedRealtime()

  // MARK: What the screen shows

  val phase: CallPhase.Phase
    get() {
      val b = brain
      return CallPhase.of(isEnded, b?.connected == true, b?.mercuryAudible == true, b?.ownerSpeaking == true,
        b != null && (b.asks.isNotEmpty() || b.awaiting != null || chat?.working == true))
    }

  val muted: Boolean get() = brain?.muted ?: false

  /** What Mercury is doing while it works ("Searching the web…"), or null. */
  val activity: String?
    get() {
      val b = brain ?: return null
      if (b.asks.isEmpty() && chat?.working != true) return null
      if (b.awaiting != null) return "Needs your OK"
      return (chat?.activity ?: "Thinking") + "…"
    }

  val status: String get() = CallPhase.status(phase, muted, activity, error, endedNote)
  val orb: CallPhase.Orb get() = CallPhase.orb(phase, muted)
  val ownerLine: String? get() = brain?.ownerLine
  val mercuryLine: String? get() = brain?.mercuryLine

  /** The approval to show on screen with Allow and Deny. */
  val approval: CallApproval?
    get() = brain?.awaiting?.approval ?: conversation.ui.value.prompts
      .firstOrNull { it.kind == "permission_request" || it.kind == "permission_continue" }
      ?.let { CallApproval(it.id, it.text, it.targetId) }

  val canInterrupt: Boolean get() = phase == CallPhase.Phase.Speaking

  // MARK: Starting

  /** Starts the call (once). The screen is already up: this runs everything else. */
  fun start() {
    if (startJob != null || isEnded) return
    startJob = scope.launch { runCall() }
  }

  private suspend fun runCall() {
    mark("screen")
    val session = scope.async { runCatching { client.voiceSession() } }
    // Telecom's call, in parallel with the token.
    val t = CallTelecom(context, scope)
    t.onEndedOutside = { endedOutside() }
    t.onHold = { held(it) }
    t.onMuted = { m -> if (m != muted) setMuted(m) }
    telecom = t
    if (t.start()) mark("telecom") else { telecom = null; Log.i(TAG, "call: running without Telecom") }
    if (isEnded) return
    router = CallRouter(context) { d -> speaker = d.speaker; telecom?.route(d.target) }.also { it.start() }
    // The microphone (with echo cancellation) and the player.
    val engine = CallAudio(meter)
    val opened = withContext(Dispatchers.Default) { engine.start() }
    if (!opened) return fail("Couldn't open the microphone.")
    if (isEnded) { engine.stop(); return }
    audio = engine
    mark("audio")
    val result = session.await()
    mark("token")
    if (isEnded) return
    result.fold(
      onSuccess = { r ->
        when (r) {
          is VoiceSessionResult.Live -> startLive(r.session, engine)
          is VoiceSessionResult.Unavailable -> fail(r.reason)
        }
      },
      onFailure = { e -> fail(e.message ?: "Couldn't reach Mercury.") },
    )
  }

  private fun startLive(s: VoiceSession, engine: CallAudio) {
    val config = VoiceConfig(
      engine = s.engine, token = s.token, ephemeral = s.ephemeral, url = s.url, model = s.model, voice = s.voice,
      instructions = s.instructions, toolsJson = s.toolsJson,
    )
    val call = try {
      VoiceCall.start(config, Listener(engine))
    } catch (e: VoiceException.Config) {
      return fail("Couldn't start the voice: ${e.reason}")
    } catch (e: Throwable) {
      // The engine's library is missing or wouldn't load.
      Log.e(TAG, "voice engine", e)
      return fail("Couldn't start the voice engine on this phone.")
    }
    // Barge-ins while Mercury speaks are judged on the phone's own microphone level (OpenAI
    // Realtime leaves interrupting to the phone on a phone call; Gemini Live cuts in by itself).
    val gate = CallBargeIn(CallBargeIn.judges(s.engine))
    gate.mercuryAudible = { engine.isPlaying }
    gate.onDue = { main.post { brain?.bargeInDue() } }
    // Every frame goes to the voice as it is; the gate only listens.
    engine.frameSink = { call.pushAudio(it); gate.frame(it) }
    engine.playbackSink = { on -> main.post { brain?.playbackChanged(on) } }
    useLive(EngineLink(call), ConversationCallChat(conversation, callId, scope), engine)
    brain?.bargeIn = gate
    brain?.begin()
  }

  /** Puts a brain on the call: the engine (or a fake), the chat and playback. */
  fun useLive(link: VoiceLink, chat: ConversationCallChat, playback: CallPlayback) {
    voice = link
    this.chat = chat
    val b = CallBrain(link, chat, playback, scope, haptic = haptics::play)
    b.onEnd = { liveEnded(it) }
    b.onMuted = { on -> audio?.setMuted(on) }
    brain = b
    ticker?.cancel()
    ticker = scope.launch {
      while (isActive) {
        delay(1_000)
        if (isEnded) return@launch
        brain?.tick()
      }
    }
  }

  /** An engine event, on the main thread (audio and levels never come here). */
  private fun voiceEvent(e: VoiceEvent) {
    if (e is VoiceEvent.Connected) {
      mark("connected")
      startedAt = SystemClock.elapsedRealtime()
    }
    brain?.handle(e)
  }

  /**
   * The engine's events, from its own thread: Mercury's audio goes straight to the player;
   * everything else goes to the model on the main thread, in order (a barge-in included: the brain
   * decides whether it's the owner before Mercury's voice stops).
   */
  private inner class Listener(private val engine: CallAudio) : VoiceListener {
    @Volatile private var heardAudio = false
    override fun onEvent(event: VoiceEvent) {
      when (event) {
        is VoiceEvent.Audio -> {
          engine.play(event.pcm16)
          if (!heardAudio) { heardAudio = true; main.post { mark("first-audio") } }
        }
        is VoiceEvent.Levels -> meter.setEngine(event.mic, event.voice)
        else -> main.post { voiceEvent(event) }
      }
    }
  }

  // MARK: Controls

  fun toggleMute() = setMuted(!muted)

  fun setMuted(on: Boolean) {
    if (isEnded || on == muted) return
    brain?.mute(on)
  }

  private fun held(on: Boolean) {
    if (on) { heldMute = !muted; if (heldMute) setMuted(true) }
    else if (heldMute) { heldMute = false; setMuted(false) }
  }

  /** The owner chose: their choice holds until a headset arrives or the call ends. */
  fun toggleSpeaker() {
    if (isEnded) return
    haptics.play(CallHaptic.MuteToggled)
    router?.toggleSpeaker()
  }

  /** Cuts Mercury off: stops its voice. */
  fun interrupt() { brain?.interrupt() }

  fun answerApproval(a: CallApproval, approved: Boolean) {
    val b = brain
    if (b != null) { b.answerOnScreen(a, approved); return }
    scope.launch { runCatching { conversation.answerPrompt(a.id, a.targetId, if (approved) "yes" else "no") } }
  }

  // MARK: Ending

  /** Hangs up. Work Mercury already started keeps going and lands in the chat. */
  fun end() {
    if (isEnded) return
    val b = brain
    if (b != null && b.ended == null) { b.finish(CallBrain.End.Owner); return }
    finish(null, failed = false)
  }

  private fun endedOutside() {
    if (isEnded) return
    telecom = null // Telecom already ended it
    end()
  }

  private fun liveEnded(end: CallBrain.End) {
    if (end is CallBrain.End.Dropped) {
      if (error == null) error = if (brain?.connected == true) "The call dropped: ${end.reason}." else "Couldn't connect to the voice: ${end.reason}."
      finish(null, failed = true)
    } else {
      finish(CallPhase.endedNote(end), failed = false)
    }
  }

  private fun fail(message: String) {
    if (isEnded) return
    error = message
    val b = brain
    if (b != null && b.ended == null) { b.finish(CallBrain.End.Dropped(message)); return }
    finish(null, failed = true)
  }

  private fun finish(note: String?, failed: Boolean) {
    if (isEnded) return
    isEnded = true
    endedAt = SystemClock.elapsedRealtime()
    endedNote = note
    haptics.play(if (failed) CallHaptic.Failed else CallHaptic.Ended)
    ticker?.cancel(); ticker = null
    audio?.let { a -> a.frameSink = null; a.playbackSink = null; scope.launch(Dispatchers.Default) { a.stop() } }
    audio = null
    voice = null
    chat?.detach()
    router?.stop(); router = null
    telecom?.end(failed); telecom = null
    meter.reset()
    onFinished(this)
    Log.i(TAG, "call ended: ${note ?: error ?: "by the owner"}")
  }

  private fun mark(step: String) {
    Log.i(TAG, "call start: $step +${SystemClock.elapsedRealtime() - tapped}ms")
  }

  private companion object { const val TAG = "MercuryCall" }
}
