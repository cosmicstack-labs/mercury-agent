package sh.mercuryagent.core

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class MercuryClientTest {
  private lateinit var server: MockWebServer
  private lateinit var base: String

  @Before fun setUp() { server = MockWebServer().apply { start() }; base = MercuryClient.normalize(server.url("/").toString())!! }
  @After fun tearDown() { server.shutdown() }

  private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

  @Test fun authHeadersExactlyAsIos() = runBlocking {
    server.enqueue(json(200, """{"threads":[]}"""))
    server.enqueue(json(200, """{"title":"Trip"}"""))
    val c = MercuryClient(base, "mdt_ab12cd34_x")
    c.threads()
    val get = server.takeRequest()
    assertEquals("GET", get.method)
    assertEquals("/api/chat/threads", get.path)
    assertEquals("Bearer mdt_ab12cd34_x", get.getHeader("Authorization"))
    assertEquals("application/json", get.getHeader("Accept"))
    assertNull(get.getHeader("Content-Type"))
    assertEquals("Trip", c.renameThread("a b/c", "Trip"))
    val put = server.takeRequest()
    assertEquals("PUT", put.method)
    assertEquals("/api/chat/threads/a%20b%2Fc/title", put.path)
    assertEquals("application/json", put.getHeader("Content-Type"))
    assertEquals("""{"title":"Trip"}""", put.body.readUtf8())
  }

  @Test fun noTokenNoAuthorization() = runBlocking {
    server.enqueue(json(200, """{"ok":true,"version":"1.6.0","apiVersion":1}"""))
    val h = MercuryClient(base).health()
    assertEquals("1.6.0", h.version)
    assertNull(server.takeRequest().getHeader("Authorization"))
  }

  @Test fun healthNotFoundIsUnauthorized() = runBlocking {
    server.enqueue(json(404, "{}"))
    try { MercuryClient(base).health(); fail() } catch (e: MercuryException.Unauthorized) { }
  }

  @Test fun signInStartsPairingThenApproved() = runBlocking {
    server.enqueue(json(202, """{"pairingId":"p1","pollToken":"pt","code":"K7Q2M","message":"Approve it","expiresAt":"2026-11-16T10:00:00.000Z"}"""))
    server.enqueue(json(200, """{"status":"pending"}"""))
    server.enqueue(json(200, """{"status":"approved","token":"mdt_ab12cd34_ff","device":{"id":"ab12cd34","name":"Pixel","platform":"android"}}"""))
    val c = MercuryClient(base)
    val r = c.signIn("owner", "pw", "Pixel · Mercury for Android") as SignInResult.Pending
    assertEquals("K7Q2M", r.pairing.code)
    val body = server.takeRequest().body.readUtf8()
    assertEquals("""{"username":"owner","password":"pw","deviceName":"Pixel · Mercury for Android","platform":"android"}""", body)
    assertEquals(PairingStatus.Waiting, c.pairingStatus(r.pairing))
    val poll = server.takeRequest()
    assertEquals("/api/auth/token/pending", poll.path)
    assertEquals("""{"pairingId":"p1","pollToken":"pt","waitMs":25000}""", poll.body.readUtf8())
    val ok = c.pairingStatus(r.pairing) as PairingStatus.Approved
    assertEquals("mdt_ab12cd34_ff", ok.token)
    assertEquals("ab12cd34", ok.device!!.id)
  }

  @Test fun pairingDeniedExpiredAndGone() = runBlocking {
    server.enqueue(json(200, """{"status":"denied"}"""))
    server.enqueue(json(200, """{"status":"expired","error":"Too late."}"""))
    server.enqueue(json(410, """{}"""))
    val c = MercuryClient(base); val p = Pairing("p", "t", "AAAAA")
    assertEquals(PairingStatus.Denied("The owner said no."), c.pairingStatus(p))
    assertEquals(PairingStatus.Expired("Too late."), c.pairingStatus(p))
    assertEquals(PairingStatus.Expired("The code expired."), c.pairingStatus(p))
  }

  @Test fun signInErrors() = runBlocking {
    server.enqueue(json(401, """{"error":"no"}"""))
    server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "30"))
    server.enqueue(json(409, "{}"))
    server.enqueue(json(200, "{}"))
    val c = MercuryClient(base)
    try { c.signIn("a", "b", "d"); fail() } catch (_: MercuryException.BadCredentials) {}
    try { c.signIn("a", "b", "d"); fail() } catch (e: MercuryException.TooManyAttempts) { assertEquals(30, e.retryAfter) }
    try { c.signIn("a", "b", "d"); fail() } catch (_: MercuryException.DeviceLimit) {}
    try { c.signIn("a", "b", "d"); fail() } catch (e: MercuryException.Server) { assertEquals("Mercury didn't send a token.", e.message) }
  }

  @Test fun signedInOnOwnComputer() = runBlocking {
    server.enqueue(json(200, """{"token":"mdt_1_2","device":{"id":"1"}}"""))
    val r = MercuryClient(base).signIn("a", "b", "d") as SignInResult.SignedIn
    assertEquals("mdt_1_2", r.token)
  }

  @Test fun ownerGate428() = runBlocking {
    server.enqueue(json(428, """{"approvalId":"ap","code":"ZZZZZ","where":"Desktop","error":"Approve it first"}"""))
    try { MercuryClient(base, "t").threads(); fail() } catch (e: MercuryException.NeedsOwner) {
      assertEquals("ZZZZZ", e.question.code); assertEquals("Approve it first", e.message)
    }
  }

  @Test fun sendSaveDeleteBodies() = runBlocking {
    repeat(4) { server.enqueue(json(200, """{"sent":true,"savedAt":"2026-11-16T10:00:00.000Z"}""")) }
    val c = MercuryClient(base, "t")
    c.sendMessage("hi", "s1")
    assertEquals("""{"content":"hi","sessionId":"s1"}""", server.takeRequest().body.readUtf8())
    assertEquals(java.time.Instant.parse("2026-11-16T10:00:00Z"), c.setThreadSaved("s1", true))
    val save = server.takeRequest()
    assertEquals("/api/chat/threads/s1/save", save.path); assertEquals("""{"saved":true}""", save.body.readUtf8())
    c.deleteThread("s1")
    val del = server.takeRequest()
    assertEquals("/api/chat/threads/s1/delete", del.path); assertEquals("""{"confirmSessionId":"s1"}""", del.body.readUtf8())
    c.stop("s1")
    assertEquals("""{"threadId":"s1"}""", server.takeRequest().body.readUtf8())
  }

  @Test fun codeSendsProgrammingAndTheProjectFolder() = runBlocking {
    repeat(2) { server.enqueue(json(200, """{"ok":true}""")) }
    server.enqueue(json(200, """{"cwd":"/Users/me/mercury","projectName":"mercury","projectType":"node","isGit":true,"branch":"main","remoteUrl":""}"""))
    server.enqueue(json(404, "{}"))
    val c = MercuryClient(base, "t")
    c.sendMessage("fix it", "s1", programming = "auto", cwd = "/Users/me/mercury")
    assertEquals("""{"content":"fix it","sessionId":"s1","programming":"auto","cwd":"/Users/me/mercury"}""", server.takeRequest().body.readUtf8())
    // A folder without Code means nothing to the server: it isn't sent.
    c.sendMessage("hi", "s1", cwd = "/Users/me/mercury")
    assertEquals("""{"content":"hi","sessionId":"s1"}""", server.takeRequest().body.readUtf8())
    assertEquals(WorkspaceInfo("/Users/me/mercury", "mercury"), c.workspaceInfo())
    assertEquals("/api/workspace/info", server.takeRequest().path)
    assertNull(c.workspaceInfo())
  }

  @Test fun optionalRoutesAreNullOnOlderRuntimes() = runBlocking {
    server.enqueue(json(404, "{}"))
    server.enqueue(json(200, """{"state":"queued"}"""))
    server.enqueue(json(200, """{"running":true,"startedAt":1700000000000,"text":"Hal","trace":{"items":[]}}"""))
    val c = MercuryClient(base, "t")
    assertNull(c.runningTurns())
    assertEquals(1, c.queuePosition("s"))
    val live = c.liveTurn("s")!!
    assertTrue(live.running); assertEquals("Hal", live.text)
  }

  @Test fun eventStreamCarriesTokenAndReconnectsWithLastId() = runBlocking {
    server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
      .setBody("event: connected\ndata: {}\n\nid: 41\nevent: activity\ndata: {\"kind\":\"done\",\"sessionId\":\"s\"}\n\n"))
    server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
      .setBody("event: activity\nid: 42\ndata: {\"kind\":\"started\",\"sessionId\":\"s\"}\n\n").setBodyDelay(0, TimeUnit.MILLISECONDS))
    val events = withTimeout(10_000) { MercuryClient(base, "tok").events("/api/chat/activity").take(3).toList() }
    assertEquals(listOf("connected", "activity", "activity"), events.map { it.name })
    val first = server.takeRequest()
    assertEquals("text/event-stream", first.getHeader("Accept"))
    assertEquals("Bearer tok", first.getHeader("Authorization"))
    assertNull(first.getHeader("Last-Event-ID"))
    assertEquals("41", server.takeRequest().getHeader("Last-Event-ID"))
  }

  @Test fun publicCleartextIsRefused() = runBlocking {
    try { MercuryClient("http://mercury.example.com").health(); fail() } catch (e: MercuryException.Unreachable) {
      assertTrue(e.message!!.contains("http://"))
    }
  }
}
