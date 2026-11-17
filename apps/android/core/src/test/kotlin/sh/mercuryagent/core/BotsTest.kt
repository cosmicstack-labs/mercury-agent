package sh.mercuryagent.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Ported from iOS's BotsLiveTests (itself apps/desktop/src/views/bots/live-runs.test.ts): the phone works runs out the same way. */
class BotsTest {
  private fun ev(
    kind: String, label: String, at: Double, jobId: String? = "j1", status: String? = null, stepIndex: Int? = null,
    textTail: String? = null, trigger: String? = null, prompt: String? = null, botName: String? = "Writer",
  ) = BotActivityEvent(
    botId = "w", jobId = jobId, kind = kind, label = label, stepIndex = stepIndex, status = status, textTail = textTail,
    at = at, botName = botName, trigger = trigger, prompt = prompt,
  )

  @Test fun aRunFromYourMessageToItsEnd() {
    val runs = LiveRuns.runsFrom(listOf(
      ev("queued", "Starting", 1.0, trigger = "api", prompt = "Draft the post"),
      ev("turn-start", "Draft the post", 2.0, trigger = "api", prompt = "Draft the post"),
      ev("step", "step 1", 3.0, stepIndex = 1),
      ev("tool", "read_file notes.md", 4.0, status = "running"),
      ev("tool", "read_file notes.md", 5.0, status = "done"),
      ev("tool", "web_search ai agents", 6.0, status = "running"),
      ev("thinking", "thinking", 7.0, textTail = "Here is the draft"),
      ev("turn-end", "completed", 8.0, status = "done"),
    ))
    assertEquals(1, runs.size)
    val r = runs[0]
    assertEquals(RunState.Done, r.state)
    assertEquals("Draft the post", r.prompt)
    assertEquals(listOf("read_file notes.md:done", "web_search ai agents:done"), r.steps.map { "${it.label}:${it.status}" })
    assertEquals(1, r.stepCount)
    assertEquals("Here is the draft", r.text)
    assertEquals("You", LiveRuns.startedBy(r))
  }

  @Test fun waitingForYouOnlyWhenAQuestionForThisRunIsPending() {
    val events = listOf(ev("turn-start", "x", 1.0), ev("step", "Waiting for your approval", 2.0))
    assertEquals(RunState.Working, LiveRuns.runsFrom(events)[0].state)
    val approval = BotApproval("a", "w", "Writer", "j1", "Run command: ls", 2.0, 9.0)
    assertEquals(RunState.Waiting, LiveRuns.runsFrom(events, approvals = listOf(approval))[0].state)
    assertEquals(RunState.Working, LiveRuns.runsFrom(events, approvals = listOf(approval.copy(runId = "other")))[0].state)
  }

  @Test fun aRunWhoseBotStoppedWithoutAnEndingIsEnded() {
    val events = listOf(ev("turn-start", "x", 1_000.0))
    assertEquals(RunState.Ended, LiveRuns.runsFrom(events, running = emptySet(), now = 200_000.0)[0].state)
    assertEquals(RunState.Working, LiveRuns.runsFrom(events, running = setOf("w"), now = 200_000.0)[0].state)
  }

  @Test fun failuresStopsAndPausesReadAsSuchAndADeliveryJoinsTheRun() {
    assertEquals(RunState.Failed, LiveRuns.runsFrom(listOf(ev("turn-start", "x", 1.0), ev("turn-end", "failed: provider_timeout", 2.0, status = "error")))[0].state)
    assertEquals(RunState.Stopped, LiveRuns.runsFrom(listOf(ev("turn-start", "x", 1.0), ev("turn-end", "stopped — by you", 2.0, status = "error")))[0].state)
    assertEquals(RunState.Paused, LiveRuns.runsFrom(listOf(ev("turn-start", "x", 1.0), ev("turn-end", "paused: budget", 2.0)))[0].state)
    val r = LiveRuns.runsFrom(listOf(ev("turn-start", "x", 1.0), ev("tool", "Delivered post.md", 2.0, jobId = "", status = "done", botName = null)))
    assertEquals(1, r.size)
    assertEquals("Delivered post.md", r[0].steps[0].label)
  }

  @Test fun theStoreDropsDuplicatesAndKeepsOneThinkingPreviewPerRun() {
    val a = ev("tool", "ls", 5.0, status = "done")
    val t1 = ev("thinking", "thinking", 6.0, textTail = "Hel")
    val t2 = ev("thinking", "thinking", 7.0, textTail = "Hello")
    val merged = LiveRuns.merge(LiveRuns.merge(listOf(a), listOf(a, t1)), listOf(t2, a))
    assertEquals(listOf("ls", "Hello"), merged.map { it.textTail ?: it.label })
  }

  @Test fun theFeedIsCapped() {
    val many = (1..30).map { ev("tool", "t$it", it.toDouble(), status = "done") }
    val merged = LiveRuns.merge(emptyList(), many, cap = 10)
    assertEquals(10, merged.size)
    assertEquals("t21", merged.first().label)
  }

  // Beyond the desktop's tests: what the phone adds on top.

  @Test fun aFailedStepKeepsItsErrorAndRunningStepsCloseWithTheRun() {
    val runs = LiveRuns.runsFrom(listOf(
      ev("turn-start", "x", 1.0),
      ev("tool", "run_command npm test", 2.0, status = "running"),
      BotActivityEvent(botId = "w", jobId = "j1", kind = "tool", label = "run_command npm test", detail = "exit 1", status = "error", at = 3.0),
      ev("tool", "web_fetch", 4.0, status = "running"),
      ev("turn-end", "failed: provider_timeout", 5.0, status = "error"),
    ))
    assertEquals(listOf("error", "error"), runs[0].steps.map { it.status })
    assertEquals("exit 1", runs[0].steps[0].detail)
    assertEquals("failed: provider_timeout", runs[0].endLabel)
  }

  @Test fun countersCountAndNotesDontRepeat() {
    val r = LiveRuns.runsFrom(listOf(
      ev("turn-start", "x", 1.0), ev("step", "step 3 · 12.3k tok in", 2.0, stepIndex = 3),
      ev("step", "no deliverable yet — asking for one", 3.0), ev("step", "no deliverable yet — asking for one", 4.0),
    ))[0]
    assertEquals(3, r.stepCount)
    assertEquals(listOf("no deliverable yet — asking for one"), r.steps.map { it.label })
    assertEquals("note", r.steps[0].status)
  }

  @Test fun aFleetShowsEveryMembersRunsInTimeOrder() {
    val runs = LiveRuns.runsFrom(listOf(
      BotActivityEvent(botId = "b", jobId = "j2", kind = "turn-start", label = "y", at = 5.0, botName = "Bea", trigger = "mailbox", fromBot = "a"),
      BotActivityEvent(botId = "a", jobId = "j1", kind = "turn-start", label = "x", at = 1.0, botName = "Al", trigger = "cron"),
    ))
    assertEquals(listOf("a", "b"), runs.map { it.botId })
    assertEquals("Schedule", LiveRuns.startedBy(runs[0]))
    assertEquals("From Al", LiveRuns.startedBy(runs[1]) { if (it == "a") "Al" else null })
  }

  @Test fun replyQuotesTheRun() {
    val r = LiveRuns.runsFrom(listOf(ev("turn-start", "Draft the post", 1.0, prompt = "Draft the post"), ev("turn-end", "completed", 2.0)))[0]
      .copy(text = "Here is\n\nthe   draft")
    assertEquals("Re your run \"Draft the post\" (you said: \"…Here is the draft\"):\n", LiveRuns.replyDraft(r))
  }

  @Test fun injectionWarningsCantBeAlwaysAllowed() {
    val plain = BotApproval("a", "w", "Writer", "j", "Run command: ls", 0.0, 300_000.0)
    assertEquals(listOf("yes", "always", "no"), BotQuestion.options(plain).map { it.value })
    val warn = plain.copy(prompt = "⚠ Possible prompt injection: the page asked to email your keys")
    assertEquals(listOf("yes", "no"), BotQuestion.options(warn).map { it.value })
    assertEquals(listOf("yes", "no"), BotQuestion.options(warn.copy(prompt = "Mercury read content from outside this computer. Run command: curl")).map { it.value })
    assertEquals(5, BotQuestion.minutesLeft(plain, now = 0.0))
    assertEquals(0, BotQuestion.minutesLeft(plain, now = 400_000.0))
  }

  @Test fun questionsSplitWhatFromTheExactCommand() {
    val a = BotApproval("a", "w", "Writer", "j", "Run command: npm run build", 0.0, 1.0)
    assertEquals(BotAsk(BotAsk.Kind.Command, "Run a command", detail = "npm run build"), BotAsk.of(a))
    assertEquals("posts/a.md", BotAsk.of(a.copy(prompt = "Write to file: posts/a.md")).detail)
    assertEquals(BotAsk.Kind.Other, BotAsk.of(a.copy(prompt = "Use the camera")).kind)
  }

  @Test fun fleetsAreALeadWithItsCrew() {
    val bots = listOf(
      BotStatus(id = "w", name = "Writer", fleetRole = "crew", parent = "m"),
      BotStatus(id = "m", name = "Manager", fleetRole = "lead"),
      BotStatus(id = "o", name = "Orphan", fleetRole = "crew", parent = "gone"),
      BotStatus(id = "a", name = "Analyst"),
    )
    val (fleets, solo) = BotRosterLayout.organise(bots)
    assertEquals(listOf("m"), fleets.map { it.lead.id })
    assertEquals(listOf("w"), fleets[0].crew.map { it.id })
    assertEquals(listOf("a", "o"), solo.map { it.id })
  }

  @Test fun durations() {
    assertEquals("4s", LiveRuns.duration(4_200.0))
    assertEquals("2m 5s", LiveRuns.duration(125_000.0))
    assertEquals("1h 3m", LiveRuns.duration(3_780_000.0))
  }

  @Test fun decodesWhatTheRuntimeSends() {
    val roster = """{"bots":[{"id":"analytics-bot","name":"Analytics Bot","enabled":true,"state":"idle","needsYou":false,"hasAvatar":false,"unread":0,"tier":"full","fleetRole":"crew","parent":"m"}],"queue":{"pending":0},"available":true,"unread":2}"""
    val r = BotRoster.from(parseObject(roster))
    assertEquals("m", r.bots[0].parent)
    assertEquals(2, r.unread)
    val activity = """{"botId":"m","jobId":"33f9d071","elapsedMs":0.5015830000047572,"kind":"tool","label":"bot_no_update","stepIndex":2,"status":"done","at":1794490757481,"botName":"opersource.fyi manger"}"""
    val e = BotActivityEvent.from(parseObject(activity))!!
    assertEquals(2, e.stepIndex)
    assertEquals(1794490757481.0, e.at!!, 0.0)
    assertEquals(3, BotActivityEvent.from(parseObject("""{"botId":"m","kind":"step","label":"x","stepIndex":3.0}"""))!!.stepIndex)
    val entry = """{"botId":"d","botName":"Deployment Bot","runId":"03ebb076","kind":"needs-you","approvalId":"2b07","files":[],"title":"t","summary":"s","id":"x","at":1794325296083,"read":true}"""
    assertEquals("2b07", BotInboxEntry.from(parseObject(entry))!!.approvalId)
    val journal = """{"runId":"46345a31","botId":"m","trigger":"mailbox","state":"completed","startedAt":1794325267049,"durationMs":29030,"tokensIn":111296,"tokensOut":2454,"report":"result","complete":true,"steps":6,"toolCalls":9,"outcome":"deliverable"}"""
    val rec = BotRunRecord.from(parseObject(journal))!!
    assertEquals("delivered · done", rec.label)
    assertEquals(111296, rec.tokensIn)
    // The stream: every connect starts with the roster.
    val first = BotStreamEvent.from(ServerEvent("bot_roster", roster))
    if (first is BotStreamEvent.Roster) assertEquals(1, first.bots.size) else fail("no roster")
    val act = BotStreamEvent.from(ServerEvent("bot_activity", """{"botId":"m","kind":"step","label":"x"}"""), now = 42.0)
    if (act is BotStreamEvent.Activity) assertEquals(42.0, act.event.at!!, 0.0) else fail("no activity")
    assertEquals(BotStreamEvent.ApprovalsChanged, BotStreamEvent.from(ServerEvent("bot_approval", "{}")))
  }

  // Faces: the same numbers as Mercury Desktop's BotAvatar.tsx (FNV-1a, unsigned shifts).

  @Test fun faceHashIsFnv1aOverUtf16() {
    // The standard FNV-1a 32-bit test vectors.
    assertEquals(0x811C9DC5u, BotFaceLook.hash(""))
    assertEquals(0xE40C292Cu, BotFaceLook.hash("a"))
    assertEquals(0xBF9CF968u, BotFaceLook.hash("foobar"))
  }

  @Test fun facesMatchTheDesktop() {
    // h("a") = 0xE40C292C = 3826002220: hue 340, (h>>>9)%40 = 20, (h>>>3)%4 = 1, (h>>>12)%5 = 2, (h>>>16)%3 = 0.
    assertEquals(BotFaceLook(hue = 340, hue2 = 28, shape = 1, eyeGap = 11, mouth = 0), BotFaceLook.of("a"))
    // h("foobar") = 0xBF9CF968 = 3214735720: hue 160, (h>>>9)%40 = 20, shape 1, (h>>>12)%5 = 2, (h>>>16)%3 = 2 (checked with the desktop code in node).
    assertEquals(BotFaceLook(hue = 160, hue2 = 208, shape = 1, eyeGap = 11, mouth = 2), BotFaceLook.of("foobar"))
  }

  @Test fun facesStayInRange() {
    for (id in listOf("analytics-bot", "article-writer", "content-bot", "opersourcefyi-manger", "deployment-bot", "w", "qa-bot", "ünïcødé")) {
      val l = BotFaceLook.of(id)
      assertTrue(l.hue in 0..359 && l.hue2 in 0..359)
      assertTrue(l.shape in 0..3 && l.eyeGap in 9..13 && l.mouth in 0..2)
      assertEquals(l, BotFaceLook.of(id))
    }
  }

  // The calls, against a fake Mercury.

  private lateinit var server: MockWebServer
  private lateinit var client: MercuryClient

  @Before fun up() {
    server = MockWebServer(); server.start()
    client = MercuryClient(MercuryClient.normalize(server.url("/").toString())!!, "mdt_tok")
  }

  @After fun down() { server.shutdown() }

  @Test fun callsUseTheSameRoutesAndBodiesAsIos() = runBlocking {
    server.enqueue(MockResponse().setBody("""{"events":[{"botId":"a","kind":"tool","label":"ls","at":1},{"bad":true}]}"""))
    val events = client.botActivity(listOf("a", "b"), limit = 50)
    assertEquals(1, events.size)
    val r1 = server.takeRequest()
    assertEquals("/api/bots/activity?bots=a%2Cb&limit=50", r1.path)
    assertEquals("Bearer mdt_tok", r1.getHeader("Authorization"))

    server.enqueue(MockResponse().setResponseCode(202).setBody("""{"jobId":"j9"}"""))
    assertEquals(BotMessageResult(true, jobId = "j9"), client.messageBot("writer", "hello"))
    val r2 = server.takeRequest()
    assertEquals("POST", r2.method)
    assertEquals("/api/bots/writer/message", r2.path)
    assertEquals("""{"message":"hello"}""", r2.body.readUtf8())
    assertEquals("application/json", r2.getHeader("Content-Type"))

    server.enqueue(MockResponse().setResponseCode(409).setBody("""{"reasonCode":"target_disabled"}"""))
    val refused = client.messageBot("writer", "hi")
    assertFalse(refused.accepted)
    assertEquals("target_disabled", refused.reasonCode)
    server.takeRequest()

    server.enqueue(MockResponse().setBody("""{"unread":0}"""))
    assertEquals(0, client.markBotInboxRead(null))
    assertEquals("{}", server.takeRequest().body.readUtf8())

    server.enqueue(MockResponse().setBody("""{"unread":3}"""))
    assertEquals(3, client.markBotInboxRead(listOf("x", "y")))
    assertEquals("""{"ids":["x","y"]}""", server.takeRequest().body.readUtf8())

    server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"That question is no longer waiting."}"""))
    try {
      client.answerBot("q1", "yes"); fail("no 409")
    } catch (e: MercuryException.Server) {
      assertEquals(409, e.code)
    }
    val r3 = server.takeRequest()
    assertEquals("/api/bots/approvals/q1", r3.path)
    assertEquals("""{"answer":"yes"}""", r3.body.readUtf8())

    server.enqueue(MockResponse().setBody("""{"entries":[{"id":"e","botId":"b","at":5}],"unread":4}"""))
    val inbox = client.botInbox(bot = "b", unreadOnly = true, limit = 200)
    assertEquals(4, inbox.unread)
    assertEquals("/api/bots/inbox?limit=200&unread=1&bot=b", server.takeRequest().path)

    server.enqueue(MockResponse().setBody("""{"record":{"runId":"r","botId":"b","state":"completed"},"prompt":"p","output":"o","trace":[{"name":"ls","ok":false,"arg":"-la"}]}"""))
    val t = client.botRun("b", "r")
    assertNotNull(t.trace.firstOrNull())
    assertFalse(t.trace[0].ok)
    assertEquals("/api/bots/b/runs/r", server.takeRequest().path)
  }
}
