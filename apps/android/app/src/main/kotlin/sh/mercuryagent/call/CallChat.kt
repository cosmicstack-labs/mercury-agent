package sh.mercuryagent.call

import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ChatMessage
import sh.mercuryagent.ui.conversation.ConversationState
import sh.mercuryagent.ui.conversation.ConversationViewModel
import sh.mercuryagent.ui.conversation.TurnTrace

/**
 * The call's chat thread as the call brain sees it (iOS: ConversationCallChat): questions go in
 * with the app's chat API (/api/chat/send with `voiceCall` = the call's id, so a new thread is named
 * "Voice call · <time>"), and the reply, the activity and the approvals come from the thread's
 * events. Main thread only.
 */
class ConversationCallChat(
  private val conversation: ConversationViewModel,
  callId: String,
  private val scope: CoroutineScope,
) : CallChat {
  /** Long enough for a turn that waits on the owner's approval (voice.rs ASK_TIMEOUT). */
  var timeoutMs: Long = 300_000

  private class Waiting(val answer: CompletableDeferred<CallAnswer>, var timer: Job? = null)
  private val waiting = LinkedHashMap<String, Waiting>()
  /** Turns already running when a question was sent: their ends aren't its reply. */
  private var foreignTurns = 0

  init {
    conversation.callId = callId
    conversation.onTurnEnd = { reply -> turnEnded(reply) }
  }

  private val state: ConversationState get() = conversation.ui.value

  /** The call is over: the chat goes back to being a chat; anyone still waiting gets no answer. */
  fun detach() {
    conversation.callId = null
    conversation.onTurnEnd = null
    val all = waiting.values.toList()
    waiting.clear()
    all.forEach { it.timer?.cancel(); it.answer.complete(CallAnswer.Stopped) }
  }

  override suspend fun ask(question: String): CallAnswer {
    val id = UUID.randomUUID().toString()
    if (state.busy && waiting.isEmpty()) foreignTurns++
    // Waiting before sending: a quick reply can't arrive before anyone listens for it.
    val w = Waiting(CompletableDeferred())
    waiting[id] = w
    w.timer = scope.launch { delay(timeoutMs); resolve(id, CallAnswer.TimedOut) }
    scope.launch {
      conversation.sendSpoken(question)?.let { e -> resolve(id, CallAnswer.Failed(e)) }
    }
    return w.answer.await()
  }

  private fun resolve(id: String, answer: CallAnswer) {
    val w = waiting.remove(id) ?: return
    w.timer?.cancel()
    w.answer.complete(answer)
  }

  /** A turn ended in the thread: the oldest question waiting gets it. */
  fun turnEnded(reply: ChatMessage?) {
    if (foreignTurns > 0) { foreignTurns--; return }
    val id = waiting.keys.firstOrNull() ?: return
    resolve(id, answer(reply, state))
  }

  override val activity: String?
    get() {
      val c = state
      if (!c.busy) return null
      if (c.queued != null) return "Waiting for another chat to finish"
      c.live?.runningStep?.let { return it.label }
      if (c.streaming.isNotEmpty()) return "Writing the answer"
      return "Thinking"
    }

  override val working: Boolean get() = state.busy

  override val approvals: List<CallApproval>
    get() = state.prompts.filter { it.kind == "permission_request" || it.kind == "permission_continue" }
      .map { CallApproval(it.id, it.text, it.targetId) }

  // Only yes or no from a call: never "always".
  override suspend fun answer(approval: CallApproval, approved: Boolean) =
    conversation.answerPrompt(approval.id, approval.targetId, if (approved) "yes" else "no")

  override suspend fun stopWork() = conversation.stop()

  companion object {
    fun answer(reply: ChatMessage?, c: ConversationState): CallAnswer {
      if (reply != null && reply.content.isNotBlank()) {
        val failed = c.traces[reply.id]?.steps.orEmpty()
          .filter { it.status == TurnTrace.Status.Error || it.status == TurnTrace.Status.Stopped }.map { it.label }
        return CallAnswer.Reply(reply.content, failed)
      }
      // An error ends the turn with a line of its own.
      val last = c.messages.lastOrNull()
      if (last != null && last.role == "system" && last.content.isNotEmpty()) return CallAnswer.Failed(last.content)
      return CallAnswer.Stopped
    }
  }
}
