package sh.mercuryagent.ui.conversation

import android.provider.Settings
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Duration
import java.time.Instant
import kotlin.math.abs
import sh.mercuryagent.core.ChatMessage
import sh.mercuryagent.ui.theme.Mercury

// Media on its way (ADR-042), as Mercury Desktop and the iPhone draw it (MediaGenerating.swift):
// a placeholder in the shape of what's coming, so nothing jumps when it lands. Pictures and video
// are a soft field drifting under a light sweep with a breathing icon; sound is moving bars; the
// words shimmer. Monochrome here, like the rest of the app. With animations turned off in the
// phone's settings everything holds still.

/** Whether the phone's "Remove animations" is on (animator duration scale 0). */
@Composable
fun reduceMotion(): Boolean {
  val ctx = LocalContext.current
  return remember { runCatching { Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false) }
}

/** Seconds since the screen started drawing it, every frame (one clock per piece). */
@Composable
private fun frameSeconds(paused: Boolean): Double {
  var ms by remember { mutableLongStateOf(0L) }
  LaunchedEffect(paused) {
    if (paused) return@LaunchedEffect
    val start = withFrameMillis { it }
    while (true) withFrameMillis { ms = it - start }
  }
  return ms / 1000.0
}

/** Media on its way: a grid of tiles for pictures and video, a row of bars for music and voice. */
@Composable
fun MediaPlaceholder(shape: TurnTrace.MediaShape, startedAt: Instant, now: Instant, done: Int = 0, quiet: Boolean = false) {
  val elapsed = maxOf(0.0, Duration.between(startedAt, now).toMillis() / 1000.0)
  val total = maxOf(shape.count ?: 1, 1)
  val line = MediaText.describe(MediaBatch("", shape, startedAt, done, total), now)
  val c = Mercury.colors
  val ink = MaterialTheme.colorScheme.onSurface
  if (shape.kind == "music" || shape.kind == "speech") {
    Row(
      Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(ink.copy(alpha = 0.035f))
        .border(1.dp, c.line, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 12.dp)
        .semantics(mergeDescendants = true) { contentDescription = line },
      verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Box(Modifier.size(36.dp).clip(CircleShape).background(ink.copy(alpha = 0.08f)), contentAlignment = Alignment.Center) {
        Icon(if (shape.kind == "music") Icons.Outlined.MusicNote else Icons.Outlined.GraphicEq, null, Modifier.size(18.dp), tint = ink)
      }
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SoundBars(Modifier.fillMaxWidth().height(28.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
          ShimmerText("$line…", Modifier.weight(1f), small = true)
          Text(TurnTrace.duration(elapsed), fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = c.ink4)
        }
      }
    }
  } else {
    val tiles = minOf(total, MediaText.MAX_TILES)
    val cols = if (shape.kind == "video") 1 else MediaText.columns(tiles)
    val width = maxWidth(shape, tiles)
    Column(Modifier.widthIn(max = width).semantics(mergeDescendants = true) { contentDescription = line }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
      TileGrid(tiles, cols, MediaText.ratio(shape, tiles)) { i ->
        Box(Modifier.fillMaxSize()) {
          GeneratingTile(shape.kind, i, ready = i < done, small = tiles > 4)
          if (i == tiles - 1 && total > tiles) Text(
            "+${total - tiles}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = c.ink3,
            modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp).clip(RoundedCornerShape(5.dp))
              .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f)).padding(horizontal = 5.dp, vertical = 1.dp),
          )
        }
      }
      if (!quiet) Row(verticalAlignment = Alignment.CenterVertically) {
        ShimmerText("$line…", Modifier.weight(1f), small = true)
        Text(TurnTrace.duration(elapsed), fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = c.ink4)
      }
      shape.prompt?.takeIf { it.isNotEmpty() }?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = c.ink4, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

fun maxWidth(s: TurnTrace.MediaShape, tiles: Int) = when {
  s.kind == "video" -> if (s.aspect == "portrait") 240.dp else 520.dp
  tiles == 1 -> if (s.aspect == "portrait") 240.dp else 340.dp
  else -> 520.dp
}

/** One waiting tile: the drifting field and a breathing icon; a tick once its picture is ready. */
@Composable
fun GeneratingTile(kind: String, index: Int = 0, ready: Boolean = false, small: Boolean = false) {
  val ink = MaterialTheme.colorScheme.onSurface
  val shape = RoundedCornerShape(12.dp)
  Box(
    Modifier.fillMaxSize().clip(shape).background(ink.copy(alpha = if (ready) 0.06f else 0.035f))
      .border(1.dp, if (ready) ink.copy(alpha = 0.25f) else Mercury.colors.line, shape),
    contentAlignment = Alignment.Center,
  ) {
    AnimatedContent(ready, transitionSpec = { (fadeIn(tween(300)) + scaleIn(tween(300), 0.6f)) togetherWith fadeOut(tween(300)) }, label = "tile") { r ->
      if (r) Box(Modifier.fillMaxSize(), Alignment.Center) { Icon(Icons.Outlined.Check, "Ready", Modifier.size(if (small) 16.dp else 20.dp), tint = ink) }
      else GeneratingField(kind, index, small)
    }
  }
}

/** Desktop's .media-aurora / .media-sweep / .media-icon as functions of time (MediaMotion). */
data class MediaMotion(val drift: Float, val sweep: Float, val breatheOpacity: Float, val breatheScale: Float) {
  companion object {
    fun at(t: Double, index: Int, still: Boolean = false): MediaMotion {
      if (still) return MediaMotion(0.35f, -1f, 0.6f, 1f)
      val d = ((t + index * 2.3) % 14) / 7
      val u = if (d < 1) d else 2 - d
      val s = ((t - index * 0.18) % 2.2) / 2.2
      val p = if (s < 0) s + 1 else s
      val b = ease(abs(((t / 2.4) % 1) * 2 - 1))
      return MediaMotion(ease(u).toFloat(), (-0.55 + 3.6 * p).toFloat(), (0.8 - 0.35 * b).toFloat(), (1.06 - 0.06 * b).toFloat())
    }

    /** CSS ease-in-out, closely enough. */
    fun ease(x: Double) = x * x * (3 - 2 * x)
  }
}

/** The moving part of a waiting picture: soft glows drifting, a band of light crossing, an icon breathing. */
@Composable
fun GeneratingField(kind: String, index: Int = 0, small: Boolean = false, modifier: Modifier = Modifier) {
  val still = reduceMotion()
  val t = frameSeconds(still)
  val m = MediaMotion.at(t, index, still)
  val ink = MaterialTheme.colorScheme.onSurface
  val dark = Mercury.colors.dark
  Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Canvas(Modifier.fillMaxSize()) {
      val w = size.width; val h = size.height
      val ox = -0.8f * w * m.drift + 0.4f * w - 0.4f * w
      val oy = -0.8f * h * m.drift + 0.4f * h - 0.4f * h
      fun glow(alpha: Float, cx: Float, cy: Float, r: Float) {
        val center = Offset(cx * w * 1.8f + ox, cy * h * 1.8f + oy)
        val radius = r * maxOf(w, h) * 1.8f
        drawCircle(Brush.radialGradient(listOf(ink.copy(alpha = alpha), ink.copy(alpha = 0f)), center, radius * 0.7f), radius, center)
      }
      glow(0.10f, 0.25f, 0.30f, 0.58f)
      glow(0.08f, 0.75f, 0.70f, 0.52f)
      glow(0.06f, 0.60f, 0.20f, 0.45f)
      if (!still) {
        val peak = if (dark) 0.09f else 0.35f
        val side = if (dark) 0.05f else 0.18f
        val band = w * 2.5f
        val x0 = m.sweep * w - band / 2
        val white = androidx.compose.ui.graphics.Color.White
        drawRect(
          Brush.linearGradient(
            0.3f to white.copy(alpha = 0f), 0.45f to white.copy(alpha = side), 0.5f to white.copy(alpha = peak),
            0.55f to white.copy(alpha = side), 0.7f to white.copy(alpha = 0f),
            start = Offset(x0, h * 0.3f), end = Offset(x0 + band, h * 0.7f),
          ),
        )
      }
    }
    Icon(
      if (kind == "video") Icons.Outlined.Movie else Icons.Outlined.Image, null,
      Modifier.size(if (small) 20.dp else 28.dp).graphicsLayer { alpha = m.breatheOpacity; scaleX = m.breatheScale; scaleY = m.breatheScale },
      tint = ink.copy(alpha = 0.3f),
    )
  }
}

/** Sound on its way: 32 bars rising and falling (Desktop's .media-bar). */
@Composable
fun SoundBars(modifier: Modifier = Modifier, count: Int = 32) {
  val still = reduceMotion()
  val t = frameSeconds(still)
  val ink = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f)
  Canvas(modifier) {
    val gap = 3.dp.toPx(); val bw = 3.dp.toPx()
    val n = minOf(count, ((size.width + gap) / (bw + gap)).toInt())
    for (i in 0 until n) {
      val base = 0.3f + ((i * 37) % 70) / 100f
      val s = if (still) 1f else barScale(t, i)
      val bh = size.height * base * s
      drawRoundRect(ink, Offset(i * (bw + gap), size.height - bh), androidx.compose.ui.geometry.Size(bw, bh), androidx.compose.ui.geometry.CornerRadius(bw / 2))
    }
  }
}

fun barScale(t: Double, i: Int): Float {
  val p = ((t - (i % 8) * 0.11) % 2.2) / 1.1
  val q = if (p < 0) p + 2 else p
  val u = if (q < 1) q else 2 - q
  return (0.35 + 0.65 * MediaMotion.ease(u)).toFloat()
}

/** Words of something in progress: a soft light passing over them (Desktop's .shimmer-text, 2.4 s). */
@Composable
fun ShimmerText(text: String, modifier: Modifier = Modifier, small: Boolean = false) {
  val still = reduceMotion()
  val t = frameSeconds(still)
  val c = Mercury.colors
  val ink = MaterialTheme.colorScheme.onSurface
  val style = if (small) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium
  Text(
    text, style = style, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis,
    modifier = modifier.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithContent {
      drawContent()
      if (!still) {
        val p = ((t % 2.4) / 2.4).toFloat()
        val w = size.width
        val cx = w * (-0.25f + 1.5f * p)
        drawRect(
          Brush.horizontalGradient(listOf(ink.copy(alpha = 0f), ink, ink.copy(alpha = 0f)), startX = cx - w * 0.25f, endX = cx + w * 0.25f),
          blendMode = BlendMode.SrcAtop,
        )
      }
    },
  )
}

/**
 * The real thing arriving: from soft to sharp (Desktop's .media-reveal, 700 ms). Each item reveals
 * once, however often it scrolls back into view; with animations off it just appears.
 */
@Composable
fun Modifier.mediaReveal(id: String, active: Boolean, delayMs: Int = 0): Modifier {
  val still = reduceMotion()
  val first = active && !still && Reveal.revealed.add(id)
  val progress = remember(id) { Animatable(if (first) 0f else 1f) }
  LaunchedEffect(id) {
    if (progress.value < 1f) progress.animateTo(1f, tween(700, delayMs, CubicBezierEasing(0.2f, 0.7f, 0.2f, 1f)))
  }
  val v = progress.value
  if (v >= 1f) return this
  return this.graphicsLayer {
    alpha = 0.6f + 0.4f * v
    scaleX = 1.02f - 0.02f * v; scaleY = scaleX
    if (android.os.Build.VERSION.SDK_INT >= 31) {
      val r = 18f * (1 - v) * density
      if (r > 0.5f) renderEffect = android.graphics.RenderEffect.createBlurEffect(r, r, android.graphics.Shader.TileMode.CLAMP).asComposeRenderEffect()
    }
  }
}

object Reveal {
  val revealed: MutableSet<String> = java.util.Collections.synchronizedSet(mutableSetOf())

  /** Just made: the reply landed under a minute ago (Desktop's isFresh). */
  fun isFresh(m: ChatMessage, now: Instant = Instant.now()) = Duration.between(m.timestamp, now).seconds < 60
}
