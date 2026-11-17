package sh.mercuryagent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SseParserTest {
  private fun parse(text: String): Pair<List<ServerEvent>, SseParser> {
    val p = SseParser()
    return text.split("\n").mapNotNull { p.feed(it.removeSuffix("\r")) } to p
  }

  @Test fun mercuryFrames() {
    val (events, p) = parse(
      "event: connected\ndata: {\"id\":\"c1\"}\n\n: keepalive\n\nevent: text_delta\nid: 7\ndata: {\"text\":\"Hi\"}\n\ndata: plain\n\n",
    )
    assertEquals(listOf("connected", "text_delta", "message"), events.map { it.name })
    assertEquals("{\"text\":\"Hi\"}", events[1].data)
    assertEquals("7", events[1].id)
    assertEquals("7", p.lastId)
  }

  @Test fun multiLineDataAndNoSpace() {
    val (events, _) = parse("event:x\ndata:a\ndata: b\n\n")
    assertEquals("x", events.single().name)
    assertEquals("a\nb", events.single().data)
  }

  @Test fun eventWithoutDataIsDropped() {
    val (events, _) = parse("event: ping\n\nevent: x\ndata: 1\n\n")
    assertEquals(listOf("x"), events.map { it.name })
  }

  @Test fun unfinishedEventAtResetIsDropped() {
    val p = SseParser()
    assertNull(p.feed("event: a"))
    assertNull(p.feed("data: 1"))
    p.reset()
    assertNull(p.feed(""))
  }
}
