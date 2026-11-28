package sh.mercuryagent.ui

import java.time.Instant
import java.time.LocalTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.ArtifactRef
import sh.mercuryagent.core.ChatEffort
import sh.mercuryagent.core.ChatModelInfo
import sh.mercuryagent.core.ChatPlan
import sh.mercuryagent.core.PlanStep
import sh.mercuryagent.core.SentAttachment
import sh.mercuryagent.ui.conversation.Agent
import sh.mercuryagent.ui.conversation.ComposerState
import sh.mercuryagent.ui.conversation.LiveStatus
import sh.mercuryagent.ui.conversation.MediaMotion
import sh.mercuryagent.ui.conversation.MediaText
import sh.mercuryagent.ui.conversation.PlanStatus
import sh.mercuryagent.ui.conversation.ReplyMediaRules
import sh.mercuryagent.ui.conversation.TurnTrace
import sh.mercuryagent.ui.conversation.Welcome
import sh.mercuryagent.ui.conversation.cleanSecurity
import sh.mercuryagent.ui.conversation.isAttachedOnly
import sh.mercuryagent.core.ChatMessage

class ConversationPartsTest {
  private val t0 = Instant.parse("2026-11-16T10:00:00Z")
  private fun at(ms: Long) = t0.plusMillis(ms)

  @Test fun timelineBlocksGroupConsecutiveSteps() {
    var t = TurnTrace(startedAt = t0)
    t = t.addReasoning("Look", at(10))
    t = t.startTool("a", "read_file", "Read a", 1, null, at(20))
    t = t.startTool("b", "read_file", "Read b", 2, null, at(30))
    t = t.addText("Hi", at(40))
    t = t.addNote("Checking my work", at(50))
    val b = t.blocks()
    assertEquals(4, b.size)
    assertTrue(b[0] is TurnTrace.Block.Reasoning)
    assertEquals(listOf("a", "b"), (b[1] as TurnTrace.Block.Steps).steps.map { it.key })
    assertEquals("Hi", (b[2] as TurnTrace.Block.Text).text)
    assertTrue(b[3] is TurnTrace.Block.Note)
  }

  @Test fun imagesBeingMadeAreOneBatch() {
    var t = TurnTrace(startedAt = t0)
    t = t.startTool("a", "generate_image", null, 1, TurnTrace.MediaShape("image", "square", 4, "cats"), at(0))
    t = t.startTool("b", "generate_image", null, 2, TurnTrace.MediaShape("image", "square", 1, "cats"), at(100))
    t = t.finishTool("a", "generate_image", false, null, 5000.0, at(5000))
    val m = t.liveMedia.single()
    assertEquals(5, m.total)
    assertEquals(4, m.done)
    assertEquals("cats", m.shape.prompt)
    assertEquals("Creating 5 images · 4 of 5 ready · Composing", MediaText.describe(m, at(4000)))
    // A failed call leaves the batch.
    t = t.finishTool("b", "generate_image", true, "boom", null, at(6000))
    assertEquals(4, t.liveMedia.single().total)
  }

  @Test fun mediaWordsAndShapes() {
    assertEquals("Adding sound", MediaText.phase("video", 40.0))
    assertEquals("Refining", MediaText.phase("image", 999.0))
    assertEquals(16f / 9, MediaText.ratio(TurnTrace.MediaShape("video")), 0.001f)
    assertEquals(2f / 3, MediaText.ratio(TurnTrace.MediaShape("image", "portrait")), 0.001f)
    assertEquals(1f, MediaText.ratio(TurnTrace.MediaShape("image", "portrait"), tiles = 3), 0.001f)
    assertEquals(listOf(1, 2, 3, 2, 3, 3), (1..6).map(MediaText::columns))
    val still = MediaMotion.at(123.0, 2, still = true)
    assertEquals(-1f, still.sweep, 0f)
  }

  @Test fun theLiveStatusLine() {
    var t = TurnTrace(startedAt = t0)
    assertEquals("Starting", LiveStatus.what(t, Agent.Thinking, false, false, null, at(0)))
    assertEquals("Waiting for another chat to finish", LiveStatus.what(t, Agent.Thinking, false, false, 2, at(0)))
    t = t.addReasoning("hm", at(10))
    assertEquals("Thinking", LiveStatus.what(t, Agent.Thinking, false, false, null, at(20)))
    t = t.startTool("a", "web_search", null, 1, null, at(30))
    assertEquals("Searching the web", LiveStatus.what(t, Agent.Working, false, false, null, at(40)))
    assertEquals("Stopping", LiveStatus.what(t, Agent.Working, true, false, null, at(40)))
    t = t.finishTool("a", "web_search", false, null, 10.0, at(50)).addText("Hello", at(60))
    assertEquals("Writing", LiveStatus.what(t, Agent.Streaming, false, false, null, at(1000)))
    assertEquals("Writing", LiveStatus.what(t, Agent.Streaming, false, false, null, at(9000)))
    assertEquals("Working", LiveStatus.what(t, Agent.Working, false, false, null, at(9000)))
    assertEquals("Waiting for you", LiveStatus.what(t.addNote("n", at(70)), Agent.Working, false, true, null, at(9000)))
  }

  @Test fun securityNotes() {
    val t = TurnTrace(startedAt = t0).addNote("🛡 **Hidden instructions** in page.html", at(1)).addNote("Checking", at(2))
    assertEquals(1, t.securityNotes.size)
    assertEquals("Hidden instructions in page.html", cleanSecurity(t.securityNotes[0]))
  }

  @Test fun planStatus() {
    fun plan(vararg s: String, state: String? = null) = ChatPlan(s.mapIndexed { i, st -> PlanStep("Step ${i + 1}", st) }, 1.0, state)
    assertNull(PlanStatus.of(plan("done", "pending"), busy = true))
    val running = PlanStatus.of(plan("done", "active", "pending"), busy = true)!!
    assertEquals(PlanStatus.State.Running, running.state)
    assertEquals("Step 2", running.current)
    assertNull(running.hint)
    val paused = PlanStatus.of(plan("done", "active", "pending"), busy = false)!!
    assertEquals("Plan paused", paused.title)
    assertEquals("The reply came before these steps were done. Say “continue” to pick it up from “Step 2”.", paused.hint)
    assertEquals(PlanStatus.State.Stopped, PlanStatus.of(plan("done", "pending", "pending", state = "stopped"), busy = false)!!.state)
    assertEquals(PlanStatus.State.Complete, PlanStatus.of(plan("done", "done", "done"), busy = true)!!.state)
  }

  @Test fun replyMediaRules() {
    val img = ArtifactRef("1", "a.png", kind = "image", tool = "generate_image", prompt = "cats")
    val doc = ArtifactRef("2", "r.pdf", kind = "pdf", size = 1_500_000)
    assertTrue(ReplyMediaRules.isGenerated(img))
    assertFalse(ReplyMediaRules.isGenerated(doc))
    assertFalse(ReplyMediaRules.isPlayable(doc))
    assertTrue(ReplyMediaRules.isPlayable(img.copy(tool = "run_command")))
    assertEquals("cats", ReplyMediaRules.prompt(listOf(img, img.copy(id = "3"))))
    assertNull(ReplyMediaRules.prompt(listOf(img, img.copy(prompt = "dogs"))))
    assertEquals("PDF · 1.5 MB", ReplyMediaRules.caption(doc))
    assertEquals("MD", ReplyMediaRules.tag(SentAttachment("notes.md")))
    assertEquals("IMG", ReplyMediaRules.tag(SentAttachment("x", mime = "image/png")))
    assertTrue(isAttachedOnly(ChatMessage(role = "user", content = "(Attached: x.png)", attachments = listOf(SentAttachment("x.png")))))
  }

  @Test fun effortChipShowsOnlyTheChatsOwnPick() {
    val m = ChatModelInfo("a", "m", reasoningLevels = listOf("low", "high"), effort = ChatEffort("high", "chat", "low", "high"))
    assertEquals("high", ComposerState(model = m).ownEffort)
    assertNull(ComposerState(model = m.copy(effort = ChatEffort("low", "model", "low"))).ownEffort)
    assertNull(ComposerState(model = m.copy(reasoningLevels = emptyList())).ownEffort)
  }

  @Test fun greetings() {
    assertEquals("Good morning", Welcome.greeting(LocalTime.of(8, 0)))
    assertEquals("Good evening", Welcome.greeting(LocalTime.of(20, 0)))
    assertEquals("Hello", Welcome.greeting(LocalTime.of(2, 0)))
  }

  @Suppress("unused") private val unused: JsonObject = Json.parseToJsonElement("{}") as JsonObject
}
