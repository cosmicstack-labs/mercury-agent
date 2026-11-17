package sh.mercuryagent.ui.more

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import sh.mercuryagent.call.CallManager
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.VOICE_PROVIDERS_FEATURE
import sh.mercuryagent.core.VoiceKeyResult
import sh.mercuryagent.core.VoiceProvider
import sh.mercuryagent.core.VoiceProvidersResponse
import sh.mercuryagent.core.PluginDetail
import sh.mercuryagent.core.PluginField
import sh.mercuryagent.core.PluginGroup
import sh.mercuryagent.core.plugin
import sh.mercuryagent.core.setPluginSetting
import sh.mercuryagent.core.settingBool
import sh.mercuryagent.core.setVoiceKey
import sh.mercuryagent.core.VoiceSetup
import sh.mercuryagent.core.settingText
import sh.mercuryagent.core.voiceProviders
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.theme.Mercury

/** Optimus is really there: installed, with a manifest that loaded (the catalog alone gives a bare entry). */
fun optimusInstalled(p: PluginDetail?): Boolean = p != null && p.installedVersion != null && p.settings.isNotEmpty()

/** What Settings → Voice shows. Never nothing: loading, a reason with Retry, or content. */
sealed interface VoiceScreenState {
  data object Loading : VoiceScreenState
  data class Failed(val message: String) : VoiceScreenState
  data class Content(
    /** The Mercury has `voice.providers`: the provider keys show, Optimus or not. */
    val showProviders: Boolean,
    val providers: VoiceProvidersResponse?,
    /** Why the providers couldn't be loaded (shown in their section, with Retry). */
    val providersError: String?,
    /** Optimus's own settings, only when it's installed. */
    val optimus: PluginDetail?,
  ) : VoiceScreenState {
    /** No Optimus: say what it would add. */
    val optimusFooter: Boolean get() = optimus == null
  }
}

/** Decides [VoiceScreenState] from what was loaded (pure, so it's tested on the JVM). */
fun voiceScreenState(
  loaded: Boolean,
  providersFeature: Boolean,
  providers: VoiceProvidersResponse?,
  providersError: String?,
  plugin: PluginDetail?,
  pluginError: String?,
): VoiceScreenState {
  if (!loaded) return VoiceScreenState.Loading
  val optimus = plugin?.takeIf { optimusInstalled(it) }
  if (providersFeature) {
    if (providers == null && optimus == null) {
      return VoiceScreenState.Failed(providersError ?: pluginError ?: "Couldn't load the voice settings.")
    }
    return VoiceScreenState.Content(true, providers, if (providers == null) providersError ?: "Couldn't load the voice providers." else null, optimus)
  }
  if (optimus == null && pluginError != null) return VoiceScreenState.Failed(pluginError)
  return VoiceScreenState.Content(false, null, null, optimus)
}

/**
 * Voice (iOS: VoiceSettings; apps/desktop/src/views/settings/Voice.tsx): on a Mercury with
 * `voice.providers`, the voice providers' keys (calls and dictation work without Optimus) and what
 * calls and dictation use; then the Optimus plugin's own settings when it's installed.
 */
@Composable
fun VoiceSettings(client: MercuryClient, calls: CallManager, onBack: () -> Unit, onOpenModels: () -> Unit) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  var plugin by remember(client) { mutableStateOf<PluginDetail?>(null) }
  var pluginError by remember(client) { mutableStateOf<String?>(null) }
  var providers by remember(client) { mutableStateOf<VoiceProvidersResponse?>(null) }
  var providersError by remember(client) { mutableStateOf<String?>(null) }
  var feature by remember(client) { mutableStateOf(false) }
  var loaded by remember(client) { mutableStateOf(false) }
  var editing by remember(client) { mutableStateOf<String?>(null) }
  /** "Set up voice" is open. */
  var settingUp by remember(client) { mutableStateOf(false) }
  /** What the person changed, shown before the save comes back. */
  val values = remember(client) { mutableStateMapOf<String, JsonElement>() }

  suspend fun load() {
    feature = VOICE_PROVIDERS_FEATURE in calls.features(client)
    coroutineScope {
      val p = async {
        try {
          plugin = client.plugin("optimus"); pluginError = null
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          pluginError = e.message ?: "Couldn't load the voice settings."
        }
      }
      if (feature) {
        try {
          providers = client.voiceProviders(); providersError = null
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          providersError = e.message ?: "Couldn't load the voice providers."
        }
      }
      p.await()
    }
    loaded = true
  }

  LaunchedEffect(client) { load() }
  val retry: () -> Unit = { scope.launch { loaded = false; load() } }

  fun save(pluginId: String, f: PluginField, v: JsonElement) {
    val had = values.containsKey(f.key)
    val old = values[f.key]
    if (f.type != "secret") values[f.key] = v
    scope.launchReporting(snackbar) {
      try {
        gate.run { a -> client.setPluginSetting(pluginId, f.key, v, approval = a) }
      } catch (e: Exception) {
        if (had && old != null) values[f.key] = old else values.remove(f.key)
        throw e
      }
      load()
      // The runtime's value is the truth once it's back.
      values.remove(f.key)
    }
  }

  /** A key was saved or removed: show it, and have the mic and call button ask again. */
  fun applied(r: VoiceKeyResult) {
    val now = providers
    if (now != null) {
      providers = now.copy(
        providers = r.provider?.let { np -> now.providers.map { if (it.id == np.id) np else it } } ?: now.providers,
        capabilities = r.capabilities ?: now.capabilities,
      )
    }
    calls.voiceChanged(client, r.capabilities)
    // Optimus restarts with the new key: its settings may change too.
    scope.launch { load() }
  }

  val state = voiceScreenState(loaded, feature, providers, providersError, plugin, pluginError)
  GatedSettingsPage("Voice", onBack, snackbar, gate, onRefresh = { load() }) {
    when (state) {
      VoiceScreenState.Loading -> loadingOrError(null)
      is VoiceScreenState.Failed -> item(key = "failed") { RetryBlock(state.message, retry) }
      is VoiceScreenState.Content -> {
        if (state.showProviders) {
          val r = state.providers
          if (r == null) {
            item(key = "providers:error") { RetryBlock(state.providersError ?: "Couldn't load the voice providers.", retry) }
          } else {
            if (VoiceSetup.settingsOffersSetup(r.providers)) item(key = "setup") {
              Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Talk to Mercury from this phone: pick a voice and paste its key.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick = { settingUp = true }, modifier = Modifier.fillMaxWidth()) { Text("Set up voice") }
              }
            }
            voiceProviderRows(r) { p -> if (p.canEdit || p.id == "openai") editing = p.id }
          }
        }
        val p = state.optimus
        if (p != null) {
          if (state.showProviders) item(key = "optimus:header") { SettingsHeader("Optimus") }
          if (p.missing.isNotEmpty()) {
            item { SettingsHeader("Needs setting up") }
            p.missing.forEachIndexed { i, m ->
              item(key = "missing:$i:${m.key}") {
                ListItem(
                  headlineContent = { Text(m.needs) },
                  supportingContent = { Text(m.fix) },
                  leadingContent = { Icon(Icons.Outlined.WarningAmber, null, tint = Mercury.colors.amber) },
                )
              }
            }
          }
          pluginForm(p.settings, p.settingGroups, values) { f, v -> save(p.id, f, v) }
        } else {
          item(key = "optimus:footer") {
            SettingsFooter(
              if (state.showProviders) "Voice for the computer comes with the Optimus plugin. Install it on your computer (Plugins in Mercury Desktop) to talk to Mercury there. Calls and dictation on this phone only need the keys above."
              else "Voice comes with the Optimus plugin. Install it on your computer (Plugins in Mercury Desktop) to talk to Mercury in real time.",
            )
          }
        }
      }
    }
  }

  if (settingUp) {
    VoiceSetupSheet(
      client, calls, VoiceSetup.Trigger.Settings,
      onDismiss = { settingUp = false; scope.launch { load() } },
      onContinue = { settingUp = false; scope.launch { load() } },
    )
  }
  val open = editing?.let { id -> providers?.providers?.firstOrNull { it.id == id } }
  if (open != null) {
    VoiceKeySheet(
      open, gate, client,
      onDismiss = { editing = null },
      onSaved = { r ->
        editing = null
        applied(r)
        scope.launch { snackbar.showSnackbar(r.message ?: if (r.provider?.set == true) "${open.name} key saved." else "${open.name} key removed.") }
      },
      onOpenModels = { editing = null; onOpenModels() },
    )
  }
}

/** A failure that blocks the page: why, and a way to try again. */
@Composable
private fun RetryBlock(message: String, retry: () -> Unit) {
  Column(
    Modifier.fillMaxWidth().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    ErrorText(message)
    OutlinedButton(onClick = retry) { Text("Retry") }
  }
}

/** The providers (the phone's first, then Optimus-only ones) and what calls and dictation use. */
private fun LazyListScope.voiceProviderRows(r: VoiceProvidersResponse, onOpen: (VoiceProvider) -> Unit) {
  val (more, main) = r.providers.partition { it.optimusOnly }
  item(key = "providers:header") { SettingsHeader("Voice providers") }
  items(main, key = { "provider:${it.id}" }) { p -> VoiceProviderRow(p) { onOpen(p) } }
  item(key = "providers:footer") {
    SettingsFooter("Keys stay on your computer: the phone only gets short-lived tokens. Optimus uses the same keys.")
  }
  val c = r.capabilities
  item(key = "uses:header") { SettingsHeader("In use") }
  item(key = "uses:calls") {
    ListItem(
      headlineContent = { Text("Calls use") },
      supportingContent = if (c.call) null else ({ Text(c.callSetup ?: "Add an OpenAI key in Settings → Models, or a Gemini key above.") }),
      trailingContent = { StatusText(if (c.call) c.callEngineName ?: c.callEngine ?: "Ready" else "Not set up", if (c.call) StatusTone.Good else StatusTone.Off) },
    )
  }
  item(key = "uses:dictation") {
    ListItem(
      headlineContent = { Text("Dictation uses") },
      supportingContent = if (c.dictation) null else ({ Text(c.setupLine) }),
      trailingContent = { StatusText(if (c.dictation) c.dictationEngineName ?: c.dictationEngine ?: "Ready" else "Not set up", if (c.dictation) StatusTone.Good else StatusTone.Off) },
    )
  }
  if (more.isNotEmpty()) {
    item(key = "more:header") { SettingsHeader("More for Optimus") }
    items(more, key = { "provider:${it.id}" }) { p -> VoiceProviderRow(p) { onOpen(p) } }
  }
}

@Composable
private fun VoiceProviderRow(p: VoiceProvider, onClick: () -> Unit) {
  val opens = p.canEdit || p.id == "openai"
  ListItem(
    headlineContent = { Text(p.name.ifEmpty { p.id }) },
    supportingContent = {
      Column {
        if (p.usedFor.isNotEmpty()) Text(p.usedFor)
        StatusText(p.status, if (p.set) StatusTone.Good else StatusTone.Off)
        if (!opens) p.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3) }
      }
    },
    trailingContent = if (opens) ({ Chevron() }) else null,
    modifier = if (opens) Modifier.clickable(onClickLabel = "Change the ${p.name} key", onClick = onClick) else Modifier,
  )
}

/**
 * One provider's key: paste it, Save (checked with the provider first), or Remove. The OpenAI key
 * belongs to the OpenAI model, so its sheet points to Models instead. The key is never shown back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VoiceKeySheet(
  p: VoiceProvider,
  gate: OwnerGate,
  client: MercuryClient,
  onDismiss: () -> Unit,
  onSaved: (VoiceKeyResult) -> Unit,
  onOpenModels: () -> Unit,
) {
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val scope = rememberCoroutineScope()
  var draft by remember(p.id) { mutableStateOf("") }
  var busy by remember(p.id) { mutableStateOf<String?>(null) }
  var error by remember(p.id) { mutableStateOf<String?>(null) }

  fun send(key: String?) {
    if (busy != null) return
    busy = if (key == null) "Removing…" else "Checking…"
    error = null
    scope.launch {
      try {
        val r = gate.run { a -> client.setVoiceKey(p.id, key, a) }
        if (r.ok) { draft = ""; onSaved(r) } else error = r.error ?: "That didn't work. Try again."
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        error = e.message ?: "That didn't work. Try again."
      } finally {
        busy = null
      }
    }
  }

  ModalBottomSheet(onDismissRequest = { if (busy == null) onDismiss() }, sheetState = state) {
    Column(
      Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding().imePadding(),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Text("${p.name.ifEmpty { p.id }} key", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
      if (p.usedFor.isNotEmpty()) Text("Used for: ${p.usedFor}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      StatusText(p.status, if (p.set) StatusTone.Good else StatusTone.Off)
      p.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3) }
      if (!p.canEdit) {
        if (p.id == "openai") {
          Button(onClick = onOpenModels, modifier = Modifier.fillMaxWidth()) { Text("Open Models") }
        }
        return@Column
      }
      OutlinedTextField(
        value = draft, onValueChange = { draft = it; error = null },
        label = { Text(if (p.set) "New key" else "API key") },
        singleLine = true,
        enabled = busy == null,
        isError = error != null,
        supportingText = error?.let { { Text(it) } },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (draft.isNotBlank()) send(draft.trim()) }),
        modifier = Modifier.fillMaxWidth(),
      )
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (p.set) {
          OutlinedButton(onClick = { send(null) }, enabled = busy == null) { Text("Remove") }
        }
        Spacer(Modifier.weight(1f))
        busy?.let {
          CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
          Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Button(onClick = { send(draft.trim()) }, enabled = busy == null && draft.isNotBlank()) { Text("Save") }
      }
    }
  }
}

/**
 * A plugin's settings as a form: only the fields that apply to what's chosen, in the plugin's own
 * groups (then anything ungrouped), each saved as it changes.
 */
fun LazyListScope.pluginForm(
  fields: List<PluginField>,
  groups: List<PluginGroup>,
  changed: Map<String, JsonElement>,
  onSet: (PluginField, JsonElement) -> Unit,
) {
  val merged: Map<String, JsonElement?> = fields.associate { it.key to (it.value ?: JsonNull) } + changed
  val shown = fields.filter { it.applies(merged) }
  val sections = mutableListOf<Triple<String, String, List<PluginField>>>()
  groups.forEach { g ->
    val f = shown.filter { it.group == g.id }
    if (f.isNotEmpty()) sections += Triple(g.id, g.label, f)
  }
  val known = groups.map { it.id }.toSet()
  val rest = shown.filter { it.group == null || it.group !in known }
  if (rest.isNotEmpty()) sections += Triple("", if (groups.isEmpty()) "" else "More", rest)

  sections.forEach { (id, label, list) ->
    if (label.isNotEmpty()) item(key = "group:$id") { SettingsHeader(label) }
    list.forEach { f ->
      item(key = "field:${f.key}") { PluginFieldRow(f, merged[f.key]) { onSet(f, it) } }
    }
  }
}

@Composable
private fun PluginFieldRow(field: PluginField, value: JsonElement?, set: (JsonElement) -> Unit) {
  val title = field.label ?: field.key
  val description = field.description?.takeIf { it.isNotEmpty() }
  when (field.type) {
    "boolean" -> SwitchRow(title, value.settingBool ?: false, supporting = description) { set(JsonPrimitive(it)) }
    "enum" -> {
      val options = field.options.orEmpty()
      ChoiceRow(
        title, options, value.settingText,
        label = { o -> field.optionLabels?.get(o) ?: o.ifEmpty { "Not set" } },
        supporting = description,
      ) { set(JsonPrimitive(it)) }
    }
    "secret" -> {
      var draft by remember(field.key) { mutableStateOf("") }
      fun submit() { if (draft.isNotEmpty()) { set(JsonPrimitive(draft)); draft = "" } }
      OutlinedTextField(
        value = draft, onValueChange = { draft = it },
        label = { Text(title) },
        placeholder = if (field.isSet == true) ({ Text("Saved") }) else null,
        supportingText = description?.let { { Text(it) } },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { submit() }),
        trailingIcon = if (draft.isNotEmpty()) ({ IconButton(onClick = { submit() }) { Icon(Icons.Outlined.Check, "Save $title") } })
        else if (field.isSet == true) ({ Icon(Icons.Outlined.CheckCircle, "Saved", tint = Mercury.colors.green) })
        else null,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
      )
    }
    else -> {
      val number = field.type == "number"
      val current = value.settingText
      var draft by remember(field.key, current) { mutableStateOf(current) }
      fun submit() {
        if (number) {
          val n = draft.trim().toDoubleOrNull() ?: return
          val asLong = n.toLong()
          set(if (n == asLong.toDouble()) JsonPrimitive(asLong) else JsonPrimitive(n))
        } else {
          set(JsonPrimitive(draft))
        }
      }
      OutlinedTextField(
        value = draft, onValueChange = { draft = it },
        label = { Text(title) },
        placeholder = if (!number) field.options?.firstOrNull()?.let { { Text(it) } } else null,
        supportingText = description?.let { { Text(it) } },
        singleLine = true,
        keyboardOptions = KeyboardOptions(
          keyboardType = if (number) KeyboardType.Decimal else KeyboardType.Text,
          autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(onDone = { submit() }),
        trailingIcon = if (draft != current) ({ IconButton(onClick = { submit() }) { Icon(Icons.Outlined.Check, "Save $title") } }) else null,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
      )
    }
  }
}
