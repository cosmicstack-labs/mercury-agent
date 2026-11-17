package sh.mercuryagent.ui.call

import android.app.Activity
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.sin
import sh.mercuryagent.call.CallApproval
import sh.mercuryagent.call.CallMeter
import sh.mercuryagent.call.CallPhase
import sh.mercuryagent.call.VoiceCallModel
import sh.mercuryagent.ui.components.MercuryMark
import sh.mercuryagent.ui.theme.Mercury

/**
 * A voice call with Mercury (iOS: VoiceCallView), full screen and monochrome. The orb is the call:
 * it breathes while Mercury listens, swells with your voice, ripples out with Mercury's, and a slow
 * light circles it while Mercury works (what it's doing is written under it). Tap it while Mercury
 * talks to cut in. Back leaves the call running in the background (the ongoing-call notification
 * returns to it).
 */
@Composable
fun VoiceCallScreen(model: VoiceCallModel, onClose: () -> Unit) {
  // The call's chat drives the activity line and approvals: follow it.
  val chat by model.conversation.ui.collectAsStateWithLifecycle()
  chat.busy
  val context = LocalContext.current
  val view = LocalView.current
  var transcript by remember { mutableStateOf(false) }
  BackHandler { (context as? Activity)?.moveTaskToBack(true) }
  // The screen never sleeps during a call (at the ear the proximity sensor darkens it).
  DisposableEffect(view) {
    view.keepScreenOn = true
    onDispose { view.keepScreenOn = false }
  }

  val approval = if (model.isEnded) null else model.approval
  Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
      Header(model, onTranscript = { transcript = true })
      Spacer(Modifier.weight(1f))
      val orbScale by animateFloatAsState(if (approval != null) 0.78f else 1f, label = "orb")
      CallOrb(
        model.orb, model.meter,
        Modifier.size(280.dp * orbScale).then(
          if (model.canInterrupt) Modifier.clickable(
            interactionSource = remember { MutableInteractionSource() }, indication = null,
            role = Role.Button, onClickLabel = "Interrupt Mercury",
          ) { model.interrupt() } else Modifier,
        ).semantics { contentDescription = "Mercury" },
      )
      Column(
        Modifier.padding(horizontal = 28.dp).padding(top = 18.dp).widthIn(max = 360.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text(
          model.status, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
          color = when {
            model.error != null -> Mercury.colors.red
            approval != null -> Mercury.colors.amber
            model.phase == CallPhase.Phase.Working -> MaterialTheme.colorScheme.onBackground
            else -> Mercury.colors.ink3
          },
        )
        model.ownerLine?.let {
          Text("“$it”", textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Mercury.colors.ink3, style = MaterialTheme.typography.bodyMedium)
        }
        model.mercuryLine?.let {
          Text(it, textAlign = TextAlign.Center, maxLines = 4, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Medium, fontSize = 20.sp))
        }
      }
      Spacer(Modifier.weight(1f))
      AnimatedVisibility(approval != null, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
        approval?.let { a -> ApprovalCard(a) { model.answerApproval(a, it) } }
      }
      Controls(model, onClose)
      Text(
        if (model.isEnded) "What Mercury did is in this chat." else "What you ask Mercury is saved in this chat.",
        style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink4, modifier = Modifier.padding(top = 16.dp, bottom = 10.dp),
      )
    }
  }
  if (transcript) Transcript(model) { transcript = false }
}

@Composable
private fun Header(model: VoiceCallModel, onTranscript: () -> Unit) {
  var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
  LaunchedEffect(model.isEnded) {
    while (!model.isEnded) { now = SystemClock.elapsedRealtime(); kotlinx.coroutines.delay(1_000) }
  }
  val subtitle = when {
    model.isEnded -> model.startedAt?.let { "Call ended · " + CallPhase.elapsed((model.endedAt ?: now) - it) } ?: "Call ended"
    model.startedAt == null -> "Calling…"
    else -> CallPhase.elapsed(now - model.startedAt!!)
  }
  Box(Modifier.fillMaxWidth().padding(top = 8.dp)) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
      MercuryMark(Modifier.size(width = 30.dp, height = 38.dp))
      Text("Mercury", style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold))
      Text(subtitle, style = MaterialTheme.typography.bodyLarge, color = Mercury.colors.ink3)
    }
    IconButton(onClick = onTranscript, modifier = Modifier.align(Alignment.TopEnd).padding(end = 8.dp)) {
      Icon(Icons.AutoMirrored.Outlined.Chat, "Show transcript")
    }
  }
}

@Composable
private fun Controls(model: VoiceCallModel, onClose: () -> Unit) {
  Row(horizontalArrangement = Arrangement.spacedBy(34.dp), verticalAlignment = Alignment.Top) {
    CallButton(if (model.muted) Icons.Filled.MicOff else Icons.Filled.Mic, if (model.muted) "Unmute" else "Mute", model.muted, !model.isEnded) { model.toggleMute() }
    CallButton(Icons.AutoMirrored.Filled.VolumeUp, "Speaker", model.speaker, !model.isEnded) { model.toggleSpeaker() }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
      FilledIconButton(
        onClick = { if (!model.isEnded) model.end(); onClose() },
        modifier = Modifier.size(72.dp),
        colors = IconButtonDefaults.filledIconButtonColors(
          containerColor = if (model.isEnded) Mercury.colors.ink3 else Mercury.colors.red, contentColor = Color.White,
        ),
      ) { Icon(if (model.isEnded) Icons.Outlined.Close else Icons.Filled.CallEnd, if (model.isEnded) "Close" else "End call", Modifier.size(30.dp)) }
      Text(if (model.isEnded) "Close" else "End", style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3)
    }
  }
}

@Composable
private fun CallButton(icon: ImageVector, label: String, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
  val ink = MaterialTheme.colorScheme.onBackground
  Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.alpha(if (enabled) 1f else 0.4f)) {
    FilledIconButton(
      onClick = onClick, enabled = enabled, modifier = Modifier.size(72.dp),
      colors = IconButtonDefaults.filledIconButtonColors(
        containerColor = if (on) ink else ink.copy(alpha = 0.09f), contentColor = if (on) MaterialTheme.colorScheme.background else ink,
        disabledContainerColor = ink.copy(alpha = 0.09f), disabledContentColor = ink,
      ),
    ) { Icon(icon, label, Modifier.size(26.dp)) }
    Text(label, style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3)
  }
}

/** An approval on the call: Mercury asks out loud, and it can be answered here too (only yes or no). */
@Composable
private fun ApprovalCard(approval: CallApproval, answer: (Boolean) -> Unit) {
  Surface(
    shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainer,
    border = BorderStroke(1.dp, Mercury.colors.amber.copy(alpha = 0.45f)),
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 18.dp),
  ) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Icons.Outlined.PanTool, null, Modifier.size(16.dp), tint = Mercury.colors.amber)
        Text("Mercury wants to", style = MaterialTheme.typography.labelLarge, color = Mercury.colors.amber)
      }
      Text(approval.text, maxLines = 4, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
      Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(onClick = { answer(false) }, modifier = Modifier.weight(1f)) { Text("Deny") }
        Button(onClick = { answer(true) }, modifier = Modifier.weight(1f)) { Text("Allow") }
      }
    }
  }
}

/** Everything said on the call so far, as text. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Transcript(model: VoiceCallModel, onDismiss: () -> Unit) {
  val lines = model.brain?.transcript.orEmpty()
  ModalBottomSheet(onDismissRequest = onDismiss) {
    Text("Transcript", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
    LazyColumn(Modifier.fillMaxWidth().height(420.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
      if (lines.isEmpty()) item { Text("Nothing said yet.", color = Mercury.colors.ink3) }
      items(lines, key = { it.id }) { l ->
        when (l.role) {
          "owner" -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
              Text(l.text, Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
          }
          "ask" -> Text("↳ Asked Mercury: ${l.text}", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
          "result" -> Text(l.text, style = MaterialTheme.typography.bodyMedium)
          else -> Text(l.text, style = MaterialTheme.typography.bodyLarge)
        }
      }
    }
  }
}

// MARK: The orb

/**
 * A core in rings, in ink (black on light, white on dark). Listening, it breathes; your voice
 * swells it; Mercury's voice sends ripples outward; while Mercury works a slow light circles it;
 * muted, it greys and dims. Driven by the call's levels every frame.
 */
@Composable
fun CallOrb(state: CallPhase.Orb, meter: CallMeter, modifier: Modifier = Modifier) {
  var t by remember { mutableStateOf(0.0) }
  val smooth = remember { OrbSmoothing() }
  var levels by remember { mutableStateOf(0.0 to 0.0) }
  LaunchedEffect(state) {
    while (state != CallPhase.Orb.Ended) {
      withFrameNanos { ns ->
        t = ns / 1e9
        val (m, v) = meter.read()
        levels = smooth.step(if (state == CallPhase.Orb.Muted) 0f else m, v, t)
      }
    }
  }
  val ink = MaterialTheme.colorScheme.onBackground
  val grey = if (Mercury.colors.dark) Color(0xFF545454) else Color(0xFFB0B0B0)
  Canvas(modifier) { drawOrb(state, t, levels.first, levels.second, if (state == CallPhase.Orb.Muted || state == CallPhase.Orb.Ended) grey else ink) }
}

private fun DrawScope.drawOrb(state: CallPhase.Orb, t: Double, mic: Double, voice: Double, tint: Color) {
  val c = center
  val unit = size.minDimension / 280f
  val base = 64.0
  var r = base
  when (state) {
    CallPhase.Orb.Listening -> r += 3 * sin(t * 1.6)
    CallPhase.Orb.OwnerSpeaking -> r += 3 * sin(t * 1.6) + 26 * mic
    CallPhase.Orb.MercurySpeaking -> r += 10 * voice
    CallPhase.Orb.Working -> r += 4 * sin(t * 2.4)
    CallPhase.Orb.Calling -> r += 6 * (0.5 + 0.5 * sin(t * 3.2))
    CallPhase.Orb.Muted -> r -= 4
    CallPhase.Orb.Ended -> r -= 8
  }
  val px = { v: Double -> (v * unit).toFloat() }

  // Ripples: Mercury's voice sends rings out; calling sends slow ones, like a ring tone.
  if (state == CallPhase.Orb.MercurySpeaking || state == CallPhase.Orb.Calling) {
    val speed = if (state == CallPhase.Orb.Calling) 0.55 else 0.9
    val strength = if (state == CallPhase.Orb.Calling) 0.5 else 0.35 + 0.65 * voice
    for (k in 0 until 3) {
      val p = (t * speed + k / 3.0) % 1.0
      val rr = r + 8 + p * 64
      drawCircle(tint.copy(alpha = ((1 - p) * 0.45 * strength).toFloat()), px(rr), c, style = Stroke(px(2 + 3 * (1 - p) * strength)))
    }
  }
  // The resting rings.
  listOf(26.0, 52.0).forEachIndexed { i, gap ->
    val rr = base + gap + if (state == CallPhase.Orb.OwnerSpeaking) mic * 10 * (i + 1) else 0.0
    drawCircle(tint.copy(alpha = if (i == 0) 0.16f else 0.09f), px(rr), c, style = Stroke(px(1.0)))
  }
  // The glow.
  val loud = max(mic, voice)
  val glow = r * (1.45 + 0.35 * loud)
  drawCircle(
    Brush.radialGradient(
      0f to tint.copy(alpha = if (state == CallPhase.Orb.Muted) 0.12f else (0.22 + 0.2 * loud).toFloat()), 1f to tint.copy(alpha = 0f),
      center = c, radius = px(glow),
    ),
    px(glow), c,
  )
  // Working: a slow light circling the core, faint at its tail, bright at its head.
  if (state == CallPhase.Orb.Working) {
    val a = t * 1.4
    val rr = px(r + 14)
    val n = 14
    for (i in 0 until n) {
      val f = (i + 1).toDouble() / n
      val start = (a + 2.2 * i / n) * 180 / PI
      val sweep = 2.2 / n * 180 / PI
      drawArc(
        tint.copy(alpha = (0.9 * f * f).toFloat()), start.toFloat(), sweep.toFloat(), false,
        topLeft = Offset(c.x - rr, c.y - rr), size = androidx.compose.ui.geometry.Size(rr * 2, rr * 2),
        style = Stroke(px(1.5 + 2.5 * f), cap = StrokeCap.Round),
      )
    }
  }
  // The core: ink, lit from the upper left.
  val shimmer = if (state == CallPhase.Orb.Working) 0.12 * sin(t * 2.4) else 0.0
  val light = tint.copy(alpha = 0.55f)
  drawCircle(
    Brush.radialGradient(
      0f to light, 1f to tint,
      center = Offset(c.x - px(r * 0.25), c.y - px(r * (0.35 + shimmer))), radius = px(r * 1.35),
    ),
    px(r), c,
  )
  if (state == CallPhase.Orb.Muted) {
    val s = px(r * 0.42)
    drawLine(Color.White.copy(alpha = 0.85f), Offset(c.x - s, c.y + s), Offset(c.x + s, c.y - s), strokeWidth = px(5.0), cap = StrokeCap.Round)
  }
}

/** Eases the levels between frames: quick to rise, slower to fall, so the orb follows speech smoothly. */
private class OrbSmoothing {
  private var mic = 0.0; private var voice = 0.0; private var last = 0.0

  fun step(m: Float, v: Float, t: Double): Pair<Double, Double> {
    val dt = if (last == 0.0) 1.0 / 60 else (t - last).coerceIn(0.0, 0.1)
    last = t
    fun ease(cur: Double, target: Double): Double {
      val rate = if (target > cur) 22.0 else 6.0
      return cur + (target - cur) * minOf(1.0, rate * dt)
    }
    mic = ease(mic, m.toDouble()); voice = ease(voice, v.toDouble())
    return mic to voice
  }
}
