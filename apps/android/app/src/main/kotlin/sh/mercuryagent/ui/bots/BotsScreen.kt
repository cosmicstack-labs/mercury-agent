package sh.mercuryagent.ui.bots

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.core.BotFleet
import sh.mercuryagent.core.BotStatus
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.components.StatusDot
import sh.mercuryagent.ui.theme.Mercury

/** Where the Bots screen is: the roster, the inbox for every bot, or one bot (a whole fleet for a lead). */
private sealed interface BotsPage {
  data object Roster : BotsPage
  data object Inbox : BotsPage
  data class Bot(val leadId: String) : BotsPage
  data object New : BotsPage
  data class Edit(val id: String) : BotsPage

  companion object {
    fun encode(p: BotsPage): String = when (p) { Roster -> ""; Inbox -> "inbox"; New -> "new"; is Bot -> "bot:${p.leadId}"; is Edit -> "edit:${p.id}" }
    fun decode(s: String): BotsPage = when {
      s == "inbox" -> Inbox
      s == "new" -> New
      s.startsWith("edit:") -> Edit(s.removePrefix("edit:"))
      s.startsWith("bot:") -> Bot(s.removePrefix("bot:"))
      else -> Roster
    }
  }
}

/**
 * Bots: every bot and fleet on this Mercury, with what each is doing now (iOS: BotsView). A fleet
 * opens to all of its members together; a bot to itself. Each opens on Live (what it's doing as it
 * happens, and a box to talk to it), with its Inbox and History beside it. Opened from the drawer;
 * back walks out of a bot, then returns to the chat.
 *
 * [onOpenChat] is kept for a later link from a bot's result to a chat; the runtime's bot routes
 * name no chat today, so nothing calls it yet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotsScreen(vm: BotsViewModel, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
  val ui by vm.ui.collectAsStateWithLifecycle()
  val snackbar = remember { SnackbarHostState() }
  var pageKey by rememberSaveable { mutableStateOf("") }
  val page = BotsPage.decode(pageKey)

  // The stream and the clock run while the screen is started.
  LifecycleStartEffect(vm) {
    vm.start()
    onStopOrDispose { vm.stop() }
  }
  LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }
  BackHandler(enabled = page != BotsPage.Roster) {
    pageKey = if (page is BotsPage.Edit) BotsPage.encode(BotsPage.Bot(page.id)) else ""
  }

  when (page) {
    BotsPage.Roster -> RosterPage(vm, ui, snackbar, onBack, onOpen = { pageKey = BotsPage.encode(it) })
    BotsPage.Inbox -> InboxPage(vm, ui, snackbar, onBack = { pageKey = "" })
    BotsPage.New -> NewBotPage(vm) { id -> pageKey = id?.let { BotsPage.encode(BotsPage.Bot(it)) } ?: "" }
    is BotsPage.Edit -> {
      val b = ui.bot(page.id)
      if (b == null) LaunchedEffect(Unit) { pageKey = "" }
      else EditBotPage(vm, b) { pageKey = BotsPage.encode(BotsPage.Bot(page.id)) }
    }
    is BotsPage.Bot -> BotDetailPage(vm, ui, page.leadId, snackbar, onBack = { pageKey = "" },
      onEdit = { pageKey = BotsPage.encode(BotsPage.Edit(it)) })
  }
}

// MARK: The roster

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RosterPage(vm: BotsViewModel, ui: BotsUi, snackbar: SnackbarHostState, onBack: () -> Unit, onOpen: (BotsPage) -> Unit) {
  val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
  Scaffold(
    modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
    topBar = {
      LargeTopAppBar(
        title = { Text("Bots") }, scrollBehavior = scroll,
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        actions = {
          if (ui.available && ui.bots.isNotEmpty()) AllBotsMenu(vm) { vm.say(it) }
          if (ui.available) IconButton(onClick = { onOpen(BotsPage.New) }) { Icon(Icons.Outlined.Add, "New bot") }
        },
      )
    },
    snackbarHost = { SnackbarHost(snackbar) },
  ) { pad ->
    PullToRefreshBox(ui.refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize().padding(pad)) {
      BotsList(vm, ui, onOpen)
      if (!ui.loaded) CircularProgressIndicator(Modifier.align(Alignment.Center))
    }
  }
}

/** The roster: the inbox, then fleets (lead with its crew), then bots on their own. */
@Composable
private fun BotsList(vm: BotsViewModel, ui: BotsUi, onOpen: (BotsPage) -> Unit) {
  val (fleets, solo) = ui.layout
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp)) {
    val e = ui.error
    if (e != null && ui.bots.isEmpty()) item(key = "error") { ErrorText(e, Modifier.padding(vertical = 12.dp)) }
    when {
      !ui.available -> item(key = "off") {
        BotsEmpty("Bots are off on this Mercury", "Turn bots on in Mercury's settings on your computer to see them here.")
      }
      ui.loaded && ui.bots.isEmpty() && ui.error == null -> item(key = "none") {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
          BotsEmpty("No bots yet", "A bot works on its own, on a schedule or when you message it, and reports back to your inbox.")
          Button(onClick = { onOpen(BotsPage.New) }) { Text("New bot") }
        }
      }
      ui.bots.isNotEmpty() -> {
        item(key = "inbox") { InboxRow(ui.unread, ui.approvals.size) { onOpen(BotsPage.Inbox) } }
        if (fleets.isNotEmpty()) item(key = "h-fleets") { BotsSectionTitle("Fleets") }
        for (f in fleets) {
          item(key = "f-${f.id}") {
            BotRow(
              f.lead, fleetLine(f), if (f.lead.needsYou) Mercury.colors.amber else Mercury.colors.ink3,
              needsYou = f.lead.needsYou || f.crew.any { it.needsYou }, size = 40.dp, vm = vm, onClick = { onOpen(BotsPage.Bot(f.lead.id)) },
            )
          }
          items(f.crew, key = { "c-${f.id}-${it.id}" }) { b ->
            CrewRow { BotRow(b, line(b, ui.activity[b.id]), lineColor(b), needsYou = b.needsYou, size = 30.dp, vm = vm, onClick = { onOpen(BotsPage.Bot(b.id)) }) }
          }
        }
        if (solo.isNotEmpty()) item(key = "h-solo") { BotsSectionTitle(if (fleets.isEmpty()) "Your bots" else "On their own") }
        items(solo, key = { "s-${it.id}" }) { b ->
          BotRow(b, line(b, ui.activity[b.id]), lineColor(b), needsYou = b.needsYou, size = 40.dp, vm = vm, onClick = { onOpen(BotsPage.Bot(b.id)) })
        }
      }
    }
  }
}

/** A crew member under its lead, on a thin line. */
@Composable
private fun CrewRow(content: @Composable () -> Unit) {
  Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(start = 19.dp)) {
    Box(Modifier.width(1.dp).fillMaxHeight().padding(vertical = 4.dp).background(Mercury.colors.line))
    Box(Modifier.padding(start = 12.dp).weight(1f)) { content() }
  }
}

internal fun fleetLine(f: BotFleet): String {
  var s = "Fleet · ${f.crew.size} crew"
  if (f.working > 0) s += " · ${f.working} working"
  if (f.members.any { it.needsYou }) s += " · waiting for you"
  if (f.lead.stopped == true) s += " · stopped"
  return s
}

/** What a bot is doing, in a few words: its current step when working. */
internal fun line(b: BotStatus, activity: String?): String {
  if (b.needsYou) return "Waiting for you"
  if (b.stopped == true) return "Stopped"
  if (!b.enabled || b.state == "disabled") return "Off"
  return when (b.state) {
    "running" -> (activity ?: b.activity)?.let { "Working · $it" } ?: "Working"
    "queued" -> "Queued"
    "paused" -> "Paused"
    else -> b.description?.takeIf { it.isNotEmpty() } ?: "Idle"
  }
}

@Composable
private fun lineColor(b: BotStatus): Color =
  if (b.needsYou) Mercury.colors.amber else if (b.isRunning) MaterialTheme.colorScheme.onSurface else Mercury.colors.ink3

@Composable
internal fun BotRow(
  bot: BotStatus,
  subtitle: String,
  subtitleColor: Color,
  needsYou: Boolean,
  size: Dp,
  vm: BotsViewModel,
  onClick: () -> Unit,
) {
  Row(
    Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(MaterialTheme.shapes.medium)
      .clickable(role = Role.Button, onClickLabel = "Open ${bot.name}", onClick = onClick)
      .padding(horizontal = 4.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box {
      BotAvatar(bot.id, bot.name, hasAvatar = bot.hasAvatar == true, size = size, dimmed = bot.isOff, client = vm.client)
      val dot = if (needsYou) Mercury.colors.amber else if (bot.isRunning) Mercury.colors.green else null
      if (dot != null) {
        Box(
          Modifier.align(Alignment.BottomEnd).offset(2.dp, 2.dp).size(12.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surface),
          contentAlignment = Alignment.Center,
        ) { StatusDot(dot, running = bot.isRunning && !needsYou, size = 8.dp) }
      }
    }
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        bot.name, style = if (size > 34.dp) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
        maxLines = 1, overflow = TextOverflow.Ellipsis,
      )
      Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = subtitleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    bot.unread?.takeIf { it > 0 }?.let { CountBadge(it) }
    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = Mercury.colors.ink4)
  }
}

@Composable
private fun InboxRow(unread: Int, asking: Int, onClick: () -> Unit) {
  Surface(
    onClick = onClick, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(1.dp, Mercury.colors.line), modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
  ) {
    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHighest), contentAlignment = Alignment.Center) {
        Icon(Icons.Outlined.Inbox, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("Inbox", style = MaterialTheme.typography.titleMedium)
        Text(
          if (asking > 0) "$asking question${if (asking == 1) "" else "s"} waiting for you" else "Results, problems and questions",
          style = MaterialTheme.typography.bodyMedium, color = if (asking > 0) Mercury.colors.amber else Mercury.colors.ink3, maxLines = 1,
        )
      }
      if (unread > 0) CountBadge(unread)
      Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = Mercury.colors.ink4)
    }
  }
}

// MARK: The inbox for every bot

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxPage(vm: BotsViewModel, ui: BotsUi, snackbar: SnackbarHostState, onBack: () -> Unit) {
  LaunchedEffect(Unit) { vm.tick() }
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Inbox") },
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
      )
    },
    snackbarHost = { SnackbarHost(snackbar) },
  ) { pad ->
    BotsInboxList(vm, ui, botIds = null, modifier = Modifier.padding(pad))
  }
}

// MARK: One bot or fleet

private enum class DetailTab(val title: String) { Live("Live"), Inbox("Inbox"), History("History") }

/** A bot, or a whole fleet when [leadId] is a lead: Live, Inbox and History. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun BotDetailPage(vm: BotsViewModel, ui: BotsUi, leadId: String, snackbar: SnackbarHostState, onBack: () -> Unit, onEdit: (String) -> Unit) {
  var tab by rememberSaveable { mutableIntStateOf(0) }
  var managing by rememberSaveable { mutableStateOf(false) }
  val members = ui.members(leadId)
  val lead = ui.bot(leadId)
  LaunchedEffect(leadId) { vm.tick() }
  Scaffold(
    topBar = {
      Column {
        TopAppBar(
          title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
              if (lead != null) BotAvatar(lead.id, lead.name, hasAvatar = lead.hasAvatar == true, size = 28.dp, client = vm.client)
              Column {
                Text(lead?.name ?: "Bot", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                if (members.size > 1) {
                  Text("Fleet · ${members.size - 1} crew", style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3)
                }
              }
            }
          },
          navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
          actions = {
            if (lead != null) IconButton(onClick = { managing = true }) { Icon(Icons.Outlined.Tune, "Manage ${lead.name}") }
          },
        )
        PrimaryTabRow(selectedTabIndex = tab) {
          DetailTab.entries.forEachIndexed { i, t ->
            Tab(
              selected = tab == i, onClick = { tab = i },
              text = { Text(t.title, fontWeight = if (tab == i) FontWeight.SemiBold else FontWeight.Normal) },
            )
          }
        }
      }
    },
    snackbarHost = { SnackbarHost(snackbar) },
  ) { pad ->
    // The composer lifts with the keyboard: what the Scaffold already pads (the navigation bar) isn't added twice.
    val m = Modifier.padding(pad).consumeWindowInsets(pad).fillMaxSize()
    if (members.isEmpty()) {
      Box(m, contentAlignment = Alignment.Center) {
        if (ui.loaded) BotsEmpty("This bot is gone", "It was removed or renamed on your Mercury.") else CircularProgressIndicator()
      }
    } else when (DetailTab.entries[tab]) {
      DetailTab.Live -> LiveFeed(vm, ui, members, leadId, m)
      DetailTab.Inbox -> BotsInboxList(vm, ui, members.map { it.id }, m)
      DetailTab.History -> BotsHistory(vm, ui, members, m)
    }
  }
  if (managing && lead != null) {
    BotManageSheet(vm, lead, crewCount = ui.bots.count { it.parent == lead.id }, onDismiss = { managing = false },
      onEdit = { managing = false; onEdit(lead.id) }, onDeleted = { managing = false; onBack() })
  }
}
