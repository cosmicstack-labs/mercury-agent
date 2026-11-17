package sh.mercuryagent.ui

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.LiveSnapshot
import sh.mercuryagent.ui.conversation.Agent
import sh.mercuryagent.ui.conversation.ConversationEvents
import sh.mercuryagent.ui.conversation.ConversationState
import sh.mercuryagent.ui.conversation.TurnTrace

class ConversationEventsTest {
  private val t0 = Instant.parse("2026-11-16T10:00:00Z")
  private var s = ConversationState(threadId = "s1", loaded = true)
  private var ended = false
  private fun on(event: String, json: String, at: Long = 0) {
    val r = ConversationEvents.reduce(s, event, json, t0.plusMillis(at))
    s = r.state; ended = ended || r.turnEnded
  }

  @Test fun aWholeTurn() {
    on("thinking", "{}")
    assertEquals(Agent.Thinking, s.agent)
    assertEquals("Thinking…", s.liveLine)
    on("reasoning", """{"text":"Let me look"}""")
    on("step_start", """{"id":"c1","tool":"read_file","title":"Read notes.md","step":1}""", 100)
    assertEquals(Agent.Working, s.agent)
    assertEquals("Read notes.md", s.liveLine)
    on("step_done", """{"id":"c1","tool":"read_file","summary":"12 lines","durationMs":250}""", 400)
    on("text_delta", """{"text":"Here "}""", 500)
    on("text_delta", """{"text":"it is."}""", 600)
    assertEquals(Agent.Streaming, s.agent)
    assertEquals("Here it is.", s.streaming)
    on("text_done", """{"fullText":"Here it is.","usage":{"inputTokens":1000,"outputTokens":20}}""", 900)
    assertTrue(ended)
    assertEquals(Agent.Idle, s.agent)
    assertNull(s.live)
    val m = s.messages.single()
    assertEquals("assistant", m.role)
    assertEquals("1k tokens", m.usage?.short)
    val trace = s.traces[m.id]!!
    assertEquals(1, trace.steps.size)
    assertEquals(TurnTrace.Status.Done, trace.steps[0].status)
    assertTrue(trace.items.none { it is TurnTrace.Item.Text })
    assertEquals("Worked for 0.9s · 1 step", trace.summary)
  }

  @Test fun otherSessionsAreIgnored() {
    on("text_delta", """{"sessionId":"other","text":"x"}""")
    assertEquals(Agent.Idle, s.agent)
  }

  @Test fun lateThinkingAfterAReplyIsNotANewTurn() {
    on("text_done", """{"text":"Done"}""")
    on("thinking", "{}", 1000)
    assertEquals(Agent.Idle, s.agent)
    on("thinking", "{}", 4000)
    assertEquals(Agent.Thinking, s.agent)
  }

  @Test fun stopNoteEndsAsStopped() {
    on("thinking", "{}")
    on("text_delta", """{"text":"Half"}""")
    s = s.copy(stopping = true)
    on("text_done", """{"text":"⏹ Task stopped. Ask again any time."}""")
    assertTrue(ended)
    assertEquals(Agent.Idle, s.agent)
    val m = s.messages.single()
    assertEquals("Half", m.content)
    assertEquals(true, m.stopped)
  }

  @Test fun promptsComeAndGo() {
    on("permission_request", """{"id":"p1","prompt":"Run `ls`?","options":["yes","always","no"]}""")
    assertEquals(listOf("Allow once", "Always allow", "Deny"), s.prompts.single().options.map { it.label })
    assertEquals("Needs you", s.titleStatus)
    on("choice_prompt", """{"id":"p2","question":"Which?","options":[{"value":"a","label":"A"}]}""")
    assertEquals(2, s.prompts.size)
    on("permission_resolved", """{"id":"p1"}""")
    assertEquals(listOf("p2"), s.prompts.map { it.id })
  }

  @Test fun queuedThenDropped() {
    on("queued", """{"position":2}""")
    assertEquals(2, s.queued); assertEquals(Agent.Thinking, s.agent)
    on("queue_dropped", """{"dropped":1}""")
    assertEquals(Agent.Idle, s.agent)
    assertNotNull(s.notice)
  }

  @Test fun errorEndsTheTurnWithANote() {
    on("thinking", "{}")
    on("error", """{"message":"Provider down"}""")
    assertTrue(ended)
    assertEquals("Provider down", s.messages.single().content)
    assertEquals("system", s.messages.single().role)
  }

  @Test fun artifactsLandOnTheLastReplyWhenIdle() {
    on("text_done", """{"text":"Made it"}""")
    on("artifacts", """{"items":[{"id":"a1","name":"x.png"}]}""")
    assertEquals(listOf("a1"), s.messages.last().artifacts.map { it.id })
  }

  @Test fun stepFailureByFlagOrText() {
    assertTrue(ConversationEvents.stepFailed(sh.mercuryagent.core.parseObject("""{"failed":true}"""), "ok"))
    assertTrue(ConversationEvents.stepFailed(sh.mercuryagent.core.parseObject("{}"), "HTTP 404 not found"))
    assertTrue(!ConversationEvents.stepFailed(sh.mercuryagent.core.parseObject("{}"), "Read 4 files"))
  }

  @Test fun restoreALiveSnapshot() {
    s = s.restore(LiveSnapshot(running = true, startedAt = 1.7e12, activity = "🔎 Searching", text = "Partial"))
    assertEquals(Agent.Streaming, s.agent)
    assertEquals("Partial", s.streaming)
    assertEquals("Searching", s.live?.phase)
    s = s.restore(LiveSnapshot(running = false))
    assertEquals(Agent.Idle, s.agent)
  }

  @Test fun durations() {
    assertEquals("0.4s", TurnTrace.duration(0.4))
    assertEquals("12s", TurnTrace.duration(12.2))
    assertEquals("1m 05s", TurnTrace.duration(65.0))
    assertEquals("1h 02m", TurnTrace.duration(3720.0))
  }
}
