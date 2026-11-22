package sh.mercuryagent.ui.owner

import android.media.MediaPlayer
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.OwnerTask
import sh.mercuryagent.core.answerOwnerTask
import sh.mercuryagent.core.declineOwnerTask
import sh.mercuryagent.core.ownerTaskMediaUrl
import sh.mercuryagent.ui.conversation.keepPlace
import sh.mercuryagent.ui.media.MediaLoader
import sh.mercuryagent.ui.theme.Mercury

/**
 * Owner tasks (ADR-048), as a card like "Needs you": something only the owner can do (type the
 * letters of a CAPTCHA, listen to one, read out a code, finish a step on a page) with the picture
 * or the sound, a box for the answer, Send (or Done) and Skip. Several are a carousel ("1 of 2").
 * Pinned above the message box in a chat, and at the bottom of every other screen. The first answer
 * from any app wins: one answered elsewhere (409) or gone (404) just leaves. Desktop:
 * apps/desktop/src/components/OwnerTasks.tsx.
 */
@Composable
fun OwnerTaskCards(store: OwnerTaskStore, client: MercuryClient, modifier: Modifier = Modifier) {
  val items by store.items.collectAsStateWithLifecycle()
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  // The "expires in N min" moves on, and expired tasks go.
  LaunchedEffect(items.isNotEmpty()) {
    while (items.isNotEmpty()) {
      now = System.currentTimeMillis()
      store.prune(now)
      delay(15_000)
    }
  }
  val context = LocalContext.current
  val ids = items.map { it.id }
  // A task's picture or sound is kept only while the task waits.
  LaunchedEffect(ids) { withContext(Dispatchers.IO) { mediaDir(context.cacheDir).listFiles()?.filter { it.nameWithoutExtension !in ids }?.forEach { it.delete() } } }

  val live = OwnerTaskStore.live(items, now)
  if (live.isEmpty()) return
  var index by remember { mutableIntStateOf(0) }
  var lastIds by remember { mutableStateOf(emptyList<String>()) }
  val liveIds = live.map { it.id }
  LaunchedEffect(liveIds) { index = keepPlace(index, lastIds, liveIds); lastIds = liveIds }
  val i = index.coerceIn(0, live.size - 1)
  fun go(d: Int) { if (live.size > 1) index = (i + d + live.size) % live.size }
  val c = Mercury.colors

  Surface(
    shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(1.dp, c.line), shadowElevation = 1.dp,
    modifier = modifier.fillMaxWidth().animateContentSize().semantics { contentDescription = "Only you can do this" },
  ) {
    Column {
      Row(Modifier.heightIn(min = 48.dp).padding(start = 14.dp, end = if (live.size > 1) 4.dp else 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(c.amber))
        Spacer(Modifier.width(10.dp))
        Text("Only you can do this", style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
        if (live.size > 1) Text("  ${i + 1} of ${live.size}", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = c.ink3)
        Spacer(Modifier.weight(1f))
        if (live.size > 1) {
          IconButton(onClick = { go(-1) }) { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, "Previous task") }
          IconButton(onClick = { go(1) }) { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, "Next task") }
        }
      }
      HorizontalDivider(color = c.line)
      AnimatedContent(live[i].id, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "owner task") { id ->
        val t = live.firstOrNull { it.id == id } ?: return@AnimatedContent
        TaskPage(t, now, store, client)
      }
    }
  }
}

@Composable
private fun TaskPage(task: OwnerTask, now: Long, store: OwnerTaskStore, client: MercuryClient) {
  var answer by remember(task.id) { mutableStateOf("") }
  var busy by remember(task.id) { mutableStateOf(false) }
  var error by remember(task.id) { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  val uri = LocalUriHandler.current
  val c = Mercury.colors
  val canSend = OwnerTaskStore.answerFor(task, answer) != null

  fun send(decline: Boolean) {
    if (busy) return
    val text = if (decline) null else OwnerTaskStore.answerFor(task, answer) ?: return
    busy = true; error = null
    scope.launch {
      try {
        // Sent, or answered elsewhere / gone (409, 404): either way it's done here.
        if (text == null) client.declineOwnerTask(task.id) else client.answerOwnerTask(task.id, text)
        store.remove(task.id)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        error = e.message ?: "Couldn't send that."
      } finally {
        busy = false
      }
    }
  }

  Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
      Icon(Icons.Outlined.Extension, null, Modifier.padding(top = 2.dp).size(18.dp), tint = c.amber)
      Text(OwnerTaskStore.heading(task), style = MaterialTheme.typography.titleMedium)
    }
    if (task.prompt.isNotBlank()) {
      Text(task.prompt, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 8, overflow = TextOverflow.Ellipsis)
    }
    task.link?.let { link ->
      Row(
        Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = "Open the page") { runCatching { uri.openUri(link) } }.padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.size(14.dp), tint = c.ink3)
        Text(link, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
    task.media?.let { TaskMedia(task, it, client) }
    if (task.needsText) {
      OutlinedTextField(
        value = answer, onValueChange = { answer = it.take(2000) },
        modifier = Modifier.fillMaxWidth(),
        placeholder = { Text("Your answer") },
        singleLine = true, enabled = !busy,
        // CAPTCHA answers are case-sensitive: no capitals, corrections or suggestions from the keyboard.
        textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 17.sp),
        keyboardOptions = KeyboardOptions(
          capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
          keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Send,
        ),
        keyboardActions = KeyboardActions(onSend = { if (canSend) send(false) }),
        shape = RoundedCornerShape(12.dp),
      )
    }
    error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
      Button(onClick = { send(false) }, enabled = canSend && !busy) {
        if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        else Text(if (task.needsText) "Send" else "Done", maxLines = 1)
      }
      Spacer(Modifier.weight(1f))
      TextButton(onClick = { send(true) }, enabled = !busy) { Text("Skip", color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
    }
    Text(OwnerTaskStore.footer(task, now), style = MaterialTheme.typography.bodySmall, color = c.ink3)
  }
}

/** The picture or sound, fetched with the device token into the cache (deleted once the task goes). */
@Composable
private fun TaskMedia(task: OwnerTask, media: OwnerTask.Media, client: MercuryClient) {
  val context = LocalContext.current
  var file by remember(task.id) { mutableStateOf<File?>(null) }
  var image by remember(task.id) { mutableStateOf<ImageBitmap?>(null) }
  var failed by remember(task.id) { mutableStateOf(false) }
  LaunchedEffect(task.id) {
    try {
      val f = File(mediaDir(context.cacheDir), task.id + extension(media.mimeType))
      if (!f.exists() || f.length() == 0L) client.downloadTo(client.ownerTaskMediaUrl(media), f, 60)
      if (media.isImage) image = withContext(Dispatchers.IO) { MediaLoader.decode(f, 1024)?.asImageBitmap() } ?: run { failed = true; null }
      file = f
    } catch (e: CancellationException) {
      throw e
    } catch (_: Exception) {
      failed = true
    }
  }
  // CAPTCHAs are drawn for a white page: a white panel in dark mode too.
  Box(
    Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(10.dp))
      .background(if (media.isImage) Color.White else MaterialTheme.colorScheme.surfaceContainerHigh)
      .border(1.dp, Mercury.colors.line, RoundedCornerShape(10.dp)).padding(8.dp),
    contentAlignment = Alignment.Center,
  ) {
    val f = file
    val img = image
    when {
      failed -> Text("Couldn't load it. Skip, or answer from another app.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
      f == null -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
      media.isImage && img != null -> Image(
        img, "What to solve", contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth().heightIn(max = 160.dp),
      )
      media.isAudio -> AudioPlayer(f)
      else -> Text("This app can't show that kind of file.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
    }
  }
}

/** Play / pause the audio CAPTCHA (a short local file); it starts over each time it ends. */
@Composable
private fun AudioPlayer(f: File) {
  var playing by remember(f) { mutableStateOf(false) }
  var broken by remember(f) { mutableStateOf(false) }
  val player = remember(f) {
    runCatching { MediaPlayer().apply { setDataSource(f.path); prepare() } }.getOrNull()
  }
  DisposableEffect(player) {
    player?.setOnCompletionListener { playing = false; runCatching { it.seekTo(0) } }
    onDispose { runCatching { player?.release() } }
  }
  if (player == null || broken) {
    Text("This phone can't play that sound.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
    return
  }
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    FilledTonalIconButton(onClick = {
      runCatching { if (playing) player.pause() else player.start(); playing = !playing }.onFailure { broken = true }
    }) {
      Icon(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (playing) "Pause" else "Play the audio")
    }
    Text(if (playing) "Playing…" else "Listen, then type what you hear", style = MaterialTheme.typography.bodyMedium)
  }
}

private fun mediaDir(cache: File) = File(cache, "owner-tasks")

private fun extension(mime: String): String = when (mime.substringBefore(';').trim().lowercase()) {
  "image/png" -> ".png"
  "image/jpeg", "image/jpg" -> ".jpg"
  "image/gif" -> ".gif"
  "image/webp" -> ".webp"
  "image/svg+xml" -> ".svg"
  "audio/mpeg", "audio/mp3" -> ".mp3"
  "audio/wav", "audio/x-wav", "audio/wave" -> ".wav"
  "audio/ogg" -> ".ogg"
  "audio/mp4", "audio/aac", "audio/x-m4a" -> ".m4a"
  "audio/webm" -> ".webm"
  else -> ".bin"
}
