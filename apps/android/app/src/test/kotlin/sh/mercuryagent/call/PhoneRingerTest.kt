package sh.mercuryagent.call

import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.MissedItem
import sh.mercuryagent.core.ReachEvent
import sh.mercuryagent.core.ReachNotice
import sh.mercuryagent.core.RingInvite
import sh.mercuryagent.core.RingOutcome

/** Mercury ringing this phone (ADR-046), with a fake Telecom: what's shown and what's reported back. */
@OptIn(ExperimentalCoroutinesApi::class)
class PhoneRingerTest {
  private class Fake : RingPresenter {
    val shown = mutableListOf<String>()
    val ended = mutableListOf<Pair<String, RingEnd>>()
    var refuse = false
    override var inCall = false
    override suspend fun show(invite: RingInvite): Boolean { if (refuse) return false; shown += invite.id; return true }
    override fun end(id: String, how: RingEnd) { ended += id to how }
  }

  private class Setup(scope: TestScope) {
    val fake = Fake()
    val outcomes = mutableListOf<Pair<String, RingOutcome>>()
    val posts = mutableListOf<ReachNotice>()
    val ringer = PhoneRinger(scope.backgroundScope, fake, report = { id, o -> outcomes += id to o }, post = { posts += it }, now = { scope.testScheduler.currentTime })
  }

  private fun TestScope.invite(id: String = "r1", inMs: Long = 45_000) =
    RingInvite(id, reason = "the deploy failed", expiresAt = Instant.ofEpochMilli(testScheduler.currentTime + inMs))

  @Test fun aRingShowsAnIncomingCallAndAnsweringIsReported() = runTest {
    val s = Setup(this)
    s.ringer.handle(ReachEvent.Ring(invite()))
    runCurrent()
    assertEquals(listOf("r1"), s.fake.shown)
    assertEquals("r1", s.ringer.ringing.value?.id)
    assertTrue(s.ringer.answerHere("r1"))
    runCurrent()
    assertNull(s.ringer.ringing.value)
    assertEquals(listOf("r1" to RingEnd.AnsweredHere), s.fake.ended)
    assertEquals(listOf("r1" to RingOutcome.Answered), s.outcomes)
    assertEquals("the deploy failed", s.ringer.takeAnswered()?.reason)
    assertNull(s.ringer.takeAnswered())
  }

  @Test fun declineIsReported() = runTest {
    val s = Setup(this)
    s.ringer.handle(ReachEvent.Ring(invite()))
    runCurrent()
    s.ringer.declineHere("r1")
    runCurrent()
    assertEquals(listOf("r1" to RingOutcome.Declined), s.outcomes)
    assertEquals(listOf("r1" to RingEnd.DeclinedHere), s.fake.ended)
  }

  @Test fun theSameRingTwiceRingsOnce() = runTest {
    val s = Setup(this)
    s.ringer.handle(ReachEvent.Ring(invite()))
    s.ringer.handle(ReachEvent.Ring(invite()))
    runCurrent()
    assertEquals(listOf("r1"), s.fake.shown)
  }

  @Test fun answeredElsewhereStopsTheRing() = runTest {
    val s = Setup(this)
    s.ringer.handle(ReachEvent.Ring(invite()))
    runCurrent()
    s.ringer.handle(ReachEvent.RingEnd("r1", "answered_elsewhere"))
    assertEquals(listOf("r1" to RingEnd.AnsweredElsewhere), s.fake.ended)
    assertTrue(s.outcomes.isEmpty())
    assertEquals(false, s.ringer.answerHere("r1"))
  }

  @Test fun noAnswerBeforeItExpiresIsAMissedCall() = runTest {
    val s = Setup(this)
    s.ringer.handle(ReachEvent.Ring(invite(inMs = 45_000)))
    runCurrent()
    advanceTimeBy(44_000)
    assertTrue(s.outcomes.isEmpty())
    advanceTimeBy(1_100)
    runCurrent()
    assertEquals(listOf("r1" to RingEnd.Unanswered), s.fake.ended)
    assertEquals(listOf("r1" to RingOutcome.Missed), s.outcomes)
    assertEquals("Missed call from Mercury", s.posts.single().title)
  }

  @Test fun busyOffOrRefusedIsMissedNotShown() = runTest {
    val s = Setup(this)
    s.fake.inCall = true
    s.ringer.handle(ReachEvent.Ring(invite("a")))
    s.fake.inCall = false
    s.ringer.ringOn = false
    s.ringer.handle(ReachEvent.Ring(invite("b")))
    s.ringer.ringOn = true
    s.fake.refuse = true
    s.ringer.handle(ReachEvent.Ring(invite("c")))
    runCurrent()
    assertTrue(s.fake.shown.isEmpty())
    assertEquals(listOf(RingOutcome.Missed, RingOutcome.Missed, RingOutcome.Missed), s.outcomes.map { it.second })
    assertNull(s.ringer.ringing.value)
  }

  @Test fun anExpiredRingIsIgnored() = runTest {
    val s = Setup(this)
    advanceTimeBy(10_000)
    s.ringer.handle(ReachEvent.Ring(invite(inMs = -1)))
    runCurrent()
    assertTrue(s.fake.shown.isEmpty() && s.outcomes.isEmpty())
  }

  @Test fun notificationsOnceAndRespectTheSwitch() = runTest {
    val s = Setup(this)
    val n = ReachNotice("n1", "Done", "Report ready")
    s.ringer.handle(ReachEvent.Notify(n))
    s.ringer.handle(ReachEvent.Notify(n))
    s.ringer.notifyOn = false
    s.ringer.handle(ReachEvent.Notify(ReachNotice("n2", "x", "y")))
    assertEquals(listOf(n), s.posts)
  }

  @Test fun missedItemsAreShownOnceAndAcknowledged() = runTest {
    val s = Setup(this)
    val items = listOf(MissedItem("m1", "call", "Missed call from Mercury", "x"), MissedItem("m2", "notification", "FYI", "y", threadId = "t1"))
    assertEquals(listOf("m1", "m2"), s.ringer.showMissed(items))
    s.ringer.showMissed(items)
    assertEquals(listOf("missed-call", "info"), s.posts.map { it.kind })
    assertEquals("t1", s.posts[1].threadId)
  }
}
