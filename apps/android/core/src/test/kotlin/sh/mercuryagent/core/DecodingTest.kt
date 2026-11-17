package sh.mercuryagent.core

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DecodingTest {
  @Test fun threadListRowWithPreviewAndNoMessages() {
    val t = MercuryJson.decodeFromString(ChatThread.serializer(), """
      {"id":"s1","shortId":"x","alias":"brave-otter","title":"New session","voiceCall":false,
       "savedAt":"2026-11-10T08:00:00.000Z","createdAt":"2026-11-10T07:00:00.000Z","updatedAt":"2026-11-10T09:30:00.123Z",
       "preview":"  Hi there  ","lastRole":"user"}
    """)
    assertEquals("New chat", t.displayTitle)
    assertEquals("You: Hi there", t.previewLine)
    assertEquals(Instant.parse("2026-11-10T09:30:00.123Z"), t.lastActivity)
    assertTrue(t.messages.isEmpty())
  }

  @Test fun previewFromAssistantHasNoPrefix() {
    val t = ChatThread(id = "a", createdAt = Instant.EPOCH, preview = "Done.", lastRole = "assistant")
    assertEquals("Done.", t.previewLine)
    assertNull(ChatThread(id = "b", createdAt = Instant.EPOCH, preview = "  ").previewLine)
  }

  @Test fun oddMessageNeverFailsTheThread() {
    val t = MercuryJson.decodeFromString(ChatThread.serializer(), """
      {"id":"s1","title":"Trip","createdAt":"2026-11-10T07:00:00Z","messages":[
        {"id":"m1","role":"user","content":"hello","timestamp":"2026-11-10T07:00:01.000Z"},
        {"id":"m2","role":"assistant","content":"hi","timestamp":"not a date"},
        {"id":"m3","role":"assistant","kind":"message","content":"**hey**","timestamp":"2026-11-10T07:00:03.000Z",
         "usage":{"inputTokens":20765,"cachedInputTokens":18649,"outputTokens":16,"steps":6,"elapsedMs":12400},
         "trace":{"startedAt":1,"endedAt":2,"items":[{"kind":"reasoning","text":"hm"},5,{"kind":"tool","id":"t1","title":"Read x"}]},
         "artifacts":[{"id":"a1","name":"x.png","mime":"image/png"},{"bad":true}],
         "attachments":[{"name":"f.pdf","kind":"pdf","url":"/api/chat/uploads/r"}]},
        {"id":"m4","role":"tool","content":"{}","timestamp":"2026-11-10T07:00:04.000Z"}
      ]}
    """)
    assertEquals(listOf("m1", "m3", "m4"), t.messages.map { it.id })
    val m3 = t.messages[1]
    assertEquals("21k tokens · 90% cached · 6 steps · 12s", m3.usage!!.short)
    assertEquals(listOf("20,765 in (18,649 from cache) · 16 out"), m3.usage!!.detail)
    assertEquals(2, m3.storedTrace!!.items.size)
    assertEquals(listOf("a1"), m3.artifacts.map { it.id })
    assertEquals(1, m3.attachments.size)
    assertTrue(m3.isShown)
    assertTrue(!t.messages[2].isShown)
  }

  @Test fun usageWithoutTokensIsNone() {
    assertNull(ReplyUsage.from(MercuryJson.parseToJsonElement("""{"steps":2}""")))
  }

  @Test fun compactNumbers() {
    assertEquals("950", ReplyUsage.compact(950))
    assertEquals("1.5k", ReplyUsage.compact(1500))
    assertEquals("2k", ReplyUsage.compact(2000))
    assertEquals("14k", ReplyUsage.compact(14_200))
    assertEquals("1.3M", ReplyUsage.compact(1_250_000))
  }

  @Test fun turnsAndActivity() {
    val t = MercuryJson.decodeFromString(TurnsInfo.serializer(), """{"running":[{"sessionId":"a","activity":"x"}],"waiting":[{"channelId":"b","position":2}],"max":2}""")
    assertEquals("a", t.running[0].sessionId)
    assertEquals(2, t.waiting[0].position)
    val a = MercuryJson.decodeFromString(ActivityEvent.serializer(), """{"kind":"needs_you","sessionId":"s","prompt":"Run a command"}""")
    assertEquals("needs_you", a.kind)
  }

  @Test fun datesInEveryShape() {
    assertEquals(Instant.parse("2026-01-01T00:00:00Z"), MercuryJson.parseToJsonElement("\"2026-01-01T00:00:00Z\"").asInstant())
    assertEquals(Instant.ofEpochMilli(1_700_000_000_000), MercuryJson.parseToJsonElement("1700000000000").asInstant())
    assertEquals(Instant.ofEpochSecond(1_700_000_000), MercuryJson.parseToJsonElement("1700000000").asInstant())
    assertEquals(Instant.parse("2026-01-01T00:00:00Z"), parseInstant("2026-01-01T01:00:00+01:00"))
  }
}
