package sh.mercuryagent.notify

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import sh.mercuryagent.MercuryApplication
import sh.mercuryagent.core.ActivityEvent
import sh.mercuryagent.core.ConnectionStore
import sh.mercuryagent.core.MercuryJson
import sh.mercuryagent.core.parseObject
import sh.mercuryagent.core.str

/**
 * Follows the active Mercury's activity (/api/chat/activity) and its bots' inbox
 * (/api/bots/events) for the whole app: the drawer's markers read [activity], and [NotifyDecider]
 * turns events into notifications. It streams while the app is on screen; in the background it
 * keeps going only while a chat works (or waits on you) or "Stay connected" is on, held up by a
 * foreground service whose notification says why. Otherwise the process is free to sleep.
 */
class ActivityMonitor(
  private val app: Context,
  private val connections: ConnectionStore,
  val prefs: NotifyPrefsStore,
  private val notifier: Notifier,
  private val scope: CoroutineScope,
) {
  val decider = NotifyDecider(prefs.value)
  private val _activity = MutableSharedFlow<ActivityEvent>(extraBufferCapacity = 64)
  /** Every activity line, for the chat list's markers. */
  val activity: SharedFlow<ActivityEvent> = _activity

  private var streams: Job? = null
  private var dueTimer: Job? = null
  private var visible = false
  private var serviceOn = false
  private var shownText: String? = null

  init {
    scope.launch { prefs.state.collectLatest { decider.prefs = it; update() } }
    scope.launch {
      connections.state.map { it.active?.id }.distinctUntilChanged().collectLatest { stopStreams(); update() }
    }
  }

  /** The app came on screen or left it. */
  fun setVisible(v: Boolean) { visible = v; update() }

  /** The chat on screen (nothing is told about it), or null. */
  fun viewing(id: String?) {
    if (id != null) decider.opened(id).forEach(::apply) else decider.viewing = null
  }

  fun botsOnScreen(on: Boolean) { decider.botsOnScreen = on }

  private val keepAlive: Boolean get() = prefs.value.stayConnected || decider.running.isNotEmpty() || decider.nextDue() != null

  private fun update() {
    val connected = connections.state.value.active != null
    val want = connected && (visible || keepAlive)
    if (want && streams?.isActive != true) startStreams() else if (!want) stopStreams()
    val wantService = connected && keepAlive
    // Started again when what it says changes (onStartCommand posts the new text).
    if (wantService && (!serviceOn || connectionText() != shownText)) startService() else if (!wantService && serviceOn) stopService()
  }

  private fun startStreams() {
    val c = connections.state.value.active ?: return
    val client = connections.client(c)
    streams = scope.launch {
      launch {
        client.runningTurns()?.let { t -> decider.seed(t.running.mapNotNull { it.sessionId ?: it.channelId }, System.currentTimeMillis()); update() }
      }
      launch {
        client.events("/api/chat/activity").collect { e ->
          if (e.name != "activity") return@collect
          val a = runCatching { MercuryJson.decodeFromString(ActivityEvent.serializer(), e.data) }.getOrNull() ?: return@collect
          _activity.tryEmit(a)
          decider.handle(a, System.currentTimeMillis()).forEach(::apply)
          scheduleDue()
          update()
        }
      }
      launch {
        client.events("/api/bots/events").collect { e ->
          if (e.name != "bot_inbox") return@collect
          val o = parseObject(e.data)
          val entry = BotInboxEntry(
            o.str("botId") ?: return@collect, o.str("botName").orEmpty(), o.str("kind") ?: "result",
            o.str("title") ?: o.str("botName") ?: "A bot", o.str("summary").orEmpty(),
          )
          decider.bot(entry).forEach(::apply)
        }
      }
    }
  }

  private fun stopStreams() { streams?.cancel(); streams = null }

  private fun scheduleDue() {
    val at = decider.nextDue() ?: return
    dueTimer?.cancel()
    dueTimer = scope.launch {
      delay((at - System.currentTimeMillis()).coerceAtLeast(0))
      decider.due(System.currentTimeMillis()).forEach(::apply)
      scheduleDue()
      update()
    }
  }

  private fun apply(o: NotifyDecider.Out) = when (o) {
    is NotifyDecider.Out.Post -> notifier.post(o.notice)
    is NotifyDecider.Out.Cancel -> notifier.cancel(o.key)
  }

  /** What the persistent notification says: why Mercury stays connected. */
  fun connectionText(): String {
    val n = decider.running.size
    val w = decider.waiting.size
    return when {
      w > 0 -> "${if (w == 1) "A chat is" else "$w chats are"} waiting for you. Mercury stays connected to tell you what happens next."
      n > 0 -> "Working on ${if (n == 1) "a chat" else "$n chats"}. Mercury stays connected to tell you when ${if (n == 1) "it finishes" else "they finish"}."
      else -> "Stay connected is on, so Mercury can tell you when something needs you. Turn it off in Settings → Notifications."
    }
  }

  private fun startService() {
    // Android only lets a foreground service start while the app is on screen.
    if (!visible && !serviceOn) return
    try {
      ContextCompat.startForegroundService(app, Intent(app, ConnectionService::class.java))
      serviceOn = true
      shownText = connectionText()
    } catch (_: Exception) { /* not allowed right now: try again next time the app is on screen */ }
  }

  private fun stopService() {
    app.stopService(Intent(app, ConnectionService::class.java))
    serviceOn = false
    shownText = null
  }
}

/**
 * Keeps the app's process (and so [ActivityMonitor]'s connection) alive in the background while
 * something runs or "Stay connected" is on. Type remoteMessaging: it relays Mercury's messages
 * about your chats to this phone (Android 14+ asks every foreground service for its reason).
 */
class ConnectionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val c = (application as MercuryApplication).container
    val n = c.notifier.connection(c.monitor.connectionText())
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
    } catch (_: Exception) {
      stopSelf()
    }
    return START_NOT_STICKY
  }

  companion object { const val NOTIFICATION_ID = 7 }
}
