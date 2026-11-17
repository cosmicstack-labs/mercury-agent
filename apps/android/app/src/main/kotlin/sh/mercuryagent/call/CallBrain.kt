package sh.mercuryagent.call

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.mercury.voice.VoiceEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import sh.mercuryagent.core.Spoken
import sh.mercuryagent.core.parseObject
import sh.mercuryagent.core.str

/** The voice engine as the call drives it: the Rust engine's `VoiceCall`, or a fake in tests. */
interface VoiceLink {
  fun pushAudio(pcm16: ByteArray)
  fun setMuted(muted: Boolean)
  fun interrupt()
  fun stop()
  fun toolResult(id: String, output: String)
  fun say(text: String)
  fun instruct(text: String)
}

/** What the call brain needs from playback: is Mercury audible right now, and cut it off. */
interface CallPlayback {
  val isPlaying: Boolean
  /** Drops everything queued and stops at once (barge-in, interrupt). */
  fun flush()
}

/** An approval Mercury is waiting on in the call's chat (a permission_request). */
data class CallApproval(val id: String, val text: String, val targetId: String?)

/** How a question to Mercury ended. */
sealed interface CallAnswer {
  /** Mercury's reply, with the steps that failed on the way. */
  data class Reply(val text: String, val failedSteps: List<String> = emptyList()) : CallAnswer
  data class Failed(val why: String) : CallAnswer
  data object Stopped : CallAnswer
  data object TimedOut : CallAnswer
}

/** Mercury's side of the call: the call's chat thread ([ConversationCallChat]), or a fake in tests. */
interface CallChat {
  /** Sends the question into the call's chat and waits for the reply. */
  suspend fun ask(question: String): CallAnswer
  /** What Mercury is doing right now ("Searching the web"), while it works. */
  val activity: String?
  /** Is a turn running in the call's chat? */
  val working: Boolean
  /** Approvals waiting in the call's chat, oldest first. */
  val approvals: List<CallApproval>
  suspend fun answer(approval: CallApproval, approved: Boolean)
  /** The owner said stop: the chat's turn stops. */
  suspend fun stopWork()
}

/** The moments on a call the phone marks with a tap. */
sealed interface CallHaptic {
  data object Connected : CallHaptic
  data object MercurySpeaks : CallHaptic
  data object BargeIn : CallHaptic
  data object ApprovalAsked : CallHaptic
  data class ApprovalAnswered(val approved: Boolean) : CallHaptic
  data object MuteToggled : CallHaptic
  data object Ended : CallHaptic
  data object Failed : CallHaptic
  data object DictationStarted : CallHaptic
  data object DictationStopped : CallHaptic
}

/**
 * The live call's brain, ported from iOS's CallBrain (itself Optimus's listening mode,
 * plugins/optimus/companion/src/voice.rs): the voice chats; for anything real it calls
 * `ask_mercury`, which goes into the call's chat thread; the spoken part of Mercury's reply comes
 * back as the tool result. While Mercury works the voice gets short status updates; approvals are
 * asked out loud (and shown on screen) and only the owner's own yes counts; silence and a time
 * limit end the call. Runs on the main thread; [scope] runs its waits.
 */
class CallBrain(
  val link: VoiceLink,
  val chat: CallChat,
  val playback: CallPlayback,
  private val scope: CoroutineScope,
  var haptic: (CallHaptic) -> Unit = {},
  private val now: () -> Long = { System.currentTimeMillis() },
) {
  sealed interface End {
    /** The owner hung up. */
    data object Owner : End
    /** The voice said goodbye (end_conversation). */
    data object Goodbye : End
    /** Nobody said anything for a while. */
    data object Idle : End
    data object TimeLimit : End
    /** The voice connection ended by itself, with why. */
    data class Dropped(val reason: String) : End
  }

  data class Ask(val question: String, val asked: Long, val last: Long, val updates: Int)
  data class Awaiting(val approval: CallApproval, val askedAt: Long)
  data class Line(val id: Int, val role: String, val text: String)

  var connected by mutableStateOf(false); private set
  /** The voice is producing a response (it may not be audible yet). */
  var responding by mutableStateOf(false); private set
  /** Mercury's voice is playing on the phone. */
  var mercuryAudible by mutableStateOf(false); private set
  var ownerSpeaking by mutableStateOf(false); private set
  var muted by mutableStateOf(false); private set
  /** The last thing the owner said, and the last thing Mercury said. */
  var ownerLine by mutableStateOf<String?>(null); private set
  var mercuryLine by mutableStateOf<String?>(null); private set
  /** The approval asked out loud, waiting for the owner's answer. */
  var awaiting by mutableStateOf<Awaiting?>(null); private set
  /** Questions Mercury is working on, by tool-call id (in the order asked). */
  var asks by mutableStateOf<Map<String, Ask>>(emptyMap()); private set
  var ended by mutableStateOf<End?>(null); private set
  var transcript by mutableStateOf<List<Line>>(emptyList()); private set

  /** The call is over (the model hangs up the telecom call and the audio). */
  var onEnd: (End) -> Unit = {}
  /** Mute changed (from the screen or by voice). */
  var onMuted: (Boolean) -> Unit = {}
  /** Judges barge-ins while Mercury speaks (is it the owner, or someone nearby?). Null: every one counts. */
  var bargeIn: BargeInJudge? = null

  /** Silence that ends the call, and the longest call (Optimus's idleStopSeconds, maxSessionMinutes). */
  var idleStopMs: Long = 60_000
  var maxDurationMs: Long = 30 * 60_000

  // Not shown: the session's bookkeeping.
  private val ready = ArrayDeque<Pair<String, String>>()
  private val notes = mutableListOf<String>()
  private val userSaid = ArrayDeque<Pair<Long, String>>()
  private data class Verifying(val toolId: String, val approval: CallApproval, val askedAt: Long, val until: Long)
  private var verifying: Verifying? = null
  private val askedApprovals = mutableSetOf<String>()
  private val settled = mutableSetOf<String>()
  private val cancelled = mutableSetOf<String>()
  private var started = now()
  private var lastActivity = started
  private var lastUpdate = started - 60_000
  private var respondingSince: Long? = null
  private var ownerSpeakingSince: Long? = null
  private var spokeThisResponse = false

  /**
   * Right after the engine starts (before it connects: the engine holds instructions until then,
   * so the hello is on its way the moment the session opens).
   */
  fun begin() {
    link.instruct("[Context, not said by the user] The user just called you from the Mercury app on their phone. Say a very short hello (a few words, like 'Hey, I'm listening') and wait for them.")
    markResponding(true)
  }

  // MARK: Engine events

  fun handle(e: VoiceEvent) {
    if (ended != null) return
    val t = now()
    when (e) {
      is VoiceEvent.Connected -> {
        connected = true
        started = t; lastActivity = t
        haptic(CallHaptic.Connected)
      }
      is VoiceEvent.Audio, is VoiceEvent.Levels -> Unit // played and metered off the main thread
      is VoiceEvent.SpeechStarted -> {
        lastActivity = t
        ownerSpeaking = true
        ownerSpeakingSince = t
        bargeIn?.setOwnerTalking(true)
        // Barge-in: the owner talks over Mercury, so its voice stops now. While Mercury is audible
        // the gate checks it's the owner close to the phone, not someone nearby; if not yet, it
        // keeps listening for a moment (bargeInDue). When Mercury isn't audible nothing is judged.
        if (mercuryAudible || playback.isPlaying || responding) {
          val audible = mercuryAudible || playback.isPlaying
          val gate = bargeIn
          if (audible && gate != null && !gate.admits()) { gate.hold(); return }
          cutIn(audible)
        }
      }
      is VoiceEvent.UserText -> heard(e.text.trim())
      is VoiceEvent.AssistantText -> {
        val s = e.text.trim()
        if (s.isEmpty()) return
        mercuryLine = s
        transcript = transcript + Line(transcript.size, "mercury", s)
      }
      is VoiceEvent.ToolCall -> toolCall(e.id, e.name, parseObject(e.argsJson))
      is VoiceEvent.ResponseStarted -> { bargeIn?.setOwnerTalking(false); markResponding(true); spokeThisResponse = false }
      is VoiceEvent.ResponseDone -> { markResponding(false); deliverIfIdle() }
      is VoiceEvent.Closed -> finish(End.Dropped(e.reason))
    }
  }

  /** A held barge-in turned out to be the owner (the gate heard the near voice): Mercury stops. */
  fun bargeInDue() {
    if (ended != null || !(mercuryAudible || playback.isPlaying)) return
    cutIn(true)
  }

  private fun cutIn(audible: Boolean) {
    bargeIn?.release()
    if (audible) haptic(CallHaptic.BargeIn)
    playback.flush()
    link.interrupt()
  }

  /** Mercury's voice started (true) or stopped (false) playing on the phone. */
  fun playbackChanged(on: Boolean) {
    if (ended != null || on == mercuryAudible) return
    mercuryAudible = on
    if (!on) bargeIn?.release()
    if (on) {
      lastActivity = now()
      if (!spokeThisResponse) { spokeThisResponse = true; haptic(CallHaptic.MercurySpeaks) }
    }
  }

  private fun heard(t: String) {
    if (t.isEmpty()) return
    val at = now()
    lastActivity = at
    ownerSpeaking = false
    bargeIn?.setOwnerTalking(false)
    ownerLine = t
    transcript = transcript + Line(transcript.size, "owner", t)
    userSaid.addLast(at to t)
    if (userSaid.size > 20) userSaid.removeFirst()
    if (isMute(t)) { mute(true); return }
    if (isStop(t) && verifying == null && awaiting == null) { stopAll(); return }
    val v = verifying ?: return
    val yes = spokenVerdict(userSaid, v.askedAt) ?: return
    verifying = null
    awaiting = null
    scope.launch { settle(v.approval, yes, v.toolId) }
  }

  // MARK: Tools

  private fun toolCall(id: String, name: String, args: JsonObject) {
    when (name) {
      "end_conversation", "end_call" -> scope.launch {
        // Let the goodbye finish playing (up to 5 s), then hang up. Work Mercury started keeps going.
        for (i in 0 until 50) { if (!playback.isPlaying) break; delay(100) }
        finish(End.Goodbye)
      }
      "answer_approval" -> {
        val approved = (args["approved"] as? JsonPrimitive)?.booleanOrNull ?: false
        val a = awaiting ?: run {
          ready.addLast(id to "No approval is waiting right now.")
          deliverIfIdle()
          return
        }
        val verdict = spokenVerdict(userSaid, a.askedAt)
        when {
          !approved || verdict == false -> { awaiting = null; scope.launch { settle(a.approval, false, id) } }
          verdict == true -> { awaiting = null; scope.launch { settle(a.approval, true, id) } }
          // The voice says yes but the owner's words haven't come in yet: give them 3 s.
          else -> verifying = Verifying(id, a.approval, a.askedAt, now() + 3_000)
        }
      }
      "ask_mercury" -> {
        val q = args.str("question").orEmpty().trim()
        if (q.isEmpty()) {
          ready.addLast(id to "No question was given: ask the user what they need, then call ask_mercury with a clear request.")
          deliverIfIdle()
          return
        }
        ask(q, id)
      }
      else -> { ready.addLast(id to "There's no tool called $name."); deliverIfIdle() }
    }
  }

  private fun ask(question: String, id: String) {
    val t = now()
    asks = asks + (id to Ask(question, t, t, 0))
    transcript = transcript + Line(transcript.size, "ask", question)
    scope.launch { answered(id, chat.ask(question)) }
  }

  fun answered(id: String, answer: CallAnswer) {
    if (id !in asks) return
    asks = asks - id
    if (id in cancelled || ended != null) return
    if (answer is CallAnswer.Reply) transcript = transcript + Line(transcript.size, "result", answer.text)
    ready.addLast(id to toolOutput(answer))
    deliverIfIdle()
  }

  // MARK: Approvals

  /** Answers an approval and gives the result to the voice (as the answer_approval result, or a note). */
  private suspend fun settle(a: CallApproval, yes: Boolean, toolId: String?) {
    settled += a.id
    val out = if (chat.approvals.none { it.id == a.id }) {
      "That approval was already settled."
    } else try {
      chat.answer(a, yes)
      haptic(CallHaptic.ApprovalAnswered(yes))
      if (yes) "Approved. Mercury is carrying on; tell the user briefly." else "Declined. Tell the user it won't be done."
    } catch (e: Exception) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      haptic(CallHaptic.Failed)
      "Couldn't reach Mercury: ${e.message}"
    }
    if (ended != null) return
    if (toolId != null) ready.addLast(toolId to out) else notes += out
    deliverIfIdle()
  }

  /** The owner tapped Allow or Deny on the call screen. */
  fun answerOnScreen(a: CallApproval, approved: Boolean) {
    if (a.id in settled) return
    val toolId = verifying?.takeIf { it.approval.id == a.id }?.toolId
    if (verifying?.approval?.id == a.id) verifying = null
    val wasAsked = awaiting?.approval?.id == a.id || a.id in askedApprovals
    if (awaiting?.approval?.id == a.id) awaiting = null
    askedApprovals += a.id
    scope.launch {
      settled += a.id
      try {
        chat.answer(a, approved)
        haptic(CallHaptic.ApprovalAnswered(approved))
        val said = if (approved) "The user approved it on their screen; Mercury is carrying on." else "The user declined it on their screen; it won't be done."
        if (toolId != null) ready.addLast(toolId to if (approved) "Approved. Mercury is carrying on; tell the user briefly." else "Declined. Tell the user it won't be done.")
        else if (wasAsked) notes += "[Status update, not said by the user] $said Say so in a few words."
      } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        haptic(CallHaptic.Failed)
        settled -= a.id
      }
      deliverIfIdle()
    }
  }

  // MARK: Controls

  fun mute(on: Boolean) {
    if (on == muted || ended != null) return
    muted = on
    link.setMuted(on)
    lastActivity = now()
    haptic(CallHaptic.MuteToggled)
    onMuted(on)
  }

  /** The orb was tapped: if Mercury is talking, it stops. True when something was cut off. */
  fun interrupt(): Boolean {
    if (ended != null || !(mercuryAudible || playback.isPlaying || responding)) return false
    playback.flush()
    link.interrupt()
    markResponding(false)
    mercuryAudible = false
    lastActivity = now()
    haptic(CallHaptic.BargeIn)
    return true
  }

  /** "Stop" / "cancel": everything halts, the call stays. */
  private fun stopAll() {
    cancelled += asks.keys
    asks = emptyMap()
    ready.clear()
    notes.clear()
    playback.flush()
    link.interrupt()
    scope.launch { chat.stopWork() }
    link.instruct("[The user stopped everything, not said by the user] All of Mercury's actions have been stopped. Say only: 'Stopped.' Then wait.")
    markResponding(true)
  }

  /** Ends the call (once): the engine stops, the model hangs up. */
  fun finish(end: End) {
    if (ended != null) return
    val e = if (end is End.Dropped && end.reason == "stopped") End.Owner else end
    ended = e
    playback.flush()
    link.stop()
    onEnd(e)
  }

  // MARK: The status tick (every second)

  fun tick() {
    if (ended != null) return
    val t = now()
    if (t - started >= maxDurationMs) { finish(End.TimeLimit); return }
    verifying?.let { v ->
      if (t >= v.until) {
        verifying = null
        ready.addLast(v.toolId to "Not approved: the user hasn't clearly said yes in their own words. Ask them again.")
      }
    }
    // A response that never started (or never said it was done) doesn't hold the call up for ever.
    respondingSince?.let { s -> if (responding && !playback.isPlaying && t - s > 20_000) markResponding(false) }
    ownerSpeakingSince?.let { s -> if (ownerSpeaking && t - s > 15_000) { ownerSpeaking = false; bargeIn?.setOwnerTalking(false) } }
    if (!responding && ready.isNotEmpty()) { deliver(); return }
    if (responding || playback.isPlaying) { lastActivity = t; return }
    if (muted) lastActivity = t
    if (idleStopMs > 0 && t - lastActivity >= idleStopMs && t - lastUpdate >= idleStopMs &&
      asks.isEmpty() && ready.isEmpty() && awaiting == null && !chat.working
    ) { finish(End.Idle); return }
    // An approval asked out loud but answered somewhere else (Mercury Desktop, another phone).
    awaiting?.let { a ->
      if (chat.approvals.none { it.id == a.approval.id }) {
        awaiting = null
        if (a.approval.id !in settled) {
          notes += "[Status update, not said by the user] That approval was answered on another screen, so there's nothing to ask any more. Say so in a few words."
        }
      }
    }
    if (awaiting == null) {
      chat.approvals.firstOrNull { it.id !in askedApprovals && it.id !in settled }?.let { next ->
        askedApprovals += next.id
        awaiting = Awaiting(next, t)
        haptic(CallHaptic.ApprovalAsked)
        link.instruct("[Approval needed, not said by the user] Mercury wants to: ${approvalSummary(next.text)}. Ask the user plainly, in one or two sentences, whether to go ahead. Then wait for their answer and call answer_approval.")
        markResponding(true)
        return
      }
    }
    if (notes.isNotEmpty()) {
      val n = notes.joinToString(" ")
      notes.clear()
      link.instruct(if (n.startsWith("[")) n else "[Status update, not said by the user] $n Mention it in one short sentence.")
      markResponding(true)
      return
    }
    // Still working: a short update after 8 s, then every 14 s (at most 8).
    if (t - lastUpdate > 12_000) {
      val due = asks.entries.firstOrNull { (_, a) -> a.updates < 8 && t - (if (a.updates == 0) a.asked else a.last) >= (if (a.updates == 0) 8_000 else 14_000) }
      if (due != null) {
        val (id, ask) = due
        asks = asks + (id to ask.copy(last = t, updates = ask.updates + 1))
        lastUpdate = t
        val doing = doing(chat.activity)
        val secs = (t - ask.asked) / 1000
        link.instruct(
          if (ask.updates == 0) "[Status update, not said by the user] Mercury is still $doing. Tell the user in one short sentence that it's taking a few seconds."
          else "[Status update, not said by the user] After $secs seconds Mercury is still $doing. Give one short, natural update (don't repeat yourself).",
        )
        markResponding(true)
      }
    }
  }

  private fun deliverIfIdle() { if (!responding) deliver() }

  private fun deliver() {
    val (id, output) = ready.removeFirstOrNull() ?: return
    link.toolResult(id, output)
    markResponding(true)
  }

  private fun markResponding(on: Boolean) {
    responding = on
    respondingSince = if (on) now() else null
  }

  companion object {
    /** What goes back to the voice for Mercury's answer: the spoken part, and plain notes about the rest. */
    fun toolOutput(answer: CallAnswer): String = when (answer) {
      is CallAnswer.Reply -> {
        val (spoken, chatPart) = Spoken.split(answer.text)
        var out = Spoken.text(spoken).ifEmpty { "Done." }
        if (chatPart.isNotEmpty()) out += "\n[The links and details are in the user's Mercury chat: say you've put them there, don't read them out.]"
        if (answer.failedSteps.isNotEmpty()) {
          out += "\n[Mercury's log for this request, not part of its answer: ${answer.failedSteps.size} step(s) failed or were stopped (${answer.failedSteps.joinToString("; ")}). Unless the answer above says Mercury checked the result, don't tell the user it's done: say what didn't work and offer to try again.]"
        }
        out
      }
      is CallAnswer.Failed -> "Mercury couldn't do it: ${answer.why}. Tell the user plainly."
      CallAnswer.Stopped -> "Mercury stopped before it finished. Tell the user plainly."
      CallAnswer.TimedOut -> "Mercury didn't answer in time. It will send the answer to the chat."
    }

    /** "Searching the web" → "searching the web", for "Mercury is still …". */
    fun doing(activity: String?): String {
      val a = activity?.trim()?.takeIf { it.isNotEmpty() } ?: return "working on it"
      val s = a.removeSuffix("…")
      return s.take(1).lowercase() + s.drop(1)
    }

    /** The approval's first line, short enough to say ("Run command: npm run deploy"). */
    fun approvalSummary(text: String): String {
      val first = text.split("\n").firstOrNull { it.isNotEmpty() } ?: text
      return if (first.length > 160) first.take(160) + "…" else first
    }

    /** Lowercased, ASCII punctuation as spaces, padded so " word " matches whole words. */
    fun normalized(t: String): String =
      " " + t.lowercase().map { c -> if (c.code < 128 && !c.isLetterOrDigit() && !c.isWhitespace()) ' ' else c }.joinToString("") + " "

    fun wordCount(t: String): Int = t.split(Regex("\\s+")).count { it.isNotEmpty() }

    /** "Mute" / "mute yourself" / "go on mute". */
    fun isMute(text: String): Boolean {
      val t = normalized(text)
      return wordCount(t) <= 4 && listOf(" mute ", " go on mute ", " mute yourself ", " mute karo ").any { t.contains(it) } && !t.contains(" unmute ")
    }

    /** A short "stop!" / "cancel" / "ruko" / "bas": halt everything. */
    fun isStop(text: String): Boolean {
      val t = normalized(text)
      return wordCount(t) <= 4 &&
        listOf(" stop ", " cancel ", " halt ", " abort ", " enough ", " never mind ", " nevermind ", " ruko ", " ruk jao ", " ruk ", " bas ", " band karo ", "रुको", "रुक जाओ", "बस", "رکو", "بس").any { t.contains(it) } &&
        !t.contains(" stop listening ")
    }

    private val NO = listOf(" no ", " nope ", " don t ", " don't ", " dont ", " do not ", " cancel ", " stop ", " wait ", " nahi ", " nahin ", " mat ", "नहीं", "मत", "نہیں")
    private val YES = listOf(" yes ", " yeah ", " yep ", " yup ", " sure ", " ok ", " okay ", " go ahead ", " do it ", " approve", " confirm", " please do ", " haan ", " han ", " ha ji ", " ji ", " theek ", " thik ", " kar do ", " karo ", "हाँ", "हां", "ठीक", "कर दो", "ہاں", "جی", "ٹھیک")

    /**
     * Did the owner say yes (or no) out loud since the approval question? Only their transcribed
     * speech counts, never the voice model's own reading.
     */
    fun spokenVerdict(said: Collection<Pair<Long, String>>, since: Long): Boolean? {
      for ((at, text) in said.reversed()) {
        if (at < since) break
        val t = normalized(text)
        if (NO.any { t.contains(it) }) return false
        if (YES.any { t.contains(it) }) return true
      }
      return null
    }
  }
}
