package sh.mercuryagent.ui.bots

import android.app.TimePickerDialog
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.mercuryagent.core.BotForms
import sh.mercuryagent.core.BotModelRef
import sh.mercuryagent.core.BotSchedule
import sh.mercuryagent.core.BotStatus
import sh.mercuryagent.core.BotTiers
import sh.mercuryagent.core.CrewSpec
import sh.mercuryagent.core.ModelCatalog
import sh.mercuryagent.core.ModelMenu
import sh.mercuryagent.core.ScheduleRule
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.more.OwnerGateSheet
import sh.mercuryagent.ui.more.rememberOwnerGate
import sh.mercuryagent.ui.theme.Mercury

// Making, changing and managing bots (iOS: BotEditorViews.swift, BotEditorFields.swift). Material 3, no glass.

// MARK: Shared pieces

@Composable
private fun Block(title: String, hint: String? = null, content: @Composable () -> Unit) {
  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
      if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
    }
    content()
  }
}

@Composable
private fun TextBox(text: String, onChange: (String) -> Unit, label: String, placeholder: String = "", lines: IntRange? = null, mono: Boolean = false, number: Boolean = false) {
  OutlinedTextField(
    value = text, onValueChange = onChange, label = { Text(label) },
    placeholder = if (placeholder.isEmpty()) null else ({ Text(placeholder) }),
    singleLine = lines == null, minLines = lines?.first ?: 1, maxLines = lines?.last ?: 1,
    textStyle = if (mono) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
    keyboardOptions = if (number) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
    modifier = Modifier.fillMaxWidth(),
  )
}

@Composable
private fun Note(text: String, title: String? = null, warn: Boolean = false) {
  Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
      if (title != null) Text(title, style = MaterialTheme.typography.titleSmall)
      Text(text, style = MaterialTheme.typography.bodyMedium, color = if (warn) Mercury.colors.amber else MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

@Composable
private fun PersonaEditor(persona: String, onChange: (String) -> Unit, canUndo: Boolean, busy: Boolean, structure: () -> Unit, undo: () -> Unit) {
  TextBox(persona, onChange, "Instructions", "You… When you finish, close with bot_report; if there's nothing new, call bot_no_update.", 6..14)
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    OutlinedButton(onClick = structure, enabled = !busy && persona.trim().length >= 10) {
      if (busy) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp) else Icon(Icons.Outlined.AutoAwesome, null, Modifier.size(16.dp))
      Spacer(Modifier.width(6.dp))
      Text(if (busy) "Structuring… (10–60 s)" else "Structure with the persona builder")
    }
    if (canUndo && !busy) TextButton(onClick = undo) { Text("Undo") }
  }
}

/** Schedules, each picked in words, with what to do each time. */
@Composable
internal fun ScheduleListEditor(schedules: List<BotSchedule>, onChange: (List<BotSchedule>) -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    if (schedules.isEmpty()) Text("No schedule: it runs when you message it or tap Run now.", style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.ink3)
    schedules.forEachIndexed { i, s ->
      fun set(n: BotSchedule) = onChange(schedules.toMutableList().also { it[i] = n })
      Surface(shape = MaterialTheme.shapes.large, border = BorderStroke(1.dp, Mercury.colors.line), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.weight(1f)) { SchedulePicker(s.cron) { set(s.copy(cron = it)) } }
            IconButton(onClick = { onChange(schedules.filterIndexed { j, _ -> j != i }) }) { Icon(Icons.Outlined.Delete, "Remove this schedule", tint = Mercury.colors.ink3) }
          }
          TextBox(s.prompt, { set(s.copy(prompt = it)) }, "What to do each time", "…and when to report nothing", 2..5)
        }
      }
    }
    TextButton(onClick = { onChange(schedules + BotSchedule(BotForms.nextRoutineName(schedules), "0 9 * * *", "")) }) {
      Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(6.dp)); Text("Add a schedule")
    }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SchedulePicker(cron: String, onChange: (String) -> Unit) {
  val rule = ScheduleRule.from(cron)
  val context = LocalContext.current
  var open by remember { mutableStateOf(false) }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Box {
      TextButton(onClick = { open = true }, contentPadding = PaddingValues(horizontal = 4.dp)) {
        Text(rule.words, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
      }
      DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        ScheduleRule.Kind.entries.forEach { k ->
          DropdownMenuItem(text = { Text(k.title) }, onClick = { open = false; onChange(rule.with(k).cron) })
        }
      }
    }
    when (rule) {
      is ScheduleRule.EveryMinutes -> FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ScheduleRule.MINUTE_STEPS.forEach { n -> FilterChip(selected = rule.n == n, onClick = { onChange(ScheduleRule.EveryMinutes(n).cron) }, label = { Text("$n min") }) }
      }
      is ScheduleRule.EveryHours -> FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ScheduleRule.HOUR_STEPS.forEach { n -> FilterChip(selected = rule.n == n, onClick = { onChange(ScheduleRule.EveryHours(n).cron) }, label = { Text("$n h") }) }
      }
      is ScheduleRule.Custom -> {
        TextBox(cron, onChange, "Cron", "0 9 * * *", mono = true)
        Text("Minute, hour, day of month, month, weekday.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink4)
      }
      else -> {
        if (rule is ScheduleRule.Weekly) FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
          (1..7).map { it % 7 }.forEach { d ->
            FilterChip(selected = rule.day == d, onClick = { onChange(ScheduleRule.Weekly(d, rule.hourOfDay, rule.minuteOfHour).cron) },
              label = { Text(ScheduleRule.DAY_NAMES[d].take(3)) })
          }
        }
        OutlinedButton(onClick = {
          TimePickerDialog(context, { _, h, m -> onChange(rule.at(h, m).cron) }, rule.hourOfDay, rule.minuteOfHour, true).show()
        }) { Text("At ${ScheduleRule.time(rule.hourOfDay, rule.minuteOfHour)}") }
      }
    }
    if (BotForms.tooFrequent(cron)) Text("Mercury runs a schedule at most every 15 minutes, so this runs every 15 minutes.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.amber)
  }
}

/** What it may do, in plain words. Runs commands and Full access need the owner's approval from a phone. */
@Composable
internal fun TierPicker(value: String, tiers: List<String>, onChange: (String) -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    if (value == "custom") Note("This bot's permissions were edited by hand (its permissions.yaml). Picking a level below replaces them.", warn = true)
    tiers.forEach { id ->
      val w = BotTiers.words(id)
      Surface(
        shape = MaterialTheme.shapes.medium, border = BorderStroke(1.dp, if (value == id) MaterialTheme.colorScheme.outline else Mercury.colors.line),
        color = if (value == id) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().selectable(selected = value == id, role = Role.RadioButton) { onChange(id) },
      ) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.Top) {
          RadioButton(selected = value == id, onClick = null, modifier = Modifier.padding(top = 2.dp, end = 10.dp))
          Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
              Text(w?.title ?: id, style = MaterialTheme.typography.titleSmall)
              if (id == "readonly") Text("recommended", style = MaterialTheme.typography.labelSmall, color = Mercury.colors.ink4)
              if (BotTiers.needsOwner(id)) Icon(Icons.Outlined.Lock, "Needs your approval", Modifier.size(14.dp), tint = Mercury.colors.amber)
            }
            Text(w?.let { "${it.can} ${it.cant}" } ?: id, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
          }
        }
      }
    }
    if (BotTiers.needsOwner(value)) Text("From your phone this needs your approval on the computer first.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.amber)
  }
}

@Composable
internal fun ModelBudget(model: BotModelRef?, budget: String, catalog: ModelCatalog?, onModel: (BotModelRef?) -> Unit, onBudget: (String) -> Unit, placeholder: String = "Fleet default") {
  var open by remember { mutableStateOf(false) }
  val title = model?.let { m -> catalog?.models?.firstOrNull { it.same(m.provider, m.model.orEmpty()) }?.let { "${it.title} · ${it.name}" } ?: "${m.model ?: "default"} · ${m.provider}" }
    ?: ("Mercury's default" + (catalog?.defaultChoice?.let { " (${it.title})" } ?: ""))
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Box {
      OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(title, maxLines = 1) }
      DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(text = { Text("Mercury's default") }, onClick = { open = false; onModel(null) })
        ModelMenu.groups(catalog?.models.orEmpty().filter { it.available }).forEach { g ->
          HorizontalDivider()
          Text(g.title, style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
          g.models.forEach { m -> DropdownMenuItem(text = { Text(m.title) }, onClick = { open = false; onModel(BotModelRef(m.name, m.model)) }) }
        }
      }
    }
    TextBox(budget, onBudget, "Daily token budget", placeholder, mono = true, number = true)
    Text("It pauses until tomorrow when it's spent.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink4)
  }
}

@Composable
internal fun CrewEditor(crew: List<CrewSpec>, max: Int, onChange: (List<CrewSpec>) -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    crew.forEachIndexed { i, c ->
      fun set(n: CrewSpec) = onChange(crew.toMutableList().also { it[i] = n })
      Surface(shape = MaterialTheme.shapes.large, border = BorderStroke(1.dp, Mercury.colors.line), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { TextBox(c.name, { set(c.copy(name = it)) }, "Name", "e.g. Fact Checker") }
            IconButton(onClick = { onChange(crew.filterIndexed { j, _ -> j != i }) }) { Icon(Icons.Outlined.Delete, "Remove crew member", tint = Mercury.colors.ink3) }
          }
          TextBox(c.description, { set(c.copy(description = it)) }, "What it does, in one line")
          TextBox(c.persona, { set(c.copy(persona = it)) }, "Instructions", "How it works and what it hands back to the lead.", 2..6)
        }
      }
    }
    if (crew.size < max) TextButton(onClick = { onChange(crew + CrewSpec()) }) { Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(6.dp)); Text("Add a crew member") }
  }
}

// MARK: New bot

private val EXAMPLES = listOf(
  "Every morning at 8, brief me on AI news: five items with links.",
  "Watch Hacker News for posts about Rust and tell me about new ones.",
  "Every Friday, draft a newsletter from what I saved this week.",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewBotPage(vm: BotsViewModel, onDone: (String?) -> Unit) {
  val form = remember(vm) { NewBotForm(vm.client, vm.ui.value.bots.map { it.id }) }
  val gate = rememberOwnerGate(vm.client)
  val scope = rememberCoroutineScope()
  LaunchedEffect(form) { form.loadChoices() }
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("New bot") },
        navigationIcon = {
          IconButton(onClick = { if (form.step == NewBotForm.Step.Form && form.createdId == null) form.step = NewBotForm.Step.Describe else onDone(form.createdId) }) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
          }
        },
      )
    },
    bottomBar = {
      Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        form.error?.let { ErrorText(it) }
        val busy = form.busy != null
        when {
          form.step == NewBotForm.Step.Describe -> {
            Button(onClick = { scope.launch { form.draft() } }, enabled = !busy && form.ask.trim().length >= 10, modifier = Modifier.fillMaxWidth().height(52.dp)) {
              if (form.busy == NewBotForm.Busy.Drafting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Draft it")
            }
            TextButton(onClick = form::manual, modifier = Modifier.fillMaxWidth()) { Text("Fill it in myself") }
          }
          form.createdId != null -> Button(onClick = { onDone(form.createdId) }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Close") }
          else -> Button(
            onClick = { scope.launch { val id = form.create(gate); if (id != null && form.error == null) onDone(id) } },
            enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp),
          ) {
            if (form.busy == NewBotForm.Busy.Creating) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Text(if (form.asFleet) "Create the fleet (${form.crew.count { it.name.isNotBlank() } + 1} bots)" else "Create bot")
          }
        }
      }
    },
  ) { pad ->
    LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
      if (form.step == NewBotForm.Step.Describe) {
        item {
          Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("What should it do?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("Say it in your own words: the job, when, and what a good result is. Mercury drafts the bot; you check every part before anything is made.",
              style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
        item { TextBox(form.ask, { form.ask = it }, "What the bot should do", "e.g. Every weekday at 7:30, summarise my calendar and the weather.", 5..10) }
        item {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Or start from one of these", style = MaterialTheme.typography.labelLarge, color = Mercury.colors.ink3)
            EXAMPLES.forEach { e ->
              Surface(onClick = { form.ask = e }, shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
                Text(e, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
              }
            }
          }
        }
        if (form.busy == NewBotForm.Busy.Drafting) item { Text("Mercury is drafting it (10–60 s)…", color = Mercury.colors.ink3) }
      } else {
        val f = form.fields
        form.plan?.let { p ->
          item { Note(p.reason.ifEmpty { "Check the draft below, then create it." }, if (form.asFleet) "Mercury suggests a fleet of ${form.crew.size + 1}" else "Mercury suggests one bot") }
        }
        form.note?.let { item { Note(it, warn = true) } }
        item { Block("Name", "Its id will be ${form.id}.") { TextBox(f.name, { form.fields = f.copy(name = it) }, "Name", "e.g. Rust Watcher") } }
        item { Block("What it's for", "One line, shown in the bot list.") { TextBox(f.description, { form.fields = f.copy(description = it) }, "Description") } }
        item {
          Block("How it works", "Its instructions. Say what a good result is, and when there's nothing to report.") {
            PersonaEditor(f.persona, { form.fields = f.copy(persona = it) }, form.personaBefore != null, form.busy == NewBotForm.Busy.Structuring,
              { scope.launch { form.structure() } }, form::undoStructure)
          }
        }
        item {
          Block(if (form.asFleet) "The crew" else "Alone or a team",
            if (form.asFleet) "${f.name.ifEmpty { "This bot" }} leads them. They get its permission level." else "One bot is cheapest: every hand-off in a fleet is an extra run.") {
            if (form.asFleet) {
              CrewEditor(form.crew, form.maxCrew) { form.crew = it }
              TextButton(onClick = { form.asFleet = false; form.crew = emptyList() }) { Text("Make it one bot instead") }
            } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              OutlinedButton(onClick = { scope.launch { form.askForTeam() } }, enabled = form.busy == null) {
                Text(if (form.busy == NewBotForm.Busy.Planning) "Mercury is planning…" else "Let Mercury design a team")
              }
              OutlinedButton(onClick = { form.asFleet = true; form.crew = listOf(CrewSpec()) }) { Text("Write the crew") }
            }
          }
        }
        item { Block("When it runs", "Between two runs of one schedule there are always at least 15 minutes.") { ScheduleListEditor(f.schedules) { form.fields = form.fields.copy(schedules = it) } } }
        item { Block("What it may do", if (form.asFleet) "Its crew get the same level." else null) { TierPicker(f.tier, form.tiers) { form.fields = form.fields.copy(tier = it) } } }
        item {
          Block("Model and budget") {
            ModelBudget(f.model, f.budget, form.catalog, { form.fields = form.fields.copy(model = it) }, { form.fields = form.fields.copy(budget = it) }, "1000000")
          }
        }
      }
    }
  }
  OwnerGateSheet(gate)
}

// MARK: Edit a bot

/** A photo made a small JPEG (the runtime takes 2 MB at most). */
private fun shrink(bytes: ByteArray, maxSide: Int = 512): ByteArray? {
  val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
  val scale = minOf(1f, maxSide.toFloat() / maxOf(src.width, src.height))
  val out = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt().coerceAtLeast(1), (src.height * scale).toInt().coerceAtLeast(1), true) else src
  return ByteArrayOutputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 85, it); it.toByteArray() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditBotPage(vm: BotsViewModel, status: BotStatus, onDone: () -> Unit) {
  val form = remember(status.id) { EditBotForm(vm.client, status.id, status.tier) }
  val gate = rememberOwnerGate(vm.client)
  val scope = rememberCoroutineScope()
  val context = LocalContext.current
  var hasAvatar by remember { mutableStateOf(status.hasAvatar == true) }
  var faceVersion by remember { mutableStateOf(0) }
  LaunchedEffect(form) { form.load() }
  val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
    if (uri != null) scope.launch {
      val jpeg = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use { it.readBytes() }?.let { shrink(it) } }
      if (jpeg == null) form.error = "That photo's format isn't supported."
      else if (form.setAvatar(jpeg)) { BotAvatarCache.forget(vm.client, status.id); hasAvatar = true; faceVersion++; vm.load() }
    }
  }
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Edit ${status.name}") },
        navigationIcon = { IconButton(onClick = onDone) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        actions = {
          if (form.busy) CircularProgressIndicator(Modifier.size(22.dp).padding(end = 4.dp), strokeWidth = 2.dp)
          else TextButton(onClick = { scope.launch { if (form.save(gate)) { vm.load(); onDone() } } }, enabled = form.loaded && form.dirty) { Text("Save") }
        },
      )
    },
  ) { pad ->
    if (!form.loaded) {
      Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    } else if (form.bot == null) {
      ErrorText(form.error ?: "Couldn't load this bot.", Modifier.padding(pad).padding(16.dp))
    } else {
      val f = form.fields
      LazyColumn(Modifier.fillMaxSize().padding(pad).imePadding(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        form.error?.let { item { ErrorText(it) } }
        item {
          Block("Face", "A photo, or the face Mercury draws from its id.") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
              androidx.compose.runtime.key(faceVersion) { BotAvatar(status.id, f.name, hasAvatar = hasAvatar, size = 64.dp, client = vm.client) }
              Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                OutlinedButton(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !form.avatarBusy) { Text("Choose a photo") }
                if (hasAvatar) TextButton(onClick = {
                  scope.launch { if (form.removeAvatar()) { BotAvatarCache.forget(vm.client, status.id); hasAvatar = false; faceVersion++; vm.load() } }
                }, enabled = !form.avatarBusy) { Text("Use the drawn face") }
              }
            }
          }
        }
        item {
          Block("Name") {
            TextBox(f.name, { form.fields = f.copy(name = it) }, "Name")
            TextBox(f.description, { form.fields = form.fields.copy(description = it) }, "What it's for, in one line")
          }
        }
        item {
          Block("How it works", "Its instructions. Say what a good result is, and when there's nothing to report.") {
            PersonaEditor(f.persona, { form.fields = f.copy(persona = it) }, form.personaBefore != null, form.structuring, { scope.launch { form.structure() } }, form::undoStructure)
          }
        }
        item { Block("When it runs", "Changes apply right away. Between two runs of one schedule there are always at least 15 minutes.") { ScheduleListEditor(f.schedules) { form.fields = form.fields.copy(schedules = it) } } }
        item { Block("What it may do", if (status.fleetRole == "lead") "Its crew keep their own level." else null) { TierPicker(f.tier, form.tiers) { form.fields = form.fields.copy(tier = it) } } }
        item { Block("Model and budget") { ModelBudget(f.model, f.budget, form.catalog, { form.fields = form.fields.copy(model = it) }, { form.fields = form.fields.copy(budget = it) }) } }
      }
    }
  }
  OwnerGateSheet(gate)
}

// MARK: Manage a bot

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotManageSheet(vm: BotsViewModel, bot: BotStatus, crewCount: Int, onDismiss: () -> Unit, onEdit: () -> Unit, onDeleted: () -> Unit) {
  val scope = rememberCoroutineScope()
  var note by remember { mutableStateOf<String?>(null) }
  var working by remember { mutableStateOf(false) }
  var confirmDelete by remember { mutableStateOf(false) }
  var addingCrew by remember { mutableStateOf(false) }
  fun act(c: BotControl) = scope.launch { working = true; note = vm.control(c, bot.id); working = false }

  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        BotAvatar(bot.id, bot.name, hasAvatar = bot.hasAvatar == true, size = 48.dp, dimmed = bot.isOff, client = vm.client)
        Column(Modifier.weight(1f)) {
          Text(bot.name, style = MaterialTheme.typography.titleMedium)
          Text(line(bot, null) + (bot.tier?.let { " · " + BotTiers.title(it) } ?: ""), style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
        }
        if (working) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
      }
      note?.let { Note(it) }
      val tiles = buildList<Triple<String, ImageVector, () -> Unit>> {
        when {
          bot.stopped == true || bot.needsYou -> add(Triple("Start", Icons.Outlined.PlayArrow) { act(BotControl.Start) })
          bot.isRunning -> add(Triple("Stop", Icons.Outlined.Stop) { act(BotControl.Stop) })
          else -> add(Triple("Run now", Icons.Outlined.PlayArrow) { act(BotControl.RunNow) })
        }
        add(Triple(if (bot.enabled) "Turn off" else "Turn on", Icons.Outlined.PowerSettingsNew) { act(if (bot.enabled) BotControl.TurnOff else BotControl.TurnOn) })
        add(Triple("Edit", Icons.Outlined.Edit, onEdit))
        if (bot.fleetRole == "lead") {
          add(Triple("Add crew", Icons.Outlined.PersonAdd) { addingCrew = true })
          add(Triple("Suggest crew", Icons.Outlined.AutoAwesome) { act(BotControl.SuggestCrew) })
        } else if (bot.fleetRole != "crew") add(Triple("Make a fleet", Icons.Outlined.Groups) { act(BotControl.MakeFleet) })
        add(Triple("Delete", Icons.Outlined.Delete) { confirmDelete = true })
      }
      LazyVerticalGrid(GridCells.Fixed(2), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.height(((tiles.size + 1) / 2 * 86).dp)) {
        items(tiles) { (title, icon, action) ->
          val danger = title == "Delete"
          val disabled = working || (title == "Run now" && !bot.enabled)
          Surface(onClick = action, enabled = !disabled, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Column(Modifier.fillMaxWidth().height(76.dp).padding(14.dp), verticalArrangement = Arrangement.SpaceBetween) {
              val tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
              Icon(icon, null, tint = tint.copy(alpha = if (disabled) 0.4f else 1f))
              Text(title, color = tint.copy(alpha = if (disabled) 0.4f else 1f), style = MaterialTheme.typography.titleSmall)
            }
          }
        }
      }
      Text("To message it, use the box on its Live tab.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink4)
    }
  }
  if (confirmDelete) AlertDialog(
    onDismissRequest = { confirmDelete = false },
    title = { Text(if (crewCount > 0) "Delete ${bot.name} and its crew (${crewCount + 1} bots)?" else "Delete ${bot.name}?") },
    text = { Text("Its folder, history and schedules go too. Results it delivered stay in your files.") },
    confirmButton = {
      TextButton(onClick = {
        confirmDelete = false
        scope.launch { working = true; val e = vm.delete(bot.id); working = false; if (e == null) onDeleted() else note = e }
      }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
    },
    dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
  )
  if (addingCrew) AddCrewDialog(vm, bot) { addingCrew = false }
}

@Composable
private fun AddCrewDialog(vm: BotsViewModel, lead: BotStatus, onDismiss: () -> Unit) {
  var crew by remember { mutableStateOf(listOf(CrewSpec())) }
  var error by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("New crew member") },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("It gets ${lead.name}'s permission level. The lead hands it work and combines what it sends back.", style = MaterialTheme.typography.bodySmall)
        CrewEditor(crew, 1) { crew = it }
        error?.let { ErrorText(it) }
      }
    },
    confirmButton = {
      TextButton(enabled = !busy && crew.isNotEmpty(), onClick = {
        scope.launch { busy = true; error = vm.addCrewMember(lead.id, crew.first()); busy = false; if (error == null) onDismiss() }
      }) { Text("Add") }
    },
    dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
  )
}

/** Start all / Stop all, from the roster's menu. */
@Composable
internal fun AllBotsMenu(vm: BotsViewModel, onSaid: (String) -> Unit) {
  var open by remember { mutableStateOf(false) }
  var confirm by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  Box {
    IconButton(onClick = { open = true }) { Icon(androidx.compose.material.icons.Icons.Outlined.PowerSettingsNew, "All bots") }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      DropdownMenuItem(text = { Text("Start all") }, leadingIcon = { Icon(Icons.Outlined.PlayArrow, null) }, onClick = { open = false; scope.launch { onSaid(vm.all(stop = false)) } })
      DropdownMenuItem(text = { Text("Stop all") }, leadingIcon = { Icon(Icons.Outlined.Stop, null) }, onClick = { open = false; confirm = true })
    }
  }
  if (confirm) AlertDialog(
    onDismissRequest = { confirm = false },
    title = { Text("Stop every bot?") },
    text = { Text("Running work halts and queued work is held until you start them again.") },
    confirmButton = { TextButton(onClick = { confirm = false; scope.launch { onSaid(vm.all(stop = true)) } }) { Text("Stop all", color = MaterialTheme.colorScheme.error) } },
    dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
  )
}

