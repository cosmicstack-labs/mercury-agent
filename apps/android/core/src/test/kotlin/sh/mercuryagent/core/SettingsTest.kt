package sh.mercuryagent.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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

class SettingsTest {
  private lateinit var server: MockWebServer
  private lateinit var base: String

  @Before fun setUp() { server = MockWebServer().apply { start() }; base = MercuryClient.normalize(server.url("/").toString())!! }
  @After fun tearDown() { server.shutdown() }

  private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

  private fun fields(raw: String): List<PluginField> = MercuryJson.decodeFromString(ListSerializer(PluginField.serializer()), raw)

  @Test fun pluginFieldsOnlyShowWhenTheyApply() {
    val f = fields("""
      [{"key":"voiceEngine","type":"enum","options":["openai","gemini"],"value":"gemini"},
       {"key":"geminiVoice","type":"enum","options":["Kore","Puck"],"when":{"voiceEngine":"gemini"}},
       {"key":"voice","type":"enum","options":["marin"],"when":[{"voiceEngine":["openai","azure"]}]},
       {"key":"bargeIn","type":"boolean","value":false}]
    """)
    val values: Map<String, JsonElement?> = mapOf("voiceEngine" to JsonPrimitive("gemini"))
    assertEquals(listOf("voiceEngine", "geminiVoice", "bargeIn"), f.filter { it.applies(values) }.map { it.key })
    assertEquals(false, f[3].value.settingBool)
    assertEquals(listOf("voiceEngine", "voice", "bargeIn"), f.filter { it.applies(mapOf("voiceEngine" to JsonPrimitive("azure"))) }.map { it.key })
    // A missing value reads as "": only unconditional fields apply.
    assertEquals(listOf("voiceEngine", "bargeIn"), f.filter { it.applies(emptyMap()) }.map { it.key })
  }

  @Test fun conditionsCompareAsText() {
    val f = fields("""[{"key":"rate","type":"number","when":[{"on":true,"n":60},{"mode":"x"}]}]""").single()
    assertTrue(f.applies(mapOf("on" to JsonPrimitive(true), "n" to JsonPrimitive(60.0))))
    assertFalse(f.applies(mapOf("on" to JsonPrimitive(true), "n" to JsonPrimitive(61))))
    assertTrue(f.applies(mapOf("mode" to JsonPrimitive("x"))))
  }

  @Test fun settingValuesReadAsText() {
    assertEquals("60", JsonPrimitive(60).settingText)
    assertEquals("60", JsonPrimitive(60.0).settingText)
    assertEquals("1.5", JsonPrimitive(1.5).settingText)
    assertEquals("true", JsonPrimitive(true).settingText)
    assertEquals("gemini", JsonPrimitive("gemini").settingText)
    assertEquals("", (null as JsonElement?).settingText)
    assertEquals("", MercuryJson.parseToJsonElement("null").settingText)
    assertEquals("", MercuryJson.parseToJsonElement("[1]").settingText)
    assertNull(JsonPrimitive("true").settingBool)
  }

  @Test fun tokenCountsAreShort() {
    assertEquals("2.4M", Tokens.short(2_400_000))
    assertEquals("1M", Tokens.short(1_000_000))
    assertEquals("750k", Tokens.short(750_000))
    assertEquals("12k", Tokens.short(12_345))
    assertEquals("1.5k", Tokens.short(1_500))
    assertEquals("1k", Tokens.short(1_000))
    assertEquals("42", Tokens.short(42))
  }

  @Test fun decodesProviderSettings() {
    val s = MercuryJson.decodeFromString(ProviderSettings.serializer(), """
      {"providers":[
        {"id":"openai","label":"OpenAI","kind":"openai","blurb":"GPT","needsKey":true,"needsBaseUrl":false,"signInOnly":false,
         "keyUrl":"https://platform.openai.com/api-keys","apiKey":"sk-a••••b3c4","hasKey":true,"baseUrl":"","model":"gpt-5",
         "enabled":true,"configured":true,"isDefault":true,"recommended":true},
        {"label":"broken"},
        {"id":"ollama","label":"Ollama","needsBaseUrl":true,"baseUrl":"http://localhost:11434","keyHint":null}
       ],
       "default":{"provider":"openai","model":"gpt-5"},"roles":{"learning":null,"crew":"ollama"}}
    """)
    assertEquals(listOf("openai", "ollama"), s.providers.map { it.id })
    assertTrue(s.providers[0].isDefault && s.providers[0].hasKey)
    assertEquals("gpt-5", s.defaultModel.model)
    assertNull(s.roles.learning)
    assertEquals("ollama", s.roles.crew)
    assertFalse(s.providers[1].configured)
  }

  @Test fun decodesPluginChannelsBudgetUsageAndDevices() {
    val p = MercuryJson.decodeFromString(PluginDetail.serializer(), """
      {"id":"optimus","name":"Optimus","enabled":true,"running":true,"settings":[{"key":"a","type":"boolean"},{"nokey":1}],
       "settingGroups":[{"id":"engine","label":"Engine","ready":true}],"missing":[{"key":"k","needs":"A key","fix":"Add one"}]}
    """)
    assertEquals(listOf("a"), p.settings.map { it.key })
    assertEquals("Engine", p.settingGroups.single().label)
    assertEquals("A key", p.missing.single().needs)

    val c = MercuryJson.decodeFromString(ChannelInfo.serializer(), """
      {"type":"telegram","label":"Telegram","enabled":true,"configured":true,"running":false,
       "settings":{"botToken":"123••••","hasBotToken":true,"chatId":42},
       "access":{"admins":[{"id":"1","name":"Sal"}],"members":[],"pending":[{"id":"2","name":"Ana","code":"ABC"}]}}
    """)
    assertEquals("123••••", c.settings["botToken"].settingText)
    assertEquals("42", c.settings["chatId"].settingText)
    assertEquals("ABC", c.access.pending.single().code)

    val b = MercuryJson.decodeFromString(BudgetState.serializer(), """
      {"daily":{"budget":2000000,"used":1500000,"remaining":500000,"percentage":75},
       "saver":{"state":"on","autoEnabled":true,"autoThreshold":90,"savedToday":1200,"savedLifetime":3400000},
       "bots":{"enabled":true,"perBot":100000,"fleet":1000000}}
    """)
    assertEquals(75.0, b.daily.percentage, 0.0)
    assertEquals(90, b.saver.autoThreshold)
    assertEquals(1_000_000L, b.bots.fleet)

    val d = MercuryJson.decodeFromString(PairedDevices.serializer(), """
      {"devices":[{"id":"ab12cd34","name":"Pixel","platform":"android","createdAt":"2026-11-10T07:00:00.000Z","lastSeenAt":null},
                  {"id":"ef56","name":"Mac","platform":"darwin","createdAt":1762758000000,"lastSeenAt":"2026-11-12T08:00:00Z"}],
       "current":"ab12cd34"}
    """)
    assertEquals("ab12cd34", d.current)
    assertNull(d.devices[0].lastSeenAt)
    assertEquals(java.time.Instant.parse("2026-11-10T07:00:00Z"), d.devices[0].createdAt)
    assertEquals(1762758000000L, d.devices[1].createdAt!!.toEpochMilli())
  }

  @Test fun aGatedChangeAsksTheOwnerThenCarriesTheApproval() = runBlocking {
    server.enqueue(json(428, """{"error":"Waiting for the owner to approve: Revoke a device.","approvalRequired":true,"approvalId":"ap1","code":"K7Q2M","where":"Telegram or this computer"}"""))
    server.enqueue(json(200, """{"status":"allowed"}"""))
    server.enqueue(json(200, """{"success":true}"""))
    val c = MercuryClient(base, "t")
    try {
      c.revokeDevice("d2")
      fail("expected the owner's question")
    } catch (e: MercuryException.NeedsOwner) {
      assertEquals(OwnerQuestion("ap1", "K7Q2M", "Telegram or this computer", "Waiting for the owner to approve: Revoke a device."), e.question)
    }
    val first = server.takeRequest()
    assertEquals("DELETE", first.method)
    assertEquals("/api/auth/devices/d2", first.path)
    assertNull(first.getHeader(APPROVAL_HEADER))

    assertEquals(ApprovalStatus.ALLOWED, c.approvalStatus("ap1"))
    assertEquals("/api/security/approvals/ap1/status", server.takeRequest().path)

    c.revokeDevice("d2", approval = "ap1")
    assertEquals("ap1", server.takeRequest().getHeader("X-Mercury-Approval"))
  }

  @Test fun gatedRequestsKeepTheirBodyAndToken() {
    val c = MercuryClient("http://mercury.test", "t")
    val r = c.gated("PUT", "/api/budget", buildJsonObject { put("dailyBudget", 1_000_000) }, "ap9")
    assertEquals("ap9", r.header("X-Mercury-Approval"))
    assertEquals("Bearer t", r.header("Authorization"))
    assertEquals("application/json", r.header("Content-Type"))
    assertNull(c.gated("GET", "/api/budget").header("X-Mercury-Approval"))
  }

  @Test fun unreadableApprovalStatusCountsAsExpired() = runBlocking {
    server.enqueue(json(404, """{"error":"gone"}"""))
    assertEquals(ApprovalStatus.EXPIRED, MercuryClient(base, "t").approvalStatus("x"))
  }

  @Test fun setModelRolesWritesNullForSameAsChat() = runBlocking {
    server.enqueue(json(200, """{"success":true}"""))
    MercuryClient(base, "t").setModelRoles(defaultProvider = "openai", model = "gpt-5", learning = RoleChoice(null), crew = RoleChoice("ollama"))
    val body = server.takeRequest().body.readUtf8()
    assertEquals("""{"default":{"provider":"openai","model":"gpt-5"},"learning":null,"crew":"ollama"}""", body)
  }

  @Test fun missingPluginIsNull() = runBlocking {
    server.enqueue(json(404, """{"error":"Not installed"}"""))
    assertNull(MercuryClient(base, "t").plugin("optimus"))
  }
}
