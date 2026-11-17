package sh.mercuryagent.ui.more

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.PluginDetail
import sh.mercuryagent.core.PluginField
import sh.mercuryagent.core.PluginGroup
import sh.mercuryagent.core.plugin
import sh.mercuryagent.core.setPluginSetting
import sh.mercuryagent.core.settingBool
import sh.mercuryagent.core.settingText
import sh.mercuryagent.ui.theme.Mercury

/**
 * Voice: the voice engine and its settings, which live in the Optimus plugin (iOS: VoiceSettings;
 * apps/desktop/src/views/settings/Voice.tsx). Real-time calls use them too. Settings only.
 */
@Composable
fun VoiceSettings(client: MercuryClient, onBack: () -> Unit) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  var plugin by remember(client) { mutableStateOf<PluginDetail?>(null) }
  var loaded by remember(client) { mutableStateOf(false) }
  var loadError by remember(client) { mutableStateOf<String?>(null) }
  /** What the person changed, shown before the save comes back. */
  val values = remember(client) { mutableStateMapOf<String, JsonElement>() }

  suspend fun load() {
    try {
      plugin = client.plugin("optimus"); loadError = null
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      loadError = e.message
      if (plugin != null) snackbar.showSnackbar(e.message ?: "Couldn't load the voice settings.")
    }
    loaded = true
  }

  LaunchedEffect(client) { load() }

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

  GatedSettingsPage("Voice", onBack, snackbar, gate, onRefresh = { load() }) {
    val p = plugin
    when {
      p != null -> {
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
      }
      loaded && loadError == null -> item {
        SettingsFooter("Voice comes with the Optimus plugin. Install it on your computer (Plugins in Mercury Desktop) to talk to Mercury in real time.")
      }
      else -> loadingOrError(loadError)
    }
  }
}

/**
 * A plugin's settings as a form: only the fields that apply to what's chosen, in the plugin's own
 * groups (then anything ungrouped), each saved as it changes.
 */
fun androidx.compose.foundation.lazy.LazyListScope.pluginForm(
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
