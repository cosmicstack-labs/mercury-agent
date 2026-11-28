package sh.mercuryagent.ui.conversation

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.TextSnippet
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.OndemandVideo
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ArtifactRef
import sh.mercuryagent.core.OutgoingAttachment
import sh.mercuryagent.core.SentAttachment
import sh.mercuryagent.core.artifactFileUrl
import sh.mercuryagent.core.fileSize
import sh.mercuryagent.core.uploadUrl
import sh.mercuryagent.ui.media.LocalMediaLoader
import sh.mercuryagent.ui.media.MediaItem
import sh.mercuryagent.ui.media.MediaViewer
import sh.mercuryagent.ui.theme.Mercury

// What a reply made, under it (iOS: ConversationMedia.swift). Pictures, clips and sounds from a
// media model are shown large: a batch is one grid laid out like its placeholder, with the prompt
// under it. Tapping opens the full-screen viewer (swipe, "3 / 5", thumbnails; videos and sounds
// play there). Other files are cards that open in another app.

object ReplyMediaRules {
  /** Made by a media model (generate_image, _video, _music, _speech): shown large and playable. */
  fun isGenerated(a: ArtifactRef): Boolean = a.tool?.startsWith("generate_") == true && a.kind in setOf("image", "video", "audio")
  /** Pictures, clips and sounds are shown large and playable, generated or downloaded alike. */
  fun isPlayable(a: ArtifactRef): Boolean = a.kind in setOf("image", "video", "audio")

  fun prompt(items: List<ArtifactRef>): String? {
    val p = items.mapNotNull { it.prompt?.trim()?.ifEmpty { null } }.toSet()
    return if (p.size == 1) p.first() else null
  }

  /** "MD", "PDF", "TXT", "IMG" for a sent file. */
  fun tag(a: SentAttachment): String {
    val n = a.name.lowercase()
    return when {
      a.isImage -> "IMG"
      a.mime == "application/pdf" || n.endsWith(".pdf") -> "PDF"
      n.endsWith(".md") || n.endsWith(".markdown") || a.mime == "text/markdown" -> "MD"
      else -> "TXT"
    }
  }

  fun caption(a: ArtifactRef): String {
    val kind = (a.kind ?: "file").uppercase()
    return a.size?.let { "$kind · ${fileSize(it)}" } ?: kind
  }
}

@Composable
fun ReplyMedia(artifacts: List<ArtifactRef>, fresh: Boolean, onError: (String) -> Unit) {
  val loader = LocalMediaLoader.current ?: return
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var viewing by remember { mutableStateOf<Int?>(null) }
  val media = artifacts.filter(ReplyMediaRules::isPlayable)
  val rest = artifacts.filterNot(ReplyMediaRules::isPlayable)
  val images = media.filter { it.kind == "image" }
  val others = media.filter { it.kind != "image" }
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    if (images.size > 1) {
      Column(Modifier.widthIn(max = 520.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val shown = minOf(images.size, MediaText.MAX_TILES)
        TileGrid(shown, MediaText.columns(images.size)) { i ->
          val a = images[i]
          Box(
            Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).border(1.dp, Mercury.colors.line, RoundedCornerShape(12.dp))
              .clickable(onClickLabel = "Open full screen", role = Role.Image) { viewing = media.indexOf(a) }
              .semantics { contentDescription = "Image ${i + 1} of ${images.size}" },
          ) {
            RemoteImage(loader.client.artifactFileUrl(a.id), a.name, fill = true, generated = true,
              modifier = Modifier.fillMaxSize().mediaReveal(a.id, fresh, i * 90))
            if (i == MediaText.MAX_TILES - 1 && images.size > MediaText.MAX_TILES) Text(
              "+${images.size - MediaText.MAX_TILES}", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
              modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp).clip(RoundedCornerShape(6.dp))
                .background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 6.dp, vertical = 2.dp),
            )
          }
        }
        Text(
          "${images.size} images" + (ReplyMediaRules.prompt(images)?.let { " · $it" } ?: ""),
          style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink4, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
      }
    } else images.firstOrNull()?.let { one ->
      RemoteImage(
        loader.client.artifactFileUrl(one.id), one.name, fill = false, generated = true,
        modifier = Modifier.widthIn(max = 340.dp).clip(RoundedCornerShape(14.dp)).border(1.dp, Mercury.colors.line, RoundedCornerShape(14.dp))
          .clickable(onClickLabel = "Open full screen", role = Role.Image) { viewing = media.indexOf(one) }
          .semantics { contentDescription = "Image: ${one.name}" }
          .mediaReveal(one.id, fresh),
      )
    }
    others.forEach { a ->
      val open = Modifier.clickable(onClickLabel = "Play full screen", role = Role.Button) { viewing = media.indexOf(a) }
      if (a.kind == "video") VideoTile(a, open.mediaReveal(a.id, fresh)) else SoundRow(a, open.mediaReveal(a.id, fresh))
    }
    rest.forEach { a ->
      var busy by remember(a.id) { mutableStateOf(false) }
      ArtifactCard(a, busy, Modifier.clickable(onClickLabel = "Open", role = Role.Button) {
        if (busy) return@clickable
        busy = true
        scope.launch {
          try {
            val f = loader.file(loader.client.artifactFileUrl(a.id), a.name)
            loader.open(context, f, a.mime)?.let(onError)
          } catch (e: Exception) {
            onError(e.message ?: "Couldn't open it.")
          } finally { busy = false }
        }
      })
    }
  }
  viewing?.let { start ->
    MediaViewer(media.map { it.toMediaItem(loader.client.artifactFileUrl(it.id)) }, start, onDismiss = { viewing = null })
  }
}

fun ArtifactRef.toMediaItem(url: String) = MediaItem(
  id, url, name, when (kind) { "video" -> MediaItem.Kind.Video; "audio" -> MediaItem.Kind.Audio; else -> MediaItem.Kind.Image }, mime,
)

/** A generated clip: a dark 16:9 poster with a play button (it plays in the viewer). */
@Composable
fun VideoTile(a: ArtifactRef, modifier: Modifier = Modifier) {
  Box(modifier.widthIn(max = 520.dp).fillMaxWidth().aspectRatio(16f / 9).clip(RoundedCornerShape(14.dp)).background(Color.Black)) {
    Box(Modifier.align(Alignment.Center).size(52.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f)), Alignment.Center) {
      Icon(Icons.Filled.PlayArrow, "Play ${a.name}", tint = Color.White)
    }
    Text(a.name, color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
      modifier = Modifier.align(Alignment.BottomStart).padding(10.dp))
  }
}

/** A generated sound or voice: a row with a play button (it plays in the viewer). */
@Composable
fun SoundRow(a: ArtifactRef, modifier: Modifier = Modifier) {
  val ink = MaterialTheme.colorScheme.onSurface
  Row(
    modifier.widthIn(max = 420.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceContainer)
      .border(1.dp, Mercury.colors.line, RoundedCornerShape(14.dp)).padding(10.dp),
    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), Alignment.Center) {
      Icon(Icons.Filled.PlayArrow, "Play ${a.name}", tint = MaterialTheme.colorScheme.onPrimary)
    }
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Row(Modifier.height(22.dp), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(30) { i -> Box(Modifier.width(3.dp).height((5 + ((i * 53) % 60) / 60f * 16).dp).clip(CircleShape).background(ink.copy(alpha = 0.25f))) }
      }
      Text(a.name + (a.size?.let { " · ${fileSize(it)}" } ?: ""), style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink4, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

/** A file Mercury made, shown under the reply: it opens in another app. */
@Composable
fun ArtifactCard(a: ArtifactRef, busy: Boolean, modifier: Modifier = Modifier) {
  Surface(
    color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(16.dp),
    border = androidx.compose.foundation.BorderStroke(1.dp, Mercury.colors.line), modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(),
  ) {
    Row(modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), Alignment.Center) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        else Icon(artifactIcon(a.kind, a.mime), null, tint = MaterialTheme.colorScheme.onSurface)
      }
      Column(Modifier.weight(1f)) {
        Text(a.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(ReplyMediaRules.caption(a), style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
      }
    }
  }
}

fun artifactIcon(kind: String?, mime: String?) = when (kind) {
  "image" -> Icons.Outlined.Image
  "video" -> Icons.Outlined.OndemandVideo
  "audio" -> Icons.Outlined.GraphicEq
  "pdf" -> Icons.Outlined.PictureAsPdf
  "document", "text" -> Icons.AutoMirrored.Outlined.TextSnippet
  else -> if (mime?.startsWith("image/") == true) Icons.Outlined.Image else Icons.AutoMirrored.Outlined.InsertDriveFile
}

/**
 * A picture on this Mercury, loaded with the token and cached. [fill]: crop to its frame; else
 * its own shape. [generated]: while it loads it keeps the look it had while being made.
 */
@Composable
fun RemoteImage(url: String, name: String?, fill: Boolean, modifier: Modifier = Modifier, generated: Boolean = false, maxSide: Int = 2048) {
  val loader = LocalMediaLoader.current
  var image by remember(url) { mutableStateOf<ImageBitmap?>(loader?.cached(url, maxSide)) }
  var failed by remember(url) { mutableStateOf(false) }
  LaunchedEffect(url) {
    if (image != null || loader == null) return@LaunchedEffect
    val img = loader.image(url, name, maxSide)
    if (img == null) failed = true else image = img
  }
  val img = image
  when {
    img != null -> Image(
      img, name, contentScale = if (fill) ContentScale.Crop else ContentScale.Fit,
      modifier = if (fill) modifier else modifier.aspectRatio(img.width.toFloat() / img.height.coerceAtLeast(1)),
    )
    generated && !failed -> Box(if (fill) modifier else modifier.aspectRatio(1f)) { GeneratingField("image") }
    else -> Box(
      (if (fill) modifier else modifier.aspectRatio(1f)).background(MaterialTheme.colorScheme.surfaceContainerHigh), Alignment.Center,
    ) {
      Icon(if (failed) Icons.Outlined.WarningAmber else Icons.Outlined.Image, if (failed) "Couldn't load the picture" else null, tint = Mercury.colors.ink4)
    }
  }
}

/** Files the person sent with a message: photos as thumbnails, documents as small tagged chips. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SentAttachments(items: List<SentAttachment>) {
  val loader = LocalMediaLoader.current
  var viewing by remember { mutableStateOf<Int?>(null) }
  val photos = items.mapNotNull { a -> if (a.isImage) a.url?.let { loader?.client?.uploadUrl(it) }?.let { a to it } else null }
  FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(6.dp)) {
    items.forEach { a ->
      val url = if (a.isImage) a.url?.let { loader?.client?.uploadUrl(it) } else null
      if (url != null) {
        RemoteImage(
          url, a.name, fill = true, maxSide = 512,
          modifier = Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)).border(1.dp, Mercury.colors.line, RoundedCornerShape(10.dp))
            .clickable(onClickLabel = "Open full screen") { viewing = photos.indexOfFirst { it.second == url } }
            .semantics { contentDescription = "Photo: ${a.name}" },
        )
      } else FileChip(ReplyMediaRules.tag(a), a.name)
    }
  }
  viewing?.let { start ->
    MediaViewer(photos.map { (a, u) -> MediaItem(u, u, a.name, MediaItem.Kind.Image, a.mime) }, start, onDismiss = { viewing = null })
  }
}

/** "MD notes.md": a file in a message or the composer; with [onRemove], an × to take it out. */
@Composable
fun FileChip(tag: String, name: String, onRemove: (() -> Unit)? = null) {
  val red = Mercury.colors.red
  Row(
    Modifier.heightIn(min = 32.dp).widthIn(max = 200.dp).clip(RoundedCornerShape(9.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh)
      .padding(start = 6.dp, end = if (onRemove == null) 10.dp else 0.dp),
    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    Text(
      tag, fontFamily = FontFamily.Monospace, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
      color = if (tag == "PDF") red else MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.clip(RoundedCornerShape(5.dp)).background((if (tag == "PDF") red else MaterialTheme.colorScheme.onSurface).copy(alpha = 0.08f))
        .padding(horizontal = 5.dp, vertical = 3.dp),
    )
    Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f, fill = false))
    if (onRemove != null) IconButton(onClick = onRemove, Modifier.size(36.dp)) { Icon(Icons.Outlined.Close, "Remove $name", Modifier.size(14.dp)) }
  }
}

/** A file waiting in the composer: a photo as a thumbnail, else a chip. */
@Composable
fun PendingAttachmentChip(a: OutgoingAttachment, onRemove: () -> Unit) {
  FileChip(a.tag, a.name, onRemove)
}
