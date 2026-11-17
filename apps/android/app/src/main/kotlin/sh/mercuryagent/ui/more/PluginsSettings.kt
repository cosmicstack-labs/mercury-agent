package sh.mercuryagent.ui.more

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Mouse
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.PluginDetail
import sh.mercuryagent.core.PluginList
import sh.mercuryagent.core.Plugins
import sh.mercuryagent.core.installPlugin
import sh.mercuryagent.core.plugin
import sh.mercuryagent.core.pluginList
import sh.mercuryagent.core.setPluginEnabled
import sh.mercuryagent.core.setPluginSetting
import sh.mercuryagent.core.uninstallPlugin
import sh.mercuryagent.core.updatePlugin
import sh.mercuryagent.ui.theme.Mercury

// Settings → Plugins (iOS: PluginsSettings.swift; apps/desktop/src/views/plugins): what's installed
// (on/off, updates), what's in the catalog (Install), and each plugin's page. Every change from the
// phone goes through the owner's approval (OwnerGate); installing or turning on a plugin asks first.

// MARK: Install / turn on

/**
 * Install or turn on one plugin: ask first, wait for the owner's approval if the computer wants it,
 * do it, then watch until the plugin is running (or say why it isn't).
 */
@Stable
class PluginActionState(
  val client: MercuryClient,
  val plugin: PluginDetail,
  val install: Boolean,
  computer: String,
  val gate: OwnerGate = OwnerGate(client),
) {
  sealed interface Stage {
    data object Confirm : Stage
    /** Installing, starting… (`gate.question` set: waiting for the owner's approval). */
    data class Working(val label: String) : Stage
    data class Done(val after: Plugins.After) : Stage
    data class Failed(val why: String) : Stage
  }

  val consent: Plugins.Consent = Plugins.consent(plugin, computer, enabling = !install)
  var stage by mutableStateOf<Stage>(Stage.Confirm)
  var result by mutableStateOf<PluginDetail?>(null)
  var pollEveryMs = 1000L
  var pollTimes = 20
  val working: Boolean get() = stage is Stage.Working

  suspend fun run() {
    stage = Stage.Working(if (install) "Installing ${plugin.name}…" else "Turning on ${plugin.name}…")
    try {
      gate.run { a -> if (install) client.installPlugin(plugin.id, a) else client.setPluginEnabled(plugin.id, true, a) }
      stage = Stage.Working("Starting ${plugin.name}…")
      val (after, last) = Plugins.watch(client, plugin.id, pollTimes, pollEveryMs)
      result = last
      stage = Stage.Done(after)
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      stage = Stage.Failed(Plugins.friendlyError(e.message ?: "That didn't work.", plugin))
    }
  }
}

/** The confirm sheet, then progress, the owner's approval and the result, in one sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PluginActionSheet(state: PluginActionState, onDismiss: () -> Unit) {
  val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !state.working })
  val scope = rememberCoroutineScope()
  fun start() { if (!state.working) scope.launch { state.run() } }
  ModalBottomSheet(onDismissRequest = { if (!state.working) onDismiss() }, sheetState = sheet) {
    Column(
      Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 28.dp).navigationBarsPadding(),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      when (val s = state.stage) {
        PluginActionState.Stage.Confirm -> {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            PluginMark(state.plugin.name, 52)
            Column {
              Text(state.consent.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
              state.plugin.tier?.let { Text(tierName(it) + " plugin", style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.ink3) }
            }
          }
          Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
            when (val c = state.consent) {
              is Plugins.Consent.ControlsComputer -> Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Outlined.Mouse, null)
                Text(c.body, style = MaterialTheme.typography.bodyLarge)
              }
              is Plugins.Consent.Access -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("It can", style = MaterialTheme.typography.labelLarge, color = Mercury.colors.ink3)
                c.lines.forEach { l -> Text("•  $l", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
              }
            }
          }
          Button(onClick = { start() }, modifier = Modifier.fillMaxWidth()) { Text(if (state.install) "Install" else "Turn on") }
          OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
        }
        is PluginActionState.Stage.Working -> {
          val q = state.gate.question
          Column(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (q != null) {
              Icon(Icons.Outlined.Lock, null, modifier = Modifier.size(32.dp))
              Text("Approve on your computer · code ${q.code}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
              Text(
                q.code, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 34.sp, letterSpacing = 6.sp,
                modifier = Modifier.semantics { contentDescription = "Code " + q.code.toList().joinToString(" ") },
              )
              Text(
                "Plugins run on your computer, so changes from your phone need your go-ahead on ${q.where}. It carries on as soon as it's approved.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
              )
              Text("Waiting…", style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.ink3)
            } else {
              PluginMark(state.plugin.name, 56)
              Text(s.label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
              if (state.install && s.label.startsWith("Installing")) {
                Text("Your computer is downloading it. This can take a minute.", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3, textAlign = TextAlign.Center)
              }
            }
            LinearProgressIndicator(Modifier.fillMaxWidth(0.4f))
          }
        }
        is PluginActionState.Stage.Done -> {
          val a = s.after
          val name = state.plugin.name
          Column(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(
              when (a) {
                Plugins.After.Running, Plugins.After.NeedsSetup -> Icons.Outlined.CheckCircle
                Plugins.After.Starting, Plugins.After.Missing -> Icons.Outlined.Schedule
                is Plugins.After.Failed -> Icons.Outlined.WarningAmber
              },
              null, modifier = Modifier.size(52.dp),
            )
            Text(
              when (a) { Plugins.After.Running -> "$name is running"; is Plugins.After.Failed -> "$name didn't start"; else -> "$name is installed" },
              style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
            )
            Text(
              when (a) {
                Plugins.After.Running -> if (state.install) "Installed and turned on." else "Turned on."
                Plugins.After.NeedsSetup -> "It needs a few settings before it can do everything."
                Plugins.After.Starting, Plugins.After.Missing -> "It's still starting on your computer."
                is Plugins.After.Failed -> a.why
              },
              style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
            )
          }
          Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text(if (a == Plugins.After.NeedsSetup) "Set it up" else "Done") }
        }
        is PluginActionState.Stage.Failed -> {
          PluginMark(state.plugin.name, 52)
          Text(
            "${if (state.install) "Couldn't install" else "Couldn't turn on"} ${state.plugin.name}",
            style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
          )
          Text(s.why, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
          if (Plugins.needsComputer(s.why)) {
            // Trying again won't change the computer.
            Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Close") }
          } else {
            Button(onClick = { start() }, modifier = Modifier.fillMaxWidth()) { Text("Try again") }
            OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Close") }
          }
        }
      }
    }
  }
}

/** A plain monogram for a plugin (no logos). */
@Composable
fun PluginMark(name: String, size: Int) {
  Box(
    Modifier.size(size.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape((size * 0.28f).dp)),
    contentAlignment = Alignment.Center,
  ) {
    Text(name.take(1).uppercase(), fontSize = (size * 0.44f).sp, fontWeight = FontWeight.SemiBold)
  }
}

private fun tierName(t: String) = when (t) { "official" -> "Official"; "community" -> "Community"; else -> "Local" }

/** Which plugin a sheet is for, and whether it installs or turns on. */
private data class ActionTarget(val plugin: PluginDetail, val install: Boolean)

// MARK: The list

/** Settings → Plugins. */
@Composable
fun PluginsSettings(client: MercuryClient, computer: String, onBack: () -> Unit, onOpen: (String) -> Unit) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  var list by remember(client) { mutableStateOf<PluginList?>(null) }
  var error by remember(client) { mutableStateOf<String?>(null) }
  var canManage by remember(client) { mutableStateOf(false) }
  var action by remember(client) { mutableStateOf<ActionTarget?>(null) }
  val busy = remember(client) { mutableStateMapOf<String, Boolean>() }

  suspend fun load(refresh: Boolean = false) {
    canManage = Plugins.canManage(runCatching { client.health().features }.getOrNull())
    try { list = client.pluginList(refresh); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) {
      if (list == null) error = e.message ?: "Couldn't load the plugins."
    }
  }
  LaunchedEffect(client) { load() }

  fun turnOff(p: PluginDetail) {
    busy[p.id] = true
    scope.launchReporting(snackbar) {
      try {
        try { gate.run { a -> client.setPluginEnabled(p.id, false, a) } } catch (e: CancellationException) { throw e } catch (e: Exception) {
          throw Exception(Plugins.friendlyError(e.message ?: "That didn't work.", p))
        }
      } finally { busy.remove(p.id); load() }
    }
  }

  GatedSettingsPage("Plugins", onBack, snackbar, gate, onRefresh = { load(refresh = true) }) {
    val l = list
    if (l == null) { loadingOrError(error); return@GatedSettingsPage }
    if (l.safeMode) item(key = "safe") { SettingsFooter("Mercury is in safe mode, so plugins are off until it restarts normally.") }
    val installed = Plugins.installed(l.items)
    val available = Plugins.available(l.items)
    item(key = "installed:header") { SettingsHeader("Installed") }
    if (installed.isEmpty()) item(key = "installed:none") { ListItem(headlineContent = { Text("No plugins yet.", color = Mercury.colors.ink3) }) }
    items(installed, key = { "i:${it.id}" }) { p ->
      PluginListRow(p, onClick = { onOpen(p.id) }) {
        if (canManage) {
          if (busy[p.id] == true) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
          else Switch(checked = p.enabled, onCheckedChange = { on -> if (on) action = ActionTarget(p, install = false) else turnOff(p) })
        }
      }
    }
    if (!canManage) item(key = "readonly") { SettingsFooter("To install or change plugins from your phone, update Mercury on your computer.") }
    if (available.isNotEmpty()) {
      item(key = "available:header") { SettingsHeader("Available") }
      items(available, key = { "a:${it.id}" }) { p ->
        PluginListRow(p, onClick = { onOpen(p.id) }) {
          if (canManage && p.status != "incompatible") FilledTonalButton(onClick = { action = ActionTarget(p, install = true) }) { Text("Install") }
        }
      }
      l.catalogError?.let { e -> item(key = "catalog:error") { SettingsFooter("The catalog couldn't be checked: $e") } }
    }
  }

  action?.let { t ->
    val state = remember(t) { PluginActionState(client, t.plugin, t.install, computer) }
    PluginActionSheet(state) { action = null; scope.launch { load() } }
  }
}

/** A plugin's name, version or what it does, its state, and "Update available". */
@Composable
private fun PluginListRow(p: PluginDetail, onClick: () -> Unit, trailing: @Composable () -> Unit) {
  val (line, tone) = Plugins.statusLine(p)
  ListItem(
    leadingContent = { PluginMark(p.name, 40) },
    headlineContent = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(p.name)
        (p.installedVersion ?: p.latestVersion)?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3) }
      }
    },
    supportingContent = {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (line.isNotEmpty()) {
          Text(
            line, maxLines = 2, overflow = TextOverflow.Ellipsis,
            color = when (tone) { Plugins.Tone.Warn -> Mercury.colors.amber; Plugins.Tone.Good -> MaterialTheme.colorScheme.onSurfaceVariant; Plugins.Tone.Off -> Mercury.colors.ink3 },
          )
        }
        if (Plugins.updateAvailable(p)) {
          Text(
            "Update available", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp),
          )
        }
      }
    },
    trailingContent = { trailing() },
    modifier = Modifier.clickable(onClickLabel = "Open ${p.name}", onClick = onClick),
  )
}

// MARK: One plugin

/** A plugin's page: what it is and can reach, Install or on/off, its settings, Update, Uninstall. */
@Composable
fun PluginDetailSettings(client: MercuryClient, computer: String, id: String, onBack: () -> Unit) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  var plugin by remember(client, id) { mutableStateOf<PluginDetail?>(null) }
  var error by remember(client, id) { mutableStateOf<String?>(null) }
  var canManage by remember(client) { mutableStateOf(false) }
  var busy by remember(client, id) { mutableStateOf<String?>(null) }
  var action by remember(client, id) { mutableStateOf<ActionTarget?>(null) }
  var confirmRemove by remember(client, id) { mutableStateOf(false) }
  val values = remember(client, id) { mutableStateMapOf<String, JsonElement>() }

  suspend fun load() {
    canManage = Plugins.canManage(runCatching { client.health().features }.getOrNull())
    try {
      plugin = client.plugin(id); error = if (plugin == null) "There's no plugin called $id." else null
    } catch (e: CancellationException) { throw e } catch (e: Exception) { if (plugin == null) error = e.message ?: "Couldn't load the plugin." }
  }
  LaunchedEffect(client, id) { load() }

  fun change(what: String, after: () -> Unit = {}, run: suspend (String?) -> Unit) {
    val p = plugin ?: return
    busy = what
    scope.launchReporting(snackbar) {
      try {
        try { gate.run { a -> run(a) } } catch (e: CancellationException) { throw e } catch (e: Exception) {
          throw Exception(Plugins.friendlyError(e.message ?: "That didn't work.", p))
        }
        after()
      } finally { busy = null; load() }
    }
  }

  fun save(f: sh.mercuryagent.core.PluginField, v: JsonElement) {
    val p = plugin ?: return
    val old = values[f.key]
    if (f.type != "secret") values[f.key] = v
    scope.launchReporting(snackbar) {
      try { gate.run { a -> client.setPluginSetting(p.id, f.key, v, approval = a) } } catch (e: Exception) {
        if (old != null) values[f.key] = old else values.remove(f.key)
        throw e
      }
      load(); values.remove(f.key)
    }
  }

  val p = plugin
  GatedSettingsPage(p?.name ?: "Plugin", onBack, snackbar, gate, onRefresh = { load() }) {
    if (p == null) { loadingOrError(error); return@GatedSettingsPage }
    val installed = Plugins.isInstalled(p)
    item(key = "head") {
      Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
          PluginMark(p.name, 52)
          Column {
            Text(p.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            val sub = listOfNotNull((p.installedVersion ?: p.latestVersion)?.let { "Version $it" }, p.tier?.let { tierName(it) }).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
          }
        }
        p.description?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (installed) {
          val (line, tone) = Plugins.statusLine(p)
          StatusText(line, when (tone) { Plugins.Tone.Good -> StatusTone.Good; Plugins.Tone.Warn -> StatusTone.Warn; Plugins.Tone.Off -> StatusTone.Off })
        } else if (p.status == "incompatible") {
          Text(
            p.incompatibleReason?.let { Plugins.friendlyError("can't be installed here: $it", p) } ?: "It can't be installed on this computer.",
            style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.amber,
          )
        }
      }
    }
    if (canManage) {
      if (!installed) {
        if (p.status != "incompatible") item(key = "install") {
          Button(onClick = { action = ActionTarget(p, install = true) }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) { Text("Install ${p.name}") }
        }
      } else {
        item(key = "on") {
          SwitchRow("On", p.enabled, enabled = busy == null) { on ->
            if (on) action = ActionTarget(p, install = false)
            else change("disable") { a -> client.setPluginEnabled(p.id, false, a) }
          }
        }
        if (Plugins.updateAvailable(p)) item(key = "update") {
          ListItem(
            headlineContent = { Text("Update to ${p.latestVersion ?: "the latest version"}") },
            trailingContent = { if (busy == "update") CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) },
            modifier = Modifier.clickable(enabled = busy == null) { change("update") { a -> client.updatePlugin(p.id, a) } },
          )
        }
      }
    }
    item(key = "can:header") { SettingsHeader("What it can do") }
    items(Plugins.accessLines(p, computer), key = { "can:$it" }) { l -> ListItem(headlineContent = { Text(l, style = MaterialTheme.typography.bodyMedium) }) }
    if (Plugins.controlsComputer(p)) item(key = "can:asks") {
      ListItem(headlineContent = { Text("It asks before anything that submits, sends or deletes.", style = MaterialTheme.typography.bodyMedium) })
    }
    if (installed) {
      if (p.missing.isNotEmpty()) {
        item(key = "missing:header") { SettingsHeader("Needs setting up") }
        p.missing.forEachIndexed { i, m ->
          item(key = "missing:$i:${m.key}") {
            ListItem(
              headlineContent = { Text(m.needs) }, supportingContent = { Text(m.fix) },
              leadingContent = { Icon(Icons.Outlined.WarningAmber, null, tint = Mercury.colors.amber) },
            )
          }
        }
      }
      pluginForm(p.settings, p.settingGroups, values) { f, v -> save(f, v) }
      if (canManage) {
        item(key = "remove") {
          ListItem(
            headlineContent = { Text("Uninstall ${p.name}", color = MaterialTheme.colorScheme.error) },
            supportingContent = { Text("Its settings stay on your computer in case you install it again.") },
            modifier = Modifier.clickable(enabled = busy == null) { confirmRemove = true },
          )
        }
      }
    }
  }

  if (confirmRemove) {
    val name = p?.name.orEmpty()
    AlertDialog(
      onDismissRequest = { confirmRemove = false },
      title = { Text("Uninstall $name?") },
      text = { Text("Mercury stops using it on $computer.") },
      confirmButton = {
        TextButton(onClick = {
          confirmRemove = false
          change("remove", after = onBack) { a -> client.uninstallPlugin(id, approval = a) }
        }) { Text("Uninstall", color = MaterialTheme.colorScheme.error) }
      },
      dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Cancel") } },
    )
  }
  action?.let { t ->
    val state = remember(t) { PluginActionState(client, t.plugin, t.install, computer) }
    PluginActionSheet(state) { action = null; scope.launch { load() } }
  }
}
