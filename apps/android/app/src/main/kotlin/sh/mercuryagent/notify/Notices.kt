package sh.mercuryagent.notify

import sh.mercuryagent.core.ActivityEvent

/** What this phone tells you about (Settings → Notifications), kept on the phone. */
data class NotifyPrefs(
  val needsYou: Boolean = true,
  val done: Boolean = true,
  /** A finished task notifies only when it ran at least this long (seconds). */
  val doneAfterSec: Int = 30,
  val failed: Boolean = true,
  /** A bot's results, failures and questions (its inbox). */
  val bots: Boolean = true,
  /** Keep the connection open in the background all the time, not only while something runs. */
  val stayConnected: Boolean = false,
  /** Asked once for Android's notification permission. */
  val asked: Boolean = false,
) {
  companion object {
    val afterChoices = listOf(10 to "10 seconds", 30 to "30 seconds", 60 to "1 minute", 120 to "2 minutes", 300 to "5 minutes")
  }
}

/** A notification to show: needs you, done or failed, about a chat (its id) or a bot ("bot:<id>"). */
data class Notice(val kind: Kind, val key: String, val title: String, val body: String) {
  enum class Kind { NeedsYou, Done, Failed }
}

/** A bot's inbox entry from /api/bots/events (`bot_inbox`). */
data class BotInboxEntry(val botId: String, val botName: String, val kind: String, val title: String, val summary: String)

/**
 * When to tell you what, as Mercury Desktop decides it (apps/desktop/src/app/notify/notify.ts):
 * a question waiting, a long task done (with its first words, after the long-task threshold using
 * the event's `ms`), a failure, a research report (said instead of the plain "Done" it follows, the
 * held-done pattern), and a bot's inbox. Nothing for the chat on screen. Pure: time is passed in, so
 * it's tested without a phone.
 */
class NotifyDecider(var prefs: NotifyPrefs = NotifyPrefs()) {
  sealed interface Out {
    data class Post(val notice: Notice) : Out
    /** The notification about [key] is out of date (answered, or the chat was opened). */
    data class Cancel(val key: String) : Out
  }

  /** The chat on screen: nothing is told about it. */
  var viewing: String? = null
  /** The Bots screen is on screen: its inbox needs no notification. */
  var botsOnScreen: Boolean = false

  /** Chats working now (or waiting on you): the background connection stays while there are any. */
  val running: MutableSet<String> = linkedSetOf()
  /** Chats waiting on an answer. */
  val waiting: MutableSet<String> = linkedSetOf()

  private val startedAt = mutableMapOf<String, Long>()
  private val held = linkedMapOf<String, Pair<Long, Notice>>()

  fun handle(e: ActivityEvent, nowMs: Long): List<Out> {
    val id = e.sessionId
    when (e.kind) {
      "started" -> { running += id; startedAt.putIfAbsent(id, nowMs) }
      "needs_you" -> {
        running += id; waiting += id
        if (viewing == id || !prefs.needsYou) return emptyList()
        return listOf(Out.Post(Notice(Notice.Kind.NeedsYou, id, "Mercury needs you", "${label(e)}: ${e.prompt?.takeIf { it.isNotBlank() } ?: "waiting for your answer"}")))
      }
      "resolved" -> { waiting -= id; return listOf(Out.Cancel(id)) }
      "done", "failed" -> {
        val began = startedAt.remove(id)
        running -= id; waiting -= id
        val ms = e.ms ?: began?.let { (nowMs - it).toDouble() } ?: 0.0
        if (viewing == id || !worthTelling(e.kind, ms, prefs)) return listOf(Out.Cancel(id))
        if (e.kind == "done") {
          held[id] = (nowMs + HOLD_DONE_MS) to Notice(Notice.Kind.Done, id, "Done: ${label(e)}", e.preview?.takeIf { it.isNotBlank() } ?: "Mercury finished.")
          return listOf(Out.Cancel(id))
        }
        return listOf(Out.Post(Notice(Notice.Kind.Failed, id, "Stopped with an error: ${label(e)}", e.message?.takeIf { it.isNotBlank() } ?: "Something went wrong.")))
      }
      "stopped" -> { startedAt.remove(id); running -= id; waiting -= id; return listOf(Out.Cancel(id)) }
      "research" -> {
        // Said instead of the plain "Done" it follows; with no "done" waiting, the turn was short,
        // watched, or its failure was already told.
        held.remove(id) ?: return emptyList()
        if (viewing == id) return emptyList()
        val r = researchNotice(e)
        return listOf(Out.Post(r))
      }
    }
    return emptyList()
  }

  /** Held "done" notices whose wait is over. */
  fun due(nowMs: Long): List<Out> {
    val ready = held.filter { it.value.first <= nowMs }
    ready.keys.forEach { held.remove(it) }
    return ready.values.filter { viewing != it.second.key }.map { Out.Post(it.second) }
  }

  /** When the next held notice is due, if any. */
  fun nextDue(): Long? = held.values.minOfOrNull { it.first }

  /** A bot's inbox entry: a result, a failure it reported, or a run that needs you. */
  fun bot(entry: BotInboxEntry): List<Out> {
    if (!prefs.bots || botsOnScreen) return emptyList()
    if (entry.kind == "needs-you" && !prefs.needsYou) return emptyList()
    val body = entry.summary.replace(Regex("\\s+"), " ").trim().take(180)
    val key = "bot:${entry.botId}"
    return listOf(Out.Post(when (entry.kind) {
      "result" -> Notice(Notice.Kind.Done, key, entry.title, body.ifEmpty { "Finished." })
      "failed" -> Notice(Notice.Kind.Failed, key, entry.title, body)
      else -> Notice(Notice.Kind.NeedsYou, key, entry.title, body.ifEmpty { "It needs you." })
    }))
  }

  /** The chat came on screen: what was told about it is read. */
  fun opened(id: String): List<Out> { viewing = id; held.remove(id); return listOf(Out.Cancel(id)) }

  /** Which chats run now (GET /api/chat/running), so a reconnect knows what it missed. */
  fun seed(runningIds: Collection<String>, nowMs: Long) {
    running.retainAll(runningIds.toSet() + waiting)
    for (id in runningIds) { running += id; startedAt.putIfAbsent(id, nowMs) }
  }

  companion object {
    /** A research run's own update follows its "done" by a moment and says more. */
    const val HOLD_DONE_MS = 1500L

    fun worthTelling(kind: String, ms: Double, prefs: NotifyPrefs): Boolean =
      if (kind == "failed") prefs.failed else prefs.done && ms >= prefs.doneAfterSec * 1000.0

    fun label(e: ActivityEvent): String = e.title.orEmpty().replace(Regex("^Code · "), "").trim().ifEmpty { "A conversation" }

    /** "Research ready: solar storms" and "41 sources read · 23 cited · 3 couldn't be read". */
    fun researchNotice(e: ActivityEvent): Notice {
      val topic = (e.topic?.takeIf { it.isNotEmpty() } ?: e.title?.takeIf { it.isNotEmpty() } ?: "your question").replace(Regex("\\s+"), " ").take(90)
      val read = e.read ?: 0
      val counts = listOf(
        "$read source${if (read == 1) "" else "s"} read",
        e.cited?.takeIf { it > 0 }?.let { "$it cited" }.orEmpty(),
        e.failed?.takeIf { it > 0 }?.let { "$it couldn't be read" }.orEmpty(),
      ).filter { it.isNotEmpty() }.joinToString(" · ")
      val id = e.sessionId
      return when (e.state) {
        "done" -> Notice(Notice.Kind.Done, id, "Research ready: $topic", counts)
        "partial" -> Notice(Notice.Kind.Done, id, "Partial research report: $topic", "Stopped early, written from what was read. $counts")
        "stopped" -> Notice(Notice.Kind.Failed, id, "Research stopped: $topic", counts)
        else -> Notice(Notice.Kind.Failed, id, "Research didn't finish: $topic", "$counts. Open it to continue.")
      }
    }
  }
}
