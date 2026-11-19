package sh.mercuryagent.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/** Ported from apps/desktop/src/views/bots/BotForms.test.ts, plus the phone's own pieces (iOS: BotEditingTests). */
class BotEditingTest {
  private lateinit var server: MockWebServer
  private lateinit var base: String

  @Before fun setUp() { server = MockWebServer().apply { start() }; base = MercuryClient.normalize(server.url("/").toString())!! }
  @After fun tearDown() { server.shutdown() }

  private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

  @Test fun makesAnIdTheRuntimeAcceptsFromAnyName() {
    assertEquals("rust-watcher", BotForms.slugify("Rust Watcher"))
    assertEquals("cafe-daily-brief", BotForms.slugify("  Café Daily Brief!! "))
    assertEquals("bot-42-news", BotForms.slugify("42 news"))
    assertEquals("bot-new", BotForms.slugify(""))
    assertEquals(30, BotForms.slugify("x".repeat(80)).length)
    for (id in listOf(BotForms.slugify("Rust Watcher"), BotForms.slugify("42 news"), BotForms.slugify("Ünïcode"), BotForms.slugify("Phone Test Bot"))) {
      assertTrue(id, Regex("^[a-z][a-z0-9-]*$").matches(id))
    }
  }

  @Test fun saysCommonSchedulesInWordsAndLeavesTheRestAsCron() {
    assertEquals("Weekdays at 9", BotForms.describeCron("0 9 * * 1-5"))
    assertEquals("Every hour", BotForms.describeCron("0 * * * *"))
    assertEquals("30 7 * * *", BotForms.describeCron("30 7 * * *"))
  }

  @Test fun warnsWhenAScheduleAsksForMoreThanOneRunEvery15Minutes() {
    assertTrue(BotForms.tooFrequent("*/5 * * * *"))
    assertTrue(BotForms.tooFrequent("* * * * *"))
    assertFalse(BotForms.tooFrequent("*/15 * * * *"))
    assertFalse(BotForms.tooFrequent("0 9 * * *"))
  }

  @Test fun theFormSaysWhatIsMissingInOrder() {
    val ok = BotSchedule("routine", "0 9 * * *", "Brief me")
    assertEquals("Give it a name.", BotForms.problem(" ", "x", "1000000", emptyList()))
    assertEquals("Say how it should work (its instructions).", BotForms.problem("A", " ", "1000000", emptyList()))
    assertEquals("The daily budget must be at least 10,000 tokens.", BotForms.problem("A", "x", "9,999", emptyList()))
    assertEquals("Every schedule needs instructions.", BotForms.problem("A", "x", "1 000 000", listOf(ok, BotSchedule("b", "0 * * * *", " "))))
    assertEquals("Add at least one crew member, or pick another option.", BotForms.problem("A", "x", "1_000_000", listOf(ok), true, listOf(CrewSpec())))
    assertNull(BotForms.problem("A", "x", "1,000,000", listOf(ok)))
    assertEquals("Every crew member needs a name and instructions.", BotForms.crewProblem(listOf(CrewSpec(name = "Checker"))))
    assertNull(BotForms.editProblem("A", "x", "", emptyList()))
    assertTrue(BotForms.editProblem("A", "x", "", listOf(BotSchedule("r", "every day", "x")))!!.contains("isn't a schedule"))
    assertEquals("scout-3", BotForms.uniqueId("scout", listOf("scout", "scout-2")))
    assertEquals("routine-2", BotForms.nextRoutineName(listOf(ok)))
  }

  @Test fun everyPickerChoiceRoundTripsThroughCron() {
    val rules = listOf(ScheduleRule.EveryMinutes(15), ScheduleRule.EveryHours(1), ScheduleRule.EveryHours(4), ScheduleRule.Daily(18, 30),
      ScheduleRule.Weekdays(7, 30), ScheduleRule.Weekly(1, 9, 0), ScheduleRule.Weekly(0, 20, 5))
    for (r in rules) assertEquals(r.cron, r, ScheduleRule.from(r.cron))
    assertEquals("Weekdays at 9:00", ScheduleRule.from("0 9 * * 1-5").words)
    assertEquals("Every day at 7:30", ScheduleRule.from("30 7 * * *").words)
    assertEquals("Mondays at 9:00", ScheduleRule.from("0 9 * * 1").words)
    assertEquals(ScheduleRule.Weekly(0, 9, 0), ScheduleRule.from("0 9 * * 7"))
    for (c in listOf("0 9 1 * *", "0 9 * * 1,3", "15 */2 * * *", "@daily")) assertEquals(c, ScheduleRule.from(c).cron)
    assertEquals(ScheduleRule.Weekdays(7, 30), ScheduleRule.Daily(7, 30).with(ScheduleRule.Kind.Weekdays))
    assertEquals(ScheduleRule.Custom("30 7 * * *"), ScheduleRule.Daily(7, 30).with(ScheduleRule.Kind.Custom))
  }

  @Test fun aFirstDraftFromPlainWords() {
    assertEquals("Watch Hacker News", BotDraft.name("Watch Hacker News for Rust posts every morning"))
    assertEquals("Summarises My Inbox", BotDraft.name("I want a bot that summarises my inbox every evening"))
    assertEquals("Watch HN for Rust posts", BotDraft.description("Watch HN for Rust posts. Report only new ones."))
    assertEquals("30 7 * * *", BotDraft.schedule("Brief me every morning at 7:30")?.cron)
    assertEquals("0 18 * * *", BotDraft.schedule("Summarise my inbox every evening")?.cron)
    assertEquals("0 */2 * * *", BotDraft.schedule("Check prices every 2 hours")?.cron)
    assertEquals("*/15 * * * *", BotDraft.schedule("Poll the API every 5 minutes")?.cron)
    assertEquals("0 9 * * 1-5", BotDraft.schedule("Send the standup on weekdays at 9am")?.cron)
    assertEquals("0 17 * * 5", BotDraft.schedule("Every Friday at 5 pm, list what shipped")?.cron)
    assertNull(BotDraft.schedule("Research a topic when I ask"))
    assertEquals("readonly", BotDraft.tier("Watch HN for Rust posts and tell me"))
    assertEquals("builder", BotDraft.tier("Draft a weekly newsletter"))
  }

  @Test fun theRequestBodiesAreWhatDesktopSends() {
    val b = NewBot("rust-watch", " Rust Watch ", " ", "You watch HN.\n", "readonly", BotModelRef("anthropic", "claude-x"), 250_000)
    assertEquals("""{"id":"rust-watch","name":"Rust Watch","persona":"You watch HN.","tier":"readonly","manifest":{"autonomy":{"dailyTokenBudget":250000},"model":{"provider":"anthropic","model":"claude-x"}}}""", b.body().toString())
    val bot = BotManifest("scout", "Scout", "Finds", model = BotModelRef("openai", "gpt-x"),
      schedules = listOf(BotSchedule("routine", "0 9 * * *", "Go")), autonomy = mapOf("dailyTokenBudget" to 500_000.0, "maxSteps" to 25.0))
    assertTrue(BotChanges.between(bot, "Scout ", "Finds", bot.model, bot.schedules, "500,000").isEmpty)
    assertEquals("""{"name":"Scout Two"}""", BotChanges.between(bot, "Scout Two", "Finds", bot.model, bot.schedules, "500000").body().toString())
    assertEquals("""{"model":null,"schedules":[{"name":"routine","cron":"0 18 * * *","prompt":"Evening"}],"autonomy":{"maxSteps":25}}""",
      BotChanges.between(bot, "Scout", "Finds", null, listOf(BotSchedule("routine", " 0 18 * * * ", " Evening ")), "").body().toString())
  }

  @Test fun readsTheManifestAndThePlan() {
    val m = BotManifest.from(parseObject("""{"id":"scout","name":"Scout","enabled":false,"model":{"provider":"openai","model":"gpt-x"},"schedules":[{"name":"r","cron":"0 9 * * *","prompt":"Go"}],"autonomy":{"dailyTokenBudget":500000,"maxSteps":25},"fleetRole":"lead"}"""))!!
    assertFalse(m.enabled)
    assertEquals(BotModelRef("openai", "gpt-x"), m.model)
    assertEquals(500_000, m.dailyTokenBudget)
    assertEquals("lead", m.fleetRole)
    assertNull(BotManifest.from(parseObject("""{"name":"no id"}""")))
    val p = BotPlan.from(parseObject("""{"shape":"fleet","reason":"Three parts","crew":[{"id":"fc","name":"Fact Checker","description":"Checks","persona":"You check."}]}"""))
    assertTrue(p.isFleet)
    assertEquals("Fact Checker", p.crew.single().name)
  }

  @Test fun aPowerfulLevelWaitsForTheOwnerThenCarriesTheApproval() = runBlocking {
    server.enqueue(json(428, """{"error":"Waiting for the owner.","approvalRequired":true,"approvalId":"ap1","code":"123456","where":"this computer"}"""))
    server.enqueue(json(201, """{"bot":{"id":"deployer","name":"Deployer","enabled":true}}"""))
    val c = MercuryClient(base, "t")
    val q = try { c.createBot(NewBot("deployer", "Deployer", persona = "You deploy.", tier = "operator")); null } catch (e: MercuryException.NeedsOwner) { e.question }
    assertEquals("ap1", q?.id)
    assertNull(server.takeRequest().getHeader(APPROVAL_HEADER))
    assertEquals("deployer", c.createBot(NewBot("deployer", "Deployer", persona = "You deploy.", tier = "operator"), approval = "ap1").id)
    val second = server.takeRequest()
    assertEquals("ap1", second.getHeader(APPROVAL_HEADER))
    assertTrue(second.body.readUtf8().contains("\"tier\":\"operator\""))
  }

  @Test fun runNowRefusedIsAnAnswerNotAnError() = runBlocking {
    server.enqueue(json(409, """{"accepted":false,"reasonCode":"target_disabled"}"""))
    val r = MercuryClient(base, "t").runBotNow("scout")
    assertFalse(r.accepted)
    assertEquals("It's off. Turn it on first.", BotWords.refused(r.reasonCode))
    val req = server.takeRequest()
    assertEquals("POST", req.method)
    assertEquals("/api/bots/scout/run", req.path)
  }

  /** Against a real Mercury: MERCURY_URL and MERCURY_TOKEN_FILE set. Leaves nothing behind. */
  @Test fun liveCreateReadEditDisableDelete() = runBlocking {
    val url = System.getenv("MERCURY_URL")
    val tokenFile = System.getenv("MERCURY_TOKEN_FILE")
    assumeTrue(url != null && tokenFile != null)
    val c = MercuryClient(MercuryClient.normalize(url!!)!!, java.io.File(tokenFile!!).readText().trim())
    val id = BotForms.uniqueId(BotForms.slugify("phone-test-bot"), c.bots().bots.map { it.id })
    assertEquals("phone-test-bot", id)
    try {
      val made = c.createBot(NewBot(id, "phone-test-bot", "Made by the Android live test", "You are a harmless test bot. Do nothing; if asked, call bot_no_update."))
      println("LIVE create → id=${made.id} name=${made.name} enabled=${made.enabled}")
      val read = c.botManifest(id)
      println("LIVE read → name=${read.name} schedules=${read.schedules.size} budget=${read.dailyTokenBudget} tier=${c.bots().bots.first { it.id == id }.tier}")
      assertTrue(read.schedules.isEmpty() && read.dailyTokenBudget == BotForms.DEFAULT_BUDGET)
      val changes = BotChanges.between(read, "Phone Test Bot (edited)", read.description, read.model, emptyList(), "1000000")
      c.updateBot(id, changes)
      c.setBotPersona(id, "You are an edited harmless test bot. Do nothing.")
      val after = c.botManifest(id)
      println("LIVE edit → patch=${changes.body()} name=${after.name} persona=${c.botPersona(id).take(40)}…")
      assertEquals("Phone Test Bot (edited)", after.name)
      c.setBotEnabled(id, false)
      val run = c.runBotNow(id)
      println("LIVE disable → enabled=${c.botManifest(id).enabled}; run now → accepted=${run.accepted} reason=${run.reasonCode}")
      assertFalse(c.botManifest(id).enabled)
      assertFalse(run.accepted)
    } finally {
      runCatching { c.deleteBot(id) }
    }
    val gone = c.bots().bots.none { it.id == id }
    val status = try { c.botManifest(id); 200 } catch (e: MercuryException.Server) { e.code }
    println("LIVE delete → gone=$gone GET status=$status")
    assertTrue(gone)
    assertEquals(404, status)
  }
}
