package sh.mercuryagent.ui.conversation

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Search
import sh.mercuryagent.core.ModelChoice
import sh.mercuryagent.core.ModelMenu
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MicOff
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material.icons.outlined.TextFields
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.background
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.mercuryagent.core.ChatEffort
import sh.mercuryagent.core.MediaAvailability
import sh.mercuryagent.core.MediaIntent
import sh.mercuryagent.core.OutgoingAttachment
import sh.mercuryagent.ui.theme.Mercury

/**
 * The message box, a rounded pill at the bottom as in the ChatGPT and Grok apps: + (files, Create,
 * thinking effort, in a bottom sheet), the text (up to six lines), the mic (live dictation into the
 * box: greyed out, with what to add, when this Mercury can't), and one round button on the right:
 * a voice call when the box is empty, Send when there's something to send, Stop while this chat
 * works. What's set for the next message shows as chips above the text.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Composer(
  vm: ConversationViewModel,
  busy: Boolean,
  stopping: Boolean,
  focus: FocusRequester,
  dictation: sh.mercuryagent.call.DictationModel,
  onDictate: () -> Unit,
  onCall: () -> Unit,
  modifier: Modifier = Modifier,
  /** The Mercury has `voice.providers`: the model picker links to Settings → Voice. */
  voiceKeys: Boolean = false,
  onVoiceSettings: () -> Unit = {},
) {
  val draft = vm.draft
  val attachments by vm.attachments.collectAsStateWithLifecycle()
  val composer by vm.composer.collectAsStateWithLifecycle()
  val canSend = draft.text.isNotBlank() || attachments.isNotEmpty()
  var sheet by remember { mutableStateOf(false) }
  val dismissKeyboard = sh.mercuryagent.ui.rememberDismissKeyboard()
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(OutgoingAttachment.MAX_FILES)) { uris ->
    scope.launch { uris.take(OutgoingAttachment.MAX_FILES - vm.attachments.value.size).forEach { addPhoto(context, vm, it) } }
  }
  val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
    scope.launch { uris.forEach { addFile(context, vm, it) } }
  }

  val placeholder = when (composer.media?.kind) {
    MediaIntent.IMAGE -> "Describe the image"
    MediaIntent.VIDEO -> "Describe the video"
    MediaIntent.MUSIC -> "Describe the music"
    else -> if (dictation.active) "Listening…" else if (composer.code) "Describe what to build" else "Ask anything"
  }
  val hasChips = attachments.isNotEmpty() || composer.media != null || composer.ownEffort != null

  var models by remember { mutableStateOf(false) }
  val scheme = MaterialTheme.colorScheme
  Surface(
    shape = RoundedCornerShape(28.dp), color = scheme.surfaceContainerHigh,
    border = BorderStroke(1.dp, Mercury.colors.line),
    modifier = modifier.fillMaxWidth().padding(horizontal = 10.dp).padding(top = 6.dp, bottom = 8.dp).animateContentSize(),
  ) {
    Column(Modifier.padding(bottom = 8.dp)) {
      AnimatedVisibility(dictation.notice != null) {
        DictationNotice(dictation.notice.orEmpty()) { dictation.notice = null }
      }
      AnimatedVisibility(hasChips) {
        FlowRow(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          attachments.forEach { a -> FileChip(a.tag, a.name) { vm.removeAttachment(a.id) } }
          composer.media?.let { m ->
            ModeChip(mediaIcon(m.kind), m.label) { vm.setMedia(null) }
          }
          composer.ownEffort?.let { e -> ModeChip(Icons.Outlined.Speed, "Effort: ${ChatEffort.label(e)}") { vm.setEffort(null) } }
        }
      }
      // Row 1: the text.
      Box(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 8.dp)) {
        if (draft.text.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = Mercury.colors.ink3)
        BasicTextField(
          state = draft,
          textStyle = MaterialTheme.typography.bodyLarge.copy(color = scheme.onSurface),
          cursorBrush = SolidColor(scheme.onSurface),
          lineLimits = TextFieldLineLimits.MultiLine(minHeightInLines = 1, maxHeightInLines = 6),
          keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
          modifier = Modifier.fillMaxWidth().focusRequester(focus),
        )
      }
      // Row 2: + and the model on the left; the mic and the one round button on the right.
      Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        CircleIcon(Icons.Outlined.Add, "Add a file, create media or set thinking effort") { dismissKeyboard(); sheet = true }
        Spacer(Modifier.width(8.dp))
        ModelPill(composer.catalog?.pill ?: "Auto", composer.switching) { dismissKeyboard(); models = true }
        Spacer(Modifier.weight(1f))
        DictationButton(dictation, onDictate)
        Spacer(Modifier.width(6.dp))
        val mode = when { busy && !canSend -> 2; canSend -> 1; else -> 0 }
        AnimatedContent(mode, transitionSpec = { (scaleIn() + fadeIn()) togetherWith (scaleOut() + fadeOut()) }, label = "action") { m ->
          when (m) {
            2 -> FilledIconButton(onClick = vm::stop, enabled = !stopping, modifier = Modifier.size(44.dp)) { Icon(Icons.Filled.Stop, if (stopping) "Stopping" else "Stop this chat") }
            1 -> FilledIconButton(onClick = { dictation.cancel(); vm.send() }, modifier = Modifier.size(44.dp)) { Icon(Icons.Filled.ArrowUpward, "Send") }
            else -> FilledIconButton(onClick = onCall, modifier = Modifier.size(44.dp)) { Icon(Icons.Outlined.GraphicEq, "Voice call") }
          }
        }
      }
    }
  }

  if (models) ModelSheet(
    vm, composer, onDismiss = { models = false },
    voice = if (voiceKeys) VoiceLine(dictation.capabilities) else null,
    onVoiceSettings = { models = false; onVoiceSettings() },
  )
  if (sheet) ComposerSheet(
    vm, composer, attachments.size,
    onDismiss = { sheet = false },
    onPhotos = { sheet = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
    onFiles = { sheet = false; files.launch(arrayOf("image/*", "application/pdf", "text/plain", "text/markdown", "text/x-markdown", "application/octet-stream")) },
  )
}

/**
 * The composer's mic: dictates live into the box. While listening it shows a waveform in a ring
 * that follows your voice; greyed out when this Mercury can't (a tap says what to add).
 */
@Composable
private fun DictationButton(dictation: sh.mercuryagent.call.DictationModel, onClick: () -> Unit) {
  val on = dictation.active
  var level by remember { mutableStateOf(0f) }
  androidx.compose.runtime.LaunchedEffect(on) {
    while (on) { androidx.compose.runtime.withFrameNanos { level = dictation.meter.read().first } }
    level = 0f
  }
  val label = when (dictation.phase) {
    sh.mercuryagent.call.DictationModel.Phase.Idle -> if (dictation.available) "Dictate" else "Dictate, unavailable"
    sh.mercuryagent.call.DictationModel.Phase.Starting, sh.mercuryagent.call.DictationModel.Phase.Listening -> "Stop dictation"
    sh.mercuryagent.call.DictationModel.Phase.Stopping -> "Finishing dictation"
  }
  val ink = MaterialTheme.colorScheme.onSurface
  IconButton(
    onClick = onClick,
    modifier = Modifier.alpha(if (on || dictation.available || dictation.capabilities == null) 1f else 0.35f),
  ) {
    Box(contentAlignment = Alignment.Center) {
      if (on) androidx.compose.foundation.Canvas(Modifier.size(36.dp)) {
        drawCircle(ink.copy(alpha = 0.10f + 0.25f * level), radius = size.minDimension / 2 * (0.82f + 0.18f * level))
      }
      Icon(
        if (on) Icons.Outlined.GraphicEq else Icons.Outlined.Mic, label,
        Modifier.alpha(if (dictation.phase == sh.mercuryagent.call.DictationModel.Phase.Stopping) 0.6f else 1f),
      )
    }
  }
}

/** Why the mic is greyed out or why dictation stopped: one line above the text, tap to dismiss. */
@Composable
private fun DictationNotice(text: String, onDismiss: () -> Unit) {
  Row(
    Modifier.fillMaxWidth().clickable(onClickLabel = "Dismiss", onClick = onDismiss).padding(start = 16.dp, end = 12.dp, top = 12.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top,
  ) {
    Icon(Icons.Outlined.MicOff, null, Modifier.size(16.dp).padding(top = 1.dp), tint = Mercury.colors.ink3)
    Text(text, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3, modifier = Modifier.weight(1f))
    Icon(Icons.Outlined.Close, null, Modifier.size(16.dp), tint = Mercury.colors.ink3)
  }
}

fun mediaIcon(kind: String) = when (kind) {
  MediaIntent.IMAGE -> Icons.Outlined.Image
  MediaIntent.VIDEO -> Icons.Outlined.Movie
  else -> Icons.Outlined.MusicNote
}

/** A setting for the next message (Image 3:2, Effort: High): tap × to remove. */
@Composable
private fun ModeChip(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, onRemove: () -> Unit) {
  InputChip(
    selected = true, onClick = onRemove, label = { Text(text, maxLines = 1) },
    leadingIcon = { Icon(icon, null, Modifier.size(InputChipDefaults.IconSize)) },
    trailingIcon = { Icon(Icons.Outlined.Close, "Remove $text", Modifier.size(InputChipDefaults.IconSize)) },
  )
}

/** The + sheet: add a photo or a file, set the next message to make media, pick the thinking effort. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ComposerSheet(
  vm: ConversationViewModel,
  c: ComposerState,
  attached: Int,
  onDismiss: () -> Unit,
  onPhotos: () -> Unit,
  onFiles: () -> Unit,
) {
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val a = c.mediaAvailable ?: MediaAvailability.unknown
  val full = attached >= OutgoingAttachment.MAX_FILES
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state) {
    Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 12.dp)) {
      Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        SheetTile(Icons.Outlined.PhotoLibrary, "Photos", !full, onPhotos, Modifier.weight(1f))
        SheetTile(Icons.AutoMirrored.Outlined.InsertDriveFile, "Files", !full, onFiles, Modifier.weight(1f))
      }
      if (full) Text("Up to ${OutgoingAttachment.MAX_FILES} files per message.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))

      SheetHeader("Your next message")
      CreateRow(Icons.Outlined.TextFields, "Normal answer", null, c.media == null, true) { vm.setMedia(null); onDismiss() }
      CreateRow(Icons.Outlined.Image, "Image", a.using[MediaIntent.IMAGE], c.media?.kind == MediaIntent.IMAGE, a.image) {
        vm.setMedia(MediaIntent(MediaIntent.IMAGE, c.media?.takeIf { it.kind == MediaIntent.IMAGE }?.aspect ?: MediaIntent.SQUARE))
      }
      if (c.media?.kind == MediaIntent.IMAGE) AspectChips(MediaIntent.IMAGE, MediaIntent.aspects, c.media.aspect) { vm.setMedia(MediaIntent(MediaIntent.IMAGE, it)) }
      CreateRow(Icons.Outlined.Movie, "Video", a.using[MediaIntent.VIDEO], c.media?.kind == MediaIntent.VIDEO, a.video) {
        vm.setMedia(MediaIntent(MediaIntent.VIDEO, c.media?.takeIf { it.kind == MediaIntent.VIDEO }?.aspect ?: MediaIntent.LANDSCAPE))
      }
      if (c.media?.kind == MediaIntent.VIDEO) AspectChips(MediaIntent.VIDEO, listOf(MediaIntent.LANDSCAPE, MediaIntent.PORTRAIT), c.media.aspect) { vm.setMedia(MediaIntent(MediaIntent.VIDEO, it)) }
      CreateRow(Icons.Outlined.MusicNote, "Music", a.using[MediaIntent.MUSIC], c.media?.kind == MediaIntent.MUSIC, a.music) { vm.setMedia(MediaIntent(MediaIntent.MUSIC)); onDismiss() }
      if (c.mediaAvailable != null && !a.any) Text("No media models on your Mercury's providers", style = MaterialTheme.typography.bodySmall,
        color = Mercury.colors.ink3, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))

      val m = c.model
      val levels = m?.reasoningLevels.orEmpty()
      if (m != null && levels.isNotEmpty()) {
        val e = m.currentEffort
        HorizontalDivider(Modifier.padding(top = 8.dp), color = Mercury.colors.line)
        SheetHeader("Thinking effort · this chat")
        EffortRow("Model default · ${ChatEffort.label(e.modelDefault)}", null, e.chat == null) { vm.setEffort(null) }
        (listOf("auto") + levels).forEach { level -> EffortRow(ChatEffort.label(level), ChatEffort.hint(level), e.chat == level) { vm.setEffort(level) } }
        if (e.chatUnsupported == true) Text("This model can't use the chat's pick; its default applies", style = MaterialTheme.typography.bodySmall,
          color = Mercury.colors.ink3, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
      }
    }
  }
}

@Composable
private fun SheetHeader(text: String) {
  Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() })
}

@Composable
private fun SheetTile(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier) {
  Surface(onClick = onClick, enabled = enabled, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = modifier.alpha(if (enabled) 1f else 0.5f)) {
    Column(Modifier.padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Icon(icon, null)
      Text(label, style = MaterialTheme.typography.labelLarge)
    }
  }
}

@Composable
private fun CreateRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, using: String?, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
  ListItem(
    headlineContent = { Text(title) },
    supportingContent = using?.let { { Text(it) } },
    leadingContent = { Icon(icon, null) },
    trailingContent = { if (on) Icon(Icons.Outlined.Check, "Selected") },
    colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
    modifier = Modifier.alpha(if (enabled) 1f else 0.4f).then(
      if (enabled) Modifier.clickable(role = Role.RadioButton, onClick = onClick) else Modifier,
    ),
  )
}


@Composable
private fun EffortRow(title: String, hint: String?, on: Boolean, onClick: () -> Unit) {
  ListItem(
    headlineContent = { Text(title) },
    supportingContent = hint?.let { { Text(it) } },
    leadingContent = { RadioButton(selected = on, onClick = null) },
    colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
    modifier = Modifier.clickable(role = Role.RadioButton, onClick = onClick),
  )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AspectChips(kind: String, aspects: List<String>, selected: String?, onPick: (String) -> Unit) {
  FlowRow(Modifier.padding(start = 56.dp, end = 16.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    aspects.forEach { asp ->
      val label = MediaIntent(kind, asp).label.substringAfter(' ', "").ifEmpty { asp }
      FilterChip(selected = selected == asp, onClick = { onPick(asp) }, label = { Text("${asp.replaceFirstChar { it.uppercase() }} · $label") })
    }
  }
}

// MARK: Files

/** A photo from the picker: HEIC and very large photos become a JPEG the runtime takes (8 MB, longest side 2560). */
private suspend fun addPhoto(context: Context, vm: ConversationViewModel, uri: Uri) {
  val data = withContext(Dispatchers.IO) { runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() }
    ?: return vm.showError("Couldn't load that photo.")
  val n = vm.attachments.value.count { it.isImage } + 1
  val sniffed = OutgoingAttachment.sniffImage(data)
  if (sniffed != null && data.size <= OutgoingAttachment.MAX_IMAGE_BYTES) {
    vm.attach("photo-$n.${sniffed.substringAfter('/')}", data)
  } else {
    val jpeg = withContext(Dispatchers.Default) { ImagePrep.jpeg(context, uri) } ?: return vm.showError("That photo's format isn't supported.")
    vm.attach("photo-$n.jpg", jpeg)
  }
}

/** A document: images that aren't png, jpeg, gif or webp become JPEG; the rest go as they are. */
private suspend fun addFile(context: Context, vm: ConversationViewModel, uri: Uri) {
  val name = withContext(Dispatchers.IO) {
    runCatching {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    }.getOrNull()
  } ?: uri.lastPathSegment ?: "file"
  val data = withContext(Dispatchers.IO) { runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() }
    ?: return vm.showError("Couldn't read $name.")
  val type = context.contentResolver.getType(uri)
  if (OutgoingAttachment.sniffImage(data) == null && type?.startsWith("image/") == true) {
    val jpeg = withContext(Dispatchers.Default) { ImagePrep.jpeg(context, uri) }
    if (jpeg != null) return vm.attach(name.substringBeforeLast('.') + ".jpg", jpeg)
  }
  vm.attach(name, data)
}

object ImagePrep {
  /** Any picture Android can read as a JPEG, longest side at most [maxSide]. */
  fun jpeg(context: Context, uri: Uri, maxSide: Int = 2560): ByteArray? = runCatching {
    val src = ImageDecoder.createSource(context.contentResolver, uri)
    val bmp = ImageDecoder.decodeBitmap(src) { d, info, _ ->
      val w = info.size.width; val h = info.size.height
      val scale = minOf(1f, maxSide.toFloat() / maxOf(w, h))
      if (scale < 1f) d.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
      d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
    ByteArrayOutputStream().use { out -> bmp.compress(Bitmap.CompressFormat.JPEG, 85, out); out.toByteArray() }
  }.getOrNull()
}


/** A round icon button in the composer's second row (+). */
@Composable
private fun CircleIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
  Surface(
    onClick = onClick, shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHighest,
    modifier = Modifier.size(40.dp),
  ) { Box(contentAlignment = Alignment.Center) { Icon(icon, label, Modifier.size(22.dp)) } }
}

/** The model Mercury answers with ("Auto" on its configured default): tap to pick another. */
@Composable
private fun ModelPill(name: String, busy: Boolean, onClick: () -> Unit) {
  Surface(
    onClick = onClick, shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerHighest,
    modifier = Modifier.height(40.dp).semantics { contentDescription = "Model: $name. Change the model" },
  ) {
    Row(Modifier.padding(start = 12.dp, end = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      if (busy) androidx.compose.material3.CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
      else Icon(Icons.Outlined.AutoAwesome, null, Modifier.size(16.dp))
      Text(name, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
        modifier = Modifier.widthIn(max = 150.dp))
      Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(16.dp), tint = Mercury.colors.ink3)
    }
  }
}

/**
 * The model picker: Auto (Mercury's configured default) first, then every model by family, the
 * current one ticked, a search when there are many. Mercury has one model for every chat, so the
 * sheet says a pick changes it everywhere.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelSheet(
  vm: ConversationViewModel,
  c: ComposerState,
  onDismiss: () -> Unit,
  voice: VoiceLine? = null,
  onVoiceSettings: () -> Unit = {},
) {
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  var query by remember { mutableStateOf("") }
  androidx.compose.runtime.LaunchedEffect(Unit) { vm.loadModels() }
  val catalog = c.catalog
  val groups = remember(catalog, query) { ModelMenu.groups(catalog?.models.orEmpty(), query) }
  fun pick(m: ModelChoice?) { vm.pickModel(m); onDismiss() }
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
    Column(Modifier.navigationBarsPadding().heightIn(max = 640.dp)) {
      Text("Model", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 20.dp))
      Text(
        "Changes the model for Mercury, in every chat.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 8.dp),
      )
      voice?.let { v ->
        Row(
          Modifier.fillMaxWidth().clickable(onClickLabel = "Set up voice", onClick = onVoiceSettings).padding(horizontal = 20.dp, vertical = 8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(v.status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
          Text("Set up voice →", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
        }
      }
      if ((catalog?.models?.size ?: 0) > 8) Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).height(44.dp)
          .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(22.dp)).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(Icons.Outlined.Search, null, Modifier.size(18.dp), tint = Mercury.colors.ink3)
        Box(Modifier.weight(1f).padding(start = 10.dp)) {
          if (query.isEmpty()) Text("Search ${catalog?.models?.size ?: 0} models", color = Mercury.colors.ink3)
          androidx.compose.foundation.text.BasicTextField(
            query, { query = it }, singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface), modifier = Modifier.fillMaxWidth(),
          )
        }
      }
      when {
        catalog == null -> Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) { androidx.compose.material3.CircularProgressIndicator() }
        else -> LazyColumn(Modifier.fillMaxWidth()) {
          if (query.isBlank()) item(key = "auto") {
            val d = catalog.defaultChoice
            ModelRow("Auto", d?.let { "Mercury's default · ${it.title}" } ?: "Mercury's default model", catalog.isAuto, enabled = d != null) { pick(null) }
          }
          catalog.notices.forEach { n -> item { Text(n, color = Mercury.colors.amber, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) } }
          for (g in groups) {
            item(key = "g:${g.title}") { SheetHeader(g.title + if (g.models.size > 1) " · ${g.models.size}" else "") }
            items(g.models, key = { "${it.name}:${it.model}" }) { m ->
              ModelRow(m.title, if (m.title != m.model) m.model else ModelMenu.providerName(m.name), m.isCurrent && !catalog.isAuto, m.available) { pick(m) }
            }
          }
          if (groups.isEmpty()) item { Text(if (query.isBlank()) "No providers configured." else "No model matches “$query”.", color = Mercury.colors.ink3, modifier = Modifier.padding(20.dp)) }
        }
      }
    }
  }
}

/** The model picker's voice line: what calls use, from the capabilities the mic already asked for. */
data class VoiceLine(val capabilities: sh.mercuryagent.core.VoiceCapabilities?) {
  val status: String
    get() {
      val c = capabilities ?: return "Voice"
      return if (c.call) "Voice: ${c.callEngineName ?: c.callEngine ?: "ready"} ✓" else "Voice: not set up"
    }
}

@Composable
private fun ModelRow(title: String, detail: String?, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
  ListItem(
    headlineContent = { Text(title, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) },
    supportingContent = detail?.let { { Text(it, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) } },
    trailingContent = { if (on) Icon(Icons.Outlined.Check, "Current") },
    colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
    modifier = Modifier.alpha(if (enabled) 1f else 0.4f).then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier),
  )
}
