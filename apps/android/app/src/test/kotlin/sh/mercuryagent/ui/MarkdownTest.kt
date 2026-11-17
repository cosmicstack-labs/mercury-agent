package sh.mercuryagent.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.ui.conversation.Markdown
import sh.mercuryagent.ui.conversation.Markdown.Block
import sh.mercuryagent.ui.conversation.Markdown.Style

class MarkdownTest {
  @Test fun blocks() {
    val b = Markdown.parse(
      """
      # Title
      Some **bold** and *it* text.

      - one
      - [x] two
        - nested
      1. first
      2. second

      > [!WARNING]
      > Careful

      ```kotlin
      val x = 1
      ```

      | A | B |
      |:--|--:|
      | 1 | `2` |

      ---
      """.trimIndent(),
    )
    assertEquals(
      listOf(Block.Heading::class, Block.Paragraph::class, Block.ListBlock::class, Block.ListBlock::class, Block.Quote::class,
        Block.Code::class, Block.Table::class, Block.Rule::class),
      b.map { it::class },
    )
    val list = b[2] as Block.ListBlock
    assertEquals(2, list.items.size)
    assertEquals(true, list.items[1].done)
    assertTrue(list.items[1].blocks.any { it is Block.ListBlock })
    val ordered = b[3] as Block.ListBlock
    assertTrue(ordered.ordered)
    assertEquals("warning", (b[4] as Block.Quote).alert)
    assertEquals(Block.Code("kotlin", "val x = 1"), b[5])
    val table = b[6] as Block.Table
    assertEquals(listOf(Markdown.Align.Start, Markdown.Align.End), table.align)
    assertEquals("2", table.rows[0][1].text)
  }

  @Test fun unclosedFenceWhileStreaming() {
    val b = Markdown.parse("Look:\n```\nline 1\nline 2")
    assertEquals(Block.Code(null, "line 1\nline 2"), b[1])
  }

  @Test fun inlineStyles() {
    val i = Markdown.inline("A **bold _it_** `co*de*` ~~gone~~ [link](https://x.dev) and https://y.dev/a. snake_case_name")
    assertEquals("A bold it co*de* gone link and https://y.dev/a. snake_case_name", i.text)
    fun spanOf(style: Style) = i.spans.filter { it.style == style }.map { i.text.substring(it.start, it.end) }
    assertEquals(listOf("bold it"), spanOf(Style.Bold))
    assertEquals(listOf("it"), spanOf(Style.Italic))
    assertEquals(listOf("co*de*"), spanOf(Style.Code))
    assertEquals(listOf("gone"), spanOf(Style.Strike))
    assertEquals(listOf("link", "https://y.dev/a"), spanOf(Style.Link))
    assertEquals("https://x.dev", i.spans.first { it.style == Style.Link }.url)
  }

  @Test fun unmatchedDelimitersStayText() {
    assertEquals("2 * 3 = 6 and **open", Markdown.inline("2 * 3 = 6 and **open").text)
    assertTrue(Markdown.inline("2 * 3 = 6 and **open").spans.isEmpty())
    assertEquals("a*b", Markdown.inline("a\\*b").text)
  }
}
