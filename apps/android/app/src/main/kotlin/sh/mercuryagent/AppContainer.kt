package sh.mercuryagent

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import sh.mercuryagent.core.ConnectionStore
import sh.mercuryagent.core.KeystoreSecretStore
import sh.mercuryagent.core.PrefsKeyValueStore
import sh.mercuryagent.core.ackMissed
import sh.mercuryagent.core.missed
import sh.mercuryagent.core.ownerTasks
import sh.mercuryagent.core.registerReach
import sh.mercuryagent.core.reportRing
import kotlinx.coroutines.launch
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
  /** Owner tasks waiting on the active Mercury (ADR-048): CAPTCHAs, codes, steps only the owner can do. */
  val ownerTasks = sh.mercuryagent.ui.owner.OwnerTaskStore()
  /** Voice calls (one at a time) and each Mercury's voice capabilities. */
  val calls = sh.mercuryagent.call.CallManager(app)

  // ── Mercury rings and notifies this phone (ADR-046), over the activity stream only ──
  private val reachPrefs = app.getSharedPreferences("mercury.reach", Context.MODE_PRIVATE)
  val ringTelecom = sh.mercuryagent.call.RingTelecom(app, scope)
  val ringer = sh.mercuryagent.call.PhoneRinger(
    scope, ringTelecom,
    report = { id, outcome -> activeClient()?.let { c -> runCatching { c.reportRing(id, outcome) } } },
    post = { notifier.postReach(it) },
  ).apply {
    ringOn = reachPrefs.getBoolean("ring", true)
    notifyOn = reachPrefs.getBoolean("notify", true)
  }
  /** Why registering this phone failed (Settings → Calls from Mercury), or null. */
  val reachProblem = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

  private fun activeClient(): sh.mercuryagent.core.MercuryClient? = connections.state.value.active?.let { connections.client(it) }

  /** Ring this phone / show Mercury's notifications on it: kept here and told to Mercury. */
  fun setReach(ring: Boolean = ringer.ringOn, notify: Boolean = ringer.notifyOn) {
    ringer.ringOn = ring; ringer.notifyOn = notify
    reachPrefs.edit().putBoolean("ring", ring).putBoolean("notify", notify).apply()
    activeClient()?.let { c -> scope.launch { registerReach(c) } }
  }

  private suspend fun registerReach(c: sh.mercuryagent.core.MercuryClient) {
    val caps = buildList { add("telecom"); if (sh.mercuryagent.call.RingTelecom.canRingFullScreen(app)) add("full-screen-intent") }
    reachProblem.value = try {
      c.registerReach(ringer.ringOn, ringer.notifyOn, appVersion, caps); null
    } catch (e: sh.mercuryagent.core.MercuryException.Server) {
      when (e.code) {
        404 -> "Your Mercury is too old to call this phone. Update Mercury on your computer."
        403 -> "This phone isn't paired with a device token, so Mercury can't call it. Pair it again from Mercury Desktop."
        else -> e.message
      }
    } catch (e: Exception) { e.message }
  }

  /** The streams opened: tell Mercury how to reach this phone, and show what it missed. */
  private fun reachConnected(c: sh.mercuryagent.core.MercuryClient) {
    // Owner tasks already waiting (the stream only tells what changes after it opens).
    scope.launch {
      runCatching { c.ownerTasks() }.onSuccess { ownerTasks.replace(it) }
    }
    scope.launch {
      registerReach(c)
      val items = runCatching { c.missed() }.getOrNull() ?: return@launch
      val ids = ringer.showMissed(items)
      runCatching { c.ackMissed(ids) }
    }
  }

  /** Answer a ring on this phone: the chat on screen starts the call, which says why Mercury called. */
  fun answerRing(id: String): Boolean {
    if (!ringer.answerHere(id)) return false
    requestCall()
    return true
  }

  /** The answered ring, for the call that starts now (once). */
  fun takeAnsweredRing(): sh.mercuryagent.core.RingInvite? = ringer.takeAnswered()

  /** What the owner sees in their device list: the phone's own name, then the app. */
  val deviceName: String by lazy {
    val name = runCatching { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
      ?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
    "$name · Mercury for Android"
  }

  val appVersion: String get() = BuildConfig.VERSION_NAME

  init {
    ringTelecom.onAnswer = { id -> if (answerRing(id)) openApp() }
    ringTelecom.onDecline = { id -> ringer.declineHere(id) }
    ringTelecom.callRunning = { calls.running }
    monitor.onReach = { ringer.handle(it) }
    monitor.onStreamsStarted = { reachConnected(it) }
    monitor.onOwnerTask = { ownerTasks.apply(it) }
    // Another Mercury: the last one's tasks aren't this one's.
    scope.launch {
      connections.state.map { it.active?.id }.distinctUntilChanged().collect { ownerTasks.clear() }
    }
  }

  private fun openApp() {
    runCatching {
      app.startActivity(android.content.Intent(app, MainActivity::class.java)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
  }

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
