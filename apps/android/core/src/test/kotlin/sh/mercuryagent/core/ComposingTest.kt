package sh.mercuryagent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposingTest {
  @Test fun filesAreSniffedAndLimited() {
    val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0, 0)
    assertEquals("image/png", OutgoingAttachment.make("x.bin", png).getOrThrow().mime)
    assertEquals("IMG", OutgoingAttachment.make("x.bin", png).getOrThrow().tag)
    assertEquals("application/pdf", OutgoingAttachment.make("r", byteArrayOf(0x25, 0x50, 0x44, 0x46)).getOrThrow().mime)
    assertEquals("text/markdown", OutgoingAttachment.make("n.md", "# hi".toByteArray()).getOrThrow().mime)
    assertEquals("TXT", OutgoingAttachment.make("n.txt", "hi".toByteArray()).getOrThrow().tag)
    assertTrue(OutgoingAttachment.make("a.docx", byteArrayOf(1, 2)).exceptionOrNull() is AttachmentProblem.Unsupported)
    assertTrue(OutgoingAttachment.make("a.txt", ByteArray(OutgoingAttachment.MAX_TEXT_BYTES + 1) { 'a'.code.toByte() }).exceptionOrNull() is AttachmentProblem.TooLarge)
    assertTrue(OutgoingAttachment.make("a.txt", byteArrayOf(0xC3.toByte(), 0x28)).exceptionOrNull() is AttachmentProblem.NotText)
    val webp = "RIFF0000WEBP".toByteArray()
    assertEquals("image/webp", OutgoingAttachment.sniffImage(webp))
    assertEquals("x.txt is too large (the limit is 262 KB).", AttachmentProblem.TooLarge("x.txt", OutgoingAttachment.MAX_TEXT_BYTES).message)
  }

  @Test fun mediaLabels() {
    assertEquals("Image 3:2", MediaIntent("image", "landscape").label)
    assertEquals("Video 9:16", MediaIntent("video", "portrait").label)
    assertEquals("Image 1:1", MediaIntent("image", "square").label)
    assertEquals("Music", MediaIntent("music", "square").label)
    assertEquals("""{"kind":"video","aspect":"landscape"}""", MediaIntent("video", "landscape").toJson().toString())
  }

  @Test fun mediaAvailability() {
    val j = parseObject("""{"image":{"models":[{"ref":"a","label":"GPT Image 2"}],"default":{"ref":"a","available":true}},
      "video":{"models":[],"auto":{"label":"Veo"}},"music":{"models":[{"ref":"m"}],"auto":{"label":"Lyria"}}}""")
    val a = MediaAvailability.from(j)
    assertTrue(a.image); assertFalse(a.video); assertTrue(a.music)
    assertEquals(mapOf("image" to "GPT Image 2", "video" to "Veo", "music" to "Lyria"), a.using)
    assertFalse(MediaAvailability.from(parseObject("{}")).any)
  }

  @Test fun effortsAndModels() {
    assertEquals("Extra high", ChatEffort.label("xhigh"))
    assertEquals("The model decides", ChatEffort.hint("auto"))
    val m = MercuryJson.decodeFromString(ChatModelInfo.serializer(), """{"name":"a","model":"m","reasoning":"high"}""")
    assertEquals(ChatEffort("high", "model", "high", null), m.currentEffort)
    assertEquals(ChatEffort("low", "chat", "high", "low"), ChatEffort.withPending(m.currentEffort, "low"))
  }

  @Test fun suggestionsDropEmptyOnes() {
    val p = SuggestionPick.from(parseObject("""{"greeting":"","subtitle":"Busy week","items":[{"id":"1","title":"Plan","prompt":"Plan my week"},{"id":"2","title":"","prompt":"x"},{"bad":true}]}"""))
    assertEquals(null, p.greeting)
    assertEquals("Busy week", p.subtitle)
    assertEquals(listOf("1"), p.items.map { it.id })
  }

  @Test fun fileSizes() {
    assertEquals("512 bytes", fileSize(512))
    assertEquals("38 KB", fileSize(38_000))
    assertEquals("4.2 MB", fileSize(4_200_000))
  }
}
