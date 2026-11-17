package sh.mercuryagent

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.receiveAsFlow
import sh.mercuryagent.core.ConnectionStore
import sh.mercuryagent.core.KeystoreSecretStore
import sh.mercuryagent.core.PrefsKeyValueStore
import sh.mercuryagent.data.AppearanceStore
import sh.mercuryagent.data.ReadMarksStore

private val Context.prefs by preferencesDataStore(name = "mercury_prefs")

/**
 * The app's few long-lived objects, made once (no DI framework): connections, appearance,
 * notifications and the activity stream, and voice calls.
 */
class AppContainer(context: Context) {
  private val app = context.applicationContext
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  val connections = ConnectionStore(PrefsKeyValueStore(app), KeystoreSecretStore(app))
  val appearance = AppearanceStore(app.prefs, scope)
  val readMarks = ReadMarksStore(app.prefs)
  /** Brain → Mind map's display and force settings. */
  val mindMapSettings = sh.mercuryagent.data.MindMapSettingsStore(app.prefs, scope)
  val notifier = sh.mercuryagent.notify.Notifier(app)
  val notifyPrefs = sh.mercuryagent.notify.NotifyPrefsStore(app)
  val monitor = sh.mercuryagent.notify.ActivityMonitor(app, connections, notifyPrefs, notifier, scope)
  /** Voice calls (one at a time) and each Mercury's voice capabilities. */
  val calls = sh.mercuryagent.call.CallManager(app)

  /** What the owner sees in their device list: the phone's own name, then the app. */
  val deviceName: String by lazy {
    val name = runCatching { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
      ?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
    "$name · Mercury for Android"
  }

  val appVersion: String get() = BuildConfig.VERSION_NAME

  private val ui = app.getSharedPreferences("mercury.ui", Context.MODE_PRIVATE)

  private val opens = kotlinx.coroutines.channels.Channel<String>(kotlinx.coroutines.channels.Channel.CONFLATED)

  /** Chats to open from outside (a notification's tap): a thread id, or "bot:<id>". Each is taken once. */
  val openChat: kotlinx.coroutines.flow.Flow<String> = opens.receiveAsFlow()

  fun open(key: String) { opens.trySend(key) }

  /**
   * Call Mercury was asked for from outside the chat (the drawer, the launcher's app shortcut): the
   * chat on screen starts the call, as its own call button does, and clears this.
   */
  val callRequested = kotlinx.coroutines.flow.MutableStateFlow(false)

  fun requestCall() { callRequested.value = true }

  /** The chat on screen now (nothing is announced for it), or null. */
  val viewingChat = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

  fun viewing(id: String, open: Boolean?) {
    when (open) {
      true -> { viewingChat.value = id; monitor.viewing(id) }
      false -> if (viewingChat.value == id) { viewingChat.value = null; monitor.viewing(null) }
      null -> Unit
    }
  }

  /** Open the app to the last chat (when set in Settings) or, by default, a new one. */
  var openToLastChat: Boolean
    get() = ui.getBoolean("openLast", false)
    set(v) { ui.edit().putBoolean("openLast", v).apply() }

  fun startChat(): String? = if (openToLastChat) ui.getString("lastChat", null) else null

  fun rememberChat(id: String?) { if (id != null) ui.edit().putString("lastChat", id).apply() }
}
