package sh.mercuryagent.ui.bots

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import sh.mercuryagent.core.BotFaceLook
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.botAvatarUrl

/**
 * A bot's face, as Mercury Desktop draws it (apps/desktop/src/components/BotAvatar.tsx): the avatar
 * the runtime stores when there is one; otherwise a face drawn from the id, a shape (circle,
 * squircle, shield, hexagon) in a two-tone gradient with two eyes and a smile. Same id, same face,
 * on every device. Always coloured: the one place the monochrome app shows colour, as the desktop does.
 */
@Composable
fun BotAvatar(
  id: String,
  name: String,
  modifier: Modifier = Modifier,
  hasAvatar: Boolean = false,
  size: Dp = 32.dp,
  dimmed: Boolean = false,
  client: MercuryClient? = null,
) {
  val context = LocalContext.current
  val image by produceState<ImageBitmap?>(null, id, hasAvatar, client) {
    value = if (hasAvatar && client != null) BotAvatarCache.image(client, id, context.cacheDir) else null
  }
  val m = modifier.size(size).alpha(if (dimmed) 0.55f else 1f).semantics { contentDescription = name }
  val img = image
  if (img != null) {
    Image(img, contentDescription = null, contentScale = ContentScale.Crop, modifier = m.clip(RoundedCornerShape(size * 0.28f)))
  } else {
    Box(m) { BotFace(id, Modifier.size(size)) }
  }
}

/** Avatars fetched once per bot per launch (iOS: BotAvatarCache). */
object BotAvatarCache {
  private val images = ConcurrentHashMap<String, Result<ImageBitmap>>()

  suspend fun image(client: MercuryClient, id: String, cacheDir: File): ImageBitmap? {
    val key = client.baseUrl + "|" + id
    images[key]?.let { return it.getOrNull() }
    val got = try {
      withContext(Dispatchers.IO) {
        val name = java.lang.Long.toString((key.hashCode().toLong() and 0xffffffffL), 36)
        val file = File(File(cacheDir, "bot-avatars"), "$name.img")
        client.downloadTo(client.botAvatarUrl(id), file, 30)
        BitmapFactory.decodeFile(file.path)?.asImageBitmap()
      }
    } catch (e: CancellationException) {
      throw e
    } catch (_: Exception) {
      null
    }
    images[key] = if (got != null) Result.success(got) else Result.failure(IllegalStateException("no avatar"))
    return got
  }
}

/** The drawn face. Its numbers come from [BotFaceLook] (FNV-1a over the id, unsigned shifts), as on the desktop. */
@Composable
fun BotFace(id: String, modifier: Modifier = Modifier) {
  val look = remember(id) { BotFaceLook.of(id) }
  val shape = remember(look.shape) { facePath(look.shape) }
  val brush = remember(look) {
    Brush.linearGradient(
      listOf(Color.hsl(look.hue.toFloat(), 0.70f, 0.62f), Color.hsl(look.hue2.toFloat(), 0.72f, 0.44f)),
      start = Offset(0f, 0f), end = Offset(100f, 100f),
    )
  }
  Canvas(modifier) {
    val k = size.minDimension / 100f
    scale(k, k, pivot = Offset.Zero) {
      // The shape at 88%, stroked wide with round joins so every corner is soft.
      translate(6f, 6f) {
        scale(0.88f, 0.88f, pivot = Offset.Zero) {
          drawPath(shape, brush)
          drawPath(shape, brush, style = Stroke(width = 10f, join = StrokeJoin.Round))
        }
      }
      val tri = look.shape == 2
      val eyeY = if (tri) 36f else 44f
      val mouthY = if (tri) 52f else 60f
      drawCircle(Color.White, radius = 5.2f, center = Offset(50f - look.eyeGap, eyeY))
      drawCircle(Color.White, radius = 5.2f, center = Offset(50f + look.eyeGap, eyeY))
      val mouth = Path()
      when (look.mouth) {
        0 -> {
          mouth.moveTo(40f, mouthY); mouth.quadraticTo(50f, mouthY + 9f, 60f, mouthY)
          drawPath(mouth, Color.White, style = Stroke(width = 4.5f, cap = StrokeCap.Round))
        }
        1 -> {
          mouth.moveTo(38f, mouthY - 1f); mouth.quadraticTo(50f, mouthY + 12f, 62f, mouthY - 1f); mouth.close()
          drawPath(mouth, Color.White)
        }
        else -> {
          mouth.moveTo(44f, mouthY); mouth.quadraticTo(50f, mouthY + 5f, 56f, mouthY)
          drawPath(mouth, Color.White, style = Stroke(width = 4.5f, cap = StrokeCap.Round))
        }
      }
    }
  }
}

/** The desktop's four SVG paths, in its 100 x 100 box. */
private val shapes = listOf(
  "", // circle: an oval, below
  "M50 4c36 0 46 10 46 46s-10 46-46 46S4 86 4 50 14 4 50 4z",
  "M14 10h72c6 0 10 5 8 11L60 88c-4 8-16 8-20 0L6 21c-2-6 2-11 8-11z",
  "M50 3l41 23v48L50 97 9 74V26z",
)

private fun facePath(i: Int): Path =
  if (i == 0) Path().apply { addOval(Rect(4f, 4f, 96f, 96f)) }
  else PathParser().parsePathString(shapes[i.coerceIn(1, 3)]).toPath()
