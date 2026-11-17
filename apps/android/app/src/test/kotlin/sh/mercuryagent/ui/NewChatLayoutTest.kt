package sh.mercuryagent.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.ui.conversation.NewChatLayout
import sh.mercuryagent.ui.conversation.Welcome

/**
 * A new chat with the keyboard up: the mark and greeting go, the chips stay just above the composer
 * as many as fit, and nothing overlaps at any height, down to a 640 dp phone. And the bar reads
 * Ask | Code.
 */
class NewChatLayoutTest {
  private val chip = 46f

  @Test fun theBarReadsAskAndCode() {
    assertEquals("Ask", Welcome.ASK)
    assertEquals("Code", Welcome.CODE)
  }

  @Test fun roomyKeyboardDownShowsEverything() {
    assertEquals(NewChatLayout(hello = true, chips = 5), NewChatLayout.of(560f, 5, chip, typing = false))
  }

  @Test fun typingHidesTheMarkAndKeepsTheChips() {
    val l = NewChatLayout.of(560f, 5, chip, typing = true)
    assertFalse(l.hello)
    assertEquals(5, l.chips)
  }

  @Test fun neverOverlapsAtAnyHeight() {
    for (typing in listOf(false, true)) for (h in 0..900) for (c in listOf(44f, 46f, 60f)) {
      val l = NewChatLayout.of(h.toFloat(), 5, c, typing)
      val used = NewChatLayout.chipsHeight(l.chips, c) + l.helloHeight
      assertTrue("height $h chip $c: $l", used <= h)
      if (typing) assertFalse(l.hello)
    }
  }

  @Test fun smallPhoneWithTheKeyboardKeepsSomeChips() {
    // 640 dp − 24 status − 60 bar − 120 composer − 260 keyboard ≈ 176 dp between the bar and the box.
    val l = NewChatLayout.of(176f, 5, chip, typing = true)
    assertEquals(3, l.chips)
    assertFalse(l.hello)
    // Keyboard down on the same phone: ≈ 390 dp, all five chips and a smaller mark.
    assertEquals(NewChatLayout(hello = true, chips = 5, compact = true), NewChatLayout.of(390f, 5, chip, typing = false))
  }
}
