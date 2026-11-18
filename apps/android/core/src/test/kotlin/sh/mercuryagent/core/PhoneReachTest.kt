package sh.mercuryagent.core

import java.time.Instant
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The ring / ring_end / notify events and routes of src/reach (ADR-046), as the app reads them. */
class PhoneReachTest {
  @Test fun parsesARing() {
    val e = ReachEvent.parse("ring", """{"id":"r1","caller":"Mercury","reason":"the deploy failed","urgency":"high","at":"2026-11-18T14:00:00.000Z","expiresAt":"2026-11-18T14:00:45.000Z"}""")
    assertEquals(ReachEvent.Ring(RingInvite("r1", "Mercury", "the deploy failed", "high", Instant.parse("2026-11-18T14:00:45Z"))), e)
  }

  @Test fun parsesRingEndAndNotify() {
    assertEquals(ReachEvent.RingEnd("r1", "answered_elsewhere"), ReachEvent.parse("ring_end", """{"id":"r1","outcome":"answered_elsewhere"}"""))
    assertEquals(
      ReachEvent.Notify(ReachNotice("n1", "Done", "Report ready", "result", "normal", "t9", silent = true)),
      ReachEvent.parse("notify", """{"id":"n1","title":"Done","body":"Report ready","kind":"result","urgency":"normal","threadId":"t9","silent":true,"at":"x"}"""),
    )
  }

  @Test fun ignoresOtherEventsAndJunk() {
    assertNull(ReachEvent.parse("activity", """{"id":"x"}"""))
    assertNull(ReachEvent.parse("ring", "not json"))
    assertNull(ReachEvent.parse("ring", """{"reason":"no id"}"""))
  }

  @Test fun settingsAndMissedDecode() {
    val s = ReachSettings.decode("""{"settings":{"calls":false,"notifications":true,"quietHours":{"enabled":true,"start":"23:00","end":"06:30"},"maxCallsPerHour":2}}""")
    assertEquals(ReachSettings(calls = false, quietHours = true, quietStart = "23:00", quietEnd = "06:30", maxCallsPerHour = 2), s)
    assertEquals("""{"calls":false,"notifications":true,"quietHours":{"enabled":true,"start":"23:00","end":"06:30"}}""", s.patch().toString())
    val m = ReachSettings.decodeMissed("""{"items":[{"id":"m1","kind":"call","title":"Missed call from Mercury","body":"x","urgency":"normal","at":"2026-11-18T14:00:00.000Z"},{"nope":1}]}""")
    assertEquals(listOf(MissedItem("m1", "call", "Missed call from Mercury", "x", null, Instant.parse("2026-11-18T14:00:00Z"))), m)
  }

  @Test fun routes() = runTest {
    val server = MockWebServer()
    server.enqueue(MockResponse().setBody("""{"reach":{}}"""))
    server.enqueue(MockResponse().setBody("""{"ok":true,"state":"answered"}"""))
    server.enqueue(MockResponse().setBody("""{"engine":"gemini","token":"auth_tokens/x","ephemeral":true,"instructions":"…","tools":[]}"""))
    server.start()
    val client = MercuryClient(server.url("/").toString().trimEnd('/'), "mdt_x")
    client.registerReach(ring = true, notify = false, appVersion = "1.2 (3)", capabilities = listOf("telecom"))
    client.reportRing("r 1", RingOutcome.Answered)
    client.voiceSession(ring = RingInvite("r1", reason = "the build broke"))
    val put = server.takeRequest()
    assertEquals("PUT /api/devices/me/reach", "${put.method} ${put.path}")
    assertEquals("""{"platform":"android","appVersion":"1.2 (3)","ring":true,"notify":false,"capabilities":["telecom"]}""", put.body.readUtf8())
    val ring = server.takeRequest()
    assertEquals("POST /api/devices/me/ring/r%201", "${ring.method} ${ring.path}")
    assertEquals("""{"outcome":"answered"}""", ring.body.readUtf8())
    val session = server.takeRequest()
    assertEquals("""{"callInviteId":"r1","reason":"the build broke"}""", session.body.readUtf8())
    server.shutdown()
  }
}
