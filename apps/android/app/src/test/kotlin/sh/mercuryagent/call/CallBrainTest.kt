package sh.mercuryagent.call

import app.mercury.voice.VoiceEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.call.CallPhase.Orb
import sh.mercuryagent.call.CallPhase.Phase
import sh.mercuryagent.core.ChatMessage
import sh.mercuryagent.ui.conversation.ConversationState
import sh.mercuryagent.ui.conversation.TurnTrace

private class FakeLink : VoiceLink {
  val calls = mutableListOf<String>()
  val results = mutableListOf<Pair<String, String>>()
  override fun pushAudio(pcm16: ByteArray) = Unit
  override fun setMuted(muted: Boolean) { calls += "muted:$muted" }
  override fun interrupt() { calls += "interrupt" }
  override fun stop() { calls += "stop" }
  override fun toolResult(id: String, output: String) { results += id to output }
  override fun say(text: String) { calls += "say" }
  override fun instruct(text: String) { calls += "instruct:$text" }
  val instructions get() = calls.filter { it.startsWith("instruct:") }
}

private class FakePlayback : CallPlayback {
  override var isPlaying = false
  var flushed = 0
  override fun flush() { flushed++; isPlaying = false }
}

private class FakeChat : CallChat {
  val asked = mutableListOf<String>()
  val replies = mutableListOf<CompletableDeferred<CallAnswer>>()
  override var activity: String? = null
  override var working = false
  override var approvals = listOf<CallApproval>()
  val answered = mutableListOf<Pair<String, Boolean>>()
  var stopped = 0
  override suspend fun ask(question: String): CallAnswer {
    asked += question
    val d = CompletableDeferred<CallAnswer>()
    replies += d
    return d.await()
  }
  override suspend fun answer(approval: CallApproval, approved: Boolean) {
    answered += approval.id to approved
    approvals = approvals.filter { it.id != approval.id }
  }
  override suspend fun stopWork() { stopped++ }
}

@OptIn(ExperimentalCoroutinesApi::class)
class CallBrainTest {
  private var clock = 1_000_000L
  private val link = FakeLink()
  private val playback = FakePlayback()
  private val chat = FakeChat()
  private val haptics = mutableListOf<CallHaptic>()

  private fun TestScope.brain(): CallBrain {
    val b = CallBrain(link, chat, playback, backgroundScope, haptic = { haptics += it }, now = { clock })
    b.begin()
    b.handle(VoiceEvent.Connected)
    b.handle(VoiceEvent.ResponseDone)
    return b
  }

  private fun CallBrain.tickFor(seconds: Int) = repeat(seconds) { clock += 1_000; tick() }

  @Test fun saysHelloAndConnects() = runTest {
    val b = brain()
    assertTrue(link.instructions.first().contains("very short hello"))
    assertTrue(b.connected)
    assertEquals(CallHaptic.Connected, haptics.first())
  }

  @Test fun askMercuryGoesToTheChatAndTheSpokenPartComesBack() = runTest {
    val b = brain()
    b.handle(VoiceEvent.ToolCall("t1", "ask_mercury", """{"question":"  What's on today? "}"""))
    runCurrent()
    assertEquals(listOf("What's on today?"), chat.asked)
    assertEquals(setOf("t1"), b.asks.keys)
    chat.replies[0].complete(CallAnswer.Reply("**Two meetings.**\nFor the chat: 10:00 Design, 14:00 Sync"))
    runCurrent()
    assertTrue(b.asks.isEmpty())
    assertEquals("t1", link.results.single().first)
    assertTrue(link.results.single().second.startsWith("Two meetings.\n[The links and details are in the user's Mercury chat"))
    assertEquals(listOf("ask", "result"), b.transcript.map { it.role })
  }

  @Test fun resultsWaitWhileTheVoiceIsTalking() = runTest {
    val b = brain()
    b.handle(VoiceEvent.ToolCall("t1", "ask_mercury", """{"question":"q"}"""))
    runCurrent()
    b.handle(VoiceEvent.ResponseStarted)
    chat.replies[0].complete(CallAnswer.Reply("Done it."))
    runCurrent()
    assertTrue(link.results.isEmpty())
    b.handle(VoiceEvent.ResponseDone)
    assertEquals(listOf("t1" to "Done it."), link.results)
  }

  @Test fun anEmptyQuestionOrAnUnknownToolIsAnsweredAtOnce() = runTest {
    brain().handle(VoiceEvent.ToolCall("t1", "ask_mercury", "{}"))
    assertTrue(link.results.single().second.startsWith("No question was given"))
  }

  @Test fun bargeInFlushesPlaybackAndInterrupts() = runTest {
    val b = brain()
    playback.isPlaying = true
    b.playbackChanged(true)
    assertEquals(Phase.Speaking, CallPhase.of(false, b.connected, b.mercuryAudible, b.ownerSpeaking, false))
    b.handle(VoiceEvent.SpeechStarted)
    assertEquals(1, playback.flushed)
    assertTrue("interrupt" in link.calls)
    assertTrue(CallHaptic.BargeIn in haptics)
    assertTrue(b.ownerSpeaking)
  }

  @Test fun sayingMuteMutes() = runTest {
    var muted: Boolean? = null
    val b = brain()
    b.onMuted = { muted = it }
    b.handle(VoiceEvent.UserText("Mute yourself."))
    assertTrue(b.muted)
    assertEquals(true, muted)
    assertTrue("muted:true" in link.calls)
    b.mute(false)
    assertFalse(b.muted)
  }

  @Test fun stopHaltsEverythingButKeepsTheCall() = runTest {
    val b = brain()
    b.handle(VoiceEvent.ToolCall("t1", "ask_mercury", """{"question":"q"}"""))
    runCurrent()
    b.handle(VoiceEvent.UserText("Stop!"))
    runCurrent()
    assertEquals(1, chat.stopped)
    assertTrue(b.asks.isEmpty())
    assertTrue(link.instructions.last().contains("Say only: 'Stopped.'"))
    chat.replies[0].complete(CallAnswer.Reply("late"))
    runCurrent()
    assertTrue(link.results.isEmpty())
    assertNull(b.ended)
  }

  @Test fun approvalsAreAskedAloudAndOnlyTheOwnersYesCounts() = runTest {
    val b = brain()
    chat.approvals = listOf(CallApproval("p1", "Run command: npm run deploy\nin ~/app", null))
    b.tick()
    assertEquals("p1", b.awaiting?.approval?.id)
    assertTrue(link.instructions.last().contains("Mercury wants to: Run command: npm run deploy."))
    b.handle(VoiceEvent.ResponseDone)
    // The voice says yes before the owner's words arrive: it waits for them.
    b.handle(VoiceEvent.ToolCall("t2", "answer_approval", """{"approved":true}"""))
    runCurrent()
    assertTrue(chat.answered.isEmpty())
    clock += 500
    b.handle(VoiceEvent.UserText("Yeah, go ahead"))
    runCurrent()
    assertEquals(listOf("p1" to true), chat.answered)
    assertEquals("t2" to "Approved. Mercury is carrying on; tell the user briefly.", link.results.last())
  }

  @Test fun anApprovalWithoutTheOwnersYesIsRefused() = runTest {
    val b = brain()
    chat.approvals = listOf(CallApproval("p1", "Delete files", null))
    b.tick()
    b.handle(VoiceEvent.ResponseDone)
    b.handle(VoiceEvent.UserText("hmm let me think"))
    b.handle(VoiceEvent.ToolCall("t2", "answer_approval", """{"approved":true}"""))
    b.tickFor(4)
    runCurrent()
    assertTrue(chat.answered.isEmpty())
    assertTrue(link.results.last().second.startsWith("Not approved"))
  }

  @Test fun onScreenAnswersCount() = runTest {
    val b = brain()
    chat.approvals = listOf(CallApproval("p1", "Send the email", null))
    b.tick()
    b.handle(VoiceEvent.ResponseDone)
    b.answerOnScreen(CallApproval("p1", "Send the email", null), approved = false)
    runCurrent()
    assertEquals(listOf("p1" to false), chat.answered)
    assertNull(b.awaiting)
    b.tick()
    assertTrue(link.instructions.last().contains("declined it on their screen"))
  }

  @Test fun statusUpdatesWhileMercuryWorks() = runTest {
    val b = brain()
    chat.activity = "Searching the web"; chat.working = true
    b.handle(VoiceEvent.ToolCall("t1", "ask_mercury", """{"question":"q"}"""))
    runCurrent()
    b.tickFor(7)
    assertFalse(link.instructions.last().contains("still"))
    b.tickFor(2)
    assertTrue(link.instructions.last().contains("Mercury is still searching the web"))
    assertEquals(1, b.asks.getValue("t1").updates)
  }

  @Test fun quietEndsTheCallAndSoDoesTheLimit() = runTest {
    var end: CallBrain.End? = null
    val b = brain()
    b.onEnd = { end = it }
    b.tickFor(59)
    assertNull(end)
    b.tickFor(2)
    assertEquals(CallBrain.End.Idle, end)
    assertTrue("stop" in link.calls)

    val b2 = CallBrain(FakeLink(), chat, playback, backgroundScope, now = { clock })
    b2.idleStopMs = 0
    b2.handle(VoiceEvent.Connected)
    clock += 30 * 60_000
    b2.tick()
    assertEquals(CallBrain.End.TimeLimit, b2.ended)
  }

  @Test fun goodbyeWaitsForThePlaybackThenEnds() = runTest {
    val b = brain()
    playback.isPlaying = true
    b.handle(VoiceEvent.ToolCall("t9", "end_conversation", "{}"))
    runCurrent()
    assertNull(b.ended)
    playback.isPlaying = false
    advanceTimeBy(150)
    runCurrent()
    assertEquals(CallBrain.End.Goodbye, b.ended)
  }

  @Test fun aStoppedEngineIsTheOwnerHangingUp() = runTest {
    val b = brain()
    b.handle(VoiceEvent.Closed("stopped"))
    assertEquals(CallBrain.End.Owner, b.ended)
    val b2 = brain()
    b2.handle(VoiceEvent.Closed("the voice model disconnected"))
    assertEquals(CallBrain.End.Dropped("the voice model disconnected"), b2.ended)
    // Nothing after the end.
    b2.handle(VoiceEvent.UserText("hello"))
    assertNull(b2.ownerLine)
  }

  @Test fun words() {
    assertTrue(CallBrain.isStop("Stop!"))
    assertTrue(CallBrain.isStop("bas"))
    assertFalse(CallBrain.isStop("don't stop the music, play the next song please"))
    assertFalse(CallBrain.isStop("stop listening"))
    assertTrue(CallBrain.isMute("go on mute"))
    assertFalse(CallBrain.isMute("unmute"))
    assertEquals("searching the web", CallBrain.doing("Searching the web…"))
    assertEquals("working on it", CallBrain.doing(" "))
    assertEquals(true, CallBrain.spokenVerdict(listOf(10L to "okay do it"), 5))
    assertEquals(false, CallBrain.spokenVerdict(listOf(10L to "yes", 11L to "no wait"), 5))
    assertEquals(false, CallBrain.spokenVerdict(listOf(10L to "Don't."), 5))
    assertNull(CallBrain.spokenVerdict(listOf(1L to "yes"), 5))
    assertEquals("x".repeat(160) + "…", CallBrain.approvalSummary("x".repeat(200)))
  }

  @Test fun toolOutputs() {
    assertEquals("Done.", CallBrain.toolOutput(CallAnswer.Reply("```\ncode\n```")))
    assertTrue(CallBrain.toolOutput(CallAnswer.Reply("Sent.", listOf("Send email"))).contains("1 step(s) failed or were stopped (Send email)"))
    assertEquals("Mercury couldn't do it: offline. Tell the user plainly.", CallBrain.toolOutput(CallAnswer.Failed("offline")))
    assertTrue(CallBrain.toolOutput(CallAnswer.TimedOut).contains("didn't answer in time"))
  }
}

class CallPhaseTest {
  @Test fun phases() {
    assertEquals(Phase.Ended, CallPhase.of(true, true, true, true, true))
    assertEquals(Phase.Starting, CallPhase.of(false, false, false, false, false))
    assertEquals(Phase.Speaking, CallPhase.of(false, true, true, true, true))
    assertEquals(Phase.Hearing, CallPhase.of(false, true, false, true, true))
    assertEquals(Phase.Working, CallPhase.of(false, true, false, false, true))
    assertEquals(Phase.Listening, CallPhase.of(false, true, false, false, false))
  }

  @Test fun theOrbAndTheStatusLine() {
    assertEquals(Orb.Calling, CallPhase.orb(Phase.Starting, muted = true))
    assertEquals(Orb.MercurySpeaking, CallPhase.orb(Phase.Speaking, muted = true))
    assertEquals(Orb.Muted, CallPhase.orb(Phase.Listening, muted = true))
    assertEquals(Orb.Working, CallPhase.orb(Phase.Working, muted = false))
    assertEquals("Muted", CallPhase.status(Phase.Listening, true, null, null, null))
    assertEquals("Searching…", CallPhase.status(Phase.Working, false, "Searching…", null, null))
    assertEquals("No key.", CallPhase.status(Phase.Listening, false, null, "No key.", null))
    assertEquals("Call ended", CallPhase.status(Phase.Ended, false, null, null, null))
    assertEquals("Mercury said goodbye.", CallPhase.endedNote(CallBrain.End.Goodbye))
    assertNull(CallPhase.endedNote(CallBrain.End.Owner))
    assertEquals("01:05", CallPhase.elapsed(65_400))
    assertEquals("00:00", CallPhase.elapsed(-5))
  }

  @Test fun aTurnsReplyBecomesTheAnswer() {
    val reply = ChatMessage(id = "m1", role = "assistant", content = "Booked.")
    val step = TurnTrace.Step("k", 1, "email", "Send email", TurnTrace.Status.Error, java.time.Instant.EPOCH)
    val s = ConversationState(messages = listOf(reply), traces = mapOf("m1" to TurnTrace(steps = listOf(step))))
    assertEquals(CallAnswer.Reply("Booked.", listOf("Send email")), ConversationCallChat.answer(reply, s))
    val failed = ConversationState(messages = listOf(ChatMessage(role = "system", content = "The model is unavailable.")))
    assertEquals(CallAnswer.Failed("The model is unavailable."), ConversationCallChat.answer(null, failed))
    assertEquals(CallAnswer.Stopped, ConversationCallChat.answer(ChatMessage(role = "assistant", content = " "), ConversationState()))
  }
}

class DictationTextTest {
  @Test fun partialsAreReplacedByFinals() {
    val t = DictationText("")
    assertEquals("Hello", t.partial("Hello", ""))
    assertEquals("Hello wor", t.partial(" Hello wor ", "Hello"))
    assertEquals("Hello world.", t.final("Hello world.", "Hello wor"))
    assertEquals("Hello world. How", t.partial("How", "Hello world."))
    assertEquals("Hello world. How are you?", t.final("How are you?", "Hello world. How"))
  }

  @Test fun itGoesAfterWhatWasTyped() {
    val t = DictationText("Note:")
    assertEquals("Note: buy milk", t.final("buy milk", "Note:"))
    val nl = DictationText("Line one\n")
    assertEquals("Line one\nnext", nl.partial("next", "Line one\n"))
  }

  @Test fun theOwnersEditsWin() {
    val t = DictationText("")
    t.final("Send it to Sam", "")
    t.partial("tomor", "Send it to Sam")
    // The owner fixed the name while talking; the partial at the end will come again, final.
    assertEquals("Send it to Pam tomorrow", t.final("tomorrow", "Send it to Pam tomor"))
  }

  @Test fun joining() {
    assertEquals("a b", DictationText.join("a", "b"))
    assertEquals("a, b", DictationText.join("a", ", b"))
    assertEquals("a.", DictationText.join("a", "."))
    assertEquals("a\nb", DictationText.join("a\n", "b"))
    assertEquals("b", DictationText.join("", "b"))
    assertEquals("a", DictationText.join("a", ""))
  }
}
