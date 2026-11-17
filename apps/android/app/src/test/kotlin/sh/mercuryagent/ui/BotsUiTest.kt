package sh.mercuryagent.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.mercuryagent.core.BotFleet
import sh.mercuryagent.core.BotStatus
import sh.mercuryagent.ui.bots.BotsUi
import sh.mercuryagent.ui.bots.fleetLine
import sh.mercuryagent.ui.bots.line
import sh.mercuryagent.ui.bots.plainInline

/** The roster's words, as iOS's BotsList says them. */
class BotsUiTest {
  @Test fun aBotsLineSaysWhatItIsDoing() {
    assertEquals("Waiting for you", line(BotStatus("a", "A", state = "running", needsYou = true), "ls"))
    assertEquals("Working · web_fetch x", line(BotStatus("a", "A", state = "running"), "web_fetch x"))
    assertEquals("Working · from roster", line(BotStatus("a", "A", state = "running", activity = "from roster"), null))
    assertEquals("Off", line(BotStatus("a", "A", enabled = false), null))
    assertEquals("Stopped", line(BotStatus("a", "A", stopped = true), null))
    assertEquals("Sorts mail", line(BotStatus("a", "A", description = "Sorts mail"), null))
    assertEquals("Idle", line(BotStatus("a", "A", description = ""), null))
  }

  @Test fun aFleetsLineCountsItsCrew() {
    val f = BotFleet(
      BotStatus("m", "Manager", fleetRole = "lead"),
      listOf(BotStatus("w", "Writer", state = "running"), BotStatus("d", "Deployer", needsYou = true)),
    )
    assertEquals("Fleet · 2 crew · 1 working · waiting for you", fleetLine(f))
  }

  @Test fun membersAreTheFleetOrTheBot() {
    val ui = BotsUi(bots = listOf(
      BotStatus("m", "Manager", fleetRole = "lead"), BotStatus("w", "Writer", fleetRole = "crew", parent = "m"), BotStatus("a", "Analyst"),
    ))
    assertEquals(listOf("m", "w"), ui.members("m").map { it.id })
    assertEquals(listOf("w"), ui.members("w").map { it.id })
    assertEquals(emptyList<String>(), ui.members("gone").map { it.id })
  }

  @Test fun previewsDropInlineMarks() {
    assertEquals("Below your $95 limit, see docs", plainInline("Below your **\$95** limit, see [docs](https://x.y)"))
  }
}
