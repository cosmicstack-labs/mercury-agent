package sh.mercuryagent.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import sh.mercuryagent.MainActivity
import sh.mercuryagent.MercuryApplication
import sh.mercuryagent.R

/**
 * Keeps a voice call alive in the background: a foreground service of type phoneCall (and
 * microphone, which Android 14+ needs to record while the app isn't on screen), with an ongoing
 * call notification (tap to return, Hang up). Started when a call starts, while the app is on
 * screen, and stopped when it ends.
 */
class CallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val calls = (application as MercuryApplication).container.calls
    if (intent?.action == ACTION_HANG_UP) {
      calls.current?.end()
      return START_NOT_STICKY
    }
    // Foreground first, always: a service started this way must say so even when the call
    // already ended (it then stops at once).
    val ok = foreground(notification())
    if (!ok || !calls.running) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  /** startForeground with both types; microphone alone, then phone call alone, when one is refused. */
  private fun foreground(n: Notification): Boolean {
    val types = if (Build.VERSION.SDK_INT >= 30) {
      listOf(
        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
      )
    } else listOf(ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
    for (t in types) {
      try {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, t)
        return true
      } catch (e: Exception) {
        Log.w("MercuryCall", "call service: type $t refused (${e.message})")
      }
    }
    return false
  }

  private fun notification(): Notification {
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CHANNEL, "Voice calls", NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = "A voice call with Mercury in progress"
      setSound(null, null)
      enableVibration(false)
    })
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val hangUp = PendingIntent.getService(
      this, 1, Intent(this, CallService::class.java).setAction(ACTION_HANG_UP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val mercury = Person.Builder().setName("Mercury").setImportant(true).build()
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Mercury")
      .setContentText("Voice call · tap to return")
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setUsesChronometer(true)
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(mercury, hangUp))
      .build()
  }

  companion object {
    private const val CHANNEL = "calls"
    private const val NOTIFICATION_ID = 7301
    private const val ACTION_HANG_UP = "sh.mercuryagent.call.HANG_UP"

    fun start(context: Context) {
      runCatching { ContextCompat.startForegroundService(context, Intent(context, CallService::class.java)) }
        .onFailure { Log.w("MercuryCall", "call service: ${it.message}") }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, CallService::class.java))
    }
  }
}
