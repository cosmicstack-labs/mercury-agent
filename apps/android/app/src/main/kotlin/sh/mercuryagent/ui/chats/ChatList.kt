package sh.mercuryagent.ui.chats

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import sh.mercuryagent.core.ChatThread

/** What a chat is doing right now (ADR-037): several can run at once, so each row has its own. */
sealed interface ChatStatus {
  data object Working : ChatStatus
  data object Waiting : ChatStatus
  data class NeedsYou(val prompt: String?) : ChatStatus
  data object Failed : ChatStatus
}

/**
 * The drawer's day labels, after Mercury Desktop's ThreadList `groupByDay`, finer for the week:
 * "Today", "Yesterday", "2 days ago" … "6 days ago", "Previous 30 days", then the month ("October",
 * or "September 2025" in another year). Counted in calendar days in the phone's time zone, so a chat
 * from 11 pm is "Yesterday" at 1 am. The same rules as iOS's `ChatSections`.
 */
object ChatSections {
  /** [title] null: no label (Saved, which is newest save first, not by day). */
  data class Section(val title: String?, val threads: List<ChatThread>)

  private val months = listOf("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")

  fun title(d: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val day = d.atZone(zone).toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(day, today)
    return when {
      days <= 0 -> "Today"
      days == 1L -> "Yesterday"
      days < 7 -> "$days days ago"
      days < 30 -> "Previous 30 days"
      else -> {
        val month = months[day.monthValue - 1]
        if (day.year == today.year) month else "$month ${day.year}"
      }
    }
  }

  /** Threads in the order given, cut into day sections (in order of first appearance). */
  fun byDay(threads: List<ChatThread>, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<Section> {
    val out = LinkedHashMap<String, MutableList<ChatThread>>()
    for (t in threads) out.getOrPut(title(t.lastActivity, now, zone)) { mutableListOf() } += t
    return out.map { Section(it.key, it.value) }
  }
}

/**
 * Which chats have something this phone hasn't seen. Mercury keeps no read state, so the phone keeps
 * its own: when it last looked at each chat, per Mercury (two Mercurys can share chat ids). A chat is
 * unread when it moved after that. Chats with no mark compare against when marks started, so a first
 * launch doesn't show everything as new. Immutable: each change returns new marks to save.
 */
data class ReadMarks(val seen: Map<String, Instant> = emptyMap(), val since: Instant = Instant.now()) {
  fun isUnread(t: ChatThread, open: String? = null): Boolean {
    if (t.id == open) return false
    return Duration.between(seen[t.id] ?: since, t.lastActivity) > SLACK
  }

  /** Seen now, or as of the chat's last activity when Mercury's clock runs ahead of the phone's. */
  fun markSeen(id: String, at: Instant = Instant.now()): ReadMarks {
    val old = seen[id]
    if (old != null && old >= at) return this
    return copy(seen = seen + (id to at))
  }

  fun markAllSeen(threads: List<ChatThread>, now: Instant = Instant.now()): ReadMarks =
    copy(seen = seen + threads.associate { t -> t.id to maxOf(now, t.lastActivity, seen[t.id] ?: Instant.MIN) })

  /** Marks for chats that are gone are dropped; a fresh mark stays (its chat may be newer than the list). */
  fun prune(keeping: Set<String>, now: Instant = Instant.now()): ReadMarks {
    val kept = seen.filter { it.key in keeping || Duration.between(it.value, now) < Duration.ofMinutes(10) }
    return if (kept.size == seen.size) this else copy(seen = kept)
  }

  companion object {
    /** A second's slack: the phone's clock and Mercury's aren't quite the same. */
    val SLACK: Duration = Duration.ofSeconds(1)
  }
}

/** The list's filtering and ordering, kept pure for tests. */
object ChatFilter {
  fun visible(threads: List<ChatThread>, query: String, savedOnly: Boolean): List<ChatThread> {
    val q = query.trim().lowercase()
    val list = if (savedOnly) threads.filter { it.savedAt != null }.sortedByDescending { it.savedAt }
    else threads.sortedByDescending { it.lastActivity }
    return if (q.isEmpty()) list
    else list.filter { it.displayTitle.lowercase().contains(q) || it.preview?.lowercase()?.contains(q) == true }
  }

  fun sections(threads: List<ChatThread>, query: String, savedOnly: Boolean, now: Instant = Instant.now()): List<ChatSections.Section> {
    val list = visible(threads, query, savedOnly)
    if (savedOnly) return if (list.isEmpty()) emptyList() else listOf(ChatSections.Section("Saved", list))
    return ChatSections.byDay(list, now)
  }
}

object RelativeTime {
  /** "now", "2m", "1h", "Yesterday", "Mon", "3 Nov" */
  fun short(d: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val s = Duration.between(d, now).seconds
    if (s < 60) return "now"
    if (s < 3600) return "${s / 60}m"
    val days = ChronoUnit.DAYS.between(d.atZone(zone).toLocalDate(), now.atZone(zone).toLocalDate())
    if (days == 0L) return "${s / 3600}h"
    if (days == 1L) return "Yesterday"
    if (s < 6 * 86400) return DateTimeFormatter.ofPattern("EEE", locale).format(d.atZone(zone))
    return DateTimeFormatter.ofPattern("d MMM", locale).format(d.atZone(zone))
  }
}

/**
 * The drawer's history, as in Grok's: one list, newest first, rows the title alone, with small day
 * labels between them ("Today", "3 days ago", "October"; search results keep them). "Saved" shows
 * only saved chats, newest save first, unlabelled. A search filters live, on titles and previews;
 * the label above the list says which it is. Built off the main thread.
 */
data class ChatHistory(
  val threads: List<ChatThread> = emptyList(),
  val query: String = "",
  val savedOnly: Boolean = false,
  val sections: List<ChatSections.Section> = emptyList(),
) {
  val isEmpty: Boolean get() = threads.isEmpty()
  /** "Conversations", "Saved" or "Results". */
  val label: String get() = when { query.isNotEmpty() -> "Results"; savedOnly -> "Saved"; else -> "Conversations" }

  companion object {
    fun build(
      threads: List<ChatThread>, query: String, savedOnly: Boolean,
      now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(),
    ): ChatHistory {
      val q = query.trim()
      val base = if (savedOnly) threads.filter { it.savedAt != null }.sortedByDescending { it.savedAt }
      else threads.sortedByDescending { it.lastActivity }
      val shown = if (q.isEmpty()) base else base.filter { ChatSearch.matches(it, q) }
      val sections = if (savedOnly) (if (shown.isEmpty()) emptyList() else listOf(ChatSections.Section(null, shown)))
      else ChatSections.byDay(shown, now, zone)
      return ChatHistory(shown, q, savedOnly, sections)
    }
  }
}

/** Live search over the history: case-insensitive, on the title and the last message. */
object ChatSearch {
  fun matches(t: ChatThread, query: String): Boolean {
    val q = query.trim()
    if (q.isEmpty()) return true
    return t.displayTitle.contains(q, ignoreCase = true) || t.preview?.contains(q, ignoreCase = true) == true
  }

  /** Where [query] occurs in [text], for emphasis (every occurrence, never overlapping). */
  fun ranges(text: String, query: String): List<IntRange> {
    val q = query.trim()
    if (q.isEmpty()) return emptyList()
    val out = mutableListOf<IntRange>()
    var i = text.indexOf(q, ignoreCase = true)
    while (i >= 0) {
      out += i until i + q.length
      i = text.indexOf(q, i + q.length, ignoreCase = true)
    }
    return out
  }
}

/** A status marker before a row's title: only when there's something to say. */
enum class RowMarker { Working, Waiting, NeedsYou, Failed }

/**
 * How a history row looks: the title alone, on one line. A dot before it only when the chat
 * works, waits, needs you or failed; unread: a semibold title and a dot at the end.
 */
data class RowLook(val marker: RowMarker?, val unread: Boolean) {
  companion object {
    fun of(status: ChatStatus?, unread: Boolean): RowLook = RowLook(
      when (status) {
        ChatStatus.Working -> RowMarker.Working
        ChatStatus.Waiting -> RowMarker.Waiting
        is ChatStatus.NeedsYou -> RowMarker.NeedsYou
        ChatStatus.Failed -> RowMarker.Failed
        null -> null
      },
      unread,
    )
  }
}

/** What a waiting question asks, in a few words ("Run a command"), else its first line. */
fun askLine(prompt: String): String = prompt.lineSequence().firstOrNull()?.trim().orEmpty().ifEmpty { prompt }
