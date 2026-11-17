package sh.mercuryagent.ui.bots

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.mercuryagent.core.BotInboxEntry
import sh.mercuryagent.core.BotRunRecord
import sh.mercuryagent.core.BotRunTranscript
import sh.mercuryagent.core.BotStatus
import sh.mercuryagent.core.LiveRuns
import sh.mercuryagent.ui.components.StatusDot
import sh.mercuryagent.ui.conversation.MarkdownText
import sh.mercuryagent.ui.theme.Mercury

/**
 * What the bots did for you, kept until you read it: results (the bot's own summary and the files
 * it delivered), failures a bot reported, and runs that need you, with the questions waiting on top.
 * Runs where nothing was new aren't here; History has every run. (iOS: BotsInbox; Desktop: views/bots/Inbox.tsx)
 * [botIds]: some bots (one bot, or a fleet), or every bot when null.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BotsInboxList(vm: BotsViewModel, ui: BotsUi, botIds: List<String>?, modifier: Modifier = Modifier) {
  var unreadOnly by rememberSaveable { mutableStateOf(false) }
  var entries by remember(botIds) { mutableStateOf<List<BotInboxEntry>?>(null) }
  var failed by remember { mutableStateOf(false) }
  var refreshing by remember { mutableStateOf(false) }
  var reload by remember { mutableIntStateOf(0) }
  val key = botIds?.joinToString(",") ?: ""

  LaunchedEffect(unreadOnly, ui.inboxVersion, key, reload) {
    val got = vm.inbox(botIds, unreadOnly)
    failed = got == null
    entries = got ?: entries
    refreshing = false
  }

  fun markRead(ids: List<String>?) {
    entries = entries?.map { e -> if (ids == null || e.id in ids) e.copy(read = true) else e }
    vm.markRead(ids)
  }

  val questions = ui.approvals.filter { botIds == null || it.botId in botIds }
  val list = entries
  val unread = list.orEmpty().filter { !it.read }

  PullToRefreshBox(refreshing, onRefresh = { refreshing = true; reload++ }, modifier = modifier.fillMaxSize()) {
    LazyColumn(
      Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      item(key = "filters") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          FilterChip(selected = !unreadOnly, onClick = { unreadOnly = false }, label = { Text("All") })
          FilterChip(selected = unreadOnly, onClick = { unreadOnly = true }, label = { Text("Unread") })
          Box(Modifier.weight(1f))
          if (unread.isNotEmpty()) {
            TextButton(onClick = { markRead(unread.map { it.id }) }) {
              Icon(Icons.Outlined.DoneAll, null, Modifier.size(18.dp))
              Text("Mark all read", Modifier.padding(start = 6.dp))
            }
          }
        }
      }
      items(questions, key = { "q-${it.id}" }) { a ->
        BotQuestionCard(a, ui.now, inline = false) { v -> vm.answerFromUi(a, v) }
      }
      when {
        list == null && failed -> item(key = "failed") {
          BotsEmpty("Couldn't load the inbox", "Pull down to try again.")
        }
        list == null -> item(key = "loading") {
          Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        }
        list.isEmpty() -> item(key = "empty") {
          BotsEmpty(
            if (unreadOnly) "Nothing unread" else "Nothing here yet",
            "When a bot finishes something, reports a problem or needs you, it lands here, even while the app is closed. Runs with nothing new stay quiet.",
          )
        }
        else -> {
          for ((day, group) in byDay(list)) {
            item(key = "d-$day") { BotsSectionTitle(day) }
            items(group, key = { "e-${it.id}" }) { e ->
              InboxCard(e, ui.bot(e.botId), vm) { if (!e.read) markRead(listOf(e.id)) }
            }
          }
        }
      }
    }
  }
}

/** Entries (newest first) under their day: Today, Yesterday, Monday 3 Nov. */
internal fun byDay(entries: List<BotInboxEntry>): List<Pair<String, List<BotInboxEntry>>> {
  val out = mutableListOf<Pair<String, MutableList<BotInboxEntry>>>()
  for (e in entries) {
    val day = BotsTime.day(e.at)
    if (out.lastOrNull()?.first == day) out.last().second += e else out += day to mutableListOf(e)
  }
  return out
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InboxCard(entry: BotInboxEntry, bot: BotStatus?, vm: BotsViewModel, onOpen: () -> Unit) {
  var expanded by rememberSaveable(entry.id) { mutableStateOf(false) }
  val c = Mercury.colors
  val (icon, tint) = when (entry.kind) {
    "result" -> Icons.Outlined.CheckCircle to MaterialTheme.colorScheme.onSurface
    "failed" -> Icons.Outlined.Cancel to c.red
    else -> Icons.Outlined.WarningAmber to c.amber
  }
  val kindWords = when (entry.kind) { "result" -> "Result"; "failed" -> "Failed"; else -> "Needs you" }
  Surface(
    onClick = { expanded = !expanded; onOpen() },
    shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(1.dp, if (entry.read) c.line else MaterialTheme.colorScheme.outline.copy(alpha = 0.6f)),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Row(Modifier.padding(14.dp).animateContentSize(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      BotAvatar(entry.botId, entry.botName, hasAvatar = bot?.hasAvatar == true, size = 32.dp, client = vm.client)
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          Icon(icon, kindWords, Modifier.padding(top = 2.dp).size(16.dp), tint = tint)
          Text(
            entry.title.ifEmpty { entry.botName }, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f),
            maxLines = if (expanded) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis,
          )
          if (!entry.read) {
            StatusDot(MaterialTheme.colorScheme.primary, Modifier.padding(top = 6.dp), size = 7.dp)
          }
          Text(BotsTime.time(entry.at), style = MaterialTheme.typography.labelSmall, color = c.ink4)
        }
        Text(entry.botName, style = MaterialTheme.typography.labelMedium, color = c.ink3)
        if (entry.summary.isNotEmpty() && entry.summary != entry.title) {
          if (expanded) MarkdownText(entry.summary, color = MaterialTheme.colorScheme.onSurfaceVariant)
          else Text(plainInline(entry.summary), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
        val tags = buildList {
          if (entry.complete == true) add("job done")
          if (entry.kind == "needs-you") entry.reasonCode?.let { add(it.replace('_', ' ')) }
        }
        if (entry.files.isNotEmpty() || tags.isNotEmpty()) {
          FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            entry.files.forEach { FileChip(it) }
            tags.forEach { t -> Tag(t, if (t == "job done") c.green else c.amber) }
          }
        }
      }
    }
  }
}

// MARK: History

private enum class HistoryFilter(val title: String) { All("All"), Done("Done"), Failed("Failed") }

/**
 * Every finished run, newest first, across the fleet for a lead. Open one to see what it was asked,
 * each step it took and what it concluded. (iOS: BotsHistory; Desktop: views/bots/Activity.tsx)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BotsHistory(vm: BotsViewModel, ui: BotsUi, members: List<BotStatus>, modifier: Modifier = Modifier) {
  var runs by remember { mutableStateOf<List<BotRunRecord>?>(null) }
  var filter by rememberSaveable { mutableStateOf(HistoryFilter.All) }
  var open by remember { mutableStateOf<BotRunRecord?>(null) }
  var refreshing by remember { mutableStateOf(false) }
  var reload by remember { mutableIntStateOf(0) }
  val ids = members.map { it.id }
  val fleet = members.size > 1

  LaunchedEffect(ids.joinToString(","), reload) {
    runs = vm.history(ids)
    refreshing = false
  }

  PullToRefreshBox(refreshing, onRefresh = { refreshing = true; reload++ }, modifier = modifier.fillMaxSize()) {
    LazyColumn(
      Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      item(key = "filters") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          HistoryFilter.entries.forEach { f -> FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.title) }) }
        }
      }
      val all = runs
      if (all == null) {
        item(key = "loading") { Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
      } else {
        val shown = all.filter {
          when (filter) {
            HistoryFilter.All -> true
            HistoryFilter.Failed -> it.state == "failed"
            HistoryFilter.Done -> it.state == "completed"
          }
        }
        if (shown.isEmpty()) item(key = "empty") { BotsEmpty("No runs yet", "Finished runs show up here, with every step they took.") }
        items(shown, key = { it.id }) { r ->
          HistoryRow(r, members.firstOrNull { it.id == r.botId }, fleet, vm) { open = r }
        }
      }
    }
  }

  open?.let { r ->
    RunTranscriptSheet(vm, r, members.firstOrNull { it.id == r.botId }?.name ?: ui.bot(r.botId)?.name ?: r.botId) { open = null }
  }
}

@Composable
private fun HistoryRow(run: BotRunRecord, bot: BotStatus?, fleet: Boolean, vm: BotsViewModel, onClick: () -> Unit) {
  val c = Mercury.colors
  val meta = buildList {
    if (fleet) add(bot?.name ?: run.botId)
    add(BotsTime.stamp(run.startedAt, System.currentTimeMillis().toDouble()))
    add(LiveRuns.triggerWords(run.trigger))
    add(LiveRuns.duration(run.durationMs))
  }.joinToString(" · ")
  Surface(
    onClick = onClick, shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(1.dp, if (run.failed) c.red.copy(alpha = 0.3f) else c.line), modifier = Modifier.fillMaxWidth(),
  ) {
    Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      if (fleet) BotAvatar(run.botId, bot?.name ?: run.botId, hasAvatar = bot?.hasAvatar == true, size = 28.dp, client = vm.client)
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(run.summary ?: run.error ?: run.reasonCode ?: run.state, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(meta, style = MaterialTheme.typography.labelSmall, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
          StateLabel(run.label, recordDot(run), modifier = Modifier.padding(start = 8.dp))
        }
      }
    }
  }
}

@Composable
private fun recordDot(run: BotRunRecord): Color? = when {
  run.failed -> Mercury.colors.red
  else -> null
}

/** One run read back, in a sheet: what it was asked, its thought process, what it concluded, what it delivered. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun RunTranscriptSheet(vm: BotsViewModel, run: BotRunRecord, botName: String, onDismiss: () -> Unit) {
  val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val scope = rememberCoroutineScope()
  var transcript by remember(run.id) { mutableStateOf<BotRunTranscript?>(null) }
  var error by remember(run.id) { mutableStateOf<String?>(null) }
  LaunchedEffect(run.id) {
    vm.transcript(run).onSuccess { transcript = it }.onFailure { error = it.message ?: "unavailable" }
  }
  val c = Mercury.colors

  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
    Column(
      Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
      verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        BotAvatar(run.botId, botName, size = 32.dp, client = vm.client)
        Text(botName, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
        TextButton(onClick = { scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() } }) { Text("Done") }
      }
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StateLabel(run.label, recordDot(run))
        Text(
          "${LiveRuns.duration(run.durationMs)} · ${run.steps ?: 0} steps · ${LiveRuns.compact(run.tokensIn + run.tokensOut)} tok",
          style = MaterialTheme.typography.labelMedium, color = c.ink3,
        )
      }
      error?.let { Text("No transcript for this run ($it).", style = MaterialTheme.typography.bodyMedium, color = c.ink3) }
      val t = transcript
      if (t != null) {
        if (t.prompt.isNotEmpty()) Section("Asked") {
          SelectionContainer { Text(t.prompt, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Section("Thought process · ${t.trace.size} step${if (t.trace.size == 1) "" else "s"}") {
          if (t.trace.isEmpty()) Text("Answered without tools.", style = MaterialTheme.typography.bodyMedium, color = c.ink4)
          t.trace.forEach { s ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              Icon(
                if (s.ok) Icons.Outlined.Check else Icons.Outlined.ErrorOutline, if (s.ok) "Done" else "Failed",
                Modifier.padding(top = 2.dp).size(14.dp), tint = if (s.ok) MaterialTheme.colorScheme.onSurface else c.red,
              )
              Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(s.name, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                val arg = s.arg
                if (!arg.isNullOrEmpty()) {
                  Text(arg, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = c.ink3, maxLines = 4, overflow = TextOverflow.Ellipsis)
                }
              }
            }
          }
        }
        Section(
          when (t.record.report) { "no_update" -> "Nothing new"; "failure" -> "Couldn't do it"; else -> "Concluded" },
        ) {
          MarkdownText(t.output.ifEmpty { t.record.summary ?: "(no output)" })
        }
        val files = t.record.deliverables.orEmpty()
        if (files.isNotEmpty()) Section("Delivered") {
          FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { files.forEach { FileChip(it) } }
        }
      } else if (error == null) {
        Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
      }
    }
  }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(title, style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3, modifier = Modifier.semantics { heading() })
    content()
  }
}
