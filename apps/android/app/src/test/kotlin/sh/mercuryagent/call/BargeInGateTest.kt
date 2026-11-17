package sh.mercuryagent.call

import app.mercury.voice.VoiceEvent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Feeds a gate 60 ms frames at given levels, on a fake clock. */
private class GateRun {
  val gate = BargeInGate()
  var t = 100.0
  private val frame = 0.06

  /** True if a held barge-in became due during these frames. */
  fun feed(level: Float, seconds: Double, ownerTalking: Boolean = false, mercury: Boolean = false): Boolean {
    var due = false
    repeat(Math.round(seconds / frame).toInt()) {
      t += frame
      if (gate.observe(level, t, frame, ownerTalking, mercury)) due = true
    }
    return due
  }
}

class BargeInGateTest {
  @Test fun levelsOfFrames() {
    assertEquals(-100f, BargeInGate.level(ByteArray(1920)), 0f)
    val loud = ByteArray(1920)
    for (i in 0 until 960) {
      val s = if (i % 2 == 0) 16384 else -16384
      loud[2 * i] = (s and 0xFF).toByte(); loud[2 * i + 1] = (s shr 8).toByte()
    }
    assertEquals(-6.02f, BargeInGate.level(loud), 0.1f)
  }

  @Test fun unsureMeansTheBargeInHappens() {
    val r = GateRun()
    assertTrue(r.gate.admits(r.t))
    r.feed(-60f, 0.6)
    assertTrue(r.gate.admits(r.t))
    r.feed(-60f, 1.2)
    assertFalse(r.gate.admits(r.t))
    assertTrue(r.gate.admits(r.t + 1))
  }

  @Test fun theNearOwnerCutsInAndBackgroundTalkDoesnt() {
    val r = GateRun()
    r.feed(-60f, 2.0)
    r.feed(-25f, 1.5, ownerTalking = true)
    r.feed(-60f, 1.0)
    assertNotNull(r.gate.owner)
    r.feed(-45f, 0.3, mercury = true)
    assertFalse(r.gate.admits(r.t))
    r.feed(-27f, 0.3, mercury = true)
    assertTrue(r.gate.admits(r.t))
  }

  @Test fun withoutTheOwnersLevelTheFloorDecides() {
    val r = GateRun()
    r.feed(-60f, 2.0)
    r.feed(-58f, 0.3, mercury = true)
    assertFalse(r.gate.admits(r.t))
    r.feed(-40f, 0.3, mercury = true)
    assertTrue(r.gate.admits(r.t))
  }

  @Test fun aHeldBargeInHappensWhenTheNearVoiceShowsUp() {
    val r = GateRun()
    r.feed(-60f, 2.0)
    r.gate.hold(r.t)
    assertFalse(r.feed(-58f, 0.3, mercury = true))
    assertTrue(r.feed(-30f, 0.3, mercury = true))
    assertNull(r.gate.heldUntil)
  }

  @Test fun aHeldBargeInLapses() {
    val r = GateRun()
    r.feed(-60f, 2.0)
    r.gate.hold(r.t)
    assertFalse(r.feed(-58f, 2.0, mercury = true))
    assertNull(r.gate.heldUntil)
    r.gate.hold(r.t)
    assertFalse(r.feed(-30f, 0.12, mercury = false))
    assertNull(r.gate.heldUntil)
  }

  @Test fun theFloorFollowsTheRoom() {
    val r = GateRun()
    r.feed(-60f, 2.0)
    assertEquals(-60f, r.gate.floor!!, 0.5f)
    r.feed(-40f, 1.0)
    assertTrue(r.gate.floor!! < -50f)
    r.feed(-40f, 20.0)
    assertTrue(r.gate.floor!! > -41f)
    r.feed(-60f, 0.6)
    assertTrue(r.gate.floor!! < -58f)
  }

  @Test fun echoWhileMercurySpeaksIsntLearnedAsTheOwner() {
    val r = GateRun()
    r.feed(-60f, 2.0)
    r.feed(-30f, 2.0, ownerTalking = true, mercury = true)
    assertNull(r.gate.owner)
  }

  @Test fun onlyOpenAIIsJudgedOnThePhone() {
    assertTrue(CallBargeIn.judges("openai"))
    assertFalse(CallBargeIn.judges("gemini"))
    assertTrue(CallBargeIn(enabled = false, clock = { 0.0 }).admits())
  }
}

private class Judge(var admit: Boolean = true) : BargeInJudge {
  var holds = 0
  var releases = 0
  val talking = mutableListOf<Boolean>()
  override fun admits() = admit
  override fun hold() { holds++ }
  override fun release() { releases++ }
  override fun setOwnerTalking(on: Boolean) { talking += on }
}

private class GateLink : VoiceLink {
  var interrupts = 0
  override fun pushAudio(pcm16: ByteArray) = Unit
  override fun setMuted(muted: Boolean) = Unit
  override fun interrupt() { interrupts++ }
  override fun stop() = Unit
  override fun toolResult(id: String, output: String) = Unit
  override fun say(text: String) = Unit
  override fun instruct(text: String) = Unit
}

private class GatePlayback : CallPlayback {
  override var isPlaying = false
  var flushed = 0
  override fun flush() { flushed++; isPlaying = false }
}

private class NoChat : CallChat {
  override suspend fun ask(question: String): CallAnswer = CallAnswer.Stopped
  override val activity: String? = null
  override val working = false
  override val approvals = emptyList<CallApproval>()
  override suspend fun answer(approval: CallApproval, approved: Boolean) = Unit
  override suspend fun stopWork() = Unit
}

class BargeInBrainTest {
  private val link = GateLink()
  private val playback = GatePlayback()
  private val haptics = mutableListOf<CallHaptic>()

  private fun kotlinx.coroutines.test.TestScope.brain(judge: Judge): CallBrain {
    val b = CallBrain(link, NoChat(), playback, backgroundScope, haptic = { haptics += it }, now = { 1_000_000L })
    b.handle(VoiceEvent.Connected)
    b.bargeIn = judge
    return b
  }

  @Test fun backgroundSpeechDoesntStopMercury() = runTest {
    val j = Judge(admit = false)
    val b = brain(j)
    playback.isPlaying = true
    b.playbackChanged(true)
    b.handle(VoiceEvent.SpeechStarted)
    assertEquals(0, playback.flushed); assertEquals(0, link.interrupts)
    assertEquals(1, j.holds)
    assertEquals(listOf(true), j.talking)
    b.bargeInDue()
    assertEquals(1, playback.flushed); assertEquals(1, link.interrupts)
    assertEquals(CallHaptic.BargeIn, haptics.last())
  }

  @Test fun theOwnerStopsMercuryAtOnce() = runTest {
    val j = Judge()
    val b = brain(j)
    playback.isPlaying = true
    b.playbackChanged(true)
    b.handle(VoiceEvent.SpeechStarted)
    assertEquals(1, playback.flushed); assertEquals(1, link.interrupts); assertEquals(0, j.holds)
  }

  @Test fun whenMercuryIsQuietNothingIsJudged() = runTest {
    val j = Judge(admit = false)
    val b = brain(j)
    b.handle(VoiceEvent.ResponseStarted)
    b.handle(VoiceEvent.SpeechStarted)
    assertEquals(1, link.interrupts); assertEquals(0, j.holds)
  }

  @Test fun aLateBargeInAfterMercuryWentQuietDoesNothing() = runTest {
    val j = Judge(admit = false)
    val b = brain(j)
    playback.isPlaying = true
    b.playbackChanged(true)
    b.handle(VoiceEvent.SpeechStarted)
    playback.isPlaying = false
    b.playbackChanged(false)
    assertTrue(j.releases >= 1)
    b.bargeInDue()
    assertEquals(0, link.interrupts)
  }
}
