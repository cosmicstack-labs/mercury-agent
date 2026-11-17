package sh.mercuryagent.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sh.mercuryagent.core.BrainMap
import sh.mercuryagent.core.BrainWeb
import sh.mercuryagent.core.LocalGraph
import sh.mercuryagent.core.WebSettings
import sh.mercuryagent.ui.brain.MapView
import sh.mercuryagent.ui.brain.MindMapPins
import sh.mercuryagent.ui.brain.MindMapViewModel
import sh.mercuryagent.ui.brain.formatSetting

/** Brain → Mind map's behaviour, as iOS's MindMapTests checks it. */
@OptIn(ExperimentalCoroutinesApi::class)
class MindMapViewModelTest {
  private val main = UnconfinedTestDispatcher()

  @Before fun setUp() = Dispatchers.setMain(main)
  @After fun tearDown() = Dispatchers.resetMain()

  /** Three themes: a family hub with spokes, a work chain, a loose note. */
  private val map = BrainMap(
    themes = listOf(BrainMap.Theme("c0", "Family", size = 6), BrainMap.Theme("c1", "Work", size = 5), BrainMap.Theme("loose", "Loose notes", size = 1)),
    placement = (0 until 6).associate { "f$it" to "c0" } + (0 until 5).associate { "w$it" to "c1" } + mapOf("x" to "loose"),
    links = (1 until 6).map { BrainMap.Link("f0", "f$it", 0.5) } + (1 until 5).map { BrainMap.Link("w${it - 1}", "w$it", 0.3) } + BrainMap.Link("f1", "w0", 0.2),
    notes = listOf("Married to Heer", "Heer is a doctor", "Has a dog named Sheru", "Visits his parents every Sunday", "Heer's birthday is in March", "Brother studies in Delhi")
      .mapIndexed { i, t -> BrainMap.Note("f$i", t, "relationship") } +
      (0 until 5).map { BrainMap.Note("w$it", "Work note $it", "project") } + BrainMap.Note("x", "Likes green", "preference"),
  )

  private var saved: WebSettings? = null

  private fun vm(seed: Long = 3): MindMapViewModel {
    MindMapPins.byScope.remove("test-$seed")
    val m = MindMapViewModel(null, WebSettings.DEFAULTS, { saved = it }, "test-$seed", CoroutineScope(SupervisorJob() + main))
    m.show(map, seed, 390.0, 763.0)
    return m
  }

  private fun screen(m: MindMapViewModel, i: Int): Pair<Double, Double> {
    m.engine.pull()
    val f = m.engine.front
    return m.view.toScreenX(f.xs[i].toDouble(), m.width) to m.view.toScreenY(f.ys[i].toDouble(), m.height)
  }

  @Test fun tapOnADotSelectsItAndTheBackgroundClears() {
    val m = vm()
    val (x, y) = screen(m, 0)
    m.tap(x, y)
    assertEquals(m.graph.nodes[0].id, m.selected)
    assertTrue(m.showDetail)
    assertEquals(0, m.hoverIndex)
    m.tap(2.0, 2.0)
    assertNull(m.selected)
    assertFalse(m.showDetail)
  }

  @Test fun filterLocalAndGroupsRebuildTheWeb() {
    val m = vm()
    val all = m.graph.nodes.size
    m.filter("heer")
    assertEquals(3, m.graph.nodes.size)
    m.filter("")
    assertEquals(all, m.graph.nodes.size)
    m.showLocal(LocalGraph("f0", 1))
    assertEquals(6, m.graph.nodes.size)
    m.showLocal(null)
    m.toggleGroup("c1")
    assertFalse(m.graph.nodes.any { it.theme == "c1" })
    m.toggleGroup("c1")
    assertEquals(all, m.graph.nodes.size)
  }

  @Test fun holdingAndDraggingADotPinsItForTheSession() {
    val m = vm()
    val i = 3
    val id = m.graph.nodes[i].id
    val (x, y) = screen(m, i)
    m.dragBegan(i, x, y)
    assertTrue(i in m.pinned) // the amber dot shows while dragging, as fx is set
    m.dragMoved(x + 40, y + 30)
    m.dragEnded()
    assertNotNull(m.pins[id])
    val pin = m.pins[id]!!
    val gx = m.view.toGraphX(x, m.width); val gy = m.view.toGraphY(y, m.height)
    assertEquals(Math.round(gx + 40 / m.view.k).toDouble(), pin.first, 1.0)
    assertEquals(Math.round(gy + 30 / m.view.k).toDouble(), pin.second, 1.0)
    // A rebuild (a filter) keeps the pin: the dot comes back where it was put.
    m.filter("a"); m.filter("")
    assertTrue(m.index[id]!! in m.pinned)
    m.resetLayout()
    assertTrue(m.pins.isEmpty() && m.pinned.isEmpty())
  }

  @Test fun holdingWithoutMovingIsATap() {
    val m = vm()
    val (x, y) = screen(m, 2)
    m.dragBegan(2, x, y)
    m.dragEnded()
    assertEquals(m.graph.nodes[2].id, m.selected)
    assertTrue(m.pins.isEmpty())
  }

  @Test fun pinchKeepsThePointUnderTheFingers() {
    val m = vm()
    val gx = m.view.toGraphX(120.0, m.width); val gy = m.view.toGraphY(300.0, m.height)
    m.pinch(120.0, 300.0, 2.5, 0.0, 0.0)
    assertEquals(120.0, m.view.toScreenX(gx, m.width), 1e-9)
    assertEquals(300.0, m.view.toScreenY(gy, m.height), 1e-9)
    m.pinch(120.0, 300.0, 1000.0, 0.0, 0.0)
    assertEquals(MapView.MAX_ZOOM, m.view.k, 0.0)
  }

  @Test fun settingsSaveAndRestoreDefaultsKeepsHiddenGroups() {
    val m = vm(11)
    m.updateSettings { it.copy(repel = 80.0) }
    m.toggleGroup("c1")
    assertEquals(80.0, saved!!.repel, 0.0)
    assertEquals(listOf("c1"), saved!!.hidden)
    m.restoreDefaults()
    assertEquals(40.0, m.settings.repel, 0.0)
    assertEquals(listOf("c1"), m.settings.hidden)
    assertEquals("0.06", formatSetting(0.06)); assertEquals("40", formatSetting(40.0)); assertEquals("1.6", formatSetting(1.6))
  }

  @Test fun theNotePanelKnowsKindThemeAndLinks() {
    val m = vm()
    assertEquals("Family" to BrainWeb.themeColors(listOf("c0", "c1", "loose"))["c0"]!!, m.theme("f0"))
    assertEquals(5, BrainWeb.related(m.data!!, "f0").size)
    assertEquals("Relationship", BrainWeb.KIND_LABEL[m.note("f0")!!.kind])
  }
}
