package sh.mercuryagent.ui.artifacts

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.ViewList
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ArtifactFormat
import sh.mercuryagent.core.ArtifactGroup
import sh.mercuryagent.core.ArtifactItem
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.artifactFileUrl
import sh.mercuryagent.ui.components.EmptyState
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.conversation.RemoteImage
import sh.mercuryagent.ui.conversation.artifactIcon
import sh.mercuryagent.ui.media.LocalMediaLoader
import sh.mercuryagent.ui.media.MediaItem
import sh.mercuryagent.ui.media.MediaViewer
import sh.mercuryagent.ui.theme.Mercury
import androidx.compose.foundation.lazy.grid.items as gridItems

/** Pictures in cards and rows: small, so a page of them stays light. */
private const val THUMB_SIDE = 400

private data class ViewerRequest(val items: List<MediaItem>, val start: Int)

/**
 * Everything Mercury made, across every conversation (iOS: ArtifactsView): kind filters with
 * counts, search, a grid of cards or a list, batches as mosaics, the full-screen viewer for
 * pictures, videos and sounds (with delete), other files opened in another app, share, delete one
 * or select many, the chat each came from, and Clean up.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtifactsScreen(vm: ArtifactsViewModel, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
  val ui by vm.ui.collectAsStateWithLifecycle()
  val loader = LocalMediaLoader.current
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val snackbar = remember { SnackbarHostState() }
  var searching by rememberSaveable { mutableStateOf(ui.query.isNotEmpty()) }
  var opening by remember { mutableStateOf<String?>(null) }
  var viewing by remember { mutableStateOf<ViewerRequest?>(null) }
  var actionsFor by remember { mutableStateOf<ArtifactGroup?>(null) }
  var confirmDelete by remember { mutableStateOf<ArtifactGroup?>(null) }
  var confirmPicked by remember { mutableStateOf(false) }
  var cleaningUp by rememberSaveable { mutableStateOf(false) }

  LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }

  BackHandler(enabled = ui.picking || searching) {
    if (ui.picking) vm.stopPicking() else { searching = false; vm.setQuery("") }
  }

  /** Downloads [a] (once; it's cached) and hands it to [then]; says why when it can't. */
  fun withFile(a: ArtifactItem, then: (java.io.File) -> String?) {
    val l = loader ?: return
    if (opening != null) return
    opening = a.id
    scope.launch {
      val problem = try {
        then(l.file(vm.client.artifactFileUrl(a.id), a.name.ifEmpty { null }))
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        e.message ?: "Couldn't download it."
      } finally {
        opening = null
      }
      problem?.let { snackbar.showSnackbar(it) }
    }
  }

  fun open(g: ArtifactGroup, at: Int = 0) {
    if (g.items.all { it.isMedia }) {
      viewing = ViewerRequest(g.items.map { it.mediaItem(vm.client) }, at)
      return
    }
    val a = g.items[at]
    withFile(a) { f -> loader?.open(context, f, a.mime) }
  }

  fun share(a: ArtifactItem) = withFile(a) { f -> loader?.share(context, f, a.mime); null }

  fun tap(g: ArtifactGroup) { if (ui.picking) vm.toggle(g) else open(g) }
  fun longPress(g: ArtifactGroup) { if (ui.picking) vm.toggle(g) else actionsFor = g }

  Scaffold(
    topBar = {
      when {
        ui.picking -> TopAppBar(
          title = {
            Text(
              if (ui.picked.isEmpty()) "Select artifacts" else "${ui.pickedCards} selected · ${ArtifactFormat.bytes(ui.pickedBytes)}",
              maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
          },
          navigationIcon = { IconButton(onClick = { vm.stopPicking() }) { Icon(Icons.Outlined.Close, "Done selecting") } },
          actions = {
            TextButton(onClick = { vm.selectAllOrClear() }, enabled = ui.items.isNotEmpty()) {
              Text(if (ui.picked.isEmpty()) "Select all" else "Clear")
            }
          },
        )
        searching -> SearchBarTop(
          query = ui.query, onQuery = vm::setQuery, onSearch = vm::search,
          onClose = { searching = false; vm.setQuery("") },
        )
        else -> TopAppBar(
          title = { Text("Artifacts") },
          navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
          actions = {
            IconButton(onClick = { searching = true }) { Icon(Icons.Outlined.Search, "Search artifacts") }
            IconButton(onClick = { vm.setListMode(!ui.listMode) }) {
              if (ui.listMode) Icon(Icons.Outlined.GridView, "Show as grid") else Icon(Icons.AutoMirrored.Outlined.ViewList, "Show as list")
            }
            OverflowMenu(
              storage = ui.usage?.let { "Storage · ${ArtifactFormat.bytes(it.bytes)}" },
              canSelect = ui.items.isNotEmpty(),
              onSelect = { vm.startPicking() },
              onCleanUp = { vm.openCleanup(); cleaningUp = true },
            )
          },
        )
      }
    },
    bottomBar = {
      if (ui.picking) PickBar(
        text = if (ui.picked.isEmpty()) "Select artifacts to delete" else "${ui.pickedCards} selected · ${ArtifactFormat.bytes(ui.pickedBytes)}",
        enabled = ui.picked.isNotEmpty() && !ui.deleting, busy = ui.deleting, onDelete = { confirmPicked = true },
      )
    },
    snackbarHost = { SnackbarHost(snackbar) },
  ) { padding ->
    Column(Modifier.fillMaxSize().padding(padding)) {
      KindFilters(ui, onPick = vm::setKind)
      ui.error?.let { ErrorText(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
      PullToRefreshBox(ui.refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.weight(1f).fillMaxWidth()) {
        when {
          !ui.loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
          ui.items.isEmpty() && ui.error == null -> LazyColumn(Modifier.fillMaxSize()) {
            item(key = "empty") {
              EmptyState(
                title = if (ui.isFiltered) "Nothing matches" else "Nothing made yet",
                body = "Images, PDFs and reports Mercury makes show up here.",
                modifier = Modifier.fillParentMaxSize(),
              )
            }
          }
          ui.listMode -> ArtifactList(ui, vm.client, opening, onTap = { tap(it) }, onMore = { longPress(it) }, onEnd = { vm.more() })
          else -> ArtifactGrid(ui, vm.client, opening, onTap = { tap(it) }, onLongPress = { longPress(it) }, onEnd = { vm.more() })
        }
      }
    }
  }

  actionsFor?.let { g ->
    ArtifactActions(
      group = g,
      onDismiss = { actionsFor = null },
      onOpen = { open(g) },
      onShare = if (g.isBatch) null else ({ share(g.lead) }),
      onChat = g.lead.threadId?.takeIf { it.isNotEmpty() }?.let { id -> { onOpenChat(id) } },
      onSelect = { vm.startPicking(g) },
      onDelete = { confirmDelete = g },
    )
  }

  confirmDelete?.let { g ->
    val remove = g.lead.keepsOriginal && !g.isBatch
    AlertDialog(
      onDismissRequest = { confirmDelete = null },
      title = { Text(if (g.isBatch) "Delete ${ArtifactFormat.batchLabel(g.items)}?" else ArtifactFormat.deleteTitle(g.lead)) },
      text = { Text(ArtifactFormat.deleteDetail(g.items)) },
      confirmButton = {
        TextButton(onClick = { confirmDelete = null; vm.delete(g.ids) }) {
          Text(if (remove) "Remove from Mercury" else "Delete", color = MaterialTheme.colorScheme.error)
        }
      },
      dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
    )
  }

  if (confirmPicked) AlertDialog(
    onDismissRequest = { confirmPicked = false },
    title = { Text("Delete ${ui.pickedCards}?") },
    text = { Text(ArtifactFormat.deleteDetail(ui.pickedItems) + " " + ArtifactFormat.bytes(ui.pickedBytes) + " in all.") },
    confirmButton = {
      TextButton(onClick = { confirmPicked = false; vm.delete(ui.picked.toList()) }) {
        Text("Delete", color = MaterialTheme.colorScheme.error)
      }
    },
    dismissButton = { TextButton(onClick = { confirmPicked = false }) { Text("Cancel") } },
  )

  if (cleaningUp) ArtifactCleanupSheet(
    ui = ui, onDismiss = { cleaningUp = false }, onAge = vm::setAge, onRun = vm::runCleanup,
  )

  viewing?.let { v ->
    key(v) {
      MediaViewer(
        items = v.items, start = v.start,
        onDismiss = { viewing = null },
        onDelete = { m -> vm.deleteOne(m.id) },
        deleteMessage = { m -> ui.items.firstOrNull { it.id == m.id }?.let { a -> ArtifactFormat.deleteDetail(a) } ?: "Deletes the file." },
      )
    }
  }
}

// MARK: Top bar pieces

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchBarTop(query: String, onQuery: (String) -> Unit, onSearch: () -> Unit, onClose: () -> Unit) {
  val focus = remember { FocusRequester() }
  val keyboard = LocalSoftwareKeyboardController.current
  LaunchedEffect(Unit) { focus.requestFocus() }
  TopAppBar(
    navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Close search") } },
    title = {
      TextField(
        value = query, onValueChange = onQuery, singleLine = true,
        placeholder = { Text("Search by name") },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch(); keyboard?.hide() }),
        trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { onQuery("") }) { Icon(Icons.Outlined.Close, "Clear search") } },
        colors = TextFieldDefaults.colors(
          focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
          focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
        ),
        modifier = Modifier.fillMaxWidth().focusRequester(focus),
      )
    },
  )
}

@Composable
private fun OverflowMenu(storage: String?, canSelect: Boolean, onSelect: () -> Unit, onCleanUp: () -> Unit) {
  var open by remember { mutableStateOf(false) }
  Box {
    IconButton(onClick = { open = true }) { Icon(Icons.Outlined.MoreVert, "More: storage and clean up") }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      if (storage != null) {
        DropdownMenuItem(
          text = { Text(storage) }, onClick = {}, enabled = false,
          leadingIcon = { Icon(Icons.Outlined.Storage, null) },
        )
        HorizontalDivider(color = Mercury.colors.line)
      }
      DropdownMenuItem(
        text = { Text("Select…") }, onClick = { open = false; onSelect() }, enabled = canSelect,
        leadingIcon = { Icon(Icons.Outlined.CheckCircle, null) },
      )
      DropdownMenuItem(
        text = { Text("Clean up…") }, onClick = { open = false; onCleanUp() },
        leadingIcon = { Icon(Icons.Outlined.CleaningServices, null) },
      )
    }
  }
}

/** Select mode's bar: how many are ticked and their size, and Delete. */
@Composable
private fun PickBar(text: String, enabled: Boolean, busy: Boolean, onDelete: () -> Unit) {
  Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
    Row(
      Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 2)
      Button(
        onClick = onDelete, enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
      ) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
        else Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Delete")
      }
    }
  }
}

/** Same tabs as Mercury Desktop, each with its count; a kind shows once there is something in it. */
@Composable
private fun KindFilters(ui: ArtifactsUi, onPick: (String) -> Unit) {
  LazyRow(
    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    modifier = Modifier.fillMaxWidth(),
  ) {
    items(ui.shownKinds, key = { it.value }) { k ->
      val n = ui.counts[k.value]
      FilterChip(
        selected = ui.kind == k.value,
        onClick = { onPick(k.value) },
        label = {
          Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(k.label)
            if (n != null) Text("$n", style = MaterialTheme.typography.labelSmall, color = LocalContentColor.current.copy(alpha = 0.6f))
          }
        },
        modifier = Modifier.semantics { contentDescription = if (n != null) "${k.label}, $n" else k.label },
      )
    }
  }
}

// MARK: Grid and list

@Composable
private fun ArtifactGrid(
  ui: ArtifactsUi, client: MercuryClient, opening: String?,
  onTap: (ArtifactGroup) -> Unit, onLongPress: (ArtifactGroup) -> Unit, onEnd: () -> Unit,
) {
  val state = rememberLazyGridState()
  val nearEnd by remember(state) {
    derivedStateOf {
      val info = state.layoutInfo
      val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
      info.totalItemsCount > 0 && last >= info.totalItemsCount - 6
    }
  }
  LaunchedEffect(nearEnd, ui.next, ui.groups.size) { if (nearEnd && ui.next != null) onEnd() }
  LazyVerticalGrid(
    columns = GridCells.Adaptive(minSize = 160.dp),
    state = state,
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    gridItems(ui.groups, key = { it.id }) { g ->
      ArtifactTile(
        group = g, client = client, opening = g.items.any { it.id == opening },
        picking = ui.picking, picked = ui.isPicked(g),
        onClick = { onTap(g) }, onLongClick = { onLongPress(g) },
      )
    }
    if (ui.loadingMore) item(key = "more", span = { GridItemSpan(maxLineSpan) }) { MoreSpinner() }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ArtifactList(
  ui: ArtifactsUi, client: MercuryClient, opening: String?,
  onTap: (ArtifactGroup) -> Unit, onMore: (ArtifactGroup) -> Unit, onEnd: () -> Unit,
) {
  val state = rememberLazyListState()
  val nearEnd by remember(state) {
    derivedStateOf {
      val info = state.layoutInfo
      val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
      info.totalItemsCount > 0 && last >= info.totalItemsCount - 6
    }
  }
  LaunchedEffect(nearEnd, ui.next, ui.groups.size) { if (nearEnd && ui.next != null) onEnd() }
  LazyColumn(state = state, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 4.dp, bottom = 24.dp)) {
    items(ui.groups, key = { it.id }) { g ->
      val picked = ui.isPicked(g)
      val title = g.cardTitle
      ListItem(
        headlineContent = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
          Column {
            Text(g.cardCaption, maxLines = 1, overflow = TextOverflow.Ellipsis)
            g.lead.threadTitle?.takeIf { it.isNotEmpty() }?.let {
              Text(it, color = Mercury.colors.ink4, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
          }
        },
        leadingContent = {
          Box(Modifier.size(56.dp).clip(RoundedCornerShape(10.dp))) {
            if (g.isBatch) ArtifactMosaic(g.items, client, Modifier.fillMaxSize())
            else ArtifactThumb(g.lead, client, Modifier.fillMaxSize(), compact = true)
            if (g.items.any { it.id == opening }) CircularProgressIndicator(Modifier.align(Alignment.Center).size(22.dp), strokeWidth = 2.dp)
          }
        },
        trailingContent = {
          if (ui.picking) Checkbox(checked = picked, onCheckedChange = null)
          else IconButton(onClick = { onMore(g) }) { Icon(Icons.Outlined.MoreVert, "More actions for $title") }
        },
        colors = ListItemDefaults.colors(containerColor = if (picked) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent),
        modifier = Modifier
          .combinedClickable(
            onClickLabel = when {
              ui.picking -> if (picked) "Unselect" else "Select"
              g.isBatch -> "Step through them full screen"
              else -> "Open"
            },
            onLongClickLabel = if (ui.picking) null else "More actions",
            onLongClick = { if (ui.picking) onTap(g) else onMore(g) },
            onClick = { onTap(g) },
          )
          .semantics { selected = picked },
      )
    }
    if (ui.loadingMore) item(key = "more") { MoreSpinner() }
  }
}

@Composable
private fun MoreSpinner() {
  Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
  }
}

/** A card: one artifact, or a batch made together (a mosaic of its first four and a count). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ArtifactTile(
  group: ArtifactGroup, client: MercuryClient, opening: Boolean, picking: Boolean, picked: Boolean,
  onClick: () -> Unit, onLongClick: () -> Unit,
) {
  val item = group.lead
  val shape = RoundedCornerShape(16.dp)
  val title = group.cardTitle
  val label = when {
    picking -> "${if (picked) "Selected" else "Select"}: $title"
    group.isBatch -> "Open ${ArtifactFormat.batchLabel(group.items)}: $title"
    else -> title
  }
  Column(
    Modifier
      .clip(shape)
      .background(MaterialTheme.colorScheme.surfaceContainerLow)
      .border(if (picked) 2.dp else 1.dp, if (picked) MaterialTheme.colorScheme.primary else Mercury.colors.line, shape)
      .combinedClickable(
        onClickLabel = if (picking) null else if (group.isBatch) "Step through them full screen" else "Open",
        onLongClickLabel = if (picking) null else "More actions",
        onLongClick = onLongClick,
        onClick = onClick,
      )
      .semantics(mergeDescendants = true) {
        contentDescription = label
        selected = picked
      },
  ) {
    Box(Modifier.fillMaxWidth().height(118.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
      if (group.isBatch) ArtifactMosaic(group.items, client, Modifier.fillMaxSize())
      else ArtifactThumb(item, client, Modifier.fillMaxSize(), badge = !picking)
      if (opening) CircularProgressIndicator(Modifier.align(Alignment.Center).size(28.dp), strokeWidth = 2.5.dp)
      if (group.isBatch) {
        Row(
          Modifier.align(Alignment.TopEnd).padding(8.dp).clip(RoundedCornerShape(7.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.92f)).padding(horizontal = 7.dp, vertical = 3.dp),
          horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(Icons.Outlined.Layers, null, Modifier.size(13.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
          Text(
            "${group.items.size}", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }
      if (picking) {
        Icon(
          if (picked) Icons.Filled.CheckCircle else Icons.Outlined.RadioButtonUnchecked, null,
          tint = if (picked) MaterialTheme.colorScheme.primary else Color.White,
          modifier = Modifier.align(Alignment.TopStart).padding(8.dp).size(24.dp).clip(CircleShape)
            .background(if (picked) MaterialTheme.colorScheme.surface else Color.Black.copy(alpha = 0.25f)),
        )
      }
    }
    Column(Modifier.padding(horizontal = 10.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(group.cardCaption, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis)
      item.threadTitle?.takeIf { it.isNotEmpty() }?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink4, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

/** A batch's cover: its first four, as a mosaic (the first is tall when there are three). */
@Composable
private fun ArtifactMosaic(items: List<ArtifactItem>, client: MercuryClient, modifier: Modifier = Modifier) {
  val shown = items.take(4)
  val gap = Arrangement.spacedBy(1.dp)
  Box(modifier.background(Mercury.colors.line)) {
    when (shown.size) {
      1 -> ArtifactThumb(shown[0], client, Modifier.fillMaxSize(), compact = true)
      2 -> Row(Modifier.fillMaxSize(), horizontalArrangement = gap) {
        for (a in shown) ArtifactThumb(a, client, Modifier.weight(1f).fillMaxHeight().clipToBounds(), compact = true)
      }
      3 -> Row(Modifier.fillMaxSize(), horizontalArrangement = gap) {
        ArtifactThumb(shown[0], client, Modifier.weight(1f).fillMaxHeight().clipToBounds(), compact = true)
        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = gap) {
          ArtifactThumb(shown[1], client, Modifier.weight(1f).fillMaxWidth().clipToBounds(), compact = true)
          ArtifactThumb(shown[2], client, Modifier.weight(1f).fillMaxWidth().clipToBounds(), compact = true)
        }
      }
      else -> Column(Modifier.fillMaxSize(), verticalArrangement = gap) {
        for (r in 0..1) {
          Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = gap) {
            for (c in 0..1) ArtifactThumb(shown[r * 2 + c], client, Modifier.weight(1f).fillMaxHeight().clipToBounds(), compact = true)
          }
        }
      }
    }
  }
}

/** A picture for images; for anything else, its icon and file type (a play badge on videos). */
@Composable
private fun ArtifactThumb(item: ArtifactItem, client: MercuryClient, modifier: Modifier = Modifier, compact: Boolean = false, badge: Boolean = true) {
  Box(modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
    if (item.kind == "image") {
      RemoteImage(client.artifactFileUrl(item.id), item.name, fill = true, modifier = Modifier.fillMaxSize(), maxSide = THUMB_SIDE)
    } else {
      Icon(
        artifactIcon(item.kind, item.mime), null,
        Modifier.align(Alignment.Center).size(if (compact) 22.dp else 34.dp),
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      if (!compact) {
        val ext = item.ext
        if (badge && ext.isNotEmpty()) Text(
          ext.uppercase(), style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold,
          color = Mercury.colors.ink3,
          modifier = Modifier.align(Alignment.TopStart).padding(8.dp).clip(RoundedCornerShape(5.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f)).padding(horizontal = 5.dp, vertical = 1.dp),
        )
        if (item.kind == "video") Icon(
          Icons.Filled.PlayArrow, null, Modifier.align(Alignment.BottomEnd).padding(8.dp).size(16.dp), tint = Mercury.colors.ink3,
        )
      }
    }
  }
}

// MARK: Actions

/** Long-press or ⋮ on a card: open, share, the chat it came from, select, delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArtifactActions(
  group: ArtifactGroup,
  onDismiss: () -> Unit,
  onOpen: () -> Unit,
  onShare: (() -> Unit)?,
  onChat: (() -> Unit)?,
  onSelect: () -> Unit,
  onDelete: () -> Unit,
) {
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val scope = rememberCoroutineScope()
  fun pick(action: () -> Unit) {
    scope.launch { state.hide() }.invokeOnCompletion { onDismiss(); action() }
  }
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state) {
    Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
      Text(
        group.cardTitle, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(horizontal = 24.dp),
      )
      Text(
        group.cardCaption, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 2.dp, bottom = 8.dp),
      )
      val remove = group.lead.keepsOriginal && !group.isBatch
      ActionRow(Icons.AutoMirrored.Outlined.OpenInNew, if (group.isBatch) "Open ${ArtifactFormat.batchLabel(group.items)}" else "Open") { pick(onOpen) }
      if (onShare != null) ActionRow(Icons.Outlined.Share, "Share") { pick(onShare) }
      if (onChat != null) ActionRow(
        Icons.AutoMirrored.Outlined.Chat, "Go to the chat",
        detail = group.lead.threadTitle?.takeIf { it.isNotEmpty() },
      ) { pick(onChat) }
      ActionRow(Icons.Outlined.CheckCircle, "Select") { pick(onSelect) }
      ActionRow(Icons.Outlined.Delete, if (remove) "Remove from Mercury" else "Delete", danger = true) { pick(onDelete) }
    }
  }
}

@Composable
private fun ActionRow(icon: ImageVector, label: String, detail: String? = null, danger: Boolean = false, onClick: () -> Unit) {
  val tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
  ListItem(
    headlineContent = { Text(label, color = tint) },
    supportingContent = detail?.let { { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
    leadingContent = { Icon(icon, null, tint = tint) },
    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    modifier = Modifier.clickable(onClick = onClick),
  )
}

// MARK: Labels

internal val ArtifactItem.isMedia: Boolean get() = kind == "image" || kind == "video" || kind == "audio"

internal val ArtifactItem.ext: String
  get() = name.substringAfterLast('/').let { n -> if (n.contains('.')) n.substringAfterLast('.') else "" }

internal fun ArtifactItem.mediaItem(client: MercuryClient): MediaItem = MediaItem(
  id = id, url = client.artifactFileUrl(id), title = name,
  kind = when (kind) { "video" -> MediaItem.Kind.Video; "audio" -> MediaItem.Kind.Audio; else -> MediaItem.Kind.Image },
  mime = mime,
)

/** A batch's prompt (or "4 images"); a single artifact's name. */
internal val ArtifactGroup.cardTitle: String
  get() = if (isBatch) lead.prompt?.takeIf { it.isNotEmpty() } ?: ArtifactFormat.batchLabel(items) else lead.name

/** "4 images · 6.1 MB · Nov 3", or "PNG · 1.2 MB · 14:02". */
internal val ArtifactGroup.cardCaption: String
  get() {
    val a = lead
    val whenText = ArtifactFormat.`when`(a.createdAt)
    val head = if (isBatch) "${ArtifactFormat.batchLabel(items)} · ${ArtifactFormat.bytes(size)}"
    else listOfNotNull(a.ext.uppercase().takeIf { it.isNotEmpty() }, a.size?.let { ArtifactFormat.bytes(it) }).joinToString(" · ")
    return when {
      whenText.isEmpty() -> head
      head.isEmpty() -> whenText
      else -> "$head · $whenText"
    }
  }
