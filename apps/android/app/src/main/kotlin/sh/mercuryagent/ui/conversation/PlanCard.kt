package sh.mercuryagent.ui.conversation

import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.mercuryagent.core.ChatPlan
import sh.mercuryagent.ui.theme.Mercury

/**
 * Where a plan stands, for the card (Desktop's PlanCard.tsx, iOS PlanCard.swift). An unfinished plan
 * in an idle chat isn't being worked on, whatever it says: it shows as paused, and nothing pulses.
 */
data class PlanStatus(val state: State, val done: Int, val total: Int, val current: String?) {
  enum class State { Running, Paused, Stopped, Complete }

  val title: String get() = when (state) {
    State.Running -> "Plan"
    State.Paused -> "Plan paused"
    State.Stopped -> "Plan stopped"
    State.Complete -> "Plan complete"
  }

  val settled: Boolean get() = state == State.Paused || state == State.Stopped

  /** The quiet line under a settled plan. */
  val hint: String?
    get() {
      if (!settled) return null
      val from = current?.let { "“$it”" } ?: "where it stopped"
      return (if (state == State.Stopped) "Stopped before it finished." else "The reply came before these steps were done.") +
        " Say “continue” to pick it up from $from."
    }

  companion object {
    /** Chat shows only real multi-step plans (three or more steps). */
    const val MIN_STEPS = 3

    fun of(plan: ChatPlan?, busy: Boolean): PlanStatus? {
      if (plan == null || plan.steps.size < MIN_STEPS) return null
      val steps = plan.steps
      val done = steps.count { it.status == "done" }
      if (done == steps.size) return PlanStatus(State.Complete, done, steps.size, null)
      val current = (steps.firstOrNull { it.status == "active" } ?: steps.firstOrNull { it.status == "pending" })?.label
      val state = if (busy) State.Running else if (plan.state == "stopped") State.Stopped else State.Paused
      return PlanStatus(state, done, steps.size, current)
    }
  }
}

/**
 * The plan Mercury is working through, pinned above the message box: done steps ticked, the current
 * one half filled, the rest open. One line until tapped (remembered per chat). A finished or settled
 * plan can be closed until the plan changes.
 */
@Composable
fun PlanCard(plan: ChatPlan, busy: Boolean, threadId: String?, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  val prefs = remember { context.getSharedPreferences("mercury.plans", Context.MODE_PRIVATE) }
  val key = threadId ?: "new"
  var expanded by remember(key) { mutableStateOf(prefs.getBoolean("open.$key", false)) }
  var closedAt by remember(key) { mutableDoubleStateOf(prefs.getLong("closed.$key", 0L).toDouble()) }
  val s = PlanStatus.of(plan, busy) ?: return
  if (closedAt > 0 && closedAt >= (plan.updatedAt ?: 0.0)) return
  // A finished plan folds by itself once the work stops.
  LaunchedEffect(s.state, busy) { if (s.state == PlanStatus.State.Complete && !busy) expanded = false }
  val c = Mercury.colors
  val turn by animateFloatAsState(if (expanded) 180f else 0f, label = "chevron")
  Surface(
    shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(1.dp, c.line), modifier = modifier.fillMaxWidth().animateContentSize(),
  ) {
    Column {
      Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
          Modifier.weight(1f).heightIn(min = 48.dp)
            .clickable(onClickLabel = if (expanded) "Fold the plan" else "Show the steps", role = Role.Button) {
              expanded = !expanded; prefs.edit().putBoolean("open.$key", expanded).apply()
            }
            .semantics(mergeDescendants = true) { contentDescription = "${s.title}, ${s.done} of ${s.total} done" }
            .padding(start = 14.dp, end = 8.dp),
          verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          ProgressRing(s.done.toFloat() / maxOf(s.total, 1), s.state == PlanStatus.State.Complete)
          Text(s.title, style = MaterialTheme.typography.titleSmall, maxLines = 1)
          Text("${s.done} of ${s.total}", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = c.ink3)
          if (!expanded && !s.settled && s.current != null) Text(
            "· ${s.current}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
          )
          androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
          Icon(Icons.Outlined.ExpandLess, null, Modifier.size(18.dp).rotate(turn), tint = c.ink4)
        }
        if ((s.state == PlanStatus.State.Complete || s.settled) && !busy) IconButton(onClick = {
          closedAt = plan.updatedAt ?: System.currentTimeMillis().toDouble()
          prefs.edit().putLong("closed.$key", closedAt.toLong()).apply()
        }) { Icon(Icons.Outlined.Close, "Close the plan", Modifier.size(18.dp)) }
      }
      if (!expanded && s.settled) Text(
        (s.current?.let { "At “$it” · " } ?: "") + "say “continue” to pick it up",
        style = MaterialTheme.typography.bodySmall, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(start = 40.dp, end = 14.dp, bottom = 10.dp),
      )
      if (expanded) {
        HorizontalDivider(color = c.line)
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          plan.steps.forEach { step ->
            val status = if (s.settled && step.status == "active") "pending" else step.status
            val now = step.status == "active" && !s.settled
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
              StepMark(status, live = busy && step.status == "active", modifier = Modifier.padding(top = 2.dp))
              Text(
                step.label, style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (now) FontWeight.Medium else FontWeight.Normal,
                color = when { step.status == "done" -> c.ink3; now -> MaterialTheme.colorScheme.onSurface; else -> MaterialTheme.colorScheme.onSurfaceVariant },
              )
            }
          }
        }
        s.hint?.let {
          HorizontalDivider(color = c.line)
          Text(it, style = MaterialTheme.typography.bodySmall, color = c.ink3, modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp))
        }
      }
    }
  }
}

/** ✓ done · ◐ in progress (pulsing only while Mercury works) · ○ not started. */
@Composable
fun StepMark(status: String, live: Boolean, modifier: Modifier = Modifier) {
  val ink = MaterialTheme.colorScheme.onSurface
  val c = Mercury.colors
  val label = when (status) { "done" -> "Done"; "active" -> "In progress"; else -> "Not started" }
  val pulse = if (live) rememberInfiniteTransition(label = "pulse").animateFloat(1f, 0.35f, infiniteRepeatable(tween(800), RepeatMode.Reverse), label = "a").value else 1f
  if (status == "done") { Icon(Icons.Filled.CheckCircle, label, modifier.size(16.dp), tint = ink); return }
  Canvas(modifier.size(16.dp).semantics { contentDescription = label }) {
    val r = size.minDimension / 2 - 1.dp.toPx()
    val color = if (status == "active") ink.copy(alpha = pulse) else c.ink4
    drawCircle(color, r, style = Stroke(1.5.dp.toPx()))
    if (status == "active") drawArc(color, 90f, 180f, true, topLeft = Offset(size.width / 2 - r, size.height / 2 - r), size = Size(r * 2, r * 2))
  }
}

@Composable
fun ProgressRing(fraction: Float, complete: Boolean) {
  val ink = MaterialTheme.colorScheme.onSurface
  if (complete) { Icon(Icons.Filled.CheckCircle, null, Modifier.size(16.dp), tint = ink); return }
  Canvas(Modifier.size(16.dp)) {
    val w = 2.dp.toPx()
    drawCircle(ink.copy(alpha = 0.12f), size.minDimension / 2 - w / 2, style = Stroke(w))
    drawArc(ink, -90f, 360f * fraction, false, topLeft = Offset(w / 2, w / 2), size = Size(size.width - w, size.height - w), style = Stroke(w, cap = StrokeCap.Round))
  }
}

