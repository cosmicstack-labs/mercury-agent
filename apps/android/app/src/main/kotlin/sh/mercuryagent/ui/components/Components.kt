package sh.mercuryagent.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sh.mercuryagent.ui.theme.Mercury

/** A chat's marker: steady for needs-you or failed, breathing while it runs, hollow while it waits. */
@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier, running: Boolean = false, hollow: Boolean = false, size: Dp = 9.dp) {
  val pulse = if (running) {
    val t = rememberInfiniteTransition(label = "dot")
    t.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Restart), label = "pulse").value
  } else 0f
  Canvas(modifier.size(size)) {
    val r = this.size.minDimension / 2
    if (running) drawCircle(color.copy(alpha = 0.3f * (1 - pulse)), radius = r * (1 + 0.9f * pulse))
    if (hollow) drawCircle(color, radius = r - 1.dp.toPx(), style = Stroke(1.5.dp.toPx()))
    else drawCircle(color, radius = r, center = Offset(r, r))
  }
}

@Composable
fun ErrorText(text: String, modifier: Modifier = Modifier) {
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
    Icon(Icons.Outlined.ErrorOutline, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
  }
}

/** A centred state: the mark, a title, a line, and maybe a button. */
@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
  Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
      MarkTile(56.dp)
      Text(title, style = MaterialTheme.typography.titleMedium)
      Text(
        body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 300.dp),
      )
      action?.invoke()
    }
  }
}

/** The placeholder for screens a later phase fills in. */
@Composable
fun ComingSoon(what: String, modifier: Modifier = Modifier) {
  EmptyState("Coming in the next phase", "$what will be here soon. Mercury Desktop and the iPhone app have it today.", modifier)
}

@Composable
fun quietInk(): Color = Mercury.colors.ink3
