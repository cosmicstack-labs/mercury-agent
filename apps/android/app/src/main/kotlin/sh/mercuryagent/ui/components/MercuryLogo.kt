package sh.mercuryagent.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sh.mercuryagent.core.ConnectionLogos

/**
 * One of the playful Mercury logos a connection wears ([ConnectionLogos.ids]): the Mercury mark
 * ([MercuryMark]: the round face, its wings, the stem) on a round colour plate, dressed up: sunglasses,
 * a party hat, headphones… All vector, drawn in the mark's own coordinates on a 660-unit square
 * centred on the face, so it stays crisp from 24 to 96 dp. iOS: MercuryLogo.swift draws the same
 * shapes from the same numbers.
 */
@Composable
fun MercuryLogo(id: String, size: Dp = 44.dp, modifier: Modifier = Modifier) {
  val look = LogoLook.of(id)
  Canvas(modifier.size(size).semantics { contentDescription = "${look.name} Mercury" }) {
    val s = minOf(this.size.width, this.size.height) / LogoLook.SIDE
    translate((this.size.width - LogoLook.SIDE * s) / 2, (this.size.height - LogoLook.SIDE * s) / 2) {
      scale(s, s, pivot = Offset.Zero) {
        translate(-LogoLook.ORIGIN_X, -LogoLook.ORIGIN_Y) { look.draw(this) }
      }
    }
  }
}

/** A logo's plate, the mark's colour, and what it wears (under the mark or over it). */
class LogoLook(
  val name: String,
  private val plate: Long,
  private val mark: Long = 0xFFFFFFFF,
  private val eyes: Boolean = true,
  private val smile: Boolean = true,
  private val under: List<Op> = emptyList(),
  private val over: List<Op> = emptyList(),
) {
  sealed interface Op {
    data class Fill(val d: String, val c: Long) : Op
    data class StrokePath(val d: String, val c: Long, val w: Float) : Op
    data class FillCircle(val x: Float, val y: Float, val r: Float, val c: Long) : Op
    data class StrokeCircle(val x: Float, val y: Float, val r: Float, val c: Long, val w: Float) : Op
    data class FillEllipse(val x: Float, val y: Float, val rx: Float, val ry: Float, val c: Long) : Op
    data class FillRound(val x: Float, val y: Float, val w: Float, val h: Float, val r: Float, val c: Long) : Op
    data class StrokeRound(val x: Float, val y: Float, val w: Float, val h: Float, val r: Float, val c: Long, val lw: Float) : Op
  }

  fun draw(scope: DrawScope) = with(scope) {
    drawCircle(color(plate), radius = SIDE / 2, center = Offset(ORIGIN_X + SIDE / 2, ORIGIN_Y + SIDE / 2))
    for (op in under) drawOp(op)
    val m = color(mark)
    val w = stroke(26f)
    for (d in MARK_STROKES) drawPath(path(d), m, style = w)
    drawCircle(m, radius = 136.5f, center = Offset(511f, 495f), style = w)
    if (eyes) {
      drawCircle(m, radius = 21f, center = Offset(451f, 497f))
      drawCircle(m, radius = 21f, center = Offset(571f, 497f))
    }
    if (smile) drawPath(path(SMILE), m, style = Stroke(width = 20f, cap = StrokeCap.Round))
    for (op in over) drawOp(op)
  }

  private fun DrawScope.drawOp(op: Op) {
    when (op) {
      is Op.Fill -> drawPath(path(op.d), color(op.c))
      is Op.StrokePath -> drawPath(path(op.d), color(op.c), style = stroke(op.w))
      is Op.FillCircle -> drawCircle(color(op.c), radius = op.r, center = Offset(op.x, op.y))
      is Op.StrokeCircle -> drawCircle(color(op.c), radius = op.r, center = Offset(op.x, op.y), style = stroke(op.w))
      is Op.FillEllipse -> drawOval(color(op.c), topLeft = Offset(op.x - op.rx, op.y - op.ry), size = Size(2 * op.rx, 2 * op.ry))
      is Op.FillRound -> drawRoundRect(color(op.c), Offset(op.x, op.y), Size(op.w, op.h), CornerRadius(op.r, op.r))
      is Op.StrokeRound -> drawRoundRect(color(op.c), Offset(op.x, op.y), Size(op.w, op.h), CornerRadius(op.r, op.r), style = stroke(op.lw))
    }
  }

  companion object {
    const val SIDE = 660f
    const val ORIGIN_X = 181f
    const val ORIGIN_Y = 152f

    fun of(id: String): LogoLook = ALL[id] ?: ALL.getValue(ConnectionLogos.ids[0])
    fun name(id: String): String = of(id).name

    private fun stroke(w: Float) = Stroke(width = w, cap = StrokeCap.Round, join = StrokeJoin.Round)
    /** 0xAARRGGBB. */
    private fun color(argb: Long) = Color(argb.toInt())

    private val paths = HashMap<String, Path>()
    /** The SVG path data, parsed once. */
    private fun path(d: String): Path = paths.getOrPut(d) { PathParser().parsePathString(d).toPath() }

    /** The wings and the stem (assets/brand/mark.svg). */
    private val MARK_STROKES = listOf(
      "M393 414 C378 372 376 334 396 325 C413 318 434 338 452 363",
      "M629 414 C644 372 646 334 626 325 C609 318 588 338 570 363",
      "M511 631.5 L511 699.5 M480.5 677 L542.5 677",
    )
    private const val SMILE = "M492 540 Q511.5 561 531 540"

    /** A heart centred on (x, y), about 76 wide and 54 tall. */
    private fun heart(x: Float, y: Float): String =
      "M$x ${y + 24} C${x - 38} ${y - 2} ${x - 34} ${y - 30} ${x - 17} ${y - 30} C${x - 7} ${y - 30} $x ${y - 22} $x ${y - 15} " +
        "C$x ${y - 22} ${x + 7} ${y - 30} ${x + 17} ${y - 30} C${x + 34} ${y - 30} ${x + 38} ${y - 2} $x ${y + 24} Z"

    // The set: the same order and numbers as iOS's MercuryLogo.swift.
    private val ALL: Map<String, LogoLook> = mapOf(
      "shades" to LogoLook("Shades", 0xFF0CA678, eyes = false, over = listOf(
        Op.FillRound(403f, 470f, 96f, 60f, 22f, 0xFF111418),
        Op.FillRound(523f, 470f, 96f, 60f, 22f, 0xFF111418),
        Op.StrokePath("M497 490 Q511 480 525 490", 0xFF111418, 12f),
        Op.StrokePath("M405 488 L378 478", 0xFF111418, 12f),
        Op.StrokePath("M617 488 L644 478", 0xFF111418, 12f),
        Op.StrokePath("M418 490 L434 478", 0x8CFFFFFF, 7f),
        Op.StrokePath("M538 490 L554 478", 0x8CFFFFFF, 7f),
      )),
      "party" to LogoLook("Party", 0xFFF03E3E, over = listOf(
        Op.Fill("M450 388 L511 222 L572 388 Q511 406 450 388 Z", 0xFFFFD43B),
        Op.Fill("M482.3 300 L539.7 300 L547.7 322 L474.3 322 Z", 0xFF4C6EF5),
        Op.Fill("M465.8 345 L556.2 345 L564.3 367 L457.7 367 Z", 0xFF4C6EF5),
        Op.FillCircle(511f, 220f, 20f, 0xFFFFFFFF),
        Op.FillCircle(420f, 300f, 8f, 0xFFFFD43B),
        Op.FillCircle(612f, 262f, 7f, 0xFFFFFFFF),
        Op.FillCircle(640f, 330f, 6f, 0xFF4C6EF5),
      )),
      "headphones" to LogoLook("Headphones", 0xFF4263EB, over = listOf(
        Op.StrokePath("M352 440 C352 245 670 245 670 440", 0xFF141833, 24f),
        Op.FillRound(322f, 430f, 60f, 132f, 28f, 0xFF141833),
        Op.FillRound(640f, 430f, 60f, 132f, 28f, 0xFF141833),
        Op.FillRound(338f, 452f, 16f, 88f, 8f, 0xFF91A7FF),
        Op.FillRound(668f, 452f, 16f, 88f, 8f, 0xFF91A7FF),
      )),
      "wizard" to LogoLook("Wizard", 0xFF7048E8, over = listOf(
        Op.Fill("M440 372 Q482 280 552 200 Q560 290 584 372 Z", 0xFF23164F),
        Op.FillEllipse(511f, 374f, 150f, 24f, 0xFF23164F),
        Op.Fill("M515 294 L520.3 308.7 L535.9 309.2 L523.6 318.8 L527.9 333.8 L515 325 L502.1 333.8 L506.4 318.8 L494.1 309.2 L509.7 308.7 Z", 0xFFFFD43B),
        Op.FillCircle(470f, 342f, 5f, 0xFFFFD43B),
        Op.FillCircle(553f, 260f, 4f, 0xFFFFD43B),
      )),
      "astronaut" to LogoLook("Astronaut", 0xFF1B2A4A, under = listOf(
        Op.FillCircle(511f, 468f, 182f, 0x1FFFFFFFL),
      ), over = listOf(
        Op.StrokeCircle(511f, 468f, 182f, 0xFFDCE6F5, 22f),
        Op.StrokePath("M598 342 Q630 368 645 406", 0xB3FFFFFF, 14f),
        Op.FillCircle(300f, 300f, 5f, 0xFFFFFFFF),
        Op.FillCircle(724f, 600f, 4f, 0xFFFFFFFF),
        Op.FillCircle(700f, 250f, 6f, 0xFFFFD43B),
      )),
      "chef" to LogoLook("Chef", 0xFFF76707, over = listOf(
        Op.StrokeCircle(468f, 322f, 42f, 0xFFD9480F, 14f),
        Op.StrokeCircle(511f, 298f, 50f, 0xFFD9480F, 14f),
        Op.StrokeCircle(554f, 322f, 42f, 0xFFD9480F, 14f),
        Op.StrokeRound(448f, 340f, 126f, 48f, 10f, 0xFFD9480F, 14f),
        Op.FillCircle(468f, 322f, 42f, 0xFFFFFFFF),
        Op.FillCircle(511f, 298f, 50f, 0xFFFFFFFF),
        Op.FillCircle(554f, 322f, 42f, 0xFFFFFFFF),
        Op.FillRound(448f, 340f, 126f, 48f, 10f, 0xFFFFFFFF),
        Op.StrokePath("M481 352 L481 376 M511 352 L511 376 M541 352 L541 376", 0xFFF2B48C, 6f),
      )),
      "crown" to LogoLook("Crown", 0xFFC2255C, over = listOf(
        Op.Fill("M446 388 L440 312 L480 342 L511 290 L542 342 L582 312 L576 388 Q511 400 446 388 Z", 0xFFFCC419),
        Op.StrokePath("M446 388 L440 312 L480 342 L511 290 L542 342 L582 312 L576 388 Q511 400 446 388 Z", 0xFFFCC419, 10f),
        Op.FillCircle(440f, 306f, 11f, 0xFFFCC419),
        Op.FillCircle(511f, 284f, 12f, 0xFFFCC419),
        Op.FillCircle(582f, 306f, 11f, 0xFFFCC419),
        Op.FillCircle(511f, 362f, 12f, 0xFF3BC9DB),
        Op.FillCircle(470f, 368f, 7f, 0xFFFFFFFF),
        Op.FillCircle(552f, 368f, 7f, 0xFFFFFFFF),
      )),
      "sleepy" to LogoLook("Sleepy", 0xFF5C677D, eyes = false, smile = false, over = listOf(
        Op.StrokePath("M429 495 Q451 515 473 495", 0xFFFFFFFF, 15f),
        Op.StrokePath("M549 495 Q571 515 593 495", 0xFFFFFFFF, 15f),
        Op.StrokeCircle(511f, 552f, 10f, 0xFFFFFFFF, 10f),
        Op.StrokePath("M650 288 L678 288 L650 316 L678 316", 0xFFFFFFFF, 11f),
        Op.StrokePath("M690 244 L710 244 L690 264 L710 264", 0xCCFFFFFF, 9f),
      )),
      "wink" to LogoLook("Wink", 0xFFF59F00, mark = 0xFF2B1D00, eyes = false, smile = false, over = listOf(
        Op.FillCircle(451f, 497f, 21f, 0xFF2B1D00),
        Op.StrokePath("M549 505 Q571 483 593 505", 0xFF2B1D00, 15f),
        Op.StrokePath("M478 534 Q511 584 544 534", 0xFF2B1D00, 20f),
        Op.FillCircle(418f, 548f, 16f, 0x8CFF6B6B),
        Op.FillCircle(604f, 548f, 16f, 0x8CFF6B6B),
      )),
      "hearts" to LogoLook("Heart eyes", 0xFFE64980, eyes = false, smile = false, over = listOf(
        Op.Fill(heart(451f, 499f), 0xFFA61E4D),
        Op.Fill(heart(571f, 499f), 0xFFA61E4D),
        Op.StrokePath("M478 540 Q511 584 544 540", 0xFFFFFFFF, 20f),
        Op.Fill(heart(660f, 300f), 0x99FFFFFF),
      )),
      "ninja" to LogoLook("Ninja", 0xFF2B2F36, over = listOf(
        Op.FillRound(378f, 412f, 266f, 40f, 8f, 0xFFE03131),
        Op.StrokePath("M640 428 Q676 410 700 384", 0xFFE03131, 16f),
        Op.StrokePath("M640 436 Q680 448 702 474", 0xFFE03131, 16f),
        Op.FillCircle(642f, 432f, 15f, 0xFFE03131),
      )),
      "pirate" to LogoLook("Pirate", 0xFF1098AD, eyes = false, smile = false, over = listOf(
        Op.StrokePath("M392 430 L640 528", 0xFF15171A, 10f),
        Op.FillEllipse(571f, 499f, 32f, 28f, 0xFF15171A),
        Op.FillCircle(451f, 497f, 21f, 0xFFFFFFFF),
        Op.StrokePath("M490 545 Q515 560 538 538", 0xFFFFFFFF, 18f),
        Op.StrokeCircle(386f, 432f, 12f, 0xFFFCC419, 7f),
      )),
    )
  }
}
