package sh.mercuryagent.ui.conversation

import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.outlined.DragHandle
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.BookmarkRemove
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ChatMessage
import sh.mercuryagent.ui.chats.RenameDialog
import sh.mercuryagent.ui.theme.Mercury

/**
 * The app's main screen: one conversation, as in the ChatGPT and Grok apps. A flat bar (the drawer,
 * the chat's name with its menu and status, new chat, call), messages (yours in a soft bubble,
 * Mercury's as plain text with its thought process and actions), the turn as it happens, and pinned
 * above the message box: the plan and anything Mercury needs you for. A new chat greets you with
 * the mark and a few ideas above the box.
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun ConversationScreen(
  vm: ConversationViewModel,
  snackbar: SnackbarHostState,
  onMenu: () -> Unit,
  onNewChat: () -> Unit,
  /** The chat was deleted from its own menu. */
  onDeleted: () -> Unit,
  /** Settings → Voice (from the model picker). */
  onVoiceSettings: () -> Unit = {},
  /** Owner tasks (ADR-048: a CAPTCHA, a code), pinned above the message box with "Needs you". */
  ownerTasks: @Composable () -> Unit = {},
) {
  val ui by vm.ui.collectAsStateWithLifecycle()
  val welcome by vm.welcome.collectAsStateWithLifecycle()
  val composer by vm.composer.collectAsStateWithLifecycle()
  val list = rememberLazyListState()
  val dismissKeyboard = sh.mercuryagent.ui.rememberDismissKeyboard()
  // Scrolling the chat means reading, not typing.
  sh.mercuryagent.ui.DismissKeyboardOnDrag(list)
  val focus = remember { FocusRequester() }
  val scope = rememberCoroutineScope()
  var menu by remember { mutableStateOf(false) }
  var renaming by remember { mutableStateOf(false) }
  var deleting by remember { mutableStateOf(false) }
  val context = LocalContext.current
  val container = remember { (context.applicationContext as sh.mercuryagent.MercuryApplication).container }
  val calls = container.calls
  // Live dictation into the box, and voice calls: both need the microphone first.
  val dictation = remember(vm) { sh.mercuryagent.call.DictationModel(context.applicationContext, vm.client, vm.draft, calls, scope) }
  val mic = sh.mercuryagent.ui.call.rememberMicPermission(snackbar)
  // A voice key saved in Settings → Voice: the mic asks again at once.
  val voiceChanges by calls.changes.collectAsStateWithLifecycle()
  LaunchedEffect(dictation, voiceChanges) { dictation.load() }
  var voiceKeys by remember(vm.client) { mutableStateOf(false) }
  LaunchedEffect(vm.client) { voiceKeys = sh.mercuryagent.core.VOICE_PROVIDERS_FEATURE in calls.features(vm.client) }
  androidx.compose.runtime.DisposableEffect(dictation) { onDispose { dictation.cancel() } }
  // A ring the owner answered (ADR-046) goes with the call, so Mercury says why it called.
  val beginCall: () -> Unit = { mic { dictation.cancel(); calls.start(vm, container.takeAnsweredRing()) } }
  // "Set up voice" (VoiceSetupSheet), when a call or the mic needs a voice this Mercury doesn't have.
  var voiceSetup by remember(vm.client) { mutableStateOf<sh.mercuryagent.core.VoiceSetup.Trigger?>(null) }
  /**
   * The gate before a call or dictation starts: it works → go; an older Mercury (no voice.providers)
   * or capabilities that can't be read → [legacy] (today's behaviour); otherwise the setup sheet.
   * Only decides what happens before; the call itself is unchanged.
   */
  fun gate(trigger: sh.mercuryagent.core.VoiceSetup.Trigger, go: () -> Unit, legacy: () -> Unit = go) {
    val known = if (trigger == sh.mercuryagent.core.VoiceSetup.Trigger.Dictation) dictation.capabilities else null
    if (known != null && sh.mercuryagent.core.VoiceSetup.available(trigger, known)) { go(); return }
    scope.launch {
      var caps = calls.capabilities(vm.client)
      if (caps != null && sh.mercuryagent.core.VoiceSetup.available(trigger, caps)) { go(); return@launch }
      val supported = sh.mercuryagent.core.VOICE_PROVIDERS_FEATURE in calls.features(vm.client)
      // About to ask for setup: make sure it isn't a stale "no" (a key added on the computer meanwhile).
      if (supported) caps = calls.capabilities(vm.client, refresh = true) ?: caps
      when (sh.mercuryagent.core.VoiceSetup.decide(trigger, supported, caps)) {
        sh.mercuryagent.core.VoiceSetup.Decision.Proceed -> go()
        sh.mercuryagent.core.VoiceSetup.Decision.Legacy -> legacy()
        sh.mercuryagent.core.VoiceSetup.Decision.Setup -> { dictation.notice = null; voiceSetup = trigger }
      }
    }
  }
  val startCall: () -> Unit = {
    dismissKeyboard()
    if (calls.running) beginCall() else gate(sh.mercuryagent.core.VoiceSetup.Trigger.Call, beginCall)
  }
  // Call Mercury from the drawer or the launcher's app shortcut: the same call as the button's.
  val callRequested by container.callRequested.collectAsStateWithLifecycle()
  LaunchedEffect(callRequested) { if (callRequested) { container.callRequested.value = false; startCall() } }
  val dictate: () -> Unit = {
    when {
      dictation.active || dictation.callRunning -> dictation.tap()
      dictation.available -> mic { dictation.tap() }
      // Not known yet, or not available: the gate decides (setup, or today's notice).
      else -> gate(sh.mercuryagent.core.VoiceSetup.Trigger.Dictation, go = { scope.launch { dictation.load(); mic { dictation.tap() } } }, legacy = { dictation.tap() })
    }
  }

  LifecycleResumeEffect(vm) {
    vm.setOnScreen(true)
    onPauseOrDispose { vm.setOnScreen(false) }
  }
  LaunchedEffect(ui.error) { ui.error?.let { vm.dismissError(); snackbar.showSnackbar(it) } }
  // A new chat: ready to type.
  // A new chat opens with the keyboard down (as ChatGPT and Grok do), so the mark, greeting and
  // quick actions are seen; tapping the box brings the keyboard.
  // New content keeps the newest in view while you're at the bottom (the list is reversed).
  val liveSize = ui.live?.items?.size ?: 0
  LaunchedEffect(ui.messages.size, ui.streaming.length / 160, liveSize) {
    if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0)
  }
  val atEnd by remember { derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 200 } }
  val empty = ui.loaded && ui.messages.isEmpty() && !ui.busy

  Scaffold(
    containerColor = MaterialTheme.colorScheme.background,
    topBar = {
      // Grok's bar: round buttons floating over the chat, Ask | Code in the middle, and under it
      // the chat's name (tap: Rename, Save, Delete) with what it's doing, and in Code the project
      // folder the turns work in (as Mercury Desktop's Code view shows it). No surface behind it:
      // the chat scrolls up under the buttons and pill, which carry their own small fills.
      Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.Top,
      ) {
        sh.mercuryagent.ui.chats.RoundButton(Icons.Outlined.DragHandle, "Open chats and settings", onClick = onMenu)
        // The pill (32dp) sits centred on the 48dp buttons.
        Column(Modifier.weight(1f).padding(start = 8.dp, end = 8.dp, top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
          AskCode(composer.code, onPick = { dismissKeyboard(); vm.setCode(it) })
          if (ui.threadId != null) Box {
            Column(
              Modifier.padding(top = 4.dp).clip(RoundedCornerShape(12.dp))
                .combinedClickable(onClickLabel = "Rename, save or delete this chat", role = Role.Button, onClick = { dismissKeyboard(); menu = true })
                .padding(horizontal = 10.dp, vertical = 2.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
            ) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                if (ui.savedAt != null) Icon(Icons.Filled.Bookmark, "Saved", Modifier.size(13.dp).padding(end = 2.dp), tint = Mercury.colors.ink3)
                Text(
                  ui.title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant,
                  style = MaterialTheme.typography.labelLarge, modifier = Modifier.widthIn(max = 200.dp),
                )
                Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(16.dp), tint = Mercury.colors.ink3)
              }
              AnimatedVisibility(ui.titleStatus != null) {
                Text(
                  ui.titleStatus.orEmpty(), style = MaterialTheme.typography.labelSmall,
                  color = if (ui.prompts.isNotEmpty()) Mercury.colors.amber else Mercury.colors.green,
                )
              }
            }
            DropdownMenu(menu, { menu = false }) {
              DropdownMenuItem(text = { Text("Rename") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; renaming = true })
              DropdownMenuItem(
                text = { Text(if (ui.savedAt != null) "Unsave" else "Save") },
                leadingIcon = { Icon(if (ui.savedAt != null) Icons.Outlined.BookmarkRemove else Icons.Outlined.BookmarkBorder, null) },
                onClick = { menu = false; vm.toggleSaved() },
              )
              HorizontalDivider()
              DropdownMenuItem(
                text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
                onClick = { menu = false; deleting = true },
              )
            }
          }
          val folder = composer.workspace?.name
          AnimatedVisibility(composer.code && folder != null) {
            Row(
              Modifier.padding(top = 2.dp).semantics(mergeDescendants = true) { contentDescription = "Code works in ${folder.orEmpty()}" },
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Icon(Icons.Outlined.Folder, null, Modifier.size(14.dp).padding(end = 2.dp), tint = Mercury.colors.ink3)
              Text(
                folder.orEmpty(), style = MaterialTheme.typography.labelSmall, color = Mercury.colors.ink3,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp),
              )
            }
          }
        }
        CallNewChatPill(onCall = startCall, onNewChat = { dismissKeyboard(); onNewChat() })
      }
    },
    bottomBar = {
      Column(Modifier.imePadding().navigationBarsPadding()) {
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          ui.plan?.let { PlanCard(it, ui.busy, ui.threadId) }
          ownerTasks()
          NeedsYouCard(ui.prompts, answer = { p, v -> vm.answer(p, v) })
        }
        Composer(
          vm, ui.busy, ui.stopping, focus, dictation, onDictate = dictate, onCall = startCall,
          voiceKeys = voiceKeys, onVoiceSettings = { dismissKeyboard(); onVoiceSettings() },
        )
      }
    },
    snackbarHost = { SnackbarHost(snackbar) },
  ) { padding ->
    // The chat runs up under the bar (its top padding is the list's content padding, so the first
    // message isn't hidden at rest).
    Box(Modifier.fillMaxSize()) {
      when {
        !ui.loaded -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        // The room between the bar and the composer (which rides the keyboard): the mark and
        // greeting, and the ideas just above the composer, never overlapping.
        empty -> NewChatSpace(
          welcome.pick, welcome.pick?.items.orEmpty().take(2), composer.mediaAvailable, typing = WindowInsets.isImeVisible,
          onMedia = { vm.setMedia(it); runCatching { focus.requestFocus() } },
          onPick = { vm.useSuggestion(it); runCatching { focus.requestFocus() } },
          modifier = Modifier.padding(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding()),
        )
        else -> MessageList(vm, ui, list, PaddingValues(top = padding.calculateTopPadding() + 8.dp, bottom = padding.calculateBottomPadding() + 12.dp))
      }
      AnimatedVisibility(
        !atEnd && ui.messages.isNotEmpty(), enter = scaleIn() + fadeIn(), exit = scaleOut() + fadeOut(),
        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = padding.calculateBottomPadding() + 12.dp),
      ) {
        Surface(
          onClick = { scope.launch { list.animateScrollToItem(0) } }, shape = CircleShape, shadowElevation = 3.dp,
          color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, Mercury.colors.line), modifier = Modifier.size(40.dp),
        ) { Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.KeyboardArrowDown, "Jump to latest") } }
      }
    }
  }

  if (renaming) RenameDialog(ui.title.takeIf { it != "New chat" }.orEmpty(), onDismiss = { renaming = false }) { vm.rename(it); renaming = false }
  if (deleting) AlertDialog(
    onDismissRequest = { deleting = false },
    title = { Text("Delete this chat?") },
    text = { Text("It's deleted on your Mercury too, with its messages. This can't be undone.") },
    confirmButton = { TextButton(onClick = { deleting = false; vm.delete(onDeleted) }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
    dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
  )
  voiceSetup?.let { trigger ->
    sh.mercuryagent.ui.more.VoiceSetupSheet(
      vm.client, calls, trigger,
      onDismiss = { voiceSetup = null },
      onContinue = { next ->
        voiceSetup = null
        when (next) {
          sh.mercuryagent.core.VoiceSetup.Next.StartCall -> beginCall()
          sh.mercuryagent.core.VoiceSetup.Next.StartDictation -> scope.launch { dictation.load(); mic { dictation.tap() } }
          else -> {}
        }
      },
    )
  }
}

/** Call Mercury and New chat side by side in one dark pill, as tall as the round menu button. */
@Composable
private fun CallNewChatPill(onCall: () -> Unit, onNewChat: () -> Unit) {
  Surface(
    shape = RoundedCornerShape(24.dp), modifier = Modifier.height(48.dp),
    color = MaterialTheme.colorScheme.surfaceContainerHigh, contentColor = MaterialTheme.colorScheme.onSurface,
    border = BorderStroke(1.dp, Mercury.colors.line),
  ) {
    Row(Modifier.padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically) {
      IconButton(onClick = onCall) { Icon(Icons.Outlined.Phone, "Call Mercury", Modifier.size(22.dp)) }
      IconButton(onClick = onNewChat) { Icon(Icons.Outlined.EditNote, "New chat", Modifier.size(22.dp)) }
    }
  }
}

private sealed interface RowItem {
  val key: String
  data class Day(val label: String, override val key: String) : RowItem
  data class Msg(val m: ChatMessage) : RowItem { override val key get() = m.id }
  data object Live : RowItem { override val key = "live" }
  data object Media : RowItem { override val key = "pending-media" }
  data class Note(val n: Notice) : RowItem { override val key = "notice" }
}

@Composable
private fun MessageList(vm: ConversationViewModel, ui: ConversationState, list: LazyListState, padding: PaddingValues) {
  val days = remember(ui.messages) { DaySeparators.make(ui.messages) }
  val rows = buildList {
    ui.messages.forEach { m -> days[m.id]?.let { add(RowItem.Day(it, "day:${m.id}")) }; add(RowItem.Msg(m)) }
    if (ui.live != null && ui.busy) add(RowItem.Live)
    if (ui.pendingMedia.isNotEmpty()) add(RowItem.Media)
    ui.notice?.let { add(RowItem.Note(it)) }
  }.asReversed()
  LazyColumn(state = list, reverseLayout = true, contentPadding = padding, modifier = Modifier.fillMaxSize()) {
    items(rows.size, key = { rows[it].key }, contentType = { rows[it]::class }) { i ->
      val mod = Modifier.padding(horizontal = 16.dp, vertical = 9.dp).animateItem()
      when (val r = rows[i]) {
        is RowItem.Day -> DaySeparator(r.label, mod)
        is RowItem.Msg -> MessageRow(r.m, ui.traces[r.m.id], onEdit = vm::edit, onError = vm::showError, modifier = mod)
        RowItem.Live -> ui.live?.let { LiveTurn(ui, it, mod) }
        RowItem.Media -> PendingMediaList(ui, mod)
        is RowItem.Note -> NoticeRow(r.n, onDismiss = vm::dismissNotice, modifier = mod)
      }
    }
  }
}

/** The turn that's running: its timeline, then the one status line, ticking every second. */
@Composable
private fun LiveTurn(ui: ConversationState, trace: TurnTrace, modifier: Modifier) {
  val now = rememberNow()
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    TurnTimeline(trace, live = true, now = now)
    LiveStatusLine(trace, ui.agent, ui.stopping, ui.prompts.isNotEmpty(), ui.queued, now)
  }
}

/** Videos and songs being made in the background: their placeholders until they arrive. */
@Composable
private fun PendingMediaList(ui: ConversationState, modifier: Modifier) {
  val now = rememberNow()
  Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    ui.pendingMedia.forEach { j ->
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        MediaPlaceholder(TurnTrace.MediaShape(j.kind, j.aspect, prompt = j.prompt), j.startedAt?.let(TurnTrace::date) ?: now, now)
        Text("It will appear here when it's ready. You can keep chatting.", style = MaterialTheme.typography.labelSmall, color = Mercury.colors.ink4)
      }
    }
  }
}

/** Between messages from different days: "Yesterday", "Mon 3 Nov". */
@Composable
private fun DaySeparator(label: String, modifier: Modifier) {
  Row(modifier.fillMaxWidth().semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.CenterVertically) {
    HorizontalDivider(Modifier.weight(1f), color = Mercury.colors.line)
    Text(label, style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3, modifier = Modifier.padding(horizontal = 10.dp))
    HorizontalDivider(Modifier.weight(1f), color = Mercury.colors.line)
  }
}

@Composable
private fun NoticeRow(n: Notice, onDismiss: () -> Unit, modifier: Modifier) {
  Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    Icon(if (n.warning) Icons.Outlined.WarningAmber else Icons.Outlined.Info, null, Modifier.size(16.dp), tint = if (n.warning) Mercury.colors.amber else Mercury.colors.ink3)
    Text(n.text, style = MaterialTheme.typography.bodySmall, color = if (n.warning) Mercury.colors.amber else Mercury.colors.ink3, modifier = Modifier.weight(1f))
    TextButton(onClick = onDismiss) { Text("Dismiss", color = Mercury.colors.ink3) }
  }
}

/** A message that was only files: the files say it, not "(Attached: …)". */
fun isAttachedOnly(m: ChatMessage) = m.attachments.isNotEmpty() && m.content.startsWith("(Attached: ")

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(m: ChatMessage, trace: TurnTrace?, onEdit: (String) -> Unit, onError: (String) -> Unit, modifier: Modifier) {
  val clipboard = LocalClipboardManager.current
  val haptics = LocalHapticFeedback.current
  when (m.role) {
    "user" -> Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
      if (m.attachments.isNotEmpty()) SentAttachments(m.attachments)
      if (!isAttachedOnly(m)) Box {
        var menu by remember { mutableStateOf(false) }
        // A long press copies or edits it (Android's menu replaces text selection here).
        Text(
          m.content, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface,
          modifier = Modifier.widthIn(max = 320.dp).clip(RoundedCornerShape(22.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .combinedClickable(onClick = {}, onLongClickLabel = "Copy or edit", onLongClick = {
              haptics.performHapticFeedback(HapticFeedbackType.LongPress); menu = true
            })
            .padding(horizontal = 16.dp, vertical = 10.dp),
        )
        DropdownMenu(menu, { menu = false }) {
          DropdownMenuItem(text = { Text("Copy") }, leadingIcon = { Icon(Icons.Outlined.ContentCopy, null) },
            onClick = { menu = false; clipboard.setText(AnnotatedString(m.content)) })
          DropdownMenuItem(text = { Text("Edit") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) },
            onClick = { menu = false; onEdit(m.content) })
        }
      }
    }
    "system" -> if (TurnTrace.isSecurity(m.content)) SecurityNotice(m.content, modifier) else Row(
      modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerLow).padding(12.dp),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Icon(Icons.Outlined.WarningAmber, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
      Text(m.content, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    else -> Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      trace?.let { t ->
        t.securityNotes.forEach { SecurityNotice(it) }
        ThoughtProcess(t)
      }
      if (m.content.isNotEmpty()) SelectionContainer { MarkdownText(m.content) }
      if (m.stopped == true) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Icons.Outlined.StopCircle, null, Modifier.size(16.dp), tint = Mercury.colors.ink3)
        Text("Stopped", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
      }
      if (m.artifacts.isNotEmpty()) ReplyMedia(m.artifacts, fresh = Reveal.isFresh(m), onError = onError)
      if (m.content.isNotBlank()) ReplyActions(m)
    }
  }
}

/** Under a finished reply: copy it, share it, and what it cost (a bottom sheet). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReplyActions(m: ChatMessage) {
  val clipboard = LocalClipboardManager.current
  val haptics = LocalHapticFeedback.current
  val context = LocalContext.current
  var copied by remember { mutableStateOf(false) }
  var info by remember { mutableStateOf(false) }
  LaunchedEffect(copied) { if (copied) { delay(1600); copied = false } }
  val tint = Mercury.colors.ink3
  // IconButtons carry 12dp of padding: the row moves left so its icons line up with the text.
  Row(Modifier.height(40.dp).offset(x = (-12).dp), verticalAlignment = Alignment.CenterVertically) {
    IconButton(onClick = {
      clipboard.setText(AnnotatedString(m.content)); copied = true
      haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
    }) {
      Icon(if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy, if (copied) "Copied" else "Copy", Modifier.size(18.dp), tint = tint)
    }
    IconButton(onClick = {
      val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, m.content)
      context.startActivity(Intent.createChooser(send, null))
    }) { Icon(Icons.Outlined.Share, "Share", Modifier.size(18.dp), tint = tint) }
    m.usage?.let { u ->
      IconButton(onClick = { info = true }) { Icon(Icons.Outlined.Info, "Details", Modifier.size(18.dp), tint = tint) }
      if (info) ModalBottomSheet(onDismissRequest = { info = false }) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 24.dp, end = 24.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text("This reply", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
          Text(u.short, style = MaterialTheme.typography.bodyLarge)
          u.detail.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
          Text(
            java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM)
              .format(m.timestamp.atZone(java.time.ZoneId.systemDefault())),
            style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
          )
        }
      }
    }
    if (copied) Text("Copied", style = MaterialTheme.typography.labelMedium, color = tint)
  }
}

