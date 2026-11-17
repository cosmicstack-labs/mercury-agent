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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.ProviderCheck
import sh.mercuryagent.core.ProviderInfo
import sh.mercuryagent.core.ProviderSettings
import sh.mercuryagent.core.RoleChoice
import sh.mercuryagent.core.VoiceCapabilities
import sh.mercuryagent.core.checkProvider
import sh.mercuryagent.core.forgetProviderKey
import sh.mercuryagent.core.providerSettings
import sh.mercuryagent.core.saveProvider
import sh.mercuryagent.core.setModelRoles
import sh.mercuryagent.core.voiceCapabilities

/**
 * Models: the model Mercury chats with, the ones learning and bot crews use, and every provider
 * with its key (iOS: ModelsSettings; apps/desktop/src/views/settings/Models.tsx).
 */
@Composable
fun ModelsSettings(client: MercuryClient, onBack: () -> Unit, onVoice: () -> Unit = {}) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  var settings by remember(client) { mutableStateOf<ProviderSettings?>(null) }
  var loadError by remember(client) { mutableStateOf<String?>(null) }
  var openProvider by rememberSaveable { mutableStateOf<String?>(null) }
  var choosingChat by rememberSaveable { mutableStateOf(false) }

  suspend fun load() {
    try {
      settings = client.providerSettings(); loadError = null
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      loadError = e.message
      if (settings != null) snackbar.showSnackbar(e.message ?: "Couldn't load the models.")
    }
  }

  LaunchedEffect(client) { load() }
  /** What calls and dictation use, under Voice. */
  var voice by remember(client) { mutableStateOf<VoiceCapabilities?>(null) }
  LaunchedEffect(client) { voice = runCatching { client.voiceCapabilities() }.getOrNull() }

  val s = settings
  val ready = s?.providers.orEmpty().filter { it.configured && it.enabled }
  fun label(id: String?): String = if (id == null) "Same as chat" else s?.providers?.firstOrNull { it.id == id }?.label ?: id

  val provider = openProvider?.let { id -> s?.providers?.firstOrNull { it.id == id } }
  if (provider != null) {
    BackHandler { openProvider = null }
    ProviderDetail(client, provider, gate, snackbar, onBack = { openProvider = null }, reload = { load() })
    return
  }
  if (choosingChat && s != null) {
    BackHandler { choosingChat = false }
    ChatModelPicker(client, ready, s.defaultModel, gate, snackbar, onBack = { choosingChat = false }, saved = { load() })
    return
  }

  GatedSettingsPage("Models", onBack, snackbar, gate, onRefresh = { load() }) {
    if (s == null) {
      loadingOrError(loadError)
      return@GatedSettingsPage
    }
    item { SettingsHeader("Models in use") }
    item {
      ListItem(
        headlineContent = { Text("Chat") },
        supportingContent = { Text("${label(s.defaultModel.provider)} · ${s.defaultModel.model}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingContent = { Chevron() },
        modifier = Modifier.clickable(onClickLabel = "Change the chat model") { choosingChat = true },
      )
    }
    val roleOptions: List<String?> = listOf<String?>(null) + ready.map { it.id }
    item {
      ChoiceRow("Learning", roleOptions, s.roles.learning, label = { label(it) }) { v ->
        scope.launchReporting(snackbar) {
          val r = gate.run { a -> client.setModelRoles(learning = RoleChoice(v), approval = a) }
          r.error?.let { snackbar.showSnackbar(it) }
          load()
        }
      }
    }
    item {
      ChoiceRow("Bot crews", roleOptions, s.roles.crew, label = { label(it) }) { v ->
        scope.launchReporting(snackbar) {
          val r = gate.run { a -> client.setModelRoles(crew = RoleChoice(v), approval = a) }
          r.error?.let { snackbar.showSnackbar(it) }
          load()
        }
      }
    }
    item {
      SettingsFooter("Learning is the background work that improves Mercury after each chat. Bot crews are the bots a lead bot hands work to.")
    }
    item { SettingsHeader("Providers") }
    items(s.providers, key = { it.id }) { p -> ProviderRow(p) { openProvider = p.id } }
    item { SettingsHeader("Voice") }
    item(key = "voice") {
      val v = voice
      ListItem(
        headlineContent = { Text("Voice providers") },
        supportingContent = {
          Text(
            if (v == null) "Keys for calls and dictation"
            else "Calls: ${if (v.call) v.callEngineName ?: v.callEngine ?: "ready" else "not set up"} · Dictation: ${if (v.dictation) v.dictationEngineName ?: v.dictationEngine ?: "ready" else "not set up"}",
            maxLines = 2, overflow = TextOverflow.Ellipsis,
          )
        },
        trailingContent = { Chevron() },
        modifier = Modifier.clickable(onClickLabel = "Open voice settings", onClick = onVoice),
      )
    }
  }
}

@Composable
private fun ProviderRow(provider: ProviderInfo, onClick: () -> Unit) {
  ListItem(
    headlineContent = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(provider.label)
        if (provider.isDefault) {
          Surface(color = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary, shape = RoundedCornerShape(50)) {
            Text("Default", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
          }
        }
      }
    },
    supportingContent = {
      when {
        !provider.configured -> StatusText("Not set up", StatusTone.Off)
        !provider.enabled -> StatusText("Off", StatusTone.Off)
        else -> StatusText(provider.model.ifEmpty { "Ready" }, StatusTone.Good)
      }
    },
    trailingContent = { Chevron() },
    modifier = Modifier.clickable(onClickLabel = "Open ${provider.label}", onClick = onClick),
  )
}

/** The chat model: a provider, then one of the models it offers. */
@Composable
private fun ChatModelPicker(
  client: MercuryClient,
  providers: List<ProviderInfo>,
  current: ProviderSettings.Default,
  gate: OwnerGate,
  snackbar: SnackbarHostState,
  onBack: () -> Unit,
  saved: suspend () -> Unit,
) {
  val scope = rememberCoroutineScope()
  val models = remember { mutableStateMapOf<String, List<String>>() }
  var loading by remember { mutableStateOf<String?>(null) }

  suspend fun fetch(id: String) {
    loading = id
    try {
      val r = client.checkProvider(id)
      if (r.ok) models[id] = r.models.orEmpty() else snackbar.showSnackbar(r.error ?: "That provider didn't answer.")
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      snackbar.showSnackbar(e.message ?: "That provider didn't answer.")
    } finally {
      loading = null
    }
  }

  LaunchedEffect(Unit) { providers.firstOrNull { it.id == current.provider }?.let { fetch(it.id) } }

  GatedSettingsPage("Chat model", onBack, snackbar, gate) {
    if (providers.isEmpty()) {
      item { SettingsFooter("Set up a provider first.") }
    }
    providers.forEach { p ->
      item(key = "h:${p.id}") { SettingsHeader(p.label) }
      val list = models[p.id]
      when {
        list != null -> {
          if (list.isEmpty()) item(key = "e:${p.id}") { SettingsFooter("This provider offers no models.") }
          items(list.size, key = { "m:${p.id}:$it" }) { i ->
            val m = list[i]
            val selected = current.provider == p.id && current.model == m
            ListItem(
              headlineContent = { Text(m, maxLines = 1, overflow = TextOverflow.Ellipsis) },
              leadingContent = { RadioButton(selected = selected, onClick = null) },
              modifier = Modifier.selectable(selected = selected, role = Role.RadioButton) {
                scope.launchReporting(snackbar) {
                  val r = gate.run { a -> client.setModelRoles(defaultProvider = p.id, model = m, approval = a) }
                  if (r.error != null) {
                    snackbar.showSnackbar(r.error!!)
                  } else {
                    saved()
                    onBack()
                  }
                }
              },
            )
          }
        }
        loading == p.id -> item(key = "l:${p.id}") {
          Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.CenterStart) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
          }
        }
        else -> item(key = "s:${p.id}") {
          ListItem(
            headlineContent = { Text("Show models") },
            modifier = Modifier.clickable(enabled = loading == null, onClickLabel = "Show ${p.label}'s models") {
              scope.launchReporting(snackbar) { fetch(p.id) }
            },
          )
        }
      }
    }
  }
}

/** One provider: its key and address, checked live before saving, on or off. */
@Composable
private fun ProviderDetail(
  client: MercuryClient,
  provider: ProviderInfo,
  gate: OwnerGate,
  snackbar: SnackbarHostState,
  onBack: () -> Unit,
  reload: suspend () -> Unit,
) {
  val scope = rememberCoroutineScope()
  val uri = LocalUriHandler.current
  var key by rememberSaveable(provider.id) { mutableStateOf("") }
  var showKey by remember { mutableStateOf(false) }
  var baseUrl by rememberSaveable(provider.id) { mutableStateOf(provider.baseUrl) }
  var check by remember(provider.id) { mutableStateOf<ProviderCheck?>(null) }
  var busy by remember { mutableStateOf(false) }
  var note by remember(provider.id) { mutableStateOf<String?>(null) }
  var confirmForget by remember { mutableStateOf(false) }

  fun runCheck() = scope.launchReporting(snackbar) {
    busy = true
    try {
      check = client.checkProvider(provider.id, apiKey = key.ifEmpty { null }, baseUrl = if (provider.needsBaseUrl) baseUrl else null)
    } finally { busy = false }
  }

  fun save() = scope.launchReporting(snackbar) {
    busy = true
    try {
      val r = gate.run { a ->
        client.saveProvider(provider.id, apiKey = key.ifEmpty { null }, baseUrl = if (provider.needsBaseUrl) baseUrl else null, approval = a)
      }
      val e = r.error
      if (e != null) {
        snackbar.showSnackbar(e)
      } else {
        key = ""
        note = if (r.restartRequired == true) "Saved. Mercury uses it after a restart." else "Saved."
        reload()
      }
    } finally { busy = false }
  }

  GatedSettingsPage(provider.label, onBack, snackbar, gate, onRefresh = reload) {
    if (provider.blurb.isNotEmpty()) item {
      Text(
        provider.blurb, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
      )
    }
    if (provider.signInOnly) {
      item { SettingsFooter("Sign in to ${provider.label} in Mercury Desktop on your computer.") }
    } else {
      item { SettingsHeader("Connection") }
      item {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
          if (provider.needsKey) {
            OutlinedTextField(
              value = key, onValueChange = { key = it },
              label = { Text("API key") },
              placeholder = { Text(if (provider.hasKey) provider.apiKey else provider.keyHint ?: "API key", maxLines = 1) },
              supportingText = if (provider.hasKey) ({ Text("Saved: ${provider.apiKey}. Type a new one to replace it.") }) else null,
              singleLine = true,
              visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None),
              trailingIcon = {
                IconButton(onClick = { showKey = !showKey }) {
                  Icon(if (showKey) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (showKey) "Hide key" else "Show key")
                }
              },
              modifier = Modifier.fillMaxWidth(),
            )
          }
          if (provider.needsBaseUrl) {
            OutlinedTextField(
              value = baseUrl, onValueChange = { baseUrl = it },
              label = { Text("Address") },
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None),
              modifier = Modifier.fillMaxWidth(),
            )
          }
          check?.let { c ->
            if (c.ok) StatusText("Works · ${c.models?.size ?: 0} models", StatusTone.Good)
            else StatusText(c.error ?: "That didn't work.", StatusTone.Warn)
          }
          Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { runCheck() }, enabled = !busy) { Text("Check") }
            Button(onClick = { save() }, enabled = !busy && !(key.isEmpty() && baseUrl == provider.baseUrl)) { Text("Save") }
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
          }
        }
      }
      provider.keyUrl?.takeIf { it.startsWith("http") }?.let { url ->
        item {
          ListItem(
            headlineContent = { Text("Get a key") },
            trailingContent = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null) },
            modifier = Modifier.clickable(onClickLabel = "Open ${provider.label}'s key page") { runCatching { uri.openUri(url) } },
          )
        }
      }
      if (provider.configured) {
        item { SettingsHeader("Use") }
        item {
          SwitchRow("Use this provider", provider.enabled) { on ->
            scope.launchReporting(snackbar) {
              gate.run { a -> client.saveProvider(provider.id, enabled = on, approval = a) }
              reload()
            }
          }
        }
        if (provider.hasKey) item {
          ListItem(
            headlineContent = { Text("Forget the key", color = MaterialTheme.colorScheme.error) },
            modifier = Modifier.clickable { confirmForget = true },
          )
        }
      }
    }
    note?.let { n -> item { StatusText(n, StatusTone.Good, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) } }
  }

  if (confirmForget) AlertDialog(
    onDismissRequest = { confirmForget = false },
    title = { Text("Forget the ${provider.label} key?") },
    text = { Text("Mercury stops using ${provider.label} until you add a key again.") },
    confirmButton = {
      TextButton(onClick = {
        confirmForget = false
        scope.launchReporting(snackbar) {
          gate.run { a -> client.forgetProviderKey(provider.id, approval = a) }
          reload()
        }
      }) { Text("Forget", color = MaterialTheme.colorScheme.error) }
    },
    dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Cancel") } },
  )
}
