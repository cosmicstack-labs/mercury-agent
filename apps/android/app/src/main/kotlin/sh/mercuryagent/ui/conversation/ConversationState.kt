package sh.mercuryagent.ui.conversation

import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import sh.mercuryagent.core.ArtifactRef
import sh.mercuryagent.core.ChatMessage
import sh.mercuryagent.core.ChatPlan
import sh.mercuryagent.core.LiveSnapshot
import sh.mercuryagent.core.MercuryJson
import sh.mercuryagent.core.PendingMedia
import sh.mercuryagent.core.PlanStep
import sh.mercuryagent.core.ReplyUsage
import sh.mercuryagent.core.arr
import sh.mercuryagent.core.bool
import sh.mercuryagent.core.double
import sh.mercuryagent.core.int
import sh.mercuryagent.core.parseObject
import sh.mercuryagent.core.str

enum class Agent { Idle, Thinking, Working, Streaming }

/** A question the turn waits on (permission or choice): the needs-you card answers it. */
data class Prompt(val id: String, val kind: String, val text: String, val options: List<Option>, val targetId: String?) {
  data class Option(val value: String, val label: String)
}

/** A line from the runtime about this chat (a stall, a dropped message). */
data class Notice(val text: String, val warning: Boolean)

/**
 * Everything one conversation screen shows (iOS: ConversationModel's state). The event handling is
 * a pure reducer ([ConversationEvents.reduce]) so it's tested without a server or a screen.
 */
data class ConversationState(
  val threadId: String? = null,
  val title: String = "New chat",
  val savedAt: Instant? = null,
  val messages: List<ChatMessage> = emptyList(),
  /** Finished replies' thought processes, by message id. */
  val traces: Map<String, TurnTrace> = emptyMap(),
  val agent: Agent = Agent.Idle,
  /** The running turn, in order. Null when nothing runs. */
  val live: TurnTrace? = null,
  val streaming: String = "",
  val plan: ChatPlan? = null,
  val prompts: List<Prompt> = emptyList(),
  val pendingArtifacts: List<ArtifactRef> = emptyList(),
  /** Videos and songs being made in the background for this chat. */
  val pendingMedia: List<PendingMedia> = emptyList(),
  val queued: Int? = null,
  /** Stop was pressed; the turn ends when the runtime confirms (or after a few seconds). */
  val stopping: Boolean = false,
  val notice: Notice? = null,
  val error: String? = null,
  val loaded: Boolean = false,
  /** When the last reply landed: a late "thinking" right after it is not a new turn. */
  val lastReplyAt: Instant? = null,
) {
  val busy: Boolean get() = agent != Agent.Idle || stopping

  /** What the title area says under the name: a question waiting beats work in progress. */
  val titleStatus: String?
    get() = when {
      prompts.isNotEmpty() -> "Needs you"
      agent != Agent.Idle && !stopping -> "Working…"
      else -> null
    }

  /** The status line of a running turn: "Thinking…", "Reading a file", a phase, "Writing…". */
  val liveLine: String?
    get() {
      if (agent == Agent.Idle) return null
      queued?.let { return if (it <= 1) "Waiting for another chat to finish" else "Waiting in line ($it)" }
      if (stopping) return "Stopping…"
      live?.runningStep?.let { return it.label }
      live?.phase?.let { return it }
      return when (agent) {
        Agent.Streaming -> "Writing…"
        Agent.Working -> "Working…"
        else -> "Thinking…"
      }
    }

  /** Messages from the runtime: what a person reads, with each reply's stored thought process. */
  fun withMessages(all: List<ChatMessage>): ConversationState {
    val shown = all.filter { it.isShown }
    val traces = shown.filter { it.role == "assistant" }.mapNotNull { m ->
      m.storedTrace?.let { TurnTrace.from(it) }?.takeIf { it.hasProcess }?.let { m.id to it }
    }.toMap()
    return copy(messages = shown, traces = traces)
  }

  /** The runtime's snapshot of a reply still being worked on, onto the screen. */
  fun restore(s: LiveSnapshot, now: Instant = Instant.now()): ConversationState {
    if (!s.running) {
      // It finished while away: the reply is in the messages now.
      return if (busy && queued == null && !stopping) copy(live = null, streaming = "", agent = Agent.Idle) else this
    }
    val t = TurnTrace.live(s, now)
    val text = s.text.orEmpty()
    return copy(
      live = t, streaming = text,
      agent = if (t.runningStep != null) Agent.Working else if (text.isEmpty()) Agent.Thinking else Agent.Streaming,
    )
  }
}

/** What a reduction asks of the caller beyond the new state. */
data class Reduction(
  val state: ConversationState,
  /** The turn ended (with its reply, when there was one): refresh the list and the title. */
  val turnEnded: Boolean = false,
  val reply: ChatMessage? = null,
  /** Something the list shows changed (a background media message). */
  val changed: Boolean = false,
)

object ConversationEvents {
  /** Handles one event from /api/chat/events (apps/desktop/src/app/events.ts is the reference). */
  fun reduce(s: ConversationState, event: String, raw: String, now: Instant = Instant.now()): Reduction {
    val data = parseObject(raw)
    val sid = data.str("sessionId")
    if (sid != null && s.threadId != null && sid != s.threadId) return Reduction(s)
    fun live(st: ConversationState) = st.live ?: TurnTrace(startedAt = now)
    when (event) {
      "queued" -> return Reduction(s.copy(
        queued = data.int("position") ?: 1,
        agent = if (s.agent == Agent.Idle) Agent.Thinking else s.agent,
        live = s.live ?: TurnTrace(startedAt = now),
      ))
      "queue_dropped" -> {
        // A stop took this chat's waiting message(s) out of line (ADR-038): they won't run.
        val wasWaiting = s.queued != null
        var st = s.copy(queued = null)
        if (st.stopping) return finishStopped(st, now)
        if (wasWaiting && st.streaming.isEmpty() && st.live?.hasProcess != true) st = st.copy(live = null, agent = Agent.Idle)
        val n = data.int("dropped") ?: 1
        return Reduction(st.copy(notice = Notice(
          "Stopped before it started: " + if (n == 1) "your waiting message wasn't sent." else "$n waiting messages weren't sent.", false,
        )))
      }
      "thinking" -> {
        // Sent every few seconds while a turn makes progress. It starts a turn on screen only when
        // none is showing, and never turns Working or Writing back into Thinking.
        var st = s.copy(queued = null)
        if (st.agent == Agent.Idle) {
          val last = st.lastReplyAt
          if (st.live == null && last != null && Duration.between(last, now).toMillis() < 2500) return Reduction(st)
          st = st.copy(agent = Agent.Thinking)
        }
        return Reduction(st.copy(live = st.live?.touch(now) ?: TurnTrace(startedAt = now)))
      }
      "phase" -> {
        val p = data.str("phase")
        if (p.isNullOrEmpty() || (s.live == null && s.agent == Agent.Idle)) return Reduction(s)
        val d = data.str("detail").orEmpty()
        val hidden = Regex("^(stall|step budget|verification gate|execute guard|completion contract)$", RegexOption.IGNORE_CASE).matches(d)
        return Reduction(s.copy(live = live(s).setPhase(if (d.isEmpty() || hidden) p else "$p · $d", now)))
      }
      "reasoning" -> {
        val st = s.copy(queued = null)
        if (data.bool("done") == true) return Reduction(st.copy(live = st.live?.endReasoning(now)))
        val t = data.str("text")
        if (t.isNullOrEmpty()) return Reduction(st)
        return Reduction(st.copy(live = live(st).addReasoning(t, now), agent = if (st.agent == Agent.Idle) Agent.Thinking else st.agent))
      }
      "progress" -> {
        // "Checking my work…", or Mercury's own warning about hidden instructions: a note in the turn.
        val t = data.str("text")
        if (t.isNullOrBlank()) return Reduction(s)
        // Between turns: a line of its own, so it's never lost.
        return if (s.live == null && s.agent == Agent.Idle) Reduction(s.copy(messages = s.messages + ChatMessage(role = "system", content = t, timestamp = now)))
        else Reduction(s.copy(live = live(s).addNote(t, now)))
      }
      "notice" -> {
        val m = data.str("message") ?: return Reduction(s)
        return Reduction(s.copy(notice = Notice(m, data.str("level") == "warning")))
      }
      "step_start" -> {
        val tool = data.str("tool").orEmpty()
        val t = live(s).startTool(
          data.str("id"), tool, data.str("title"), data.int("step") ?: data.int("stepNumber"), TurnTrace.MediaShape.from(data["media"]), now,
        )
        return Reduction(s.copy(queued = null, live = t, agent = Agent.Working))
      }
      "step_done" -> {
        val tool = data.str("tool").orEmpty()
        val summary = data.str("summary")
        val failed = stepFailed(data, summary)
        val shown = if (failed) data.str("reason")?.ifEmpty { null } ?: summary else summary
        return Reduction(s.copy(live = s.live?.finishTool(data.str("id"), tool, failed, shown, data.double("durationMs"), now)))
      }
      "text_delta" -> {
        val t = data.str("text").orEmpty()
        return Reduction(s.copy(queued = null, agent = Agent.Streaming, streaming = s.streaming + t, live = live(s).addText(t, now)))
      }
      "text_done" -> {
        val st = s.copy(queued = null, notice = null)
        val text = data.str("fullText") ?: data.str("text") ?: st.streaming
        // The runtime's reply to a stop is its "⏹ Task stopped" note: the turn ends as stopped.
        if (isStopNote(text) || (st.stopping && text.isBlank())) return finishStopped(st, now)
        var messages = st.messages
        var traces = st.traces
        var reply: ChatMessage? = null
        if (text.isNotEmpty()) {
          val m = ChatMessage(
            role = "assistant", content = text, timestamp = now, artifacts = st.pendingArtifacts,
            localUsage = ReplyUsage.from(data["usage"]),
          )
          st.live?.takeIf { it.hasProcess }?.let { traces = traces + (m.id to it.finished(now = now)) }
          messages = messages + m
          reply = m
        }
        return finishTurn(st.copy(messages = messages, traces = traces, lastReplyAt = now), reply)
      }
      "plan" -> {
        val steps = data.arr("steps").orEmpty().mapNotNull { (it as? JsonObject)?.let { o -> PlanStep(o.str("label").orEmpty(), o.str("status") ?: "pending") } }
        if (steps.isEmpty()) return Reduction(s)
        val state = data.str("state")?.takeIf { it == "paused" || it == "stopped" }
        return Reduction(s.copy(plan = ChatPlan(steps, data.double("updatedAt") ?: now.toEpochMilli().toDouble(), state)))
      }
      "artifacts" -> {
        val items = artifacts(data.arr("items"))
        if (items.isEmpty()) return Reduction(s)
        val i = s.messages.indexOfLast { it.role == "assistant" }
        return if (s.agent == Agent.Idle && i >= 0 && i == s.messages.lastIndex) {
          Reduction(s.copy(messages = s.messages.toMutableList().also { it[i] = it[i].copy(artifacts = it[i].artifacts + items) }))
        } else Reduction(s.copy(pendingArtifacts = s.pendingArtifacts + items))
      }
      "media_pending" -> {
        val job = data.str("jobId") ?: return Reduction(s)
        val p = PendingMedia(job, if (data.str("kind") == "music") "music" else "video", data.str("aspect"), data.str("prompt"), data.double("startedAt"))
        return Reduction(s.copy(pendingMedia = s.pendingMedia.filter { it.jobId != job } + p))
      }
      "media_ready" -> {
        // A video or song made in the background, after its turn ended: a message of its own.
        val job = data.str("jobId")
        val items = artifacts(data.arr("artifacts"))
        val m = ChatMessage(role = "assistant", content = data.str("text").orEmpty(), timestamp = now, artifacts = items)
        return Reduction(s.copy(pendingMedia = s.pendingMedia.filter { it.jobId != job }, messages = s.messages + m), changed = true)
      }
      "permission_request", "permission_continue", "choice_prompt" -> {
        val options = data.arr("options").orEmpty().map { o ->
          if (o is JsonPrimitive && o.isString) Prompt.Option(o.content, optionLabel(o.content))
          else (o as? JsonObject).let { j -> val v = j?.str("value").orEmpty(); Prompt.Option(v, j?.str("label") ?: v) }
        }
        val text = data.str("prompt") ?: data.str("question") ?: ""
        val id = data.str("id") ?: UUID.randomUUID().toString()
        val p = Prompt(id, event, text, options, data.str("targetId"))
        val i = s.prompts.indexOfFirst { it.id == id }
        return Reduction(s.copy(prompts = if (i >= 0) s.prompts.toMutableList().also { it[i] = p } else s.prompts + p))
      }
      "permission_resolved", "choice_resolved" -> {
        val id = data.str("id") ?: return Reduction(s)
        return Reduction(s.copy(prompts = s.prompts.filter { it.id != id }))
      }
      "error" -> {
        val st = s.copy(
          queued = null, notice = null, stopping = false,
          messages = s.messages + ChatMessage(role = "system", content = data.str("message") ?: "Something went wrong.", timestamp = now),
        )
        return finishTurn(st, null)
      }
      else -> return Reduction(s)
    }
  }

  fun finishTurn(s: ConversationState, reply: ChatMessage?): Reduction = Reduction(
    s.copy(streaming = "", live = null, pendingArtifacts = emptyList(), queued = null, agent = Agent.Idle, stopping = false),
    turnEnded = true, reply = reply,
  )

  /** End the turn as stopped: keep what was written, mark the steps, say so. */
  fun finishStopped(s: ConversationState, now: Instant = Instant.now()): Reduction {
    val partial = s.streaming
    val trace = s.live
    val wasBusy = s.agent != Agent.Idle
    var st = s.copy(stopping = false)
    if (wasBusy || partial.isNotEmpty() || trace != null) {
      val m = ChatMessage(role = "assistant", content = partial, timestamp = now, stopped = true)
      val kept = trace?.takeIf { it.hasProcess }?.finished(stopped = true, now = now)
      if (kept != null) st = st.copy(traces = st.traces + (m.id to kept))
      if (partial.isNotEmpty() || kept != null) st = st.copy(messages = st.messages + m)
    }
    return finishTurn(st, null)
  }

  /** The note the runtime sends back when a turn is stopped (agent.ts, "⏹ Task stopped. …"). */
  fun isStopNote(text: String): Boolean = Regex("^\\s*⏹\\s*Task (stopped|halted)\\b").containsMatchIn(text)

  /** Is a step's result a failure? The runtime says so now; older ones only by the text. */
  fun stepFailed(data: JsonObject, summary: String?): Boolean {
    data.bool("failed")?.let { return it }
    val s = summary?.trim().orEmpty()
    if (s.isEmpty()) return false
    return Regex("^(error|failed|denied|blocked|HTTP [45]\\d\\d\\b|Request to .* timed out)", RegexOption.IGNORE_CASE).containsMatchIn(s)
  }

  fun optionLabel(v: String): String = when (v) {
    "yes" -> "Allow once"
    "always" -> "Always allow"
    "no" -> "Deny"
    else -> v
  }

  private fun artifacts(arr: JsonArray?): List<ArtifactRef> = arr.orEmpty().mapNotNull {
    runCatching { MercuryJson.decodeFromJsonElement(ArtifactRef.serializer(), it) }.getOrNull()
  }
}
