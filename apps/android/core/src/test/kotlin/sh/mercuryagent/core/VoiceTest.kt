package sh.mercuryagent.core

import java.time.Instant
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** src/web/api/mobile-voice.ts as the phone reads it (iOS: Speech.swift, Dictation.swift). */
class VoiceTest {
  @Test fun capabilities() {
    val c = VoiceCapabilities.decode(200, """{"call":true,"callEngine":"openai","dictation":false,"dictationSetup":"Add a Deepgram key."}""")
    assertTrue(c.call)
    assertEquals("openai", c.callEngine)
    assertFalse(c.dictation)
    assertEquals("Add a Deepgram key.", c.setupLine)
    assertEquals(VoiceCapabilities.DEFAULT_DICTATION_SETUP, VoiceCapabilities.decode(200, """{"call":false,"dictation":false}""").setupLine)
    assertEquals(VoiceCapabilities.tooOld, VoiceCapabilities.decode(404, ""))
  }

  @Test fun aLiveSession() {
    val r = VoiceSessionResult.decode(200, """
      {"engine":"gemini","token":"auth_tokens/x","ephemeral":true,"expiresAt":"2026-11-16T10:00:00.000Z","model":"models/gemini-live",
       "voice":"Puck","instructions":"Be brief.","tools":[{"type":"function","name":"ask_mercury"}]}
    """) as VoiceSessionResult.Live
    val s = r.session
    assertEquals("gemini", s.engine)
    assertEquals("auth_tokens/x", s.token)
    assertEquals(Instant.parse("2026-11-16T10:00:00Z"), s.expiresAt)
    assertEquals("Be brief.", s.instructions)
    assertEquals("""[{"type":"function","name":"ask_mercury"}]""", s.toolsJson)
    assertNull(s.url)
  }

  @Test fun noLiveVoiceSaysWhatToAdd() {
    assertEquals(
      VoiceSessionResult.Unavailable("Voice calls on the phone need an OpenAI key."),
      VoiceSessionResult.decode(409, """{"error":"Voice calls on the phone need an OpenAI key.","fallback":true}"""),
    )
    assertEquals(VoiceSessionResult.Unavailable(VoiceSessionResult.NO_VOICE), VoiceSessionResult.decode(409, "{}"))
    assertEquals(VoiceSessionResult.Unavailable(VoiceSessionResult.TOO_OLD), VoiceSessionResult.decode(404, ""))
    assertTrue(runCatching { VoiceSessionResult.decode(200, """{"engine":"openai","token":""}""") }.isFailure)
    assertTrue(runCatching { VoiceSessionResult.decode(401, "") }.exceptionOrNull() is MercuryException.Unauthorized)
  }

  @Test fun dictationTokens() {
    val now = Instant.parse("2026-11-16T10:00:00Z")
    val live = DictationStart.decode(200, """{"engine":"deepgram","token":"t","expiresAt":"2026-11-16T10:00:30.000Z","language":"en"}""") as DictationStart.Live
    assertEquals("deepgram", live.session.engine)
    assertEquals("en", live.session.language)
    assertTrue(live.session.fresh(now))
    assertFalse(live.session.fresh(now.plusSeconds(20)))
    assertFalse(live.session.copy(expiresAt = null).fresh(now))
    assertEquals(DictationStart.Unavailable("Add a key."), DictationStart.decode(409, """{"error":"x","setup":"Add a key."}"""))
    assertEquals(DictationStart.Unavailable(VoiceCapabilities.tooOld.setupLine), DictationStart.decode(404, ""))
  }

  @Test fun theRoutes() = runTest {
    val server = MockWebServer()
    server.enqueue(MockResponse().setBody("""{"call":true,"dictation":true,"dictationEngine":"openai"}"""))
    server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"Need a key.","fallback":true}"""))
    server.enqueue(MockResponse().setBody("""{"engine":"openai","token":"ek_1","url":"wss://x"}"""))
    server.start()
    val client = MercuryClient(server.url("/").toString().trimEnd('/'), "mdt_x")
    assertTrue(client.voiceCapabilities().dictation)
    assertEquals(VoiceSessionResult.Unavailable("Need a key."), client.voiceSession())
    assertEquals("wss://x", (client.dictationSession("openai") as DictationStart.Live).session.url)
    assertEquals("GET /api/mobile/voice/capabilities", server.takeRequest().let { "${it.method} ${it.path}" })
    assertEquals("{}", server.takeRequest().body.readUtf8())
    val d = server.takeRequest()
    assertEquals("/api/mobile/voice/dictation", d.path)
    assertEquals("""{"engine":"openai"}""", d.body.readUtf8())
    assertEquals("Bearer mdt_x", d.getHeader("Authorization"))
    server.shutdown()
  }

  @Test fun spokenText() {
    assertEquals("Done. See the docs and run it.", Spoken.text("**Done.** See [the docs](https://x.y/z) and\n\n```sh\nnpm test\n```\nrun it."))
    assertEquals("First Second", Spoken.text("# First\n- Second"))
    assertEquals("Here: ", Spoken.text("Here: https://example.com/a").plus(" "))
  }

  @Test fun spokenSplit() {
    assertEquals("It's booked." to "Confirmation: ABC123", Spoken.split("It's booked.\n**For the chat:** Confirmation: ABC123"))
    assertEquals("Just this." to "", Spoken.split("  Just this.  "))
    assertEquals("Said" to "kept", Spoken.split("Said\nfor the chat: kept"))
  }
}
