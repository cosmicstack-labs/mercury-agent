package sh.mercuryagent.ui.conversation

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import sh.mercuryagent.core.ChatMessage

/**
 * Labels between a conversation's messages from different days: "Today", "Yesterday", "Mon 3 Nov"
 * (with the year when it isn't this one). None before the first message when it's from today.
 */
object DaySeparators {
  fun label(d: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val day = d.atZone(zone).toLocalDate(); val today = now.atZone(zone).toLocalDate()
    val diff = ChronoUnit.DAYS.between(day, today)
    if (diff == 0L) return "Today"
    if (diff == 1L) return "Yesterday"
    val pattern = if (day.year != today.year) "EEE d MMM yyyy" else "EEE d MMM"
    return DateTimeFormatter.ofPattern(pattern, locale).format(day)
  }

  /** Message id → the label to show above it. */
  fun make(messages: List<ChatMessage>, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Map<String, String> {
    val out = mutableMapOf<String, String>()
    var last: java.time.LocalDate? = null
    val today = now.atZone(zone).toLocalDate()
    for (m in messages) {
      val day = m.timestamp.atZone(zone).toLocalDate()
      if (last == day) continue
      if (last != null || day != today) out[m.id] = label(m.timestamp, now, zone)
      last = day
    }
    return out
  }
}
