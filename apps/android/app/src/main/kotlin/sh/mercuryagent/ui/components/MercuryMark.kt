package sh.mercuryagent.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sh.mercuryagent.ui.theme.rgb

/**
 * The Mercury mark (assets/brand/mark.svg): the round face with its wings, stem and smile, drawn in
 * the mark's own 338 × 443 viewBox (origin 342, 292) and scaled to fit. iOS: MercuryMark.swift.
 */
@Composable
fun MercuryMark(modifier: Modifier = Modifier, color: Color = sh.mercuryagent.ui.theme.Mercury.colors.green) {
  Canvas(modifier) {
    val s = minOf(size.width / 338f, size.height / 443f)
    translate((size.width - 338 * s) / 2, (size.height - 443 * s) / 2) {
      scale(s, s, pivot = Offset.Zero) {
        translate(-342f, -292f) {
          val stroke = Stroke(width = 25f, cap = StrokeCap.Round, join = StrokeJoin.Round)
          val wing = Path().apply {
            moveTo(393f, 414f); cubicTo(378f, 372f, 376f, 334f, 396f, 325f); cubicTo(413f, 318f, 434f, 338f, 452f, 363f)
          }
          val wing2 = Path().apply {
            moveTo(629f, 414f); cubicTo(644f, 372f, 646f, 334f, 626f, 325f); cubicTo(609f, 318f, 588f, 338f, 570f, 363f)
          }
          drawPath(wing, color, style = stroke)
          drawPath(wing2, color, style = stroke)
          drawCircle(color, radius = 136.5f, center = Offset(511f, 495f), style = stroke)
          drawLine(color, Offset(511f, 631.5f), Offset(511f, 699.5f), strokeWidth = 25f, cap = StrokeCap.Round)
          drawLine(color, Offset(480.5f, 677f), Offset(542.5f, 677f), strokeWidth = 25f, cap = StrokeCap.Round)
          drawCircle(color, radius = 21f, center = Offset(451f, 497f))
          drawCircle(color, radius = 21f, center = Offset(571f, 497f))
          val smile = Path().apply { moveTo(492f, 540f); quadraticTo(511.5f, 561f, 531f, 540f) }
          drawPath(smile, color, style = Stroke(width = 20f, cap = StrokeCap.Round))
        }
      }
    }
  }
}

/** The mark on Mercury's dark green plate, like the app icon. */
@Composable
fun MarkTile(size: Dp = 72.dp, modifier: Modifier = Modifier) {
  Box(
    modifier
      .size(size)
      .clip(RoundedCornerShape(size * 0.24f))
      .background(Brush.verticalGradient(listOf(rgb(0x1A2924), rgb(0x090D0C)))),
    contentAlignment = Alignment.Center,
  ) {
    MercuryMark(Modifier.padding(size * 0.2f).size(size * 0.6f), color = rgb(0x34E1A1))
  }
}

