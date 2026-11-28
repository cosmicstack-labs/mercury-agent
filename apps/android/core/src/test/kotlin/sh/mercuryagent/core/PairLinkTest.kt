package sh.mercuryagent.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PairLinkTest {
  private val code = "K7Q2M9ABCD3EFGH4JKMN5PQRS"

  @Test fun normalizesTypedCodes() {
    assertEquals(code, PairCode.normalize("k7q2m-9abcd-3efgh-4jkmn-5pqrs"))
    assertEquals(code, PairCode.normalize(" K7Q2M 9ABCD\n3EFGH_4JKMN.5PQRS "))
    // O reads as zero, I and L as one (as the server reads them).
    assertEquals("10110", PairCode.normalize("IOLlo"))
    assertEquals("", PairCode.normalize("—·"))
  }

  @Test fun validCodes() {
    assertTrue(PairCode.isValid(code))
    assertFalse(PairCode.isValid(code.dropLast(1)))
    assertFalse(PairCode.isValid(code + "A"))
    // U isn't in the alphabet, and normalizing doesn't turn it into anything.
    assertFalse(PairCode.isValid(code.dropLast(1) + "U"))
    assertFalse(PairCode.isValid(code.lowercase()))
  }

  @Test fun groupsInFives() {
    assertEquals("K7Q2M-9ABCD-3EFGH-4JKMN-5PQRS", PairCode.group(code))
  }

  @Test fun parsesTheComputersLink() {
    // pairLink() in pair-codes.ts leaves ':' and '/' readable.
    val l = PairLink.parse("mercury://pair?u=https://mac.tail1234.ts.net&c=$code")!!
    assertEquals("https://mac.tail1234.ts.net", l.address)
    assertEquals(code, l.code)
    assertEquals("mac.tail1234.ts.net", l.host)
    assertFalse(l.insecure)
  }

  @Test fun parsesPercentEncodedAddressAndGroupedCode() {
    val l = PairLink.parse("mercury://pair?u=http%3A%2F%2F192.168.1.7%3A6175%2F&c=k7q2m-9abcd-3efgh-4jkmn-5pqrs")!!
    assertEquals("http://192.168.1.7:6175", l.address)
    assertEquals(code, l.code)
    assertEquals("192.168.1.7:6175", l.host)
    assertFalse(l.insecure)
  }

  @Test fun parameterOrderAndCaseDontMatter() {
    val l = PairLink.parse("  MERCURY://pair/?c=$code&u=mac.example.com:8443  ")!!
    assertEquals("https://mac.example.com:8443", l.address)
  }

  @Test fun rejectsWhatIsntAPairingLink() {
    assertNull(PairLink.parse("https://mac.example.com/pair?u=https://x.com&c=$code"))
    assertNull(PairLink.parse("mercury://chat/abc"))
    assertNull(PairLink.parse("mercury://pairing?u=https://x.com&c=$code"))
    assertNull(PairLink.parse("mercury://pair"))
    assertNull(PairLink.parse("mercury://pair?u=https://x.com"))
    assertNull(PairLink.parse("mercury://pair?c=$code"))
    assertNull(PairLink.parse("mercury://pair?u=https://x.com&c=SHORT"))
    assertNull(PairLink.parse("mercury://pair?u=ftp://x.com&c=$code"))
    assertNull(PairLink.parse("mercury://pair?u=not%20an%20address&c=$code"))
    assertNull(PairLink.parse("just some text"))
  }

  @Test fun plainHttpOffTheLocalNetworkIsInsecure() {
    assertTrue(PairLink.parse("mercury://pair?u=http://mercury.example.com&c=$code")!!.insecure)
    assertTrue(PairLink.parse("mercury://pair?u=http://8.8.8.8:6175&c=$code")!!.insecure)
    assertFalse(PairLink.parse("mercury://pair?u=http://mymac.local:6175&c=$code")!!.insecure)
    assertFalse(PairLink.parse("mercury://pair?u=http://100.101.102.103:6175&c=$code")!!.insecure)
    assertFalse(PairLink.parse("mercury://pair?u=http://[fd7a:115c:a1e0::1]:6175&c=$code")!!.insecure)
  }

  // ── POST /api/auth/pair ──

  private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

  @Test fun pairSendsTheCodeAndReturnsTheToken() = runBlocking<Unit> {
    val server = MockWebServer().apply { start() }
    try {
      server.enqueue(json(200, """{"token":"mdt_ab12cd34_xyz","device":{"id":"ab12cd34","name":"Pixel","platform":"android"},"apiVersion":1}"""))
      val base = MercuryClient.normalize(server.url("/").toString())!!
      val p = MercuryClient(base).pair(code, "Pixel · Mercury for Android")
      assertEquals("mdt_ab12cd34_xyz", p.token)
      assertEquals("ab12cd34", p.device?.id)
      val r = server.takeRequest()
      assertEquals("POST", r.method)
      assertEquals("/api/auth/pair", r.path)
      assertNull(r.getHeader("Authorization"))
      assertEquals("""{"code":"$code","deviceName":"Pixel · Mercury for Android","platform":"android"}""", r.body.readUtf8())
    } finally { server.shutdown() }
  }

  @Test fun pairErrors() = runBlocking<Unit> {
    val server = MockWebServer().apply { start() }
    try {
      server.enqueue(json(401, """{"error":"This pairing code isn't valid. Make a new one on the computer Mercury runs on."}"""))
      server.enqueue(json(429, """{"error":"Too many wrong pairing codes; try again later"}""").setHeader("Retry-After", "42"))
      server.enqueue(json(403, """{"error":"Remote access is turned off on this Mercury. Turn it on with /server on the computer it runs on.","remoteOff":true}"""))
      server.enqueue(json(403, """{"addressBlocked":true}"""))
      server.enqueue(json(404, "{}"))
      val c = MercuryClient(MercuryClient.normalize(server.url("/").toString())!!)
      try { c.pair(code, "d"); fail() } catch (e: MercuryException.BadPairCode) {
        assertEquals("This pairing code isn't valid. Make a new one on the computer Mercury runs on.", e.message)
      }
      try { c.pair(code, "d"); fail() } catch (e: MercuryException.TooManyAttempts) { assertEquals(42, e.retryAfter) }
      try { c.pair(code, "d"); fail() } catch (e: MercuryException.Server) { assertEquals(403, e.code); assertTrue(e.message!!.startsWith("Remote access is turned off")) }
      try { c.pair(code, "d"); fail() } catch (e: MercuryException.Server) { assertEquals("This address is not allowed to connect to this Mercury.", e.message) }
      try { c.pair(code, "d"); fail() } catch (e: MercuryException.Server) { assertEquals(404, e.code); assertTrue(e.message!!.contains("too old")) }
    } finally { server.shutdown() }
  }

  // ── "Enter a code or token" ──

  private val token = "mdt_0a1b2c3d_" + "0123456789abcdef".repeat(4)

  @Test fun aTokenIsToldFromACode() {
    assertEquals(ConnectSecret.Token(token), ConnectSecret.read(token))
    assertEquals(ConnectSecret.Token(token), ConnectSecret.read("  $token\n"))
    // Pasted across two lines.
    assertEquals(ConnectSecret.Token(token), ConnectSecret.read(token.take(40) + "\n " + token.drop(40)))
    assertEquals(ConnectSecret.Code(code), ConnectSecret.read("K7Q2M-9ABCD-3EFGH-4JKMN-5PQRS"))
    assertEquals(ConnectSecret.Code(code), ConnectSecret.read("k7q2m 9abcd 3efgh 4jkmn 5pqrs"))
    assertEquals(ConnectSecret.Code(code), ConnectSecret.read(code))
    // O reads as 0, I and L as 1, as the server reads them.
    assertEquals(ConnectSecret.Code("0123456789ABCDEFGHJKMNPQ1"), ConnectSecret.read("o1234-56789-abcde-fghjk-mnpqi"))
  }

  @Test fun whatIsNeitherSaysWhy() {
    assertEquals(ConnectSecret.Invalid(ConnectSecret.EMPTY), ConnectSecret.read("  "))
    assertEquals(ConnectSecret.Invalid(ConnectSecret.NEITHER), ConnectSecret.read("K7Q2M-9ABCD"))
    assertEquals(ConnectSecret.Invalid(ConnectSecret.NEITHER), ConnectSecret.read(code + "A"))
    assertEquals(ConnectSecret.Invalid(ConnectSecret.NEITHER), ConnectSecret.read("my password"))
    assertEquals(ConnectSecret.Invalid(ConnectSecret.NEITHER), ConnectSecret.read(code.dropLast(1) + "U"))
    assertEquals(ConnectSecret.Invalid(ConnectSecret.BAD_TOKEN), ConnectSecret.read("mdt_"))
    assertEquals(ConnectSecret.Invalid(ConnectSecret.BAD_TOKEN), ConnectSecret.read(token.dropLast(1)))
    assertEquals(ConnectSecret.Invalid(ConnectSecret.BAD_TOKEN), ConnectSecret.read(token.uppercase()))
    assertTrue(ConnectSecret.isToken(" MDT_abc"))
    assertFalse(ConnectSecret.isToken(code))
  }
}
