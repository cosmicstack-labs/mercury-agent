package sh.mercuryagent.ui.more

import androidx.compose.foundation.clickable
import androidx.compose.material3.ListItem
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.AppContainer
import sh.mercuryagent.data.ThemeMode

/** Theme (System, Light, Dark) and where the app opens. The app is monochrome, like ChatGPT's and Grok's. */
@Composable
fun AppearanceSettings(container: AppContainer, onBack: () -> Unit) {
  val look by container.appearance.state.collectAsStateWithLifecycle()
  var openLast by remember { mutableStateOf(container.openToLastChat) }
  SettingsPage("Appearance", onBack) {
    item { SettingsHeader("Theme") }
    ThemeMode.entries.forEach { m ->
      item(key = m.name) {
        ListItem(
          headlineContent = { Text(when (m) { ThemeMode.System -> "System"; ThemeMode.Light -> "Light"; ThemeMode.Dark -> "Dark" }) },
          supportingContent = if (m == ThemeMode.System) ({ Text("Follows your phone's dark theme") }) else null,
          leadingContent = { RadioButton(selected = look.mode == m, onClick = null) },
          modifier = Modifier.clickable(role = Role.RadioButton) { container.appearance.setMode(m) },
        )
      }
    }
    item { SettingsHeader("Opening the app") }
    item {
      ListItem(
        headlineContent = { Text("Open the last chat") },
        supportingContent = { Text("Off: Mercury opens to a new chat") },
        trailingContent = { Switch(openLast, onCheckedChange = null) },
        modifier = Modifier.clickable(role = Role.Switch) { openLast = !openLast; container.openToLastChat = openLast },
      )
    }
  }
}
