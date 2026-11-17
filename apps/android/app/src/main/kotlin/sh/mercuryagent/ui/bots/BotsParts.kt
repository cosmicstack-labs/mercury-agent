package sh.mercuryagent.ui.bots

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Badge
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import sh.mercuryagent.core.RunState
import sh.mercuryagent.ui.components.StatusDot
import sh.mercuryagent.ui.theme.Mercury

/** A section title over a list ("Fleets", "Today"). */
@Composable
internal fun BotsSectionTitle(text: String, modifier: Modifier = Modifier) {
  Text(
    text, style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3,
    modifier = modifier.padding(top = 16.dp, bottom = 6.dp).semantics { heading() },
  )
}

/** A quiet centred state inside a list (no full-screen fill, unlike EmptyState). */
@Composable
internal fun BotsEmpty(title: String, text: String, modifier: Modifier = Modifier) {
  Column(
    modifier.fillMaxWidth().padding(vertical = 48.dp, horizontal = 16.dp),
    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(Icons.Outlined.SmartToy, null, tint = Mercury.colors.ink3, modifier = Modifier.size(32.dp))
    Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
    Text(
      text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 300.dp),
    )
  }
}

/** An unread count, in ink (the app is monochrome; Material's default badge is red). */
@Composable
internal fun CountBadge(n: Int) {
  Badge(
    containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary,
    modifier = Modifier.semantics { contentDescription = "$n unread" },
  ) { Text("$n") }
}

/** A state in words with a small dot: green while working, amber when it needs you, red when it failed. */
@Composable
internal fun StateLabel(text: String, dot: Color?, running: Boolean = false, modifier: Modifier = Modifier) {
  Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    if (dot != null) StatusDot(dot, running = running, size = 8.dp)
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
  }
}

/** The dot for a run's state. */
@Composable
internal fun runDot(s: RunState): Color? = when (s) {
  RunState.Working, RunState.Queued -> Mercury.colors.green
  RunState.Waiting, RunState.Paused -> Mercury.colors.amber
  RunState.Failed -> Mercury.colors.red
  else -> null
}

/** A file a bot delivered, by its name. */
@Composable
internal fun FileChip(path: String) {
  Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
    Row(Modifier.padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
      Text(
        path.substringAfterLast('/'), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1, overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

/** A small tag ("job done", a reason). */
@Composable
internal fun Tag(text: String, dot: Color? = null) {
  Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
    StateLabel(text, dot, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
  }
}

internal object BotsTime {
  private val zone: ZoneId get() = ZoneId.systemDefault()

  fun time(ms: Double): String =
    DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault()).format(Instant.ofEpochMilli(ms.toLong()).atZone(zone))

  /** The time today, else "3 Nov, 14:05". */
  fun stamp(ms: Double, now: Double): String {
    val d = Instant.ofEpochMilli(ms.toLong()).atZone(zone)
    val n = Instant.ofEpochMilli(now.toLong()).atZone(zone)
    return if (d.toLocalDate() == n.toLocalDate()) time(ms)
    else DateTimeFormatter.ofPattern("d MMM", Locale.getDefault()).format(d) + ", " + time(ms)
  }

  /** "Today", "Yesterday", or "Monday 3 Nov". */
  fun day(ms: Double, today: LocalDate = LocalDate.now(zone)): String {
    val d = Instant.ofEpochMilli(ms.toLong()).atZone(zone).toLocalDate()
    return when (d) {
      today -> "Today"
      today.minusDays(1) -> "Yesterday"
      else -> DateTimeFormatter.ofPattern("EEEE d MMM", Locale.getDefault()).format(d)
    }
  }
}

/** Markdown's inline marks taken out, for a short preview. */
internal fun plainInline(s: String): String =
  s.replace("**", "").replace("__", "").replace("`", "").replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1")
