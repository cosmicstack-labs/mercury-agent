package sh.mercuryagent.ui.chats

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bookmark

import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.BookmarkRemove
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardDoubleArrowRight
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.core.ChatThread
import sh.mercuryagent.core.Connection
import sh.mercuryagent.ui.components.MercuryLogo
import sh.mercuryagent.ui.connect.MercurySwitcherSheet
import sh.mercuryagent.ui.components.StatusDot
import sh.mercuryagent.ui.theme.Mercury

/**
 * The left drawer, laid out like Grok's: at the top the connected Mercury, its logo and friendly name
 * (tap: the switcher, to switch, rename, pick a logo or add another) and a » button that closes the
 * drawer; Call Mercury, Bots, Artifacts, Brain (the mind map) and Saved; "Conversations" (or "Results",
 * or "Saved") over the chats, newest first, each row the title alone, with small day labels between
 * them ("Today", "3 days ago", "October"). All of it is one scrolling list; pinned at the bottom over a fade, Settings, Search (filters live on titles and messages) and a
 * white New chat button. Better than Grok, quietly: a dot before a title only when the chat works
 * (green, pulsing), needs you (amber) or failed (red); unread titles semibold with a dot at the end;
 * matches emphasised; swipe left to delete (Undo in the drawer); long-press for Rename, Save, Delete.
 */
@OptIn(ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ChatDrawer(
  vm: ChatsViewModel,
  connection: Connection,
  connections: List<Connection>,
  online: Boolean?,
  currentChat: String?,
  onOpen: (ChatThread) -> Unit,
  onNewChat: () -> Unit,
  /** Call Mercury: closes the drawer and starts a voice call in the chat on screen. */
  onCall: () -> Unit,
  onBots: () -> Unit,
  onArtifacts: () -> Unit,
  /** Brain: the second brain's mind map. */
  onBrain: () -> Unit,
  onSettings: () -> Unit,
  onClose: () -> Unit,
  onSwitchMercury: (String) -> Unit,
  onAddMercury: () -> Unit,
  /** Edit in the switcher: a new friendly name and logo for a Mercury. */
  onEditMercury: (id: String, name: String, logo: String) -> Unit,
) {
  val ui by vm.ui.collectAsStateWithLifecycle()
  val history by vm.history.collectAsStateWithLifecycle()
  var renaming by remember { mutableStateOf<ChatThread?>(null) }
  var switching by remember { mutableStateOf(false) }
  val list = rememberLazyListState()
  val focus = LocalFocusManager.current
  val bg = MaterialTheme.colorScheme.background

  Box(Modifier.fillMaxSize().background(bg).statusBarsPadding().navigationBarsPadding()) {
    // One list from the top of the drawer to the last chat (Grok's drawer scrolls as a whole): the
    // Mercury, the nav rows and the labels are items too; only the bottom bar stays put. Chats are
    // lazy rows with stable keys, so 590 of them scroll smoothly.
    PullToRefreshBox(ui.refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
      val failed = ui.error != null
      LazyColumn(state = list, contentPadding = PaddingValues(bottom = 96.dp), modifier = Modifier.fillMaxSize()) {
        item(key = "header", contentType = "header") { Header(connection, online, onClose) { switching = true } }
        item(key = "nav", contentType = "nav") {
          Column {
            NavRow(Icons.Outlined.Phone, "Call Mercury", onClick = onCall)
            NavRow(Icons.Outlined.SmartToy, "Bots", onClick = onBots)
            NavRow(Icons.Outlined.FolderOpen, "Artifacts", onClick = onArtifacts)
            NavRow(Icons.Outlined.Psychology, "Brain", onClick = onBrain)
            NavRow(
              if (ui.savedOnly) Icons.Filled.Bookmark else Icons.Outlined.BookmarkBorder, "Saved", selected = ui.savedOnly,
              onClick = { vm.setSavedOnly(!ui.savedOnly) },
            )
          }
        }
        item(key = "label", contentType = "label") {
          Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, top = 18.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              history.label, style = MaterialTheme.typography.labelLarge, color = Mercury.colors.ink3,
              modifier = Modifier.weight(1f).semantics { heading() },
            )
            if (ui.anyUnread && history.query.isEmpty()) Icon(
              Icons.Outlined.DoneAll, "Mark all as read", tint = Mercury.colors.ink3,
              modifier = Modifier.clip(CircleShape).clickable(onClick = vm::markAllRead).padding(8.dp).size(18.dp),
            )
          }
        }
        // A list that couldn't load says so, with Retry: never a silent empty drawer.
        when {
          !ui.loaded && ui.threads.isEmpty() -> item(key = "loading", contentType = "loading") {
            Box(Modifier.fillMaxWidth().height(120.dp), Alignment.Center) {
              CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = Mercury.colors.ink3)
            }
          }
          failed && ui.threads.isEmpty() -> item(key = "load-error", contentType = "error") { LoadError(ui.error.orEmpty(), vm::refresh) }
          else -> {
            if (failed) item(key = "error", contentType = "error") { InlineError(ui.error.orEmpty(), vm::refresh) }
            for (section in history.sections) {
              section.title?.let { title -> item(key = "day:$title", contentType = "day") { DayLabel(title) } }
              items(section.threads, key = { it.id }, contentType = { "row" }) { t ->
                HistoryRow(
                  t, RowLook.of(ui.status[t.id], ui.isUnread(t)), history.query, selected = t.id == currentChat,
                  onOpen = { focus.clearFocus(); onOpen(t) }, onSave = { vm.toggleSaved(t) }, onRename = { renaming = t },
                  onDelete = { vm.delete(t) }, modifier = Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null),
                )
              }
            }
            if (ui.loaded && history.isEmpty) item(key = "none", contentType = "empty") {
              Text(
                when { history.query.isNotEmpty() -> "No chats match “${history.query}”."; ui.savedOnly -> "No saved chats yet. Long-press a chat to save it."; else -> "No chats yet. Ask Mercury anything." },
                color = Mercury.colors.ink3, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
              )
            }
          }
        }
      }
    }

    // Pinned at the bottom, over the list's end: Undo, then Settings, Search, New chat.
    Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
      Box(Modifier.fillMaxWidth().height(28.dp).background(Brush.verticalGradient(listOf(Color.Transparent, bg))))
      Column(Modifier.fillMaxWidth().background(bg)) {
        UndoBar(ui.deleted.lastOrNull(), vm::undoDelete)
        Row(
          Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp),
          verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          RoundButton(Icons.Outlined.Settings, "Settings", onClick = onSettings)
          SearchField(ui.query, vm::setQuery, onDone = { focus.clearFocus() }, modifier = Modifier.weight(1f))
          RoundButton(Icons.Outlined.EditNote, "New chat", filled = true, onClick = onNewChat)
        }
      }
    }
  }

  if (switching) MercurySwitcherSheet(
    connections, connection.id, onSwitch = onSwitchMercury, onEdit = onEditMercury, onAdd = onAddMercury, onDismiss = { switching = false },
  )
  renaming?.let { t ->
    RenameDialog(t.displayTitle.takeIf { it != "New chat" }.orEmpty(), onDismiss = { renaming = null }) { vm.rename(t, it); renaming = null }
  }
}

/** The connected Mercury, its logo and friendly name (tap: the switcher), and » to close the drawer. */
@Composable
private fun Header(connection: Connection, online: Boolean?, onClose: () -> Unit, onSwitcher: () -> Unit) {
  Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
    Row(
      Modifier.weight(1f).clip(RoundedCornerShape(16.dp)).clickable(onClickLabel = "Switch Mercury, rename it, or add another", onClick = onSwitcher).padding(6.dp),
      verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      MercuryLogo(connection.logoId, 44.dp)
      Column(Modifier.weight(1f, fill = false)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(
            connection.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
          )
          Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(18.dp), tint = Mercury.colors.ink3)
        }
        Text(
          when (online) { true -> "Online"; false -> "Offline"; null -> "Connecting…" },
          style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
        )
      }
    }
    Spacer(Modifier.width(8.dp))
    RoundButton(Icons.Outlined.KeyboardDoubleArrowRight, "Close chats", onClick = onClose)
  }
}

/** A small muted label over a day's chats: "Today", "3 days ago", "October". */
@Composable
private fun DayLabel(title: String) {
  Text(
    title, style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3,
    modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 14.dp, bottom = 4.dp).semantics { heading() },
  )
}

/** A 48dp round button: dark grey with a hairline, or [filled] ink (white on dark) for the main action. */
@Composable
fun RoundButton(icon: ImageVector, label: String, filled: Boolean = false, size: Dp = 48.dp, onClick: () -> Unit) {
  val scheme = MaterialTheme.colorScheme
  Surface(
    onClick = onClick, shape = CircleShape, modifier = Modifier.size(size),
    color = if (filled) scheme.primary else scheme.surfaceContainerHigh,
    contentColor = if (filled) scheme.onPrimary else scheme.onSurface,
    border = if (filled) null else BorderStroke(1.dp, Mercury.colors.line),
  ) { Box(contentAlignment = Alignment.Center) { Icon(icon, label, Modifier.size(22.dp)) } }
}

@Composable
private fun SearchField(query: String, onChange: (String) -> Unit, onDone: () -> Unit, modifier: Modifier) {
  val c = MaterialTheme.colorScheme
  Row(
    modifier.height(48.dp).clip(RoundedCornerShape(24.dp)).background(c.surfaceContainerHigh).padding(start = 16.dp, end = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(Icons.Outlined.Search, null, Modifier.size(20.dp), tint = Mercury.colors.ink3)
    Box(Modifier.weight(1f).padding(horizontal = 10.dp)) {
      if (query.isEmpty()) Text("Search", style = MaterialTheme.typography.bodyLarge, color = Mercury.colors.ink3)
      BasicTextField(
        query, onChange, singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.onSurface), cursorBrush = SolidColor(c.onSurface),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { onDone() }),
        modifier = Modifier.fillMaxWidth(),
      )
    }
    if (query.isNotEmpty()) Icon(
      Icons.Outlined.Close, "Clear search", tint = Mercury.colors.ink3,
      modifier = Modifier.clip(CircleShape).clickable { onChange("") }.padding(8.dp).size(18.dp),
    )
  }
}

/** Bots, Artifacts, Saved: a large icon and label, no background (a soft one while Saved filters). */
@Composable
private fun NavRow(icon: ImageVector, label: String, selected: Boolean = false, onClick: () -> Unit) {
  Row(
    Modifier.fillMaxWidth().padding(horizontal = 10.dp).clip(RoundedCornerShape(16.dp))
      .background(if (selected) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent)
      .clickable(onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 14.dp),
    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Icon(icon, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.onSurface)
    Text(label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Normal)
  }
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun HistoryRow(
  t: ChatThread, look: RowLook, query: String, selected: Boolean,
  onOpen: () -> Unit, onSave: () -> Unit, onRename: () -> Unit, onDelete: () -> Unit, modifier: Modifier,
) {
  var menu by remember { mutableStateOf(false) }
  val haptics = LocalHapticFeedback.current
  val saved = t.savedAt != null
  val swipe = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
    if (v == SwipeToDismissBoxValue.EndToStart) { haptics.performHapticFeedback(HapticFeedbackType.LongPress); onDelete() }
    false
  })
  val bg = MaterialTheme.colorScheme.background
  SwipeToDismissBox(
    swipe, enableDismissFromStartToEnd = false, modifier = modifier.padding(horizontal = 10.dp),
    backgroundContent = {
      Box(
        Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest).padding(end = 20.dp),
        Alignment.CenterEnd,
      ) { Icon(Icons.Outlined.Delete, "Delete", tint = MaterialTheme.colorScheme.onSurfaceVariant) }
    },
  ) {
    Box {
      Box(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
          .background(if (selected) MaterialTheme.colorScheme.surfaceContainerHigh else bg)
          .combinedClickable(
            onClick = onOpen, onLongClickLabel = "Chat actions",
            onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); menu = true },
          ),
      ) { HistoryLine(t, look, query) }
      DropdownMenu(menu, { menu = false }) {
        DropdownMenuItem(text = { Text("Rename") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; onRename() })
        DropdownMenuItem(
          text = { Text(if (saved) "Unsave" else "Save") },
          leadingIcon = { Icon(if (saved) Icons.Outlined.BookmarkRemove else Icons.Outlined.BookmarkBorder, null) },
          onClick = { menu = false; onSave() },
        )
        HorizontalDivider()
        DropdownMenuItem(
          text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
          leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
          onClick = { menu = false; onDelete() },
        )
      }
    }
  }
}

/** One line: the title (matches emphasised), a status dot before it, an unread dot after it. */
@Composable
fun HistoryLine(t: ChatThread, look: RowLook, query: String = "", modifier: Modifier = Modifier) {
  val c = Mercury.colors
  val ink = MaterialTheme.colorScheme.onSurface
  val title = remember(t.displayTitle, query, ink) { emphasise(t.displayTitle, query, ink) }
  Row(
    modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 14.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    look.marker?.let { m ->
      StatusDot(
        when (m) { RowMarker.Working -> c.green; RowMarker.NeedsYou -> c.amber; RowMarker.Failed -> c.red; RowMarker.Waiting -> c.ink3 },
        running = m == RowMarker.Working, hollow = m == RowMarker.Waiting, size = 8.dp,
      )
      Spacer(Modifier.width(10.dp))
    }
    Text(
      title, style = MaterialTheme.typography.bodyLarge, color = ink,
      fontWeight = if (look.unread) FontWeight.SemiBold else FontWeight.Normal,
      maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
    )
    if (look.unread) {
      Spacer(Modifier.width(10.dp))
      StatusDot(ink, size = 7.dp)
    }
  }
}

/** The matched parts in semibold with a faint wash; the rest as it is. */
private fun emphasise(text: String, query: String, ink: Color): AnnotatedString {
  val ranges = ChatSearch.ranges(text, query)
  if (ranges.isEmpty()) return AnnotatedString(text)
  return buildAnnotatedString {
    append(text)
    for (r in ranges) addStyle(SpanStyle(fontWeight = FontWeight.SemiBold, background = ink.copy(alpha = 0.12f)), r.first, r.last + 1)
  }
}

@Composable
private fun LoadError(message: String, onRetry: () -> Unit) {
  Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Text("Couldn't load your chats", style = MaterialTheme.typography.titleSmall)
    Text(message, style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.ink3)
    OutlinedButton(onClick = onRetry) { Text("Retry") }
  }
}

@Composable
private fun InlineError(message: String, onRetry: () -> Unit) {
  Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(
      "Couldn't refresh: $message", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
      maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
    )
    TextButton(onClick = onRetry) { Text("Retry") }
  }
}

/** "Deleted “…” · Undo" for the few seconds before Mercury deletes it. */
@Composable
private fun UndoBar(t: ChatThread?, onUndo: (ChatThread) -> Unit) {
  var last by remember { mutableStateOf<ChatThread?>(null) }
  if (t != null) last = t
  AnimatedVisibility(t != null, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
    val shown = last ?: return@AnimatedVisibility
    Row(
      Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(14.dp))
        .background(MaterialTheme.colorScheme.inverseSurface).padding(start = 16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        "Deleted “${shown.displayTitle}”", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.inverseOnSurface,
        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
      )
      TextButton(onClick = { onUndo(shown) }) { Text("Undo", color = MaterialTheme.colorScheme.inverseOnSurface, fontWeight = FontWeight.SemiBold) }
    }
  }
}
