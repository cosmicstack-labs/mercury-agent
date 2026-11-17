package sh.mercuryagent.call

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.call.CallRouting.Target

class PcmTest {
  @Test fun littleEndianBothWays() {
    val s = shortArrayOf(0, 1, -1, 32767, -32768, 0x1234)
    val b = Pcm.bytes(s)
    assertArrayEquals(byteArrayOf(0, 0, 1, 0, -1, -1, -1, 0x7F, 0, -0x80, 0x34, 0x12), b)
    assertArrayEquals(s, Pcm.samples(b))
    // An odd trailing byte is ignored.
    assertArrayEquals(shortArrayOf(1), Pcm.samples(byteArrayOf(1, 0, 9)))
    assertArrayEquals(byteArrayOf(-1, -1), Pcm.bytes(s, from = 2, count = 1))
  }

  @Test fun floatsAreClipped() {
    assertArrayEquals(shortArrayOf(0, 32767, -32768, 32767, -32768, 16383), Pcm.fromFloats(floatArrayOf(0f, 1f, -1f, 2f, -3f, 0.5f)))
  }

  @Test fun peaksAndTheOrbsLevel() {
    assertEquals(0.5f, Pcm.peak(shortArrayOf(100, -16384, 200)), 1e-4f)
    assertEquals(0.5f, Pcm.peak(Pcm.bytes(shortArrayOf(100, -16384, 200))), 1e-4f)
    assertEquals(1f, Pcm.peak(shortArrayOf(-32768)), 0f)
    assertEquals(0f, Pcm.display(0f), 0f)
    assertEquals(1f, Pcm.display(1f), 0f)
    assertEquals(0.5f, Pcm.display(0.16f), 1e-4f) // speech peaks are lifted
    assertEquals(60L, Pcm.millis(Pcm.FRAME * 2))
  }

  @Test fun framesAreWhole60msFrames() {
    val f = PcmFramer()
    assertTrue(f.append(ShortArray(320) { 1 }).isEmpty())
    assertTrue(f.append(ShortArray(320) { 2 }).isEmpty())
    val one = f.append(ShortArray(500) { 3 })
    assertEquals(1, one.size)
    assertEquals(Pcm.FRAME * 2, one[0].size)
    val back = Pcm.samples(one[0])
    assertEquals(1, back[0].toInt()); assertEquals(2, back[320].toInt()); assertEquals(3, back[959].toInt())
    assertEquals(180, f.pendingCount)
    // A big read gives several frames in order and keeps the rest.
    val many = f.append(ShortArray(2000) { 4 }, n = 1800)
    assertEquals(2, many.size)
    assertEquals(3, Pcm.samples(many[0])[0].toInt())
    assertEquals(60, f.pendingCount)
    f.reset()
    assertEquals(0, f.pendingCount)
  }

  @Test fun theMeterFadesStaleLevels() {
    var now = 1_000L
    val m = CallMeter { now }
    m.setMic(0.4f); m.setVoice(0.2f)
    assertEquals(0.4f to 0.2f, m.read())
    now += 260
    assertEquals(0f to 0f, m.read())
    m.setEngine(0.16f, 0f)
    assertEquals(0.5f, m.read().first, 1e-4f)
    now += 310
    assertEquals(0f, m.read().first, 0f)
  }
}

class CallRoutingTest {
  private fun d(manual: Boolean? = null, external: Boolean = false, near: Boolean = false, earpiece: Boolean = true) =
    CallRouting.decide(manual, external, near, earpiece)

  @Test fun loudByDefaultEarpieceOnlyAtTheEar() {
    assertEquals(Target.SPEAKER, d().target)
    assertTrue(d().speaker)
    assertEquals(Target.EARPIECE, d(near = true).target)
    // The screen goes dark at the ear only on the phone's own speakers.
    assertTrue(d().proximityLock)
    assertTrue(d(near = true).proximityLock)
  }

  @Test fun headsetsTakeOver() {
    assertEquals(CallRouting.Decision(Target.EXTERNAL, false), d(external = true))
    assertEquals(Target.EXTERNAL, d(external = true, near = true).target)
    assertEquals(Target.EXTERNAL, d(manual = false, external = true).target)
  }

  @Test fun theOwnersChoiceHolds() {
    assertEquals(Target.SPEAKER, d(manual = true, near = true).target)
    assertEquals(Target.SPEAKER, d(manual = true, external = true).target)
    assertEquals(Target.EARPIECE, d(manual = false).target)
    assertEquals(Target.EARPIECE, d(manual = false, near = false).target)
    assertTrue(CallRouting.toggled(Target.EARPIECE))
    assertTrue(CallRouting.toggled(Target.EXTERNAL))
    assertFalse(CallRouting.toggled(Target.SPEAKER))
  }

  @Test fun noEarpieceStaysLoud() {
    assertEquals(Target.SPEAKER, d(near = true, earpiece = false).target)
    assertEquals(Target.SPEAKER, d(manual = false, earpiece = false).target)
  }

  @Test fun proximity() {
    assertTrue(CallRouting.isNear(0f, 5f))
    assertFalse(CallRouting.isNear(5f, 5f))
    assertTrue(CallRouting.isNear(3f, 8f))
    assertFalse(CallRouting.isNear(8f, 8f))
    assertTrue(CallRouting.isNear(0f, 1f))
    assertFalse(CallRouting.isNear(1f, 1f))
  }
}
