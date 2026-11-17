package sh.mercuryagent.core

import kotlin.math.roundToLong

/*
 The live feed's model: raw bot events → one card per run. A port of iOS's BotsLive.swift (itself
 Mercury Desktop's apps/desktop/src/views/bots/live-runs.ts and the store's mergeLive); keep them
 in step.

 A run's state is worked out from its latest event, so it can't drift: an answered question or a
 finished run clears itself. "Waiting for you" comes only from a pending approval for that very
 run, never from wording. A run with no ending event whose bot is no longer running (the runtime
 restarted mid-run) is shown as ended, not "working" forever.
 */

enum class RunState(val label: String) {
  Queued("Queued"), Working("Working"), Waiting("Waiting for you"), Done("Done"),
  Failed("Failed"), Stopped("Stopped"), Paused("Paused"), Ended("Ended");

  /** Still going (or about to): shows elapsed time to now and no Reply. */
  val isActive: Boolean get() = this == Working || this == Waiting || this == Queued
}

data class LiveStep(
  val label: String,
  /** running, done, error or note */
  val status: String,
  val detail: String? = null,
  val at: Double,
)

data class LiveRun(
  val jobId: String,
  val botId: String,
  val botName: String,
  val trigger: String? = null,
  val prompt: String? = null,
  val fromBot: String? = null,
  val startedAt: Double,
  val updatedAt: Double,
  val steps: List<LiveStep> = emptyList(),
  /** Steps the model took (its step counter). */
  val stepCount: Int = 0,
  /** The reply as it is being written (a rolling tail). */
  val text: String? = null,
  val reasoning: String? = null,
  val state: RunState,
  /** How it ended, in the runtime's words ("completed", "failed: …"). */
  val endLabel: String? = null,
) {
  val id: String get() = jobId
}

object LiveRuns {
  /** How many live events the app keeps (the whole fleet). */
  const val CAP = 2000

  /** Steps that only count ("step 4 · 12.3k tok in") rather than say something. */
  internal fun isCounter(label: String): Boolean = label.startsWith("step ") && label.length > 5 && label[5] in '0'..'9'

  internal fun endState(e: BotActivityEvent): RunState {
    val l = e.label.lowercase()
    return when {
      l.startsWith("paused") -> RunState.Paused
      l.startsWith("stopped") || l == "halted" -> RunState.Stopped
      e.status == "error" || l.startsWith("failed") -> RunState.Failed
      else -> RunState.Done
    }
  }

  /**
   * Runs from events (oldest first in, oldest first out). [running] is the set of bots the runtime
   * says are running now (null: unknown); [approvals] the questions waiting; [now] in ms. Deliveries
   * outside a run join the bot's latest run.
   */
  fun runsFrom(
    events: List<BotActivityEvent>,
    running: Set<String>? = null,
    approvals: List<BotApproval> = emptyList(),
    now: Double = System.currentTimeMillis().toDouble(),
  ): List<LiveRun> {
    val runs = mutableListOf<LiveRun>()
    val byJob = HashMap<String, Int>()
    val latestOf = HashMap<String, Int>()
    for (e in events) {
      val at = e.at ?: now
      val job = e.jobId ?: ""
      val found: Int? = if (job.isEmpty()) latestOf[e.botId] else byJob[job]
      val i: Int
      if (found != null) {
        i = found
      } else {
        if (job.isEmpty() && e.kind != "tool") continue
        val id = if (job.isEmpty()) "loose-${e.botId}-${at.toLong()}" else job
        runs += LiveRun(
          jobId = id, botId = e.botId, botName = e.botName ?: e.botId, startedAt = at, updatedAt = at,
          state = if (e.kind == "queued") RunState.Queued else RunState.Working,
        )
        i = runs.size - 1
        byJob[id] = i
      }
      if (job.isNotEmpty()) latestOf[e.botId] = i
      var run = runs[i]
      run = run.copy(updatedAt = maxOf(run.updatedAt, at))
      if (!e.botName.isNullOrEmpty()) run = run.copy(botName = e.botName)
      when (e.kind) {
        "queued" -> run = run.copy(prompt = run.prompt ?: e.prompt, trigger = run.trigger ?: e.trigger)
        "turn-start" -> run = run.copy(
          prompt = e.prompt ?: run.prompt ?: e.label, trigger = e.trigger ?: run.trigger,
          fromBot = e.fromBot ?: run.fromBot, state = RunState.Working,
        )
        "tool" -> {
          val status = when (e.status) { "error" -> "error"; "running" -> "running"; else -> "done" }
          val steps = run.steps.toMutableList()
          val open = if (status != "running") steps.indexOfLast { it.label == e.label && it.status == "running" } else -1
          if (open >= 0) steps[open] = steps[open].copy(status = status, detail = e.detail, at = at)
          else steps += LiveStep(e.label, status, e.detail?.takeIf { it.isNotEmpty() }, at)
          run = run.copy(steps = steps, state = if (run.state == RunState.Queued) RunState.Working else run.state)
        }
        "step" -> {
          if (isCounter(e.label)) run = run.copy(stepCount = maxOf(run.stepCount, e.stepIndex ?: 0))
          else if (run.steps.lastOrNull()?.label != e.label) run = run.copy(steps = run.steps + LiveStep(e.label, "note", at = at))
          if (run.state == RunState.Queued) run = run.copy(state = RunState.Working)
        }
        "thinking" -> {
          if (!e.textTail.isNullOrEmpty()) run = run.copy(text = e.textTail)
          if (!e.reasoningTail.isNullOrEmpty()) run = run.copy(reasoning = e.reasoningTail)
        }
        "turn-end" -> {
          val state = endState(e)
          // Nothing still "running" in a finished run.
          val steps = run.steps.map { if (it.status == "running") it.copy(status = if (state == RunState.Done) "done" else "error") else it }
          run = run.copy(state = state, endLabel = e.label, steps = steps)
        }
        else -> Unit
      }
      runs[i] = run
    }
    val waiting = approvals.map { it.runId }.toSet()
    for (i in runs.indices) {
      var r = runs[i]
      if (r.jobId in waiting && (r.state == RunState.Working || r.state == RunState.Queued)) r = r.copy(state = RunState.Waiting)
      // No ending event, and the bot isn't running any more: it ended without telling us (a restart).
      if (r.state == RunState.Working && running != null && r.botId !in running && now - r.updatedAt > 60_000) r = r.copy(state = RunState.Ended)
      runs[i] = r
    }
    // Oldest first; ties keep the order they arrived in (sortedBy is stable).
    return runs.sortedBy { it.startedAt }
  }

  /** One key per distinct event: the same event from history and the stream counts once. */
  fun key(e: BotActivityEvent): String =
    "${e.jobId ?: ""}|${e.kind}|${e.stepIndex ?: 0}|${e.label}|${e.status ?: ""}|${(e.at ?: 0.0).toLong()}"

  /** Merge events into the feed: dedupe, keep only the latest thinking preview per run, sort by time, cap. */
  fun merge(current: List<BotActivityEvent>, incoming: List<BotActivityEvent>, cap: Int = CAP): List<BotActivityEvent> {
    val seen = current.mapTo(HashSet()) { key(it) }
    val next = current.toMutableList()
    for (e in incoming) {
      if (!seen.add(key(e))) continue
      if (e.kind == "thinking") next.removeAll { it.kind == "thinking" && it.jobId == e.jobId && (it.at ?: 0.0) <= (e.at ?: 0.0) }
      next += e
    }
    val sorted = next.sortedBy { it.at ?: 0.0 }
    return if (sorted.size > cap) sorted.takeLast(cap) else sorted
  }

  /** Who started a run, in words. */
  fun startedBy(r: LiveRun, nameOf: (String) -> String? = { null }): String = when (val t = r.trigger) {
    "api", "web", "chat" -> "You"
    "telegram" -> "You · Telegram"
    "cloud" -> "You · Cloud"
    "cron" -> "Schedule"
    "mailbox" -> r.fromBot?.let { "From ${nameOf(it) ?: it}" } ?: "From the fleet"
    null -> "Run"
    else -> if (t.isEmpty()) "Run" else t.substring(0, 1).uppercase() + t.substring(1)
  }

  /** Reply on a finished run: the draft that answers it with the run quoted. */
  fun replyDraft(r: LiveRun): String {
    val said = (r.text ?: r.endLabel ?: "").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    val tail = said.takeLast(160)
    val asked = (r.prompt ?: "").take(60)
    return "Re your run \"$asked\"" + (if (tail.isEmpty()) "" else " (you said: \"…$tail\")") + ":\n"
  }

  /** "4s", "2m 5s", "1h 3m" */
  fun duration(ms: Double): String {
    val s = (ms / 1000).roundToLong()
    if (s < 60) return "${s}s"
    val m = s / 60
    return if (m < 60) "${m}m ${s % 60}s" else "${m / 60}h ${m % 60}m"
  }

  /** 950, 12.3k, 1.2M tokens. */
  fun compact(n: Int): String = when {
    n >= 1_000_000 -> String.format(java.util.Locale.US, "%.1fM", n / 1e6)
    n >= 1000 -> String.format(java.util.Locale.US, "%.1fk", n / 1e3)
    else -> "$n"
  }

  /** History's words for what started a run. */
  fun triggerWords(t: String): String = when (t) {
    "api", "web", "chat" -> "from you"
    "cron" -> "schedule"
    "mailbox" -> "from the fleet"
    else -> t
  }
}
