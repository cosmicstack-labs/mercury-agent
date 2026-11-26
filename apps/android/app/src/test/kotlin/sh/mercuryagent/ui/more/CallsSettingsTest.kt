package sh.mercuryagent.ui.more

import org.junit.Assert.assertEquals
import org.junit.Test

class CallsSettingsTest {
  @Test fun quietHoursTimes() {
    assertEquals(7 to 5, parseHhmm("07:05"))
    assertEquals("23:30", formatHhmm(23, 30))
    assertEquals(0 to 0, parseHhmm("junk"))
  }
}
