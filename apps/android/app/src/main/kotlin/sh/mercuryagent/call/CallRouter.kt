package sh.mercuryagent.call

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Puts the call's sound where [CallRouting] decides, with AudioManager's communication-device API
 * (Android 12+; the speakerphone switch before that): the loudspeaker by default, the earpiece
 * only while the proximity sensor says the phone is at the ear (with the proximity wake lock, so
 * the screen goes dark there), a headset whenever one is connected, and the owner's Speaker tap
 * over all of that. [onRoute] hears every decision (the screen's Speaker button, Telecom's endpoint).
 * Main thread only.
 */
class CallRouter(context: Context, private val onRoute: (CallRouting.Decision) -> Unit) : SensorEventListener {
  private val audio = context.getSystemService(AudioManager::class.java)
  private val power = context.getSystemService(PowerManager::class.java)
  private val sensors = context.getSystemService(SensorManager::class.java)
  private val proximity: Sensor? = sensors?.getDefaultSensor(Sensor.TYPE_PROXIMITY)
  private val wakeLock: PowerManager.WakeLock? =
    if (power?.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) == true) {
      power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "mercury:call-proximity").apply { setReferenceCounted(false) }
    } else null
  private val main = Handler(Looper.getMainLooper())
  private var manual: Boolean? = null
  private var near = false
  private var started = false
  private var previousMode = AudioManager.MODE_NORMAL

  var decision: CallRouting.Decision? = null
    private set

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
      // A headset that arrives takes over, whatever was chosen before.
      if (added.any { it.type in EXTERNAL && it.isSink }) manual = null
      apply()
    }
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = apply()
  }

  fun start() {
    if (started) return
    started = true
    previousMode = audio.mode
    runCatching { audio.mode = AudioManager.MODE_IN_COMMUNICATION }
    proximity?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, main) }
    audio.registerAudioDeviceCallback(devices, main)
    apply()
  }

  /** The owner tapped Speaker: their choice holds until a headset arrives or the call ends. */
  fun toggleSpeaker() {
    manual = CallRouting.toggled(decision?.target ?: CallRouting.Target.SPEAKER)
    apply()
  }

  fun stop() {
    if (!started) return
    started = false
    sensors?.unregisterListener(this)
    audio.unregisterAudioDeviceCallback(devices)
    if (wakeLock?.isHeld == true) wakeLock.release()
    if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else @Suppress("DEPRECATION") { audio.isSpeakerphoneOn = false }
    runCatching { audio.mode = if (previousMode == AudioManager.MODE_IN_COMMUNICATION) AudioManager.MODE_NORMAL else previousMode }
    decision = null
  }

  override fun onSensorChanged(e: SensorEvent) {
    val now = CallRouting.isNear(e.values.firstOrNull() ?: return, e.sensor.maximumRange)
    if (now == near) return
    near = now
    apply()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  private fun apply() {
    if (!started) return
    val external: AudioDeviceInfo?
    val hasEarpiece: Boolean
    if (Build.VERSION.SDK_INT >= 31) {
      val available = audio.availableCommunicationDevices
      external = available.sortedBy { EXTERNAL.indexOf(it.type) }.firstOrNull { it.type in EXTERNAL }
      hasEarpiece = available.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
    } else {
      external = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.type in EXTERNAL }
      hasEarpiece = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
    }
    val d = CallRouting.decide(manual, external != null, near, hasEarpiece)
    if (Build.VERSION.SDK_INT >= 31) {
      val target = when (d.target) {
        CallRouting.Target.EXTERNAL -> external
        CallRouting.Target.SPEAKER -> audio.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        CallRouting.Target.EARPIECE -> audio.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
      }
      if (target != null && audio.communicationDevice?.id != target.id) {
        if (!audio.setCommunicationDevice(target)) Log.w("MercuryCall", "route: couldn't switch to ${d.target}")
      }
    } else {
      @Suppress("DEPRECATION")
      audio.isSpeakerphoneOn = d.target == CallRouting.Target.SPEAKER
    }
    // At the ear the screen goes dark (only on the phone's own speakers, never with a headset).
    if (d.proximityLock) { if (wakeLock?.isHeld == false) wakeLock.acquire(60 * 60_000L) }
    else if (wakeLock?.isHeld == true) wakeLock.release()
    if (d != decision) {
      decision = d
      onRoute(d)
    }
  }

  private companion object {
    /** Headsets, in the order they're preferred. */
    val EXTERNAL = listOf(
      AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_HEARING_AID,
    )
  }
}
