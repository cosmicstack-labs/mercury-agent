package sh.mercuryagent.ui.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SubdirectoryArrowRight
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.delay
import sh.mercuryagent.ui.theme.Mercury

// A turn as it happened, top to bottom: thinking, the tools it ran, the answer, notes (iOS:
// ConversationTimeline.swift, Desktop's TurnTimeline.tsx). Live, the open thinking streams and the
// running tool ticks; pictures being made show as one placeholder grid under it all.

/** The current time, ticking every [periodMs] while [active] (a running turn's clocks). */
@Composable
fun rememberNow(active: Boolean = true, periodMs: Long = 1000): Instant {
  val now by produceState(Instant.now(), active) {
    while (active) { value = Instant.now(); delay(periodMs) }
  }
  return now
}

private fun seconds(a: Instant, b: Instant) = Duration.between(a, b).toMillis() / 1000.0

@Composable
fun TurnTimeline(trace: TurnTrace, live: Boolean, now: Instant, modifier: Modifier = Modifier) {
  val blocks = trace.blocks()
  Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
    blocks.forEachIndexed { n, b ->
      val last = live && n == blocks.lastIndex
      androidx.compose.runtime.key(b.index) {
        when (b) {
          is TurnTrace.Block.Reasoning -> ReasoningBlock(b.text, b.startedAt, b.endedAt, active = last && b.endedAt == null, now = now)
          is TurnTrace.Block.Steps -> StepGroup(b.steps, live, now)
          is TurnTrace.Block.Text -> MarkdownText(b.text)
          is TurnTrace.Block.Note -> if (live && TurnTrace.isSecurity(b.text)) SecurityNotice(b.text) else NoteRow(b.text)
        }
      }
    }
    if (live) trace.liveMedia.forEach { m ->
      androidx.compose.runtime.key(m.id) { MediaPlaceholder(m.shape, m.startedAt, now, done = m.done, quiet = true) }
    }
  }
}

/** A row that folds something open: icon, words, a chevron that turns. 48dp tall for touch. */
@Composable
private fun FoldHeader(icon: androidx.compose.ui.graphics.vector.ImageVector, iconTint: Color, text: String, open: Boolean, hint: String, onClick: () -> Unit) {
  val turn by animateFloatAsState(if (open) 90f else 0f, label = "chevron")
  Row(
    Modifier.heightIn(min = 40.dp).clip8().clickable(onClickLabel = hint, role = Role.Button, onClick = onClick).padding(end = 6.dp),
    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Icon(icon, null, Modifier.size(18.dp), tint = iconTint)
    Text(text, style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.ink3)
    Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp).rotate(turn), tint = Mercury.colors.ink3)
  }
}

private fun Modifier.clip8() = clip(RoundedCornerShape(8.dp))

/** One thinking block: open while it streams (its latest lines), folded to "Thought for 8s" after. */
@Composable
fun ReasoningBlock(text: String, startedAt: Instant, endedAt: Instant?, active: Boolean, now: Instant) {
  var userOpen by rememberSaveable { mutableStateOf<Boolean?>(null) }
  val open = userOpen ?: active
  val took = TurnTrace.duration(seconds(startedAt, endedAt ?: now))
  Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    FoldHeader(
      Icons.Outlined.Psychology, if (active) MaterialTheme.colorScheme.onSurface else Mercury.colors.ink3,
      if (active) "Thinking · $took" else "Thought for $took", open,
      if (open) "Fold the thinking" else "Show the thinking",
    ) { userOpen = !open }
    if (open) {
      Row(Modifier.height(IntrinsicSize.Min).padding(start = 8.dp)) {
        Box(Modifier.width(1.dp).fillMaxHeight().background(Mercury.colors.line))
        val shown = if (active) text.trim().takeLast(420) else text.trim()
        SelectionContainer {
          Text(
            shown, style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.ink3,
            maxLines = if (active) 5 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 12.dp),
          )
        }
      }
    }
  }
}


/** A run of tool calls. Long runs show the latest few; failures and the running one always show. */
@Composable
fun StepGroup(steps: List<TurnTrace.Step>, live: Boolean, now: Instant) {
  var all by rememberSaveable { mutableStateOf(false) }
  // While it runs, a picture or voice being made is its placeholder, not also a row.
  val listed = if (live) steps.filter { !it.isMaking } else steps
  if (listed.isEmpty()) return
  val hidden = if (all) emptyList() else listed.take(maxOf(0, listed.size - SHOWN_STEPS))
    .filter { it.status != TurnTrace.Status.Error && it.status != TurnTrace.Status.Running }
  val hiddenKeys = hidden.map { it.key }.toSet()
  Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
    if (hidden.isNotEmpty()) {
      FoldHeader(Icons.Outlined.ChevronRight, Mercury.colors.ink4, "${hidden.size} earlier step${if (hidden.size == 1) "" else "s"}", false, "Show every step") { all = true }
    }
    listed.filter { it.key !in hiddenKeys }.forEach { s -> androidx.compose.runtime.key(s.key) { StepRow(s, now) } }
  }
}

private const val SHOWN_STEPS = 4

@Composable
fun StepRow(s: TurnTrace.Step, now: Instant) {
  var open by rememberSaveable(s.key) { mutableStateOf(false) }
  val running = s.status == TurnTrace.Status.Running
  val failed = s.status == TurnTrace.Status.Error
  val detail = if (!running) s.summary?.trim().orEmpty() else ""
  val c = Mercury.colors
  val state = when (s.status) { TurnTrace.Status.Running -> "running"; TurnTrace.Status.Error -> "failed"; TurnTrace.Status.Stopped -> "stopped"; else -> "done" }
  Row(
    Modifier.fillMaxWidth().heightIn(min = 36.dp).clip8()
      .then(if (detail.isNotEmpty()) Modifier.clickable(onClickLabel = if (open) "Hide the result" else "Show the result") { open = !open } else Modifier)
      .padding(vertical = 6.dp)
      .semantics(mergeDescendants = true) { stateDescription = state },
    verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
      when (s.status) {
        TurnTrace.Status.Running -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.6.dp, color = MaterialTheme.colorScheme.onSurface)
        TurnTrace.Status.Stopped -> Icon(Icons.Filled.Stop, null, Modifier.size(12.dp), tint = c.ink4)
        TurnTrace.Status.Error -> Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(16.dp), tint = c.red)
        TurnTrace.Status.Done -> Icon(Icons.Outlined.Check, null, Modifier.size(16.dp), tint = c.ink3)
      }
    }
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        s.label, style = MaterialTheme.typography.bodyMedium,
        color = if (running) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = if (open) Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis,
      )
      if (s.status == TurnTrace.Status.Stopped) Text("Stopped before it finished", style = MaterialTheme.typography.bodySmall, color = c.ink4)
      if (detail.isNotEmpty() && (failed || open)) Text(
        detail, style = MaterialTheme.typography.bodySmall, color = if (failed) c.red.copy(alpha = 0.9f) else c.ink4,
        maxLines = if (open) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis,
      )
    }
    s.duration(now)?.let { d ->
      Text(TurnTrace.duration(d), fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = if (running) c.ink3 else c.ink4, modifier = Modifier.padding(top = 2.dp))
    }
  }
}

/** "Checking my work…": a note inside the turn, not its reply. */
@Composable
fun NoteRow(text: String) {
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
    Icon(Icons.Outlined.SubdirectoryArrowRight, null, Modifier.size(14.dp).padding(top = 2.dp), tint = Mercury.colors.ink4)
    Text(text.replace(Regex("^[^\\p{L}\\p{N}*_`]+"), ""), style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
  }
}

/** Mercury's own warning that something it read holds instructions written to an AI (ADR-044): never folded away. */
@Composable
fun SecurityNotice(text: String, modifier: Modifier = Modifier) {
  val amber = Mercury.colors.amber
  Row(
    modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(amber.copy(alpha = 0.08f))
      .border(1.dp, amber.copy(alpha = 0.35f), RoundedCornerShape(12.dp)).padding(12.dp)
      .semantics(mergeDescendants = true) {},
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(Icons.Outlined.Shield, null, Modifier.size(18.dp), tint = amber)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text("Hidden instructions found", style = MaterialTheme.typography.titleSmall)
      SelectionContainer { Text(cleanSecurity(text), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
  }
}

/** Without the leading shield and markdown emphasis. */
fun cleanSecurity(s: String): String = s.replace(Regex("^[^\\p{L}\\p{N}\"“(]+"), "").replace("**", "")

/** What the line under a running turn says (iOS: LiveStatusLine.what). Pure, for tests. */
object LiveStatus {
  const val QUIET_S = 20.0
  const val LONG_QUIET_S = 120.0

  fun what(t: TurnTrace, agent: Agent, stopping: Boolean, waitingForYou: Boolean, queued: Int?, now: Instant): String {
    val quietFor = seconds(t.lastEventAt, now)
    val last = t.items.lastOrNull()
    val writing = last is TurnTrace.Item.Text && quietFor < 2.5 && !stopping
    val thinking = last is TurnTrace.Item.Reasoning && last.endedAt == null
    val step = t.runningStep
    val media = t.liveMedia.firstOrNull()
    val makingNow = media != null && media.done < media.total && (step == null || step.isMaking)
    return when {
      stopping -> "Stopping"
      queued != null -> "Waiting for another chat to finish"
      writing -> "Writing"
      makingNow -> MediaText.describe(media!!, now)
      step != null -> step.label
      thinking -> "Thinking"
      t.phase != null -> t.phase
      waitingForYou -> "Waiting for you"
      t.items.isEmpty() -> "Starting"
      agent == Agent.Streaming -> "Writing"
      else -> "Working"
    }
  }
}

/** The one progress line under a running turn: what is happening and how long it has taken. */
@Composable
fun LiveStatusLine(trace: TurnTrace, agent: Agent, stopping: Boolean, waitingForYou: Boolean, queued: Int?, now: Instant) {
  val quietFor = seconds(trace.lastEventAt, now)
  val waitingOnModel = trace.runningStep == null && !stopping && !waitingForYou && queued == null && quietFor >= LiveStatus.QUIET_S
  val c = Mercury.colors
  val what = LiveStatus.what(trace, agent, stopping, waitingForYou, queued, now)
  Column(Modifier.semantics(mergeDescendants = true) { contentDescription = what }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.6.dp, color = if (stopping) c.ink4 else MaterialTheme.colorScheme.onSurface)
      ShimmerText("$what…", Modifier.weight(1f))
      Text(TurnTrace.duration(seconds(trace.startedAt, now)), fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = c.ink4)
    }
    AnimatedVisibility(waitingOnModel) {
      val long = quietFor >= LiveStatus.LONG_QUIET_S
      Row(Modifier.padding(start = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (long) Icon(Icons.Outlined.WarningAmber, null, Modifier.size(14.dp), tint = c.amber)
        Text(
          if (long) "No response from the model for ${TurnTrace.duration(quietFor)}. It may be overloaded: you can stop and try again."
          else "Waiting for the model · ${TurnTrace.duration(quietFor)}",
          style = MaterialTheme.typography.bodySmall, color = if (long) c.amber else c.ink4,
        )
      }
    }
  }
}

/** A finished reply's thought process, folded to one line: "Worked for 12s · 3 steps". */
@Composable
fun ThoughtProcess(trace: TurnTrace) {
  var open by rememberSaveable { mutableStateOf(false) }
  Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    FoldHeader(
      when { trace.stopped -> Icons.Outlined.StopCircle; trace.steps.isEmpty() -> Icons.Outlined.Psychology; else -> Icons.Outlined.Checklist },
      Mercury.colors.ink3, trace.summary, open, if (open) "Fold the steps" else "Show the thinking and steps",
    ) { open = !open }
    if (open) TurnTimeline(trace, live = false, now = trace.endedAt ?: Instant.now(), modifier = Modifier.padding(start = 4.dp))
  }
}

/** Equal tiles in rows (waiting and finished pictures share it, so nothing jumps). */
@Composable
fun TileGrid(count: Int, columns: Int, ratio: Float = 1f, spacing: androidx.compose.ui.unit.Dp = 6.dp, modifier: Modifier = Modifier, tile: @Composable (Int) -> Unit) {
  val rows = (count + columns - 1) / maxOf(columns, 1)
  Column(modifier, verticalArrangement = Arrangement.spacedBy(spacing)) {
    for (r in 0 until rows) {
      Row(horizontalArrangement = Arrangement.spacedBy(spacing)) {
        for (c in 0 until columns) {
          val i = r * columns + c
          Box(Modifier.weight(1f).aspectRatio(ratio)) { if (i < count) tile(i) }
        }
      }
    }
  }
}
