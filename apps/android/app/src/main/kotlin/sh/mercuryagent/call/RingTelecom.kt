package sh.mercuryagent.call

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.mercuryagent.MainActivity
import sh.mercuryagent.MercuryApplication
import sh.mercuryagent.R
import sh.mercuryagent.core.RingInvite

/**
 * Mercury ringing this phone, as Android shows an incoming call (ADR-046; iOS: CallKitCall's
 * reportIncoming): a self-managed incoming call through core-telecom, so headsets, watches and the
 * car can answer and a real call takes priority, plus the call notification Android wants with it:
 * CallStyle, Answer and Decline, the ringtone (repeating) and vibration, and a full-screen intent
 * that opens [IncomingCallActivity] over the lock screen (Android 14+ only when the owner allowed
 * full-screen calls once, see [canRingFullScreen]). Only while the app's process is alive: there is
 * no push and no service for it. Answering hands over to the app's normal voice call ([CallTelecom]).
 */
class RingTelecom(private val context: Context, private val scope: CoroutineScope) : RingPresenter {
  var onAnswer: (String) -> Unit = {}
  var onDecline: (String) -> Unit = {}
  var callRunning: () -> Boolean = { false }
  override val inCall: Boolean get() = callRunning()

  private class Live(@Volatile var job: Job? = null, @Volatile var control: CallControlScope? = null, @Volatile var endingHere: Boolean = false)
  private val live = HashMap<String, Live>()
  private val manager = NotificationManagerCompat.from(context)

  init { createChannel(context) }

  override suspend fun show(invite: RingInvite): Boolean {
    if (!canNotify()) return false
    try {
      manager.notify(invite.id, NOTIFICATION_ID, notification(invite))
    } catch (e: Exception) {
      Log.w(TAG, "ring: notification refused (${e.message})")
      return false
    }
    addTelecomCall(invite)
    return true
  }

  /** The incoming call in Telecom; without it (it refused) the notification still rings. */
  private fun addTelecomCall(invite: RingInvite) {
    val calls = CallsManager(context)
    try {
      calls.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
    } catch (e: Exception) {
      Log.w(TAG, "ring: telecom unavailable (${e.message})"); return
    }
    val attrs = CallAttributesCompat(
      displayName = invite.caller.ifBlank { "Mercury" },
      address = Uri.parse("mercury:ring/${invite.id}"),
      direction = CallAttributesCompat.DIRECTION_INCOMING,
      callType = CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
      callCapabilities = 0,
    )
    val entry = Live()
    live[invite.id] = entry
    entry.job = scope.launch(Dispatchers.Default) {
      try {
        calls.addCall(
          attrs,
          // Answered from outside the app (a headset, a watch, the car).
          onAnswer = { _ -> withContext(Dispatchers.Main) { onAnswer(invite.id) } },
          onDisconnect = { _ ->
            entry.control = null
            if (!entry.endingHere) withContext(Dispatchers.Main) { onDecline(invite.id) }
          },
          onSetActive = {},
          onSetInactive = {},
        ) { entry.control = this }
      } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        Log.w(TAG, "ring: addCall failed (${e.message}), ringing with the notification only")
      }
    }
  }

  override fun end(id: String, how: RingEnd) {
    manager.cancel(id, NOTIFICATION_ID)
    val l = live.remove(id) ?: return
    l.endingHere = true
    val c = l.control
    if (c == null) { l.job?.cancel(); return }
    val cause = when (how) {
      RingEnd.AnsweredHere -> DisconnectCause.LOCAL
      RingEnd.DeclinedHere -> DisconnectCause.REJECTED
      RingEnd.AnsweredElsewhere -> DisconnectCause.ANSWERED_ELSEWHERE
      RingEnd.Unanswered, RingEnd.DeclinedElsewhere -> DisconnectCause.MISSED
      RingEnd.Failed -> DisconnectCause.ERROR
    }
    c.launch {
      runCatching { c.disconnect(DisconnectCause(cause)) }
      l.job?.cancel()
    }
  }

  private fun canNotify(): Boolean = manager.areNotificationsEnabled() &&
    (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

  private fun notification(invite: RingInvite): Notification {
    val caller = Person.Builder().setName(invite.caller.ifBlank { "Mercury" }).setImportant(true).build()
    val answer = PendingIntent.getActivity(
      context, invite.id.hashCode(),
      Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_ANSWER_RING).putExtra(EXTRA_RING, invite.id)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val decline = PendingIntent.getBroadcast(
      context, invite.id.hashCode(),
      Intent(context, RingActionReceiver::class.java).setAction(ACTION_DECLINE).putExtra(EXTRA_RING, invite.id),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val fullScreen = PendingIntent.getActivity(
      context, invite.id.hashCode() + 1,
      Intent(context, IncomingCallActivity::class.java).putExtra(EXTRA_RING, invite.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val n = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Mercury is calling")
      .setContentText(invite.reason.ifBlank { "Mercury wants to talk" })
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setFullScreenIntent(fullScreen, true)
      .setContentIntent(fullScreen)
      .setOngoing(true)
      .setAutoCancel(false)
      .setTimeoutAfter(((invite.expiresAt?.toEpochMilli() ?: (System.currentTimeMillis() + 45_000)) - System.currentTimeMillis()).coerceIn(5_000, 90_000))
      .build()
    // The ringtone repeats until the ring is answered, declined or cancelled.
    n.flags = n.flags or Notification.FLAG_INSISTENT
    return n
  }

  companion object {
    private const val TAG = "MercuryRing"
    const val CHANNEL = "mercury_calls"
    const val NOTIFICATION_ID = 46
    const val EXTRA_RING = "sh.mercuryagent.RING_ID"
    const val ACTION_DECLINE = "sh.mercuryagent.action.DECLINE_RING"

    fun createChannel(context: Context) {
      val nm = context.getSystemService(NotificationManager::class.java) ?: return
      val ch = NotificationChannel(CHANNEL, "Calls from Mercury", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Mercury ringing this phone: an incoming call, with the ringtone."
        group = sh.mercuryagent.notify.Notifier.GROUP
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
        )
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        setShowBadge(false)
      }
      nm.createNotificationChannel(ch)
    }

    /** Android 14+ shows full-screen calls only once the owner allowed it (Settings → Calls from Mercury). */
    fun canRingFullScreen(context: Context): Boolean =
      Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() == true
  }
}

/** The ring notification's Decline. */
class RingActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(RingTelecom.EXTRA_RING) ?: return
    if (intent.action == RingTelecom.ACTION_DECLINE) (context.applicationContext as MercuryApplication).container.ringer.declineHere(id)
  }
}
