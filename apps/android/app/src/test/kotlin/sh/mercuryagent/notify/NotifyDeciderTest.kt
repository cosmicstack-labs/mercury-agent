package sh.mercuryagent.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.ActivityEvent

/** apps/desktop/src/app/notify/notify.ts, on the phone. */
class NotifyDeciderTest {
  private val d = NotifyDecider()
  private fun posts(out: List<NotifyDecider.Out>) = out.filterIsInstance<NotifyDecider.Out.Post>().map { it.notice }

  @Test fun needsYouIsToldUnlessOnScreen() {
    val n = posts(d.handle(ActivityEvent("needs_you", "s1", title = "Trip", prompt = "Run a command"), 0))
    assertEquals(listOf(Notice(Notice.Kind.NeedsYou, "s1", "Mercury needs you", "Trip: Run a command")), n)
    assertTrue("s1" in d.waiting)
    d.viewing = "s2"
    assertTrue(posts(d.handle(ActivityEvent("needs_you", "s2", prompt = "x"), 0)).isEmpty())
    assertEquals(listOf(NotifyDecider.Out.Cancel("s1")), d.handle(ActivityEvent("resolved", "s1"), 10))
  }

  @Test fun aLongTaskIsHeldThenTold() {
    d.handle(ActivityEvent("started", "s1"), 0)
    assertTrue("s1" in d.running)
    assertTrue(posts(d.handle(ActivityEvent("done", "s1", title = "Code · Fix", ms = 45_000.0, preview = "All green"), 45_000)).isEmpty())
    assertTrue(d.running.isEmpty())
    assertTrue(d.due(45_000 + 1000).isEmpty())
    assertEquals(listOf(Notice(Notice.Kind.Done, "s1", "Done: Fix", "All green")), posts(d.due(45_000 + NotifyDecider.HOLD_DONE_MS)))
  }

  @Test fun shortTasksAreQuietAndTheThresholdUsesMs() {
    d.handle(ActivityEvent("done", "s1", ms = 5_000.0), 0)
    assertEquals(null, d.nextDue())
    d.prefs = d.prefs.copy(doneAfterSec = 3)
    d.handle(ActivityEvent("done", "s1", ms = 5_000.0), 0)
    assertEquals(NotifyDecider.HOLD_DONE_MS, d.nextDue())
  }

  @Test fun withoutMsTheStartIsUsed() {
    d.handle(ActivityEvent("started", "s1"), 0)
    d.handle(ActivityEvent("done", "s1"), 31_000)
    assertEquals(31_000 + NotifyDecider.HOLD_DONE_MS, d.nextDue())
  }

  @Test fun researchReplacesTheHeldDone() {
    d.handle(ActivityEvent("done", "s1", ms = 60_000.0), 0)
    val n = posts(d.handle(ActivityEvent("research", "s1", state = "done", topic = "solar  storms", read = 41, cited = 23, failed = 3), 500))
    assertEquals(listOf(Notice(Notice.Kind.Done, "s1", "Research ready: solar storms", "41 sources read · 23 cited · 3 couldn't be read")), n)
    assertTrue(d.due(10_000).isEmpty())
    // No "done" waiting: nothing to say.
    assertTrue(posts(d.handle(ActivityEvent("research", "s2", state = "done"), 0)).isEmpty())
  }

  @Test fun researchEndings() {
    assertEquals("Research didn't finish: q", NotifyDecider.researchNotice(ActivityEvent("research", "s", state = "failed", topic = "q", read = 1)).title)
    assertEquals("1 source read. Open it to continue.", NotifyDecider.researchNotice(ActivityEvent("research", "s", state = "failed", topic = "q", read = 1)).body)
    assertEquals(Notice.Kind.Failed, NotifyDecider.researchNotice(ActivityEvent("research", "s", state = "stopped")).kind)
    assertEquals("Partial research report: your question", NotifyDecider.researchNotice(ActivityEvent("research", "s", state = "partial")).title)
  }

  @Test fun failuresAreToldAtOnce() {
    val n = posts(d.handle(ActivityEvent("failed", "s1", title = "Trip", message = "Provider down"), 0))
    assertEquals(listOf(Notice(Notice.Kind.Failed, "s1", "Stopped with an error: Trip", "Provider down")), n)
    d.prefs = d.prefs.copy(failed = false)
    assertTrue(posts(d.handle(ActivityEvent("failed", "s1"), 0)).isEmpty())
  }

  @Test fun theChatOnScreenIsNeverTold() {
    d.handle(ActivityEvent("done", "s1", ms = 99_000.0), 0)
    d.opened("s1")
    assertTrue(d.due(99_999).isEmpty())
    assertTrue(posts(d.handle(ActivityEvent("failed", "s1"), 0)).isEmpty())
  }

  @Test fun botInbox() {
    val e = BotInboxEntry("b1", "Scout", "result", "Scout: daily digest", "  Three   things\nhappened ")
    assertEquals(listOf(Notice(Notice.Kind.Done, "bot:b1", "Scout: daily digest", "Three things happened")), posts(d.bot(e)))
    assertEquals(Notice.Kind.NeedsYou, posts(d.bot(e.copy(kind = "needs-you", summary = "")))[0].kind)
    assertEquals("It needs you.", posts(d.bot(e.copy(kind = "needs-you", summary = "")))[0].body)
    d.botsOnScreen = true
    assertTrue(d.bot(e).isEmpty())
    d.botsOnScreen = false
    d.prefs = d.prefs.copy(bots = false)
    assertTrue(d.bot(e).isEmpty())
  }

  @Test fun seedKeepsWaitingChats() {
    d.handle(ActivityEvent("needs_you", "w"), 0)
    d.handle(ActivityEvent("started", "gone"), 0)
    d.seed(listOf("a"), 0)
    assertEquals(setOf("w", "a"), d.running.toSet())
  }
}
