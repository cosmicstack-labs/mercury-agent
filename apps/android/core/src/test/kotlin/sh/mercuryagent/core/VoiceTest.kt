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

  @Test fun dictationUsesMercurysServiceElseThePhone() {
    // Gemini-only Mercury (the owner's voice): Mercury's Gemini listens.
    val gemini = VoiceCapabilities.decode(200, """{"call":true,"callEngine":"gemini","dictation":true,"dictationEngine":"gemini","dictationEngineName":"Gemini"}""")
    assertEquals(DictationRoute.Server("Gemini"), DictationRoute.decide(gemini, deviceAvailable = true))
    assertEquals("Listening · Gemini", DictationRoute.decide(gemini, deviceAvailable = false).listeningLabel)
    // An older Mercury without the engine's display name.
    assertEquals(DictationRoute.Server("Deepgram"), DictationRoute.decide(VoiceCapabilities(dictation = true, dictationEngine = "deepgram"), true))
    // No speech key at all: the phone's own recogniser, never a greyed-out mic.
    val none = VoiceCapabilities.decode(200, """{"call":false,"dictation":false,"dictationFallback":"device","dictationSetup":"Dictation uses this phone's own speech recognition."}""")
    assertEquals("device", none.dictationFallback)
    assertEquals(DictationRoute.Device, DictationRoute.decide(none, deviceAvailable = true))
    assertEquals("Listening · On this phone", DictationRoute.Device.listeningLabel)
    // A Mercury from before dictation (404): the phone too.
    assertEquals(DictationRoute.Device, DictationRoute.decide(VoiceCapabilities.decode(404, ""), true))
    // Not known yet: ask Mercury (and fall back to the phone if it refuses).
    assertEquals(DictationRoute.Server(null), DictationRoute.decide(null, false))
    assertEquals(DictationRoute.Device, DictationRoute.afterServerRefused("no key", deviceAvailable = true))
    assertEquals(DictationRoute.Unavailable("no key"), DictationRoute.afterServerRefused("no key", deviceAvailable = false))
    // Nothing can listen: say why. A call has the mic: off.
    assertTrue(DictationRoute.decide(none, deviceAvailable = false) is DictationRoute.Unavailable)
    assertEquals(DictationRoute.Unavailable(DictationRoute.DURING_CALL), DictationRoute.decide(gemini, true, callRunning = true))
    assertFalse(VoiceCapabilities.DEFAULT_DICTATION_SETUP.contains("can't"))
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

  // MARK: Voice providers (src/web/api/voice-providers.ts)

  private val providersBody = """
    {"providers":[
      {"id":"openai","name":"OpenAI","env":"OPENAI_API_KEY","uses":["calls","dictation","optimus"],"set":true,"source":"provider","canEdit":false,"note":"Change it in Settings → Models."},
      {"id":"gemini","name":"Gemini","env":"GEMINI_API_KEY","uses":["calls","optimus"],"set":false,"source":null,"canEdit":true},
      {"id":"elevenlabs","name":"ElevenLabs","env":"ELEVENLABS_API_KEY","uses":["dictation","optimus"],"set":true,"source":"env","hint":"9f2a","canEdit":false,"note":"Set on the computer."},
      {"id":"deepgram","name":"Deepgram","env":"DEEPGRAM_API_KEY","uses":["dictation","optimus"],"set":true,"source":"store","hint":"1234","canEdit":true},
      {"id":"cartesia","name":"Cartesia","env":"CARTESIA_API_KEY","uses":["optimus"],"set":false,"source":null,"canEdit":true,"future":1},
      {"name":"no id, skipped"}
    ],
    "capabilities":{"call":true,"callEngine":"openai","callEngineName":"OpenAI Realtime","dictation":true,"dictationEngine":"deepgram","dictationEngineName":"Deepgram"}}
  """

  @Test fun voiceProvidersDecode() {
    val r = MercuryJson.decodeFromString(VoiceProvidersResponse.serializer(), providersBody)
    assertEquals(listOf("openai", "gemini", "elevenlabs", "deepgram", "cartesia"), r.providers.map { it.id })
    val (openai, gemini, eleven, deepgram, cartesia) = r.providers
    assertEquals("From your OpenAI model", openai.status)
    assertFalse(openai.canEdit)
    assertEquals("Calls · Dictation · Computer voice", openai.usedFor)
    assertEquals("Not set", gemini.status)
    assertNull(gemini.source)
    assertEquals("Set on the computer", eleven.status)
    assertEquals("Set · ••••1234", deepgram.status)
    assertFalse(deepgram.optimusOnly)
    assertTrue(cartesia.optimusOnly)
    assertEquals("Computer voice", cartesia.usedFor)
    assertEquals("OpenAI Realtime", r.capabilities.callEngineName)
    assertEquals("Deepgram", r.capabilities.dictationEngineName)
    assertTrue(r.capabilities.dictation)
  }

  @Test fun capabilitiesCarryEngineNames() {
    val c = VoiceCapabilities.decode(200, """{"call":true,"callEngine":"gemini","callEngineName":"Gemini Live","dictation":false,"dictationSetup":"Add a key."}""")
    assertEquals("Gemini Live", c.callEngineName)
    assertNull(c.dictationEngineName)
    // An older Mercury: no names, still fine.
    assertNull(VoiceCapabilities.decode(200, """{"call":true,"callEngine":"openai","dictation":false}""").callEngineName)
  }

  @Test fun setVoiceKeySavesAndRemoves() = runTest {
    val server = MockWebServer()
    server.enqueue(MockResponse().setBody("""
      {"ok":true,"verified":true,"message":"Deepgram accepted the key.",
       "provider":{"id":"deepgram","name":"Deepgram","uses":["dictation","optimus"],"set":true,"source":"store","hint":"abcd","canEdit":true},
       "capabilities":{"call":false,"callSetup":"Add a Gemini key.","dictation":true,"dictationEngine":"deepgram","dictationEngineName":"Deepgram"}}
    """))
    server.enqueue(MockResponse().setBody("""{"ok":true,"verified":false,"provider":{"id":"deepgram","set":false},"capabilities":{"call":false,"dictation":false}}"""))
    server.start()
    val client = MercuryClient(server.url("/").toString().trimEnd('/'), "mdt_x")
    val saved = client.setVoiceKey("deepgram", "dg_secret_abcd")
    assertTrue(saved.ok && saved.verified)
    assertEquals("Set · ••••abcd", saved.provider?.status)
    assertEquals("Deepgram", saved.capabilities?.dictationEngineName)
    val removed = client.setVoiceKey("deepgram", null, approval = "ap_1")
    assertEquals("Not set", removed.provider?.status)
    val put = server.takeRequest()
    assertEquals("PUT /api/voice/providers/deepgram", "${put.method} ${put.path}")
    assertEquals("""{"apiKey":"dg_secret_abcd"}""", put.body.readUtf8())
    assertNull(put.getHeader(APPROVAL_HEADER))
    val del = server.takeRequest()
    assertEquals("""{"apiKey":null}""", del.body.readUtf8())
    assertEquals("ap_1", del.getHeader(APPROVAL_HEADER))
    server.shutdown()
  }

  @Test fun setVoiceKeyFailures() = runTest {
    val server = MockWebServer()
    server.enqueue(MockResponse().setResponseCode(400).setBody("""{"ok":false,"verified":false,"error":"Deepgram didn't accept that key."}"""))
    server.enqueue(MockResponse().setResponseCode(409).setBody("""{"ok":false,"error":"Set on the computer (DEEPGRAM_API_KEY in ~/.mercury/.env).","envSet":true}"""))
    server.enqueue(MockResponse().setResponseCode(428).setBody("""{"approvalRequired":true,"approvalId":"ap_9","code":"K7Q2M","where":"this computer","error":"Waiting."}"""))
    server.enqueue(MockResponse().setBody(providersBody))
    server.start()
    val client = MercuryClient(server.url("/").toString().trimEnd('/'), "mdt_x")
    val bad = runCatching { client.setVoiceKey("deepgram", "nope") }.exceptionOrNull() as MercuryException.Server
    assertEquals(400, bad.code)
    assertEquals("Deepgram didn't accept that key.", bad.message)
    val env = runCatching { client.setVoiceKey("deepgram", "x") }.exceptionOrNull() as MercuryException.Server
    assertEquals(409, env.code)
    assertTrue(env.message!!.contains("on the computer"))
    val owner = runCatching { client.setVoiceKey("deepgram", "x") }.exceptionOrNull() as MercuryException.NeedsOwner
    assertEquals("ap_9", owner.question.id)
    assertEquals("K7Q2M", owner.question.code)
    assertEquals(5, client.voiceProviders().providers.size)
    repeat(3) { server.takeRequest() }
    assertEquals("GET /api/voice/providers", server.takeRequest().let { "${it.method} ${it.path}" })
    server.shutdown()
  }
}
