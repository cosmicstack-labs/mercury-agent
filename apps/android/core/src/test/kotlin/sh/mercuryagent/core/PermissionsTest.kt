package sh.mercuryagent.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class PermissionsTest {
  private lateinit var server: MockWebServer
  private lateinit var base: String

  @Before fun setUp() { server = MockWebServer().apply { start() }; base = MercuryClient.normalize(server.url("/").toString())!! }
  @After fun tearDown() { server.shutdown() }

  private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

  @Test fun readsTheModeOrTheOlderFlag() {
    assertEquals(PermissionMode.ALLOW_ALL, PermissionMode.decode("""{"bypassPermissions":true,"permissionMode":"allow-all"}"""))
    assertEquals(PermissionMode.ASK_ME, PermissionMode.decode("""{"bypassPermissions":false,"permissionMode":"ask-me"}"""))
    // An older Mercury: only bypassPermissions.
    assertEquals(PermissionMode.ALLOW_ALL, PermissionMode.decode("""{"bypassPermissions":true,"restrictUser":false}"""))
    assertEquals(PermissionMode.ASK_ME, PermissionMode.decode("""{"bypassPermissions":false}"""))
    assertNull(PermissionMode.decode("""{"workspace":"/x"}"""))
    assertNull(PermissionMode.decode("not json"))
  }

  @Test fun readsTheLiveStatus() {
    assertEquals(PermissionMode.ALLOW_ALL, PermissionMode.fromStatus("""{"permission":"allow-all","model":"x"}"""))
    assertEquals(PermissionMode.ASK_ME, PermissionMode.fromStatus("""{"permission":"ask-me"}"""))
    assertNull(PermissionMode.fromStatus("""{"permission":"other"}"""))
    assertNull(PermissionMode.fromStatus("""{"model":"x"}"""))
  }

  @Test fun wordsTheOptions() {
    assertEquals(listOf("Ask Me", "Allow All"), PermissionMode.entries.map { it.title })
    assertEquals("Mercury asks before anything risky", PermissionMode.ASK_ME.detail)
    assertEquals("Mercury acts without asking", PermissionMode.ALLOW_ALL.detail)
  }

  @Test fun clientReadsAndSwitches() = runBlocking {
    server.enqueue(json(200, """{"bypassPermissions":false,"restrictUser":false,"workspace":"","permissionMode":"ask-me"}"""))
    server.enqueue(json(200, """{"success":true,"bypassPermissions":true,"restrictUser":false,"workspace":"","permissionMode":"allow-all"}"""))
    val c = MercuryClient(base, "t")
    assertEquals(PermissionMode.ASK_ME, c.permissionMode())
    assertEquals(PermissionMode.ALLOW_ALL, c.setPermissionMode(PermissionMode.ALLOW_ALL))
    assertEquals("GET", server.takeRequest().method)
    val put = server.takeRequest()
    assertEquals("PUT", put.method)
    assertEquals("/api/chat/settings", put.path)
    assertEquals("""{"bypassPermissions":true}""", put.body.readUtf8())
  }

  @Test fun anOlderMercuryAsksTheOwner() = runBlocking {
    server.enqueue(json(428, """{"error":"Waiting for the owner.","approvalId":"ap1","code":"482913","where":"Mercury Desktop"}"""))
    server.enqueue(json(200, """{"success":true,"bypassPermissions":true,"restrictUser":false,"workspace":""}"""))
    val c = MercuryClient(base, "t")
    try {
      c.setPermissionMode(PermissionMode.ALLOW_ALL)
      fail("should ask the owner")
    } catch (e: MercuryException.NeedsOwner) {
      assertEquals("ap1", e.question.id)
      assertEquals("482913", e.question.code)
    }
    // Repeated with the approval, it goes through (an older Mercury sends no permissionMode).
    assertEquals(PermissionMode.ALLOW_ALL, c.setPermissionMode(PermissionMode.ALLOW_ALL, approval = "ap1"))
    server.takeRequest()
    assertEquals("ap1", server.takeRequest().getHeader(APPROVAL_HEADER))
  }

  @Test fun refreshReadsAndKeepsWhatsKnownOnFailure() = runBlocking {
    val p = PermissionSwitch(load = { PermissionMode.ALLOW_ALL }, save = { it })
    assertNull(p.state.value.mode)
    p.refresh()
    assertTrue(p.state.value.allowAll)
    val down = PermissionSwitch(load = { throw MercuryException.Unreachable("offline") }, save = { it })
    down.show(PermissionMode.ASK_ME)
    down.refresh()
    assertEquals(PermissionMode.ASK_ME, down.state.value.mode)
    assertNull(down.state.value.error)
  }

  @Test fun switchesAtOnceThenTakesMercurysAnswer() = runBlocking {
    val sent = mutableListOf<PermissionMode>()
    val release = CompletableDeferred<Unit>()
    val p = PermissionSwitch(load = { PermissionMode.ASK_ME }, save = { m -> sent += m; release.await(); m })
    p.show(PermissionMode.ASK_ME)
    val job = async { p.set(PermissionMode.ALLOW_ALL) }
    while (!p.state.value.saving) yield()
    assertEquals(PermissionMode.ALLOW_ALL, p.state.value.mode) // optimistic
    // A live status while saving doesn't undo it.
    p.applyStatus("""{"permission":"ask-me"}""")
    assertEquals(PermissionMode.ALLOW_ALL, p.state.value.mode)
    release.complete(Unit)
    job.await()
    assertEquals(PermissionState(PermissionMode.ALLOW_ALL), p.state.value)
    // The same mode again: nothing sent.
    p.set(PermissionMode.ALLOW_ALL)
    assertEquals(listOf(PermissionMode.ALLOW_ALL), sent)
  }

  @Test fun revertsAndSaysWhyWhenRefused() = runBlocking {
    val p = PermissionSwitch(load = { PermissionMode.ASK_ME }, save = { throw MercuryException.Server(403, "The owner said no.") })
    p.show(PermissionMode.ASK_ME)
    p.set(PermissionMode.ALLOW_ALL)
    assertEquals(PermissionMode.ASK_ME, p.state.value.mode)
    assertFalse(p.state.value.saving)
    assertEquals("Couldn't switch to Allow All: The owner said no.", p.state.value.error)
  }

  @Test fun followsChangesMadeElsewhere() {
    val p = PermissionSwitch(load = { PermissionMode.ASK_ME }, save = { it })
    p.show(PermissionMode.ASK_ME)
    p.applyStatus("""{"permission":"allow-all","model":"claude"}""")
    assertTrue(p.state.value.allowAll)
    p.applyStatus("""{"model":"claude"}""")
    assertTrue(p.state.value.allowAll)
    p.applyStatus("""{"permission":"ask-me"}""")
    assertEquals(PermissionMode.ASK_ME, p.state.value.mode)
  }
}
