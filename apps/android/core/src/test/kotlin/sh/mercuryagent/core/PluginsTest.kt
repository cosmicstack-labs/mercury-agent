package sh.mercuryagent.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Settings → Plugins: installed or catalog, which confirm sheet, plain errors, and where it stands after. */
class PluginsTest {
  private lateinit var server: MockWebServer
  private lateinit var base: String

  @Before fun setUp() { server = MockWebServer().apply { start() }; base = MercuryClient.normalize(server.url("/").toString())!! }
  @After fun tearDown() { server.shutdown() }

  private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

  /** A real GET /api/plugins shape: Optimus only in the catalog, WhatsApp installed with an update. */
  private val listJson = """
    {"items":[
      {"id":"whatsapp","name":"WhatsApp","description":"Chat on WhatsApp.","kind":"out-of-process","tier":"official","status":"update-available",
       "installedVersion":"0.1.1","latestVersion":"0.1.2","enabled":true,"running":true,"verified":true,"tools":[],"commands":[],
       "permissions":{"network":[],"secrets":[]}},
      {"id":"optimus","name":"Optimus","description":"Uses your computer.","kind":"out-of-process","tier":"official","status":"available",
       "latestVersion":"0.5.2","sizeBytes":1459305,"enabled":false,"running":false,"verified":false,"tools":[],"commands":[],
       "permissions":{"network":["api.openai.com"],"secrets":["GEMINI_API_KEY"]}}
    ],"stale":false,"safeMode":false}
  """

  @Test fun catalogEntriesAreNotInstalled() {
    val list = MercuryJson.decodeFromString(PluginList.serializer(), listJson)
    assertEquals(listOf("whatsapp"), Plugins.installed(list.items).map { it.id })
    assertEquals(listOf("optimus"), Plugins.available(list.items).map { it.id })
    assertFalse(Plugins.isInstalled(list.items[1]))
    assertFalse(Plugins.isInstalled(null))
    assertTrue(Plugins.updateAvailable(list.items[0]))
    assertFalse(Plugins.updateAvailable(list.items[1]))
  }

  @Test fun onlyAMercuryWithRemoteApprovalsTakesChanges() {
    assertTrue(Plugins.canManage(setOf("plugins", "security.remote", "voice")))
    assertFalse(Plugins.canManage(setOf("plugins")))
    assertFalse(Plugins.canManage(null))
  }

  @Test fun optimusGetsTheComputerControlSheet() {
    val catalog = MercuryJson.decodeFromString(PluginList.serializer(), listJson).items[1]
    assertEquals(
      Plugins.Consent.ControlsComputer(
        "Install Optimus?",
        "Optimus lets Mercury see the screen and use the mouse and keyboard on Studio Mac. It asks before anything that submits, sends or deletes.",
      ),
      Plugins.consent(catalog, "Studio Mac"),
    )
    val other = PluginDetail(id = "screen-pilot", name = "Pilot", permissions = PluginPermissions(desktop = true))
    val c = Plugins.consent(other, "Studio Mac", enabling = true)
    assertTrue(c is Plugins.Consent.ControlsComputer)
    assertEquals("Turn on Pilot?", c.title)
  }

  @Test fun otherPluginsListWhatTheyReach() {
    val weather = PluginDetail(
      id = "weather", name = "Weather", kind = "in-process", tools = listOf("weather__forecast"),
      permissions = PluginPermissions(network = listOf("api.open-meteo.com"), secrets = listOf("WEATHER_KEY"), providers = mapOf("openai" to PluginProviderNeed("Spoken forecasts"))),
    )
    val c = Plugins.consent(weather, "Studio Mac") as Plugins.Consent.Access
    assertEquals("Install Weather?", c.title)
    assertEquals(
      listOf(
        "Connects to api.open-meteo.com",
        "Can read the key it needs: WEATHER_KEY",
        "Uses your OpenAI key for spoken forecasts",
        "Gives Mercury 1 tool",
        "Runs inside Mercury on Studio Mac",
      ),
      c.lines,
    )
    val quiet = Plugins.consent(PluginDetail(id = "notes", name = "Notes", kind = "out-of-process"), "Studio Mac") as Plugins.Consent.Access
    assertEquals("Doesn't reach the internet or read any keys", quiet.lines.last())
  }

  @Test fun aComputerWithoutAScreenIsSaidPlainly() {
    val optimus = PluginDetail(id = "optimus", name = "Optimus")
    val needs = "Optimus needs a desktop computer (a Mac, Windows or Linux with a screen). This Mercury runs where there isn't one."
    assertEquals(needs, Plugins.friendlyError("Optimus can't be installed here: not available for android-arm64 (supports darwin-arm64).", optimus))
    assertEquals(needs, Plugins.friendlyError("Can't open display :0", optimus))
    assertTrue(Plugins.needsComputer(needs))
    val other = PluginDetail(id = "weather", name = "Weather")
    assertEquals("Weather can't be installed here: needs Mercury >=2", Plugins.friendlyError("Weather can't be installed here: needs Mercury >=2", other))
  }

  @Test fun stateAfterInstall() {
    val p = PluginDetail(id = "optimus", name = "Optimus", enabled = true, running = true, installedVersion = "0.5.2", kind = "out-of-process")
    assertEquals(Plugins.After.Running, Plugins.after(p))
    assertEquals(Plugins.After.Starting, Plugins.after(p.copy(running = false)))
    assertEquals(Plugins.After.NeedsSetup, Plugins.after(p.copy(running = false, missing = listOf(PluginMissing("openai", "An OpenAI key", "Add it")))))
    assertTrue(Plugins.after(p.copy(running = false, lastError = "Can't open display")) is Plugins.After.Failed)
    assertEquals(Plugins.After.Missing, Plugins.after(PluginDetail(id = "optimus", name = "Optimus", status = "available")))
  }

  @Test fun watchingWaitsUntilItRuns() = runBlocking {
    val starting = """{"plugin":{"id":"optimus","name":"Optimus","installedVersion":"0.5.2","enabled":true,"running":false,"kind":"out-of-process"}}"""
    server.enqueue(json(200, starting))
    server.enqueue(json(200, starting))
    server.enqueue(json(200, starting.replace("\"running\":false", "\"running\":true")))
    val (after, last) = Plugins.watch(MercuryClient(base, "t"), "optimus", times = 5, everyMs = 1)
    assertEquals(Plugins.After.Running, after)
    assertTrue(last!!.running)
    assertEquals(3, server.requestCount)
  }

  @Test fun installAsksTheOwnerThenCarriesTheApproval() = runBlocking {
    server.enqueue(json(428, """{"error":"Waiting for the owner to approve: Change plugins (POST /install).","approvalRequired":true,"approvalId":"ap1","code":"ABC123","where":"this computer"}"""))
    server.enqueue(json(200, """{"id":"optimus","name":"Optimus","version":"0.5.2"}"""))
    val c = MercuryClient(base, "t")
    try {
      c.installPlugin("optimus")
      fail("expected the owner's question")
    } catch (e: MercuryException.NeedsOwner) {
      assertEquals("ABC123", e.question.code)
    }
    val first = server.takeRequest()
    assertEquals("/api/plugins/install", first.path)
    assertEquals("""{"source":"optimus","enable":true}""", first.body.readUtf8())
    assertEquals("optimus", c.installPlugin("optimus", approval = "ap1").id)
    assertEquals("ap1", server.takeRequest().getHeader(APPROVAL_HEADER))
  }
}
