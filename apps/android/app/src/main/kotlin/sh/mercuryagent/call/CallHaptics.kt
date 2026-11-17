package sh.mercuryagent.call

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/** Plays the call's haptics (iOS: CallHaptics): short predefined effects, never a buzz. */
class CallHaptics(context: Context) {
  private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
    context.getSystemService(VibratorManager::class.java)?.defaultVibrator
  } else {
    @Suppress("DEPRECATION") context.getSystemService(Vibrator::class.java)
  }

  fun play(h: CallHaptic) {
    val v = vibrator?.takeIf { it.hasVibrator() } ?: return
    runCatching { v.vibrate(VibrationEffect.createPredefined(effect(h))) }
  }

  companion object {
    /** What each moment feels like (iOS's success/warning/error/soft/light/medium/selection). */
    fun effect(h: CallHaptic): Int = when (h) {
      CallHaptic.Connected -> VibrationEffect.EFFECT_DOUBLE_CLICK
      CallHaptic.MercurySpeaks, CallHaptic.DictationStopped, CallHaptic.MuteToggled, CallHaptic.BargeIn, CallHaptic.DictationStarted -> VibrationEffect.EFFECT_TICK
      CallHaptic.ApprovalAsked -> VibrationEffect.EFFECT_DOUBLE_CLICK
      is CallHaptic.ApprovalAnswered -> if (h.approved) VibrationEffect.EFFECT_CLICK else VibrationEffect.EFFECT_HEAVY_CLICK
      CallHaptic.Ended -> VibrationEffect.EFFECT_CLICK
      CallHaptic.Failed -> VibrationEffect.EFFECT_HEAVY_CLICK
    }
  }
}
