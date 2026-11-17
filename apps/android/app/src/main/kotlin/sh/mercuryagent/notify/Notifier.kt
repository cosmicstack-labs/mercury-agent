package sh.mercuryagent.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import sh.mercuryagent.MainActivity
import sh.mercuryagent.R

/**
 * Android's side of notifications: one channel per kind, so each can be tuned in the system's
 * settings ("Needs you" is urgent and pops up; "Finished" and "Failed" are normal), one
 * notification per chat that updates in place (the launcher's badge counts them), and a tap opens
 * that chat (mercury://chat/<id>) or the bots.
 */
class Notifier(private val context: Context) {
  private val manager = NotificationManagerCompat.from(context)

  init { createChannels() }

  fun createChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannelGroup(NotificationChannelGroup(GROUP, "Mercury"))
    fun ch(id: String, name: String, desc: String, importance: Int) = NotificationChannel(id, name, importance).apply {
      description = desc; group = GROUP; setShowBadge(id != CH_CONNECTION)
    }
    nm.createNotificationChannels(listOf(
      ch(CH_NEEDS, "Needs you", "Mercury is waiting for your answer: a permission, a choice or a question.", NotificationManager.IMPORTANCE_HIGH),
      ch(CH_DONE, "Finished", "A long task finished, a research report is ready, a bot has a result.", NotificationManager.IMPORTANCE_DEFAULT),
      ch(CH_FAILED, "Failed", "A task or a bot stopped with an error.", NotificationManager.IMPORTANCE_DEFAULT),
      ch(CH_CONNECTION, "Staying connected", "Shown while Mercury keeps its connection open in the background.", NotificationManager.IMPORTANCE_MIN),
    ))
  }

  val canPost: Boolean
    get() = manager.areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

  fun post(n: Notice) {
    if (!canPost) return
    val channel = when (n.kind) { Notice.Kind.NeedsYou -> CH_NEEDS; Notice.Kind.Done -> CH_DONE; Notice.Kind.Failed -> CH_FAILED }
    val b = NotificationCompat.Builder(context, channel)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(n.title)
      .setContentText(n.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(n.body))
      .setAutoCancel(true)
      .setContentIntent(openIntent(context, n.key))
      .setCategory(if (n.kind == Notice.Kind.NeedsYou) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
      .setPriority(if (n.kind == Notice.Kind.NeedsYou) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
      .setNumber(1)
    try { manager.notify(n.key, ID, b.build()) } catch (_: SecurityException) { /* permission revoked meanwhile */ }
  }

  fun cancel(key: String) = manager.cancel(key, ID)

  /** The persistent notification of the background connection (the foreground service's). */
  fun connection(text: String): android.app.Notification =
    NotificationCompat.Builder(context, CH_CONNECTION)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Mercury is connected")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setContentIntent(openIntent(context, null))
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()

  companion object {
    const val GROUP = "mercury"
    const val CH_NEEDS = "needs_you"
    const val CH_DONE = "finished"
    const val CH_FAILED = "failed"
    const val CH_CONNECTION = "connection"
    const val ID = 1
    const val EXTRA_KEY = "sh.mercuryagent.KEY"

    /** Opens the chat ([key] a thread id) or the bots ("bot:<id>"); null just opens the app. */
    fun openIntent(context: Context, key: String?): PendingIntent {
      val i = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      if (key != null) i.data = Uri.parse(deepLink(key))
      return PendingIntent.getActivity(context, key?.hashCode() ?: 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun deepLink(key: String): String =
      if (key.startsWith("bot:")) "mercury://bot/${Uri.encode(key.removePrefix("bot:"))}" else "mercury://chat/${Uri.encode(key)}"

    /** mercury://chat/<id> → the id; mercury://bot/<id> → "bot:<id>". */
    fun keyOf(uri: Uri?): String? {
      if (uri?.scheme != "mercury") return null
      val id = uri.pathSegments.firstOrNull()?.takeIf { it.isNotEmpty() } ?: return null
      return when (uri.host) { "chat" -> id; "bot" -> "bot:$id"; else -> null }
    }
  }
}

/** [NotifyPrefs] in SharedPreferences, as a flow the settings screen and the monitor watch. */
class NotifyPrefsStore(context: Context) {
  private val sp: SharedPreferences = context.getSharedPreferences("mercury.notify", Context.MODE_PRIVATE)
  private val _state = MutableStateFlow(read())
  val state: StateFlow<NotifyPrefs> = _state.asStateFlow()
  val value: NotifyPrefs get() = _state.value

  private fun read() = NotifyPrefs(
    needsYou = sp.getBoolean("needsYou", true), done = sp.getBoolean("done", true), doneAfterSec = sp.getInt("doneAfterSec", 30),
    failed = sp.getBoolean("failed", true), bots = sp.getBoolean("bots", true), stayConnected = sp.getBoolean("stayConnected", false),
    asked = sp.getBoolean("asked", false),
  )

  fun update(change: (NotifyPrefs) -> NotifyPrefs) {
    val p = change(_state.value)
    sp.edit().putBoolean("needsYou", p.needsYou).putBoolean("done", p.done).putInt("doneAfterSec", p.doneAfterSec)
      .putBoolean("failed", p.failed).putBoolean("bots", p.bots).putBoolean("stayConnected", p.stayConnected).putBoolean("asked", p.asked).apply()
    _state.value = p
  }
}
