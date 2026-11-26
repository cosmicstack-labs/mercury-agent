package sh.mercuryagent.ui.brain

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.mercuryagent.core.BrainMap
import sh.mercuryagent.core.BrainMemory
import sh.mercuryagent.core.BrainWeb
import sh.mercuryagent.core.HitGrid
import sh.mercuryagent.core.LocalGraph
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.SeededRandom
import sh.mercuryagent.core.WebGraph
import sh.mercuryagent.core.WebOptions
import sh.mercuryagent.core.WebSettings
import sh.mercuryagent.core.brainMap
import sh.mercuryagent.core.brainMemory
import sh.mercuryagent.core.MercuryException

/** The view onto the graph: zoom [k] and the graph point at the middle of the screen (all in dp). */
data class MapView(val k: Double = 1.0, val cx: Double = 0.0, val cy: Double = 0.0) {
  fun toScreenX(x: Double, w: Double) = (x - cx) * k + w / 2
  fun toScreenY(y: Double, h: Double) = (y - cy) * k + h / 2
  fun toGraphX(px: Double, w: Double) = (px - w / 2) / k + cx
  fun toGraphY(py: Double, h: Double) = (py - h / 2) / k + cy

  companion object {
    const val MIN_ZOOM = 0.08
    const val MAX_ZOOM = 12.0
    fun clamp(k: Double) = k.coerceIn(MIN_ZOOM, MAX_ZOOM)
  }
}

/** Pins live for the app session, per Mercury (desktop: sessionStorage). */
object MindMapPins {
  val byScope = HashMap<String, HashMap<String, Pair<Double, Double>>>()
}

/**
 * The second brain's mind map (Mercury Desktop's NoteWeb): data, settings, selection, pins and the
 * view; the simulation runs in [MindMapEngine], drawing is [MindMapRenderer]. iOS: MindMapModel.swift.
 */
class MindMapViewModel(
  private val client: MercuryClient?,
  initialSettings: WebSettings = WebSettings.DEFAULTS,
  private val saveSettings: (WebSettings) -> Unit = {},
  private val scope: String = client?.baseUrl ?: "local",
  externalScope: CoroutineScope? = null,
) : ViewModel() {
  private val work: CoroutineScope = externalScope ?: viewModelScope
  val engine = MindMapEngine(work) { simRunning = it }
  // Made on first draw (it holds android.graphics objects; tests that never draw never make it).
  val renderer by lazy { MindMapRenderer() }

  var data by mutableStateOf<BrainMap?>(null); private set
  var error by mutableStateOf<String?>(null); private set
  var loading by mutableStateOf(false); private set
  var archive by mutableStateOf(false); private set
  var settings by mutableStateOf(initialSettings); private set
  var query by mutableStateOf(""); private set
  var local by mutableStateOf<LocalGraph?>(null); private set
  /** The note tapped: lit with its neighbours (the desktop's hover), ringed, and shown in the panel. */
  var selected by mutableStateOf<String?>(null); private set
  var showDetail by mutableStateOf(false)
  var showSettings by mutableStateOf(false)

  var graph by mutableStateOf(WebGraph()); private set
  var generation by mutableIntStateOf(0); private set
  var adjacency: List<Set<Int>> = emptyList(); private set
  var index: Map<String, Int> = emptyMap(); private set
  /** Which nodes carry the amber pin dot (pins, and the dot being dragged). */
  var pinned by mutableStateOf<Set<Int>>(emptySet()); private set
  var simRunning by mutableStateOf(false); private set
  var gesturing by mutableStateOf(false)
  var animating by mutableStateOf(false); private set
  var zoomPct by mutableIntStateOf(100); private set
  /** Bumped every display frame while something moves; the canvas reads it to redraw. */
  val frame = mutableLongStateOf(0L)

  /** Plain fields: changed every frame, read by the canvas. */
  var view = MapView()
  var width = 0.0
  var height = 0.0
  private var anim: Anim? = null
  private class Anim(val from: MapView, val to: MapView, val start: Long, val duration: Double)
  private var requested = false
  private var fitted = false
  private var dragging: Dragging? = null
  private class Dragging(val index: Int, val sx: Double, val sy: Double)

  var pins: Map<String, Pair<Double, Double>>
    get() = MindMapPins.byScope[scope].orEmpty()
    set(v) { MindMapPins.byScope[scope] = HashMap(v) }

  val live: Boolean get() = simRunning || gesturing || animating || dragging != null
  val isDragging: Boolean get() = dragging != null

  // MARK: Loading

  /** First time the screen shows: load (desktop: once, when the tab first becomes visible). */
  fun appear() {
    engine.setPaused(false)
    if (requested) return
    requested = true
    work.launch { load() }
  }

  fun disappear() = engine.setPaused(true)

  suspend fun load() {
    val c = client ?: return
    loading = true
    error = null
    try {
      data = c.brainMap(archive)
      rebuild()
    } catch (e: MercuryException) {
      error = e.message
    } catch (e: Exception) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      error = e.message ?: e.toString()
    }
    loading = false
  }

  fun reload() { work.launch { load() } }

  fun useArchive(on: Boolean) { archive = on; reload() }

  /** Previews and tests: data already in hand, settled with seeded randomness. */
  fun show(m: BrainMap, seed: Long, w: Double, h: Double) {
    val rng = SeededRandom(seed)
    engine.random = { rng.next() }
    width = w; height = h
    data = m
    rebuild()
    engine.settleNow()
    engine.pull()
    fit(60.0, 0.0)
  }

  // MARK: The graph

  private fun rebuild() {
    val d = data ?: return
    val g = BrainWeb.toWeb(d, WebOptions(settings.orphans, settings.hidden.toSet(), query, local))
    generation++
    graph = g
    adjacency = BrainWeb.adjacency(g)
    index = HashMap<String, Int>().also { m -> g.nodes.forEachIndexed { i, n -> m[n.id] = i } }
    refreshPinned()
    engine.load(g, generation, settings.forces, pins)
    engine.pull()
    if (!fitted && g.nodes.isNotEmpty()) {
      fitted = true
      after(1800) { fit(60.0, 0.7) }
    }
  }

  private fun refreshPinned() {
    val p = pins.keys.mapNotNull { index[it] }.toMutableSet()
    dragging?.let { p.add(it.index) }
    pinned = p
  }

  fun updateSettings(f: (WebSettings) -> WebSettings) {
    val old = settings
    val new = f(old)
    if (new == old) return
    settings = new
    saveSettings(new)
    if (new.orphans != old.orphans || new.hidden != old.hidden) rebuild()
    else if (new.forces != old.forces) engine.setParams(new.forces)
  }

  fun restoreDefaults() = updateSettings { WebSettings.DEFAULTS.copy(hidden = it.hidden) }

  fun toggleGroup(id: String) = updateSettings { s -> s.copy(hidden = if (id in s.hidden) s.hidden - id else s.hidden + id) }

  fun filter(q: String) { if (q != query) { query = q; rebuild() } }

  fun showLocal(l: LocalGraph?) {
    val old = local
    if (l == old) return
    local = l
    rebuild()
    if (l != null) after(900) { fit(80.0, 0.6) } else if (old != null) after(900) { fit(60.0, 0.6) }
  }

  /** Top themes with their colours and sizes (the settings' Groups). */
  val groups: List<Group>
    get() {
      val d = data ?: return emptyList()
      val tops = BrainWeb.tops(d)
      val colors = BrainWeb.themeColors(tops.map { it.id })
      return tops.map { Group(it.id, it.label, it.size, colors[it.id] ?: BrainWeb.LOOSE_COLOR) }
    }

  data class Group(val id: String, val label: String, val size: Int, val color: String)

  val hoverIndex: Int? get() = selected?.let { index[it] }

  // MARK: Touch (positions in dp)

  fun reach(i: Int): Double = BrainWeb.radius(graph.nodes[i].degree, settings.nodeSize) + 3

  /** The dot under a point: desktop's pointer area (radius + 3), else the nearest within a fingertip. */
  fun pick(px: Double, py: Double): Int? {
    engine.pull()
    val f = engine.front
    val n = graph.nodes.size
    if (f.generation != generation || n == 0 || f.xs.size != n) return null
    val grid = HitGrid(f.xs, f.ys, DoubleArray(n) { reach(it) }, n)
    return grid.pick(view.toGraphX(px, width), view.toGraphY(py, height), 14 / view.k)
  }

  fun tap(px: Double, py: Double) {
    val i = pick(px, py)
    if (i != null) select(graph.nodes[i].id) else clearSelection()
  }

  fun select(id: String) {
    selected = id
    if (!showSettings) showDetail = true
  }

  fun clearSelection() { selected = null; showDetail = false }

  /** A linked note in the panel: select it and bring it to the middle. */
  fun jump(id: String) {
    select(id)
    val i = index[id] ?: return
    val f = engine.front
    if (f.generation != generation || i >= f.xs.size) return
    animate(view.copy(cx = f.xs[i].toDouble(), cy = f.ys[i].toDouble()), 0.5)
  }

  fun pan(dx: Double, dy: Double) {
    anim = null
    view = view.copy(cx = view.cx - dx / view.k, cy = view.cy - dy / view.k)
  }

  /** Pinch: the point under the fingers stays under them while zooming by [factor]; [dx]/[dy] pan with it. */
  fun pinch(px: Double, py: Double, factor: Double, dx: Double, dy: Double) {
    anim = null
    val gx = view.toGraphX(px - dx, width); val gy = view.toGraphY(py - dy, height)
    val k = MapView.clamp(view.k * factor)
    view = MapView(k, gx - (px - width / 2) / k, gy - (py - height / 2) / k)
    updateZoomPct()
  }

  fun zoom(by: Double, px: Double? = null, py: Double? = null) {
    val k = MapView.clamp(view.k * by)
    var to = view.copy(k = k)
    if (px != null && py != null) {
      val gx = view.toGraphX(px, width); val gy = view.toGraphY(py, height)
      to = MapView(k, gx - (px - width / 2) / k, gy - (py - height / 2) / k)
    }
    animate(to, 0.25)
  }

  /** Hold a dot, then drag: it follows the finger and stays pinned where it's let go. */
  fun dragBegan(i: Int, px: Double, py: Double) {
    if (i >= engine.front.xs.size) return
    dragging = Dragging(i, px, py)
    engine.dragStart(i)
    refreshPinned()
    gesturing = true
  }

  fun dragMoved(px: Double, py: Double) {
    val d = dragging ?: return
    val dx = px - d.sx; val dy = py - d.sy
    engine.dragMove(dx / view.k, dy / view.k, Math.hypot(dx, dy))
  }

  fun dragEnded() {
    val d = dragging ?: return
    val id = graph.nodes.getOrNull(d.index)?.id
    val gen = generation
    val end = engine.dragEnd()
    dragging = null
    gesturing = false
    when (end) {
      is MindMapEngine.DragEnd.Pinned -> if (gen == generation && id != null) pins = pins + (id to (end.x to end.y))
      MindMapEngine.DragEnd.Pressed -> id?.let { select(it) }
      MindMapEngine.DragEnd.Lost -> Unit
    }
    refreshPinned()
  }

  // MARK: The view

  fun fit(padding: Double = 60.0, duration: Double = 0.5) {
    engine.pull()
    val f = engine.front
    if (f.generation != generation || f.xs.isEmpty() || width <= 0) return
    // force-graph's getGraphBbox: every dot ± 4 (nodeRelSize).
    var x0 = Double.POSITIVE_INFINITY; var x1 = Double.NEGATIVE_INFINITY; var y0 = Double.POSITIVE_INFINITY; var y1 = Double.NEGATIVE_INFINITY
    for (i in f.xs.indices) {
      val x = f.xs[i].toDouble(); val y = f.ys[i].toDouble()
      x0 = minOf(x0, x - 4); x1 = maxOf(x1, x + 4); y0 = minOf(y0, y - 4); y1 = maxOf(y1, y + 4)
    }
    val k = maxOf(1e-12, minOf(1e12, (width - padding * 2) / (x1 - x0), (height - padding * 2) / (y1 - y0)))
    animate(MapView(MapView.clamp(k), (x0 + x1) / 2, (y0 + y1) / 2), duration)
  }

  fun resetLayout() {
    pins = emptyMap()
    refreshPinned()
    engine.resetLayout()
    after(1800) { fit(60.0, 0.7) }
  }

  private fun animate(to: MapView, duration: Double) {
    if (duration <= 0) { anim = null; view = to; updateZoomPct(); frame.longValue++; return }
    anim = Anim(view, to, System.nanoTime(), duration)
    animating = true
  }

  /** Called by the canvas each frame: advances a view animation (force-graph tweens: quadratic out). */
  fun advance(now: Long) {
    val a = anim ?: return
    val t = minOf(1.0, (now - a.start) / 1e9 / a.duration)
    val e = t * (2 - t)
    view = MapView(a.from.k + (a.to.k - a.from.k) * e, a.from.cx + (a.to.cx - a.from.cx) * e, a.from.cy + (a.to.cy - a.from.cy) * e)
    if (t >= 1) {
      anim = null
      work.launch { animating = anim != null; updateZoomPct() }
    }
  }

  fun updateZoomPct() {
    val p = Math.round(view.k * 100).toInt()
    if (p != zoomPct) zoomPct = p
  }

  private fun after(ms: Long, f: () -> Unit): Job = work.launch { delay(ms); f() }

  // MARK: The note panel

  var detail by mutableStateOf<BrainMemory?>(null)
  var detailError by mutableStateOf<String?>(null); private set
  private var detailFor: String? = null

  suspend fun loadDetail(id: String) {
    if (detailFor == id) return
    detailFor = id
    detail = null
    detailError = null
    val c = client ?: return
    try {
      val m = c.brainMemory(id)
      if (detailFor == id) detail = m
    } catch (e: Exception) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      if (detailFor == id) detailError = e.message ?: e.toString()
    }
  }

  fun note(id: String): BrainMap.Note? = data?.notes?.firstOrNull { it.id == id }

  /** A note's top theme: its name and colour. */
  fun theme(id: String): Pair<String, String>? {
    val d = data ?: return null
    val top = BrainWeb.topOf(d, id)
    val label = d.themes.firstOrNull { it.id == top }?.label ?: if (top == BrainWeb.LOOSE) "Loose notes" else top
    val color = BrainWeb.themeColors(BrainWeb.tops(d).map { it.id })[top] ?: BrainWeb.LOOSE_COLOR
    return label to color
  }

  override fun onCleared() { engine.setPaused(true) }
}
