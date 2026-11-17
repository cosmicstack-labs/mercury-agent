package sh.mercuryagent.ui.bots

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.FindInPage
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.mercuryagent.core.BotApproval
import sh.mercuryagent.core.BotAsk
import sh.mercuryagent.core.BotQuestion
import sh.mercuryagent.core.BotStatus
import sh.mercuryagent.core.LiveRun
import sh.mercuryagent.core.LiveRuns
import sh.mercuryagent.core.LiveStep
import sh.mercuryagent.core.RunState
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.theme.Mercury

/**
 * Live: what a bot (or a whole fleet) is doing right now, and a box to talk to it (iOS: LiveRunsView;
 * Mercury Desktop: views/bots/Live.tsx).
 *
 * One card per run: who started it and what was asked, each step as it runs (folded past the last
 * few), what the bot is writing, how it ended. A question the bot asks sits inside its run, with its
 * buttons and how long the bot waits. The box at the bottom messages the bot (or a crew member); a
 * message to a busy bot shows as queued at once. Reply on a finished run answers it with that run
 * quoted. The recent past loads once (/api/bots/activity), then the stream adds to it.
 */
@Composable
internal fun LiveFeed(vm: BotsViewModel, ui: BotsUi, members: List<BotStatus>, leadId: String, modifier: Modifier = Modifier) {
  val ids = members.map { it.id }
  val idSet = ids.toSet()
  var target by rememberSaveable(leadId) { mutableStateOf(leadId) }
  var draft by rememberSaveable(leadId) { mutableStateOf("") }
  var sending by remember { mutableStateOf(false) }
  var problem by remember { mutableStateOf<String?>(null) }
  var loaded by remember(leadId) { mutableStateOf(false) }
  var older by remember(leadId) { mutableStateOf(false) }
  val focus = remember { FocusRequester() }
  val scope = rememberCoroutineScope()

  LaunchedEffect(ids.joinToString(",")) {
    if (target !in idSet) target = leadId
    vm.loadActivity(ids)
    vm.loadApprovals()
    loaded = true
  }

  val questions = ui.approvals.filter { it.botId in idSet }
  val runs = remember(ui.live, ui.running, questions, ui.now, idSet) {
    LiveRuns.runsFrom(ui.live.filter { it.botId in idSet }, running = ui.running, approvals = questions, now = ui.now)
  }
  val shown = if (older) runs else runs.takeLast(SHOWN_RUNS)
  val inRuns = runs.map { it.jobId }.toSet()
  // A question whose run isn't in the feed (it started before the log) still gets its card.
  val loose = questions.filter { it.runId !in inRuns }
  val fleet = members.size > 1
  val list = rememberLazyListState()

  Column(modifier.imePadding()) {
    // Newest at the bottom, pinned there as runs arrive: the list is laid out from the bottom up.
    LazyColumn(
      Modifier.weight(1f).fillMaxWidth(), state = list, reverseLayout = true,
      contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      items(loose.reversed(), key = { "q-${it.id}" }) { a ->
        BotQuestionCard(a, ui.now, inline = false) { v -> vm.answerFromUi(a, v) }
      }
      items(shown.reversed(), key = { "r-${it.jobId}" }) { r ->
        RunCard(
          r, bot = members.firstOrNull { it.id == r.botId }, fleet = fleet,
          by = LiveRuns.startedBy(r) { id -> members.firstOrNull { it.id == id }?.name ?: ui.bot(id)?.name },
          questions = questions.filter { it.runId == r.jobId }, now = ui.now, vm = vm,
          onReply = {
            target = r.botId
            draft = LiveRuns.replyDraft(r)
            scope.launch { runCatching { focus.requestFocus() } }
          },
        )
      }
      if (loaded && runs.isEmpty() && questions.isEmpty()) item(key = "empty") {
        BotsEmpty(
          "Nothing happening yet",
          "When ${if (fleet) "a bot in this fleet" else "this bot"} starts a run, on its schedule, from another bot or from your message below, you'll see each step here as it happens.",
        )
      }
      if (!loaded && runs.isEmpty()) item(key = "loading") {
        Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
      }
      if (!older && runs.size > SHOWN_RUNS) item(key = "older") {
        TextButton(onClick = { older = true }, modifier = Modifier.fillMaxWidth()) {
          Text("Show ${runs.size - SHOWN_RUNS} earlier runs", color = Mercury.colors.ink3)
        }
      }
    }
    // Keep the newest in view when something new arrives while the person is at the bottom.
    LaunchedEffect(runs.size, questions.size) { if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0) }

    problem?.let { ErrorText(it, Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
    BotsComposer(
      members = members, leadId = leadId, target = target, onTarget = { target = it }, draft = draft, onDraft = { draft = it },
      sending = sending, focus = focus, vm = vm,
      send = {
        val text = draft.trim()
        if (text.isNotEmpty() && !sending) {
          sending = true; problem = null
          scope.launch {
            val why = vm.send(text, target.ifEmpty { leadId })
            if (why != null) problem = why else draft = ""
            sending = false
          }
        }
      },
    )
  }
}

private const val SHOWN_RUNS = 40
private const val SHOWN_STEPS = 6

/** One run: what was asked, its steps, what the bot is writing, how it ended. */
@Composable
private fun RunCard(
  run: LiveRun,
  bot: BotStatus?,
  fleet: Boolean,
  by: String,
  questions: List<BotApproval>,
  now: Double,
  vm: BotsViewModel,
  onReply: () -> Unit,
) {
  val active = run.state.isActive
  val fromYou = by.startsWith("You")
  var allSteps by remember(run.jobId) { mutableStateOf(false) }
  val hidden = if (allSteps) 0 else maxOf(0, run.steps.size - SHOWN_STEPS)
  val c = Mercury.colors

  Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
    val prompt = run.prompt
    if (prompt != null && fromYou) {
      // What you asked, as your own message.
      Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 6.dp),
        modifier = Modifier.widthIn(max = 320.dp),
      ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalAlignment = Alignment.End) {
          SelectionContainer { Text(prompt, style = MaterialTheme.typography.bodyLarge) }
          if (fleet) Text("to ${run.botName}", style = MaterialTheme.typography.labelSmall, color = c.ink3)
        }
      }
    }
    Surface(
      shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
      border = BorderStroke(
        if (run.state == RunState.Waiting) 1.5.dp else 1.dp,
        when (run.state) {
          RunState.Waiting -> c.amber.copy(alpha = 0.6f)
          RunState.Failed -> c.red.copy(alpha = 0.35f)
          else -> if (active) MaterialTheme.colorScheme.outline.copy(alpha = 0.5f) else c.line
        },
      ),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(Modifier.padding(14.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // Who, its state; then who started it, when, for how long.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          BotAvatar(run.botId, run.botName, hasAvatar = bot?.hasAvatar == true, size = 28.dp, client = vm.client)
          Column(Modifier.weight(1f)) {
            Text(run.botName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
              (if (fromYou) "" else "$by · ") + meta(run, active, now), style = MaterialTheme.typography.labelSmall,
              color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
          }
          StateLabel(run.state.label, runDot(run.state), running = active && run.state != RunState.Waiting)
        }
        if (prompt != null && !fromYou) {
          Text(prompt, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        if (run.state == RunState.Queued && run.steps.isEmpty()) {
          Text(if (bot?.isRunning == true) "Runs when the current run finishes." else "Starting…", style = MaterialTheme.typography.bodyMedium, color = c.ink3)
        }
        if (run.steps.isNotEmpty()) {
          Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(1.dp).fillMaxHeight().background(c.line))
            Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
              if (hidden > 0) {
                TextButton(onClick = { allSteps = true }, contentPadding = PaddingValues(horizontal = 4.dp)) {
                  Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp), tint = c.ink3)
                  Text(" $hidden earlier step${if (hidden == 1) "" else "s"}", style = MaterialTheme.typography.labelLarge, color = c.ink3)
                }
              }
              run.steps.drop(hidden).forEach { LiveStepRow(it) }
            }
          }
        }
        val text = run.text?.trim()
        if (!text.isNullOrEmpty()) {
          SelectionContainer {
            Text(
              text, style = MaterialTheme.typography.bodyLarge,
              color = if (active) c.ink3 else MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = if (active) 4 else 6, overflow = TextOverflow.Ellipsis,
            )
          }
        }
        questions.forEach { a -> BotQuestionCard(a, now, inline = true) { v -> vm.answerFromUi(a, v) } }
        if (!active) {
          val end = run.endLabel
          if (end != null && run.state != RunState.Done) {
            Text(end, style = MaterialTheme.typography.bodyMedium, color = if (run.state == RunState.Failed) c.red else c.ink3, maxLines = 3)
          }
          if (run.state == RunState.Ended) {
            Text("No ending was reported (Mercury restarted during the run).", style = MaterialTheme.typography.bodyMedium, color = c.ink3)
          }
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            FilledTonalButton(onClick = onReply, contentPadding = PaddingValues(horizontal = 14.dp)) {
              Icon(Icons.AutoMirrored.Outlined.Reply, null, Modifier.size(18.dp))
              Text("Reply", Modifier.padding(start = 6.dp))
            }
          }
        }
      }
    }
  }
}

private fun meta(run: LiveRun, active: Boolean, now: Double): String {
  val elapsed = maxOf(0.0, (if (active) now else run.updatedAt) - run.startedAt)
  var s = BotsTime.stamp(run.startedAt, now) + " · " + LiveRuns.duration(elapsed)
  if (run.stepCount > 0) s += " · ${run.stepCount} step${if (run.stepCount == 1) "" else "s"}"
  return s
}

/** One step: the tool and how it went (running, done, failed with its error), or a note. */
@Composable
private fun LiveStepRow(step: LiveStep) {
  val c = Mercury.colors
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
    Box(Modifier.size(16.dp).padding(top = 2.dp), contentAlignment = Alignment.Center) {
      when (step.status) {
        "running" -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = c.ink3)
        "error" -> Icon(Icons.Outlined.ErrorOutline, "Failed", Modifier.size(14.dp), tint = c.red)
        "note" -> Icon(Icons.Outlined.ChatBubbleOutline, null, Modifier.size(13.dp), tint = c.ink4)
        else -> Icon(Icons.Outlined.Check, "Done", Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurface)
      }
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        step.label,
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = if (step.status == "note") FontFamily.Default else FontFamily.Monospace),
        color = if (step.status == "note") c.ink3 else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis,
      )
      val d = step.detail
      if (step.status == "error" && !d.isNullOrEmpty()) {
        Text(d, style = MaterialTheme.typography.bodySmall, color = c.red, maxLines = 4, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

/**
 * A question a bot is waiting on: what it wants to do, the exact command or path, the answers, and
 * how long it waits before taking silence as a no. After reading something untrusted there is no "Always".
 */
@Composable
internal fun BotQuestionCard(approval: BotApproval, now: Double, inline: Boolean, answer: (String) -> Unit) {
  val ask = remember(approval) { BotAsk.of(approval) }
  val opts = remember(approval) { BotQuestion.options(approval) }
  var answering by remember(approval.id) { mutableStateOf(false) }
  val c = Mercury.colors
  Surface(
    shape = MaterialTheme.shapes.medium,
    color = if (inline) c.amber.copy(alpha = 0.06f) else MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(1.5.dp, c.amber.copy(alpha = 0.55f)),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(Modifier.padding(if (inline) 12.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
          Modifier.size(36.dp).background(c.amber.copy(alpha = 0.14f), RoundedCornerShape(10.dp)),
          contentAlignment = Alignment.Center,
        ) { Icon(askIcon(ask.kind), null, tint = c.amber, modifier = Modifier.size(20.dp)) }
        Column {
          Text(ask.title, style = MaterialTheme.typography.titleSmall)
          Text(
            if (inline) "Waits ${BotQuestion.minutesLeft(approval, now)} min, then it's a no" else BotQuestion.waits(approval, now),
            style = MaterialTheme.typography.labelMedium, color = c.ink3,
          )
        }
      }
      ask.detail?.let { d ->
        SelectionContainer {
          Text(
            d, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), maxLines = 8, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp)).padding(10.dp),
          )
        }
      }
      ask.note?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 8, overflow = TextOverflow.Ellipsis) }
      // Allow once is the main answer; the others sit under it, Deny last and quiet.
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (o in opts) {
          val pick: () -> Unit = {
            if (!answering) { answering = true; answer(o.value) }
          }
          val m = Modifier.fillMaxWidth().heightIn(min = 48.dp)
          when (o.value) {
            "yes" -> Button(onClick = pick, enabled = !answering, modifier = m) { Text(o.label, fontWeight = FontWeight.SemiBold, maxLines = 1) }
            "no" -> TextButton(onClick = pick, enabled = !answering, modifier = m) { Text(o.label, color = c.ink3, maxLines = 1) }
            else -> FilledTonalButton(onClick = pick, enabled = !answering, modifier = m) { Text(o.label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
          }
        }
      }
    }
  }
}

private fun askIcon(k: BotAsk.Kind): ImageVector = when (k) {
  BotAsk.Kind.Injection -> Icons.Outlined.GppMaybe
  BotAsk.Kind.Command -> Icons.Outlined.Terminal
  BotAsk.Kind.Write -> Icons.Outlined.EditNote
  BotAsk.Kind.Read -> Icons.Outlined.FindInPage
  BotAsk.Kind.Other -> Icons.Outlined.PanTool
}

/** The box under the feed: who to send to (in a fleet, from a bottom sheet), the message, Send. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BotsComposer(
  members: List<BotStatus>,
  leadId: String,
  target: String,
  onTarget: (String) -> Unit,
  draft: String,
  onDraft: (String) -> Unit,
  sending: Boolean,
  focus: FocusRequester,
  vm: BotsViewModel,
  send: () -> Unit,
) {
  val targetBot = members.firstOrNull { it.id == target } ?: members.firstOrNull()
  val targetName = targetBot?.name ?: "the bot"
  val canSend = draft.isNotBlank() && !sending
  var picking by remember { mutableStateOf(false) }

  Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 10.dp)) {
    if (members.size > 1) {
      TextButton(
        onClick = { picking = true },
        modifier = Modifier.semantics { contentDescription = "Send to $targetName. Change" },
        contentPadding = PaddingValues(horizontal = 8.dp),
      ) {
        BotAvatar(targetBot?.id ?: leadId, targetName, hasAvatar = targetBot?.hasAvatar == true, size = 20.dp, client = vm.client)
        Text("To $targetName", Modifier.padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Icon(Icons.Outlined.UnfoldMore, null, Modifier.size(16.dp), tint = Mercury.colors.ink3)
      }
    }
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      TextField(
        value = draft, onValueChange = onDraft, placeholder = { Text("Message $targetName…") },
        maxLines = 6, shape = RoundedCornerShape(24.dp),
        colors = TextFieldDefaults.colors(
          focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
          focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        ),
        modifier = Modifier.weight(1f).focusRequester(focus),
      )
      FilledIconButton(
        onClick = send, enabled = canSend, modifier = Modifier.padding(bottom = 4.dp).size(48.dp),
      ) {
        if (sending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        else Icon(Icons.AutoMirrored.Outlined.Send, "Send")
      }
    }
  }

  if (picking) {
    ModalBottomSheet(onDismissRequest = { picking = false }) {
      Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
        Text(
          "Send to", style = MaterialTheme.typography.titleMedium,
          modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp),
        )
        members.forEach { b ->
          val desc = b.description?.takeIf { it.isNotEmpty() }
          ListItem(
            headlineContent = { Text(if (b.id == leadId) "${b.name} (lead)" else b.name) },
            supportingContent = if (desc != null) { { Text(desc, maxLines = 1, overflow = TextOverflow.Ellipsis) } } else null,
            leadingContent = { BotAvatar(b.id, b.name, hasAvatar = b.hasAvatar == true, size = 36.dp, dimmed = b.isOff, client = vm.client) },
            trailingContent = { if (b.id == target) Icon(Icons.Outlined.Check, "Selected") },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.clickable(onClickLabel = "Send to ${b.name}") { onTarget(b.id); picking = false },
          )
        }
      }
    }
  }
}
