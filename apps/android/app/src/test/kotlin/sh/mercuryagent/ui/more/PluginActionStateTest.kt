package sh.mercuryagent.ui.more

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sh.mercuryagent.core.APPROVAL_HEADER
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.PluginDetail
import sh.mercuryagent.core.Plugins

/** Install from a remote phone: the owner approves, the install goes through with the approval, then it runs. */
class PluginActionStateTest {
  private lateinit var server: MockWebServer
  private val installs = mutableListOf<RecordedRequest>()
  private var installed = false
  private var looks = 0
  private var approval = "allowed"
  private var installError: String? = null

  private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

  @Before fun setUp() {
    server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@PluginActionStateTest) {
        when (request.method to request.path) {
          "POST" to "/api/plugins/install" -> {
            installs += request
            when {
              request.getHeader(APPROVAL_HEADER) == null ->
                json(428, """{"error":"Waiting for the owner.","approvalRequired":true,"approvalId":"ap1","code":"ABC123","where":"this computer"}""")
              installError != null -> json(400, """{"error":"$installError"}""")
              else -> { installed = true; json(200, """{"id":"optimus","name":"Optimus","version":"0.5.2"}""") }
            }
          }
          "GET" to "/api/security/approvals/ap1/status" -> json(200, """{"status":"$approval"}""")
          "GET" to "/api/plugins/optimus" -> {
            looks++
            if (installed) json(200, """{"plugin":{"id":"optimus","name":"Optimus","installedVersion":"0.5.2","enabled":true,"running":${looks > 1},"kind":"out-of-process","permissions":{"desktop":true}}}""")
            else json(200, """{"plugin":{"id":"optimus","name":"Optimus","enabled":false,"running":false,"status":"available"}}""")
          }
          else -> json(404, """{"error":"Not found"}""")
        }
      }
    }
    server.start()
  }

  @After fun tearDown() { server.shutdown() }

  private fun state(): PluginActionState {
    val client = MercuryClient(MercuryClient.normalize(server.url("/").toString())!!, "t")
    return PluginActionState(client, PluginDetail(id = "optimus", name = "Optimus", status = "available"), install = true, computer = "Studio Mac")
      .apply { pollEveryMs = 5 }
  }

  @Test fun approvalThenInstallCarriesOnToRunning() = runBlocking {
    val s = state()
    assertEquals(PluginActionState.Stage.Confirm, s.stage)
    assertTrue(s.consent is Plugins.Consent.ControlsComputer)
    s.run()
    assertEquals(PluginActionState.Stage.Done(Plugins.After.Running), s.stage)
    assertTrue(Plugins.isInstalled(s.result))
    assertEquals(2, installs.size)
    assertNull(installs[0].getHeader(APPROVAL_HEADER))
    assertEquals("ap1", installs[1].getHeader(APPROVAL_HEADER))
    assertNull(s.gate.question)
  }

  @Test fun aRefusalIsShownAndNothingInstalls() = runBlocking {
    approval = "denied"
    val s = state()
    s.run()
    assertEquals(PluginActionState.Stage.Failed("The owner said no."), s.stage)
    assertFalse(installed)
  }

  @Test fun anUnsupportedComputerIsExplained() = runBlocking {
    installError = "Optimus can't be installed here: not available for android-arm64 (supports darwin-arm64, linux-x64)."
    val s = state()
    s.run()
    assertEquals(
      PluginActionState.Stage.Failed("Optimus needs a desktop computer (a Mac, Windows or Linux with a screen). This Mercury runs where there isn't one."),
      s.stage,
    )
  }
}
