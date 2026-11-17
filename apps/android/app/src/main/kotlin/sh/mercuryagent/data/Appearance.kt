package sh.mercuryagent.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

enum class ThemeMode { System, Light, Dark }

/** The phone's own look, kept on this device only: the theme (the app is monochrome). */
data class Appearance(val mode: ThemeMode = ThemeMode.System)

class AppearanceStore(private val prefs: DataStore<Preferences>, private val scope: CoroutineScope) {
  private val modeKey = stringPreferencesKey("appearance.theme")

  val state: StateFlow<Appearance> = prefs.data.map { p ->
    Appearance(
      mode = ThemeMode.entries.firstOrNull { it.name.equals(p[modeKey], ignoreCase = true) } ?: ThemeMode.System,
    )
  }.stateIn(scope, SharingStarted.Eagerly, Appearance())

  fun setMode(m: ThemeMode) = scope.launch { prefs.edit { it[modeKey] = m.name.lowercase() } }
}
