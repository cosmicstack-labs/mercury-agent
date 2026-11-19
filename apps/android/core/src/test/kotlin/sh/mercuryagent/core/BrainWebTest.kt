package sh.mercuryagent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Ported from Mercury Desktop: NoteWeb.test.ts (toWeb), MindMap.tsx's themeColors and
// NoteHoverCard.test.ts (shortLabel). Expected values come from running the desktop's own code;
// iOS's BrainWebTests.swift checks the same cases.
class BrainWebTest {
  private val map = BrainMap(
    themes = listOf(
      BrainMap.Theme("t1", "Garden", parent = null, size = 3),
      BrainMap.Theme("t2", "Rust", parent = null, size = 2),
      BrainMap.Theme("t2.a", "Cargo", parent = "t2", size = 2),
      BrainMap.Theme("loose", "Loose notes", parent = null, size = 1),
    ),
    placement = mapOf("a" to "t1", "b" to "t1", "c" to "t1", "r1" to "t2.a", "r2" to "t2.a", "x" to "loose"),
    links = listOf(BrainMap.Link("a", "b", 0.5), BrainMap.Link("b", "c", 0.4), BrainMap.Link("r1", "r2", 0.3), BrainMap.Link("c", "r1", 0.2)),
    notes = listOf("a", "b", "c", "r1", "r2", "x").map { BrainMap.Note(it, "note $it", "fact", 0.0, 0.8, false) },
  )
  private val base = WebOptions()

  @Test fun everyNoteIsADotEveryLinkALineSizedByConnections() {
    val w = BrainWeb.toWeb(map, base)
    assertEquals(6, w.nodes.size)
    assertEquals(4, w.links.size)
    assertEquals(2, w.nodes.first { it.id == "b" }.degree)
    assertEquals(0, w.nodes.first { it.id == "x" }.degree)
  }

  @Test fun coloursASubThemeNoteWithItsTopTheme() {
    val w = BrainWeb.toWeb(map, base)
    fun color(id: String) = w.nodes.first { it.id == id }.color
    assertEquals(color("r1"), color("r2"))
    assertNotEquals(color("a"), color("r1"))
  }

  @Test fun hidesOrphansHiddenGroupsAndNonMatchingNotes() {
    assertFalse(BrainWeb.toWeb(map, base.copy(orphans = false)).nodes.any { it.id == "x" })
    val noRust = BrainWeb.toWeb(map, base.copy(hidden = setOf("t2")))
    assertEquals(listOf("a", "b", "c", "x"), noRust.nodes.map { it.id }.sorted())
    assertEquals(2, noRust.links.size)
    assertEquals(2, BrainWeb.toWeb(map, base.copy(query = "note r")).nodes.size)
  }

  @Test fun localGraphKeepsANoteAndItsNeighboursToTheChosenDepth() {
    assertEquals(listOf("a", "b"), BrainWeb.toWeb(map, base.copy(local = LocalGraph("a", 1))).nodes.map { it.id }.sorted())
    assertEquals(listOf("a", "b", "c", "r1"), BrainWeb.toWeb(map, base.copy(local = LocalGraph("a", 3))).nodes.map { it.id }.sorted())
  }

  /** The desktop's exact output: order (hubs first, stable), colours, degrees and links. */
  @Test fun matchesTheDesktopsOutputExactly() {
    val w = BrainWeb.toWeb(map, base)
    assertEquals(listOf("b", "c", "r1", "a", "r2", "x"), w.nodes.map { it.id })
    assertEquals(listOf("#4F9AA8", "#4F9AA8", "#D08A2E", "#4F9AA8", "#D08A2E", "#8A97A3"), w.nodes.map { it.color })
    assertEquals(listOf(2, 2, 2, 1, 1, 0), w.nodes.map { it.degree })
    assertEquals(listOf("a" to "b", "b" to "c", "r1" to "r2", "c" to "r1"), w.linkIds)
  }

  @Test fun decodesTheMapEndpoint() {
    val json = """{"themes":[{"id":"t1","label":"Garden","terms":["tomato"],"parent":null,"size":3}],"placement":{"a":"t1"},"links":[{"a":"a","b":"b","w":0.5}],"notes":[{"id":"a","text":"note a","kind":"fact","at":1,"confidence":0.8,"archived":false}],"stats":{"notes":1,"links":1,"themes":1,"ms":1},"available":true}"""
    val m = MercuryJson.decodeFromString(BrainMap.serializer(), json)
    assertEquals(null, m.themes.first().parent)
    assertEquals("note a", m.notes.first().text)
    assertEquals(0.5, m.links.first().w, 0.0)
  }

  /** [id, FNV-1a hash, colour] from the desktop's hash/themeColors over the same list. */
  private val colours = listOf(
    Triple("t1", 138734806L, "#4F9AA8"), Triple("t2", 121957187L, "#D08A2E"), Triple("t3", 105179568L, "#5B8DEF"), Triple("t4", 222622901L, "#E8894A"),
    Triple("t5", 205845282L, "#2BB5C9"), Triple("t6", 189067663L, "#C9644F"), Triple("t7", 172290044L, "#7AA33B"), Triple("t8", 289733377L, "#E0739B"),
    Triple("t9", 272955758L, "#3FB37F"), Triple("t10", 3934318098L, "#B565C9"), Triple("t11", 3951095717L, "#D4A72C"), Triple("t12", 3900762860L, "#9B7BD8"),
    Triple("t13", 3917540479L, "#C9644F"), Triple("t14", 3867207622L, "#4F9AA8"), Triple("loose", 2377178881L, "#8A97A3"), Triple("c0", 2267668038L, "#2BB5C9"),
    Triple("c1", 2284445657L, "#E8894A"), Triple("c2", 2234112800L, "#7AA33B"), Triple("theme-ünïcode", 2560135821L, "#B565C9"), Triple("日本", 1610399396L, "#D08A2E"),
  )

  @Test fun hashesLikeTheDesktop() { for ((id, h, _) in colours) assertEquals(id, h, BrainWeb.hash(id)) }

  @Test fun coloursLikeTheDesktopSkippingClashesAndWrappingAfterTwelve() {
    val c = BrainWeb.themeColors(colours.map { it.first })
    for ((id, _, want) in colours) assertEquals(id, want, c[id])
  }

  @Test fun leavesShortNotesAloneAndDropsTheFullStop() = assertEquals("Married to Heer", BrainWeb.shortLabel("Married to Heer."))
  @Test fun endsAtTheFirstClauseWhenShortEnough() =
    assertEquals("Lives in Srinagar…", BrainWeb.shortLabel("Lives in Srinagar, works on Mercury at Cosmic Stack every evening"))
  @Test fun otherwiseCutsAtAWholeWord() {
    val out = BrainWeb.shortLabel("Prefers Mercury to communicate in Urdu and not switch languages without asking")
    assertEquals("Prefers Mercury to communicate…", out)
    assertTrue(out.length <= 32)
  }
  @Test fun cutsOneVeryLongWordHard() = assertEquals(32, BrainWeb.shortLabel("a".repeat(60)).length)
  @Test fun doesntEndOnDanglingPunctuation() =
    assertEquals("Uses Tauri for the desktop app…", BrainWeb.shortLabel("Uses Tauri for the desktop app (Rust shell) — React UI and more after that"))

  /** More cases, expected values from the desktop's function. */
  @Test fun matchesTheDesktopOnMoreCases() {
    val cases = listOf(
      "  Multiple   spaces\n\tand newlines in a fairly long note text here.  " to "Multiple spaces and newlines…",
      "Short one。。" to "Short one",
      "Works at Cosmic Stack - a small studio building agents for people" to "Works at Cosmic Stack…",
      "The quick brown fox jumps over the lazy dog again and again" to "The quick brown fox jumps over…",
      "Likes: tea, coffee, and long walks in the evening by the river" to "Likes: tea, coffee…",
      "Abcdefghijklmnopqrstuvwxyzabcdefghij klm" to "Abcdefghijklmnopqrstuvwxyzabcde…",
      "Has a dog named Sheru 🐕 who loves long walks in the park" to "Has a dog named Sheru 🐕 who…",
      "Exactly thirty-two characters!!" to "Exactly thirty-two characters!!",
      "Ends with dash right at the cut — and continues on" to "Ends with dash right at the cut…",
    )
    for ((text, want) in cases) assertEquals(text, want, BrainWeb.shortLabel(text))
  }

  @Test fun settingsDefaultsMatchTheDesktopAndStoredFieldsOverrideThem() {
    val d = WebSettings.DEFAULTS
    assertTrue(d.orphans && d.nodeSize == 1.0 && d.linkWidth == 1.0 && d.textFade == 1.6)
    assertTrue(d.center == 0.06 && d.repel == 40.0 && d.linkForce == 0.5 && d.linkDistance == 34.0 && d.hidden.isEmpty())
    val s = WebSettings.decode("""{"repel":80,"hidden":["t2"]}""")
    assertTrue(s.repel == 80.0 && s.hidden == listOf("t2") && s.linkDistance == 34.0)
    assertEquals(s, WebSettings.decode(s.encode()))
    assertEquals(WebSettings.DEFAULTS, WebSettings.decode("not json"))
  }

  @Test fun labelFadeAndLinkAlphaFollowTheDesktop() {
    assertEquals(1.0, BrainWeb.labelAlpha(1.0, 0, 1.6, true), 0.0)
    assertEquals(0.0, BrainWeb.labelAlpha(1.0, 0, 1.6, false), 0.0)
    assertEquals(0.5, BrainWeb.labelAlpha(2.0, 0, 1.6, false), 1e-12)
    assertEquals(1.0, BrainWeb.labelAlpha(3.0, 8, 1.6, false), 0.0)
    assertEquals(0.3, BrainWeb.linkAlpha(0.5, false), 1e-12)
    assertEquals(0.35, BrainWeb.linkAlpha(0.9, false), 1e-12)
    assertEquals(0.05, BrainWeb.linkAlpha(0.9, true), 0.0)
    assertEquals(2.2 + 2 * 1.15, BrainWeb.radius(4, 1.0), 1e-12)
  }
}
