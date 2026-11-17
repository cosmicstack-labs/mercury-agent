package sh.mercuryagent.ui.more

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import sh.mercuryagent.core.ChannelInfo
import sh.mercuryagent.core.ChannelPerson
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.channelAccess
import sh.mercuryagent.core.channels
import sh.mercuryagent.core.checkChannel
import sh.mercuryagent.core.saveChannel
import sh.mercuryagent.core.settingText
import sh.mercuryagent.ui.theme.Mercury

/**
 * Channels: the places people talk to Mercury besides this app, and who may (iOS: ChannelsSettings;
 * apps/desktop/src/views/settings/Channels.tsx). Requests arrive while you look, so it refreshes every 6 s.
 */
@Composable
fun ChannelsSettings(client: MercuryClient, onBack: () -> Unit) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  var channels by remember(client) { mutableStateOf<List<ChannelInfo>>(emptyList()) }
  var loaded by remember(client) { mutableStateOf(false) }
  var loadError by remember(client) { mutableStateOf<String?>(null) }
  var open by rememberSaveable { mutableStateOf<String?>(null) }

  suspend fun load() {
    try {
      channels = client.channels(); loadError = null
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      loadError = e.message
    }
    loaded = true
  }

  LaunchedEffect(client) {
    while (true) {
      load()
      delay(6000)
    }
  }

  val channel = open?.let { t -> channels.firstOrNull { it.type == t } }
  if (channel != null) {
    BackHandler { open = null }
    ChannelDetail(
      client, channel, gate, snackbar, onBack = { open = null },
      changed = { c -> channels = channels.map { if (it.type == c.type) c else it } },
      reload = { load() },
    )
    return
  }

  val waiting = channels.sumOf { it.access.pending.size }
  GatedSettingsPage("Channels", onBack, snackbar, gate, onRefresh = { load() }) {
    if (!loaded || (channels.isEmpty() && loadError != null)) {
      loadingOrError(loadError)
      return@GatedSettingsPage
    }
    loadError?.let { e -> item { SettingsFooter(e) } }
    if (waiting > 0) item {
      ListItem(
        headlineContent = { Text("$waiting ${if (waiting == 1) "person is" else "people are"} waiting for your approval") },
        leadingContent = { Icon(Icons.Outlined.PersonAdd, null, tint = Mercury.colors.amber) },
      )
    }
    items(channels, key = { it.type }) { c -> ChannelRow(c) { open = c.type } }
    item { SettingsFooter("WhatsApp is a plugin: set it up in Plugins on your computer.") }
  }
}

@Composable
private fun ChannelRow(channel: ChannelInfo, onClick: () -> Unit) {
  val pending = channel.access.pending.size
  ListItem(
    headlineContent = { Text(channel.label.ifEmpty { channel.type }) },
    supportingContent = {
      when {
        channel.running -> StatusText("Running", StatusTone.Good)
        !channel.configured -> StatusText("Not set up", StatusTone.Off)
        channel.enabled -> StatusText("Not connected", StatusTone.Warn)
        else -> StatusText("Off", StatusTone.Off)
      }
    },
    trailingContent = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (pending > 0) {
          Badge(
            containerColor = Mercury.colors.amber, contentColor = Color.Black,
            modifier = Modifier.clearAndSetSemantics { contentDescription = "$pending waiting" },
          ) { Text("$pending") }
        }
        Chevron()
      }
    },
    modifier = Modifier.clickable(onClickLabel = "Open ${channel.label}", onClick = onClick),
  )
}

/** What a channel needs to connect (the same fields Mercury Desktop asks for). */
private data class ChannelField(
  val key: String,
  val label: String,
  val placeholder: String,
  val hint: String,
  val secret: Boolean = false,
  val optional: Boolean = false,
) {
  companion object {
    val all: Map<String, List<ChannelField>> = mapOf(
      "telegram" to listOf(
        ChannelField("botToken", "Bot token", "123456789:AAE…", "In Telegram, message @BotFather: /newbot (or /token for an existing bot), then paste the token.", secret = true),
      ),
      "discord" to listOf(
        ChannelField("botToken", "Bot token", "MTIz…", "Developer Portal → your application → Bot → Reset Token. Turn on Message Content Intent there too.", secret = true),
        ChannelField("guildId", "Server ID", "123456789012345678", "Only answer in this server.", optional = true),
        ChannelField("channelId", "Channel ID", "123456789012345678", "Only answer in this channel. Leave empty for any channel the bot can see.", optional = true),
        ChannelField("adminRoleName", "Admin role", "Mercury Admin", "Members with this role (or server admins) can approve people from Discord.", optional = true),
      ),
      "slack" to listOf(
        ChannelField("botToken", "Bot token", "xoxb-…", "Your Slack app → OAuth & Permissions → Bot User OAuth Token.", secret = true),
        ChannelField("appToken", "App-level token", "xapp-…", "Basic Information → App-Level Tokens, with connections:write. Turn on Socket Mode.", secret = true),
        ChannelField("channelId", "Channel ID", "C0123456789", "Only answer mentions in this channel.", optional = true),
      ),
      "signal" to listOf(
        ChannelField("phoneNumber", "Phone number", "+923001234567", "The Signal account Mercury uses, with country code. Link it on your computer."),
        ChannelField("groupName", "Group name", "Mercury", "Group mode: Mercury answers in the Signal group with this name.", optional = true),
      ),
    )

    val howToJoin: Map<String, String> = mapOf(
      "telegram" to "People open your bot in Telegram and send /start. Their request shows up here.",
      "discord" to "People talk to Mercury in the channel you set, or DM the bot /start; requests show up here.",
      "slack" to "People DM the Mercury app /start (the first person becomes the admin). Later requests show up here.",
      "signal" to "In group mode, people send /pair in the group. In private mode, only you can talk to it.",
    )
  }
}

@Composable
private fun ChannelDetail(
  client: MercuryClient,
  channel: ChannelInfo,
  gate: OwnerGate,
  snackbar: SnackbarHostState,
  onBack: () -> Unit,
  changed: (ChannelInfo) -> Unit,
  reload: suspend () -> Unit,
) {
  val scope = rememberCoroutineScope()
  val draft = remember(channel.type) { mutableStateMapOf<String, String>() }
  var busy by remember { mutableStateOf(false) }
  var note by remember(channel.type) { mutableStateOf<Pair<String, Boolean>?>(null) }
  val fields = ChannelField.all[channel.type].orEmpty()
  fun saved(f: ChannelField): String = channel.settings[f.key].settingText

  /** Saves [patch]; true when it went through. */
  suspend fun save(patch: JsonObject): Boolean = try {
    changed(gate.run { a -> client.saveChannel(channel.type, patch, approval = a) })
    true
  } catch (e: CancellationException) {
    throw e
  } catch (e: Exception) {
    snackbar.showSnackbar(e.message ?: "Couldn't save it.", withDismissAction = true)
    false
  }

  fun access(action: String, p: ChannelPerson) = scope.launchReporting(snackbar) {
    changed(gate.run { a -> client.channelAccess(channel.type, action, p.id, approval = a) })
  }

  fun checkAndSave() = scope.launchReporting(snackbar) {
    busy = true
    try {
      val patch = JsonObject(draft.filterValues { it.isNotEmpty() }.mapValues { JsonPrimitive(it.value) })
      val c = client.checkChannel(channel.type, patch)
      if (!c.ok) {
        note = c.message.ifEmpty { "That didn't work." } to false
      } else if (save(patch)) {
        note = (c.identity?.let { "Connected as $it" } ?: c.message) to true
        draft.clear()
      }
    } finally { busy = false }
  }

  GatedSettingsPage(channel.label.ifEmpty { channel.type }, onBack, snackbar, gate, onRefresh = reload) {
    item {
      SwitchRow("On", channel.enabled, supporting = ChannelField.howToJoin[channel.type], enabled = channel.configured && !busy) { v ->
        scope.launchReporting(snackbar) { save(buildJsonObject { put("enabled", v) }) }
      }
    }

    item { SettingsHeader("Connection") }
    items(fields, key = { "field:${it.key}" }) { f ->
      val savedText = saved(f)
      OutlinedTextField(
        value = draft[f.key] ?: (if (f.secret) "" else savedText),
        onValueChange = { draft[f.key] = it },
        label = { Text(f.label + if (f.optional) " (optional)" else "") },
        placeholder = { Text(if (f.secret && savedText.isNotEmpty()) savedText else f.placeholder, maxLines = 1) },
        supportingText = { Text(f.hint) },
        singleLine = true,
        visualTransformation = if (f.secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
          keyboardType = when { f.secret -> KeyboardType.Password; f.key == "phoneNumber" -> KeyboardType.Phone; else -> KeyboardType.Text },
          autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None,
        ),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
      )
    }
    item {
      Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
          Button(onClick = { checkAndSave() }, enabled = !busy && draft.values.any { it.isNotEmpty() }) {
            Text(if (busy) "Checking…" else "Check and save")
          }
          if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
        note?.let { (text, ok) -> StatusText(text, if (ok) StatusTone.Good else StatusTone.Warn) }
      }
    }

    if (channel.access.pending.isNotEmpty()) {
      item { SettingsHeader("Waiting for you") }
      items(channel.access.pending, key = { "pending:${it.id}" }) { p ->
        Column(Modifier.fillMaxWidth()) {
          PersonRow(p)
          Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { access("approve", p) }) { Text("Let in") }
            OutlinedButton(onClick = { access("reject", p) }, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
              Text("Decline")
            }
          }
        }
      }
    }
    people("Admins", channel.access.admins, "Make member", "demote") { a, p -> access(a, p) }
    people("Members", channel.access.members, "Make admin", "promote") { a, p -> access(a, p) }
  }
}

private fun androidx.compose.foundation.lazy.LazyListScope.people(
  title: String,
  list: List<ChannelPerson>,
  swapLabel: String,
  swapAction: String,
  act: (String, ChannelPerson) -> Unit,
) {
  if (list.isEmpty()) return
  item(key = "h:$title") { SettingsHeader(title) }
  items(list, key = { "$title:${it.id}" }) { p ->
    var menu by remember { mutableStateOf(false) }
    PersonRow(p) {
      Box {
        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "Options for ${p.name}") }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
          DropdownMenuItem(text = { Text(swapLabel) }, onClick = { menu = false; act(swapAction, p) })
          DropdownMenuItem(
            text = { Text("Remove", color = MaterialTheme.colorScheme.error) },
            onClick = { menu = false; act("remove", p) },
          )
        }
      }
    }
  }
}

@Composable
private fun PersonRow(person: ChannelPerson, trailing: (@Composable () -> Unit)? = null) {
  ListItem(
    headlineContent = { Text(person.name.ifEmpty { person.id }) },
    supportingContent = (person.detail ?: person.code)?.let { { Text(it) } },
    trailingContent = trailing,
  )
}
