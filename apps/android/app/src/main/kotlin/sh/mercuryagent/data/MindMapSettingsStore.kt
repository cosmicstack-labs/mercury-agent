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
import sh.mercuryagent.core.WebSettings

/** Brain → Mind map's settings on this phone, under the desktop's key and field names (iOS: UserDefaults). */
class MindMapSettingsStore(private val prefs: DataStore<Preferences>, private val scope: CoroutineScope) {
  private val key = stringPreferencesKey(WebSettings.STORAGE_KEY)

  val state: StateFlow<WebSettings> = prefs.data.map { WebSettings.decode(it[key]) }.stateIn(scope, SharingStarted.Eagerly, WebSettings.DEFAULTS)

  fun save(s: WebSettings) = scope.launch { prefs.edit { it[key] = s.encode() } }
}
