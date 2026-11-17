package sh.mercuryagent.ui.media

import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.File
import kotlinx.coroutines.launch

/** One picture, video or sound in the viewer. [url] is a Mercury URL (the loader adds the token). */
data class MediaItem(val id: String, val url: String, val title: String?, val kind: Kind, val mime: String? = null) {
  enum class Kind { Image, Video, Audio }
}

/**
 * The full-screen viewer for pictures, videos and sounds (iOS: MediaSlider, Desktop's Lightbox):
 * swipe between them, "3 / 5", a strip of thumbnails to jump, the picture blurred behind it,
 * pinch and double-tap to zoom, share, and (when [onDelete] is given) delete. Tap hides the chrome.
 */
@Composable
fun MediaViewer(
  items: List<MediaItem>,
  start: Int,
  onDismiss: () -> Unit,
  onDelete: (suspend (MediaItem) -> Unit)? = null,
  deleteMessage: (MediaItem) -> String = { "This can't be undone." },
) {
  val loader = LocalMediaLoader.current ?: return
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val list = remember { mutableStateListOf<MediaItem>().also { it.addAll(items) } }
  val pager = rememberPagerState(initialPage = start.coerceIn(0, maxOf(items.size - 1, 0))) { list.size }
  var chrome by remember { mutableStateOf(true) }
  var sharing by remember { mutableStateOf(false) }
  var confirm by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  val current = list.getOrNull(pager.currentPage)

  Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
      if (current?.kind == MediaItem.Kind.Image) {
        val bg = loader.cached(current.url)
        if (bg != null) Image(bg, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().blur(50.dp).graphicsLayer { alpha = 0.55f })
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)))
      }
      HorizontalPager(pager, Modifier.fillMaxSize(), key = { list[it].id }, beyondViewportPageCount = 1) { page ->
        val item = list[page]
        when (item.kind) {
          MediaItem.Kind.Image -> ZoomableImage(item, active = pager.currentPage == page) { chrome = !chrome }
          else -> PlayerPage(item, active = pager.currentPage == page)
        }
      }
      AnimatedVisibility(chrome, enter = fadeIn(), exit = fadeOut()) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
          Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            RoundButton(Icons.Outlined.Close, "Close", onClick = onDismiss)
            Spacer(Modifier.weight(1f))
            if (list.size > 1) Text(
              "${pager.currentPage + 1} / ${list.size}", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
              modifier = Modifier.clip(CircleShape).background(Color.Black.copy(alpha = 0.35f)).padding(horizontal = 12.dp, vertical = 6.dp)
                .semantics { contentDescription = "${pager.currentPage + 1} of ${list.size}" },
            )
            Spacer(Modifier.weight(1f))
            if (onDelete != null) RoundButton(Icons.Outlined.Delete, "Delete") { confirm = true }
            RoundButton(Icons.Outlined.Share, "Share", busy = sharing) {
              val c = current ?: return@RoundButton
              sharing = true
              scope.launch {
                try { loader.share(context, loader.file(c.url, MediaFiles.fileName(c)), c.mime); error = null }
                catch (e: Exception) { error = "Couldn't get it to share: ${e.message}" }
                finally { sharing = false }
              }
            }
          }
          Spacer(Modifier.weight(1f))
          Column(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.55f))))
              .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
          ) {
            error?.let { Text(it, color = Color(0xFFFF6B6B), fontSize = 13.sp) }
            current?.title?.takeIf { it.isNotEmpty() }?.let { Text(it, color = Color.White.copy(alpha = 0.92f), fontSize = 14.sp, maxLines = 2) }
            if (list.size > 1) Strip(list, pager.currentPage) { i -> scope.launch { pager.animateScrollToPage(i) } }
          }
        }
      }
    }
  }

  if (confirm && current != null && onDelete != null) AlertDialog(
    onDismissRequest = { confirm = false },
    title = { Text("Delete this?") },
    text = { Text(deleteMessage(current)) },
    confirmButton = {
      TextButton(onClick = {
        confirm = false
        scope.launch {
          try {
            onDelete(current)
            list.remove(current)
            error = null
            if (list.isEmpty()) onDismiss()
          } catch (e: Exception) { error = e.message }
        }
      }) { Text("Delete", color = androidx.compose.material3.MaterialTheme.colorScheme.error) }
    },
    dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
  )
}

object MediaFiles {
  /** A share-friendly name: the title, with an extension when it has none. */
  fun fileName(item: MediaItem): String? {
    val clean = item.title?.replace('/', '-')?.takeIf { it.isNotEmpty() } ?: return null
    if (clean.substringAfterLast('.', "").isNotEmpty() && clean.contains('.')) return clean
    return clean + when (item.kind) { MediaItem.Kind.Image -> ".png"; MediaItem.Kind.Video -> ".mp4"; MediaItem.Kind.Audio -> ".mp3" }
  }
}

@Composable
private fun RoundButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, busy: Boolean = false, onClick: () -> Unit) {
  IconButton(
    onClick = onClick, enabled = !busy,
    colors = IconButtonDefaults.iconButtonColors(containerColor = Color.Black.copy(alpha = 0.35f), contentColor = Color.White, disabledContainerColor = Color.Black.copy(alpha = 0.35f)),
  ) {
    if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp) else Icon(icon, label)
  }
}

@Composable
private fun Strip(items: List<MediaItem>, current: Int, onPick: (Int) -> Unit) {
  val state = rememberLazyListState()
  LaunchedEffect(current) { state.animateScrollToItem(maxOf(0, current - 2)) }
  LazyRow(state = state, horizontalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(2.dp)) {
    itemsIndexed(items, key = { _, it -> it.id }) { i, item ->
      val selected = i == current
      Box(
        Modifier.size(48.dp).clip(RoundedCornerShape(8.dp))
          .border(if (selected) 2.dp else 1.dp, if (selected) Color.White else Color.White.copy(alpha = 0.15f), RoundedCornerShape(8.dp))
          .background(Color.White.copy(alpha = 0.08f)).graphicsLayer { alpha = if (selected) 1f else 0.65f }
          .clickable(onClickLabel = "Show") { onPick(i) }.semantics { contentDescription = item.title ?: "Item ${i + 1}" },
        contentAlignment = Alignment.Center,
      ) {
        when (item.kind) {
          MediaItem.Kind.Image -> Thumb(item)
          MediaItem.Kind.Video -> Icon(Icons.Filled.PlayArrow, null, tint = Color.White.copy(alpha = 0.8f))
          MediaItem.Kind.Audio -> Icon(Icons.Outlined.GraphicEq, null, tint = Color.White.copy(alpha = 0.8f))
        }
      }
    }
  }
}

@Composable
private fun Thumb(item: MediaItem) {
  val loader = LocalMediaLoader.current ?: return
  var img by remember(item.url) { mutableStateOf(loader.cached(item.url, 256)) }
  LaunchedEffect(item.url) { if (img == null) img = loader.image(item.url, MediaFiles.fileName(item), 256) }
  img?.let { Image(it, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
}

/** A picture that pinches and double-taps to zoom, and pans once zoomed. */
@Composable
private fun ZoomableImage(item: MediaItem, active: Boolean, onTap: () -> Unit) {
  val loader = LocalMediaLoader.current ?: return
  var img by remember(item.url) { mutableStateOf<ImageBitmap?>(loader.cached(item.url)) }
  var failed by remember(item.url) { mutableStateOf(false) }
  var scale by remember { mutableFloatStateOf(1f) }
  var offset by remember { mutableStateOf(Offset.Zero) }
  LaunchedEffect(item.url) { if (img == null) { img = loader.image(item.url, MediaFiles.fileName(item)); failed = img == null } }
  LaunchedEffect(active) { if (!active) { scale = 1f; offset = Offset.Zero } }
  Box(
    Modifier.fillMaxSize()
      .pointerInput(item.id) {
        detectTapGestures(
          onTap = { onTap() },
          onDoubleTap = { if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f },
        )
      }
      .pointerInput(item.id, scale > 1f) {
        // Only take drags once zoomed in: at 1× the pager swipes.
        if (scale > 1f) detectTransformGestures { _, pan, zoom, _ ->
          scale = (scale * zoom).coerceIn(1f, 5f)
          offset = if (scale <= 1.01f) Offset.Zero else offset + pan
        } else detectTransformGestures(panZoomLock = true) { _, _, zoom, _ ->
          if (zoom != 1f) scale = (scale * zoom).coerceIn(1f, 5f)
        }
      },
    contentAlignment = Alignment.Center,
  ) {
    val i = img
    when {
      i != null -> Image(
        i, item.title ?: "Picture", contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
      )
      failed -> Icon(Icons.Outlined.Image, "Couldn't load the picture", Modifier.size(40.dp), tint = Color.White.copy(alpha = 0.4f))
      else -> CircularProgressIndicator(color = Color.White)
    }
  }
}

/** A video or a sound: downloaded once (with the token), then played with the platform's controls. */
@Composable
private fun PlayerPage(item: MediaItem, active: Boolean) {
  val loader = LocalMediaLoader.current ?: return
  var file by remember(item.url) { mutableStateOf<File?>(null) }
  var error by remember(item.url) { mutableStateOf<String?>(null) }
  var view by remember { mutableStateOf<VideoView?>(null) }
  LaunchedEffect(item.url) {
    try { file = loader.file(item.url, MediaFiles.fileName(item)) } catch (e: Exception) { error = e.message ?: "Couldn't load it." }
  }
  LaunchedEffect(active) { if (!active) view?.pause() }
  Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
    if (item.kind == MediaItem.Kind.Audio) Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
      Icon(Icons.Outlined.GraphicEq, null, Modifier.size(54.dp), tint = Color.White)
      item.title?.let { Text(it, color = Color.White.copy(alpha = 0.85f), fontSize = 15.sp, textAlign = TextAlign.Center, maxLines = 2) }
    }
    val f = file
    when {
      error != null -> Text(error!!, color = Color(0xFFFF6B6B), modifier = Modifier.padding(32.dp))
      f == null -> CircularProgressIndicator(color = Color.White)
      else -> AndroidView(
        factory = { ctx ->
          VideoView(ctx).apply {
            val controls = MediaController(ctx)
            controls.setAnchorView(this)
            setMediaController(controls)
            setVideoURI(Uri.fromFile(f))
            setOnPreparedListener { if (active) start(); controls.show(0) }
            view = this
          }
        },
        onRelease = { it.stopPlayback() },
        modifier = if (item.kind == MediaItem.Kind.Audio) Modifier.fillMaxWidth().size(1.dp).align(Alignment.BottomCenter) else Modifier.fillMaxWidth(),
      )
    }
  }
}
