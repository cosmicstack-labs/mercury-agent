package sh.mercuryagent.call

/**
 * Where a call's sound goes (pure, tested). Loudspeaker by default; the earpiece only while the
 * phone is held to the ear (the proximity sensor says so), back to the loudspeaker when it comes
 * away. A Bluetooth or wired headset takes over whenever one is there, and once the owner taps
 * Speaker their choice holds (a headset that arrives later still takes over). iOS: VoiceCallModel's
 * autoRoute and updateRoute.
 */
object CallRouting {
  enum class Target { SPEAKER, EARPIECE, EXTERNAL }

  /**
   * [target] is where the sound goes; [proximityLock] is whether the proximity wake lock is held,
   * so the screen goes dark at the ear (only on the phone's own speakers: never with a headset).
   */
  data class Decision(val target: Target, val proximityLock: Boolean) {
    val speaker: Boolean get() = target == Target.SPEAKER
  }

  /**
   * @param manualSpeaker the owner's choice: true speaker, false not the speaker, null automatic.
   * @param external a headset (Bluetooth, wired, USB, hearing aid) is connected.
   * @param near the proximity sensor says the phone is at the ear.
   * @param hasEarpiece the phone has an earpiece (tablets don't).
   */
  fun decide(manualSpeaker: Boolean?, external: Boolean, near: Boolean, hasEarpiece: Boolean = true): Decision {
    val target = when {
      manualSpeaker == true -> Target.SPEAKER
      external -> Target.EXTERNAL
      manualSpeaker == false -> if (hasEarpiece) Target.EARPIECE else Target.SPEAKER
      near && hasEarpiece -> Target.EARPIECE
      else -> Target.SPEAKER
    }
    return Decision(target, proximityLock = target != Target.EXTERNAL)
  }

  /** The owner tapped Speaker: their new choice, from where the sound is now. */
  fun toggled(current: Target): Boolean = current != Target.SPEAKER

  /**
   * Is something at the sensor? Most phones report 0 (near) or their maximum range (far); some
   * report centimetres. Near is anything under 5 cm and under the sensor's maximum.
   */
  fun isNear(distance: Float, maximumRange: Float): Boolean = distance < minOf(5f, maximumRange)
}
