import SwiftUI
import MercuryCore

/// The view onto the graph: zoom `k` and the graph point at the middle of the screen.
struct MapView: Equatable {
  var k: Double = 1
  var cx: Double = 0
  var cy: Double = 0
  static let minZoom = 0.08
  static let maxZoom = 12.0

  func toScreen(_ x: Double, _ y: Double, _ size: CGSize) -> CGPoint {
    CGPoint(x: (x - cx) * k + size.width / 2, y: (y - cy) * k + size.height / 2)
  }
  func toGraph(_ p: CGPoint, _ size: CGSize) -> (x: Double, y: Double) {
    ((p.x - size.width / 2) / k + cx, (p.y - size.height / 2) / k + cy)
  }
  static func clamp(_ k: Double) -> Double { Swift.min(maxZoom, Swift.max(minZoom, k)) }
}

/// The second brain's mind map (Mercury Desktop's NoteWeb): data, settings, selection, pins and the
/// view; the simulation runs in `MindMapEngine`, drawing is `MindMapCanvas`.
@MainActor @Observable
final class MindMapModel {
  let client: MercuryClient?
  /// Pins live for the app session, per Mercury (desktop: sessionStorage).
  let scope: String
  @ObservationIgnored let engine = MindMapEngine()
  /// Kept with the model: its label outlines are built once per note.
  @ObservationIgnored let renderer = MindMapRenderer()

  var data: BrainMap?
  var error: String?
  var loading = false
  var archive = false
  var settings: WebSettings { didSet { settingsChanged(from: oldValue) } }
  var query = "" { didSet { if query != oldValue { rebuild() } } }
  var local: LocalGraph? { didSet { if local != oldValue { localChanged(from: oldValue) } } }
  /// The note tapped: lit with its neighbours (the desktop's hover), ringed, and shown in the sheet.
  var selected: String?
  var showDetail = false
  var showSettings = false

  private(set) var graph = WebGraph()
  private(set) var generation = 0
  @ObservationIgnored private(set) var adjacency: [Set<Int>] = []
  @ObservationIgnored private(set) var index: [String: Int] = [:]
  /// Which nodes carry the amber pin dot (pins, and the dot being dragged).
  private(set) var pinned: Set<Int> = []
  /// Set while the simulation ticks, a gesture moves the view, or the view animates: the canvas redraws every frame.
  private(set) var simRunning = false
  var gesturing = false
  private(set) var animating = false
  private(set) var zoomPct = 100
  /// Bumped when the view changes outside a frame loop, so a still canvas redraws.
  private(set) var viewVersion = 0

  @ObservationIgnored var view = MapView()
  @ObservationIgnored var size: CGSize = .zero
  @ObservationIgnored private var anim: (from: MapView, to: MapView, start: Date, duration: Double)?
  @ObservationIgnored private var requested = false
  @ObservationIgnored private var fitted = false
  @ObservationIgnored private var dragging: (index: Int, start: CGPoint, gx: Double, gy: Double)?
  @ObservationIgnored let defaults: UserDefaults

  nonisolated(unsafe) static var sessionPins: [String: [String: (Double, Double)]] = [:]
  var pins: [String: (Double, Double)] {
    get { Self.sessionPins[scope] ?? [:] }
    set { Self.sessionPins[scope] = newValue }
  }

  var live: Bool { simRunning || gesturing || animating || dragging != nil }

  init(client: MercuryClient?, scope: String? = nil, defaults: UserDefaults = .standard) {
    self.client = client
    self.scope = scope ?? client?.baseURL.absoluteString ?? "local"
    self.defaults = defaults
    settings = WebSettings.load(defaults)
    engine.onRunning = { [weak self] running in self?.simRunning = running }
  }

  // MARK: Loading

  /// First time the screen shows: load (desktop: once, when the tab first becomes visible).
  func appear() {
    engine.setPaused(false)
    guard !requested else { return }
    requested = true
    Task { await load() }
  }

  func disappear() { engine.setPaused(true) }

  func load() async {
    guard let client else { return }
    loading = true
    error = nil
    do { data = try await client.brainMap(archive: archive); rebuild() } catch { self.error = error.localizedDescription }
    loading = false
  }

  func setArchive(_ on: Bool) {
    archive = on
    Task { await load() }
  }

  /// Snapshots and tests: data already in hand, settled with seeded randomness.
  func show(_ m: BrainMap, seed: UInt64, size: CGSize) {
    var rng = SeededRandom(seed: seed)
    engine.random = { rng.next() }
    self.size = size
    data = m
    rebuild()
    engine.settleNow()
    engine.pull()
    fit(padding: 60, duration: 0)
  }

  // MARK: The graph

  private func rebuild() {
    guard let data else { return }
    let g = BrainWeb.toWeb(data, WebOptions(orphans: settings.orphans, hidden: Set(settings.hidden), query: query, local: local))
    generation += 1
    graph = g
    adjacency = BrainWeb.adjacency(g)
    var idx: [String: Int] = [:]
    for (i, n) in g.nodes.enumerated() { idx[n.id] = i }
    index = idx
    refreshPinned()
    engine.load(g, generation: generation, params: settings.forces, pins: pins)
    engine.pull()
    if !fitted && !g.nodes.isEmpty {
      fitted = true
      after(1.8) { [weak self] in self?.fit(padding: 60, duration: 0.7) }
    }
  }

  private func refreshPinned() {
    var p = Set(pins.keys.compactMap { index[$0] })
    if let d = dragging { p.insert(d.index) }
    pinned = p
  }

  private func settingsChanged(from old: WebSettings) {
    settings.save(defaults)
    if settings.orphans != old.orphans || settings.hidden != old.hidden { rebuild(); return }
    if settings.forces != old.forces { engine.setParams(settings.forces) }
  }

  private func localChanged(from old: LocalGraph?) {
    rebuild()
    if local != nil { after(0.9) { [weak self] in self?.fit(padding: 80, duration: 0.6) } }
    else if old != nil { after(0.9) { [weak self] in self?.fit(padding: 60, duration: 0.6) } }
  }

  func restoreDefaults() {
    var d = WebSettings.defaults
    d.hidden = settings.hidden
    settings = d
  }

  func toggleGroup(_ id: String) {
    if settings.hidden.contains(id) { settings.hidden.removeAll { $0 == id } } else { settings.hidden.append(id) }
  }

  /// Top themes with their colours and sizes (the settings' Groups).
  var groups: [(id: String, label: String, size: Int, color: String)] {
    guard let data else { return [] }
    let tops = BrainWeb.tops(data)
    let colors = BrainWeb.themeColors(tops.map(\.id))
    return tops.map { ($0.id, $0.label, $0.size, colors[$0.id] ?? BrainWeb.looseColor) }
  }

  var hoverIndex: Int? { selected.flatMap { index[$0] } }

  // MARK: Touch

  func reach(_ i: Int) -> Double { BrainWeb.radius(degree: graph.nodes[i].degree, nodeSize: settings.nodeSize) + 3 }

  /// The dot under a point on screen: desktop's pointer area (radius + 3), else the nearest within a fingertip.
  func pick(_ p: CGPoint) -> Int? {
    engine.pull()
    let f = engine.front
    guard f.generation == generation, !graph.nodes.isEmpty, f.xs.count == graph.nodes.count else { return nil }
    let g = view.toGraph(p, size)
    let grid = HitGrid(xs: f.xs, ys: f.ys, reach: (0..<graph.nodes.count).map(reach), count: graph.nodes.count)
    return grid.pick(x: g.x, y: g.y, slop: 14 / view.k)
  }

  func tap(_ p: CGPoint) {
    if let i = pick(p) { select(graph.nodes[i].id) } else { clearSelection() }
  }

  func select(_ id: String) {
    selected = id
    // One sheet at a time: with the settings up, a tap only lights the note.
    if !showSettings { showDetail = true }
  }

  /// The settings sheet, after the note sheet (if up) has gone.
  func openSettings() {
    guard showDetail else { showSettings = true; return }
    showDetail = false
    after(0.35) { [weak self] in self?.showSettings = true }
  }

  func clearSelection() {
    selected = nil
    showDetail = false
  }

  /// A linked note in the sheet: select it and bring it to the middle.
  func jump(to id: String) {
    select(id)
    guard let i = index[id], engine.front.generation == generation, i < engine.front.xs.count else { return }
    var to = view
    to.cx = Double(engine.front.xs[i]); to.cy = Double(engine.front.ys[i])
    animate(to: to, duration: 0.5)
  }

  func pan(by d: CGSize) {
    anim = nil
    view.cx -= d.width / view.k
    view.cy -= d.height / view.k
  }

  /// Pinch: the graph point that was under the fingers stays under them.
  func pinch(focus g: (x: Double, y: Double), at p: CGPoint, k: Double) {
    anim = nil
    view.k = MapView.clamp(k)
    view.cx = g.x - (p.x - size.width / 2) / view.k
    view.cy = g.y - (p.y - size.height / 2) / view.k
    updateZoomPct()
  }

  func zoom(by f: Double, around p: CGPoint? = nil) {
    var to = view
    to.k = MapView.clamp(view.k * f)
    if let p {
      let g = view.toGraph(p, size)
      to.cx = g.x - (p.x - size.width / 2) / to.k
      to.cy = g.y - (p.y - size.height / 2) / to.k
    }
    animate(to: to, duration: 0.25)
  }

  /// Hold a dot, then drag: it follows the finger and stays pinned where it's let go.
  func dragBegan(_ i: Int, at p: CGPoint) {
    let f = engine.front
    guard i < f.xs.count else { return }
    dragging = (i, p, Double(f.xs[i]), Double(f.ys[i]))
    engine.dragStart(i)
    refreshPinned()
    gesturing = true
  }

  func dragMoved(to p: CGPoint) {
    guard let d = dragging else { return }
    let dx = p.x - d.start.x, dy = p.y - d.start.y
    engine.dragMove(dx: dx / view.k, dy: dy / view.k, screenDistance: (dx * dx + dy * dy).squareRoot())
  }

  func dragEnded() {
    guard let d = dragging else { return }
    let id = graph.nodes[d.index].id
    let gen = generation
    engine.dragEnd { [weak self] end in
      guard let self else { return }
      self.dragging = nil
      self.gesturing = false
      switch end {
      case .pinned(let x, let y): if gen == self.generation { self.pins[id] = (x, y) }
      case .pressed: self.select(id)
      case .lost: break
      }
      self.refreshPinned()
    }
  }

  var isDragging: Bool { dragging != nil }

  // MARK: The view

  func fit(padding: Double = 60, duration: Double = 0.5) {
    engine.pull()
    let f = engine.front
    guard f.generation == generation, !f.xs.isEmpty, size.width > 0 else { return }
    // force-graph's getGraphBbox: every dot ± 4 (nodeRelSize).
    var x0 = Double.infinity, x1 = -Double.infinity, y0 = Double.infinity, y1 = -Double.infinity
    for i in 0..<f.xs.count {
      let x = Double(f.xs[i]), y = Double(f.ys[i])
      x0 = min(x0, x - 4); x1 = max(x1, x + 4); y0 = min(y0, y - 4); y1 = max(y1, y + 4)
    }
    let k = max(1e-12, min(1e12, (size.width - padding * 2) / (x1 - x0), (size.height - padding * 2) / (y1 - y0)))
    animate(to: MapView(k: MapView.clamp(k), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2), duration: duration)
  }

  func resetLayout() {
    pins = [:]
    refreshPinned()
    engine.resetLayout()
    after(1.8) { [weak self] in self?.fit(padding: 60, duration: 0.7) }
  }

  private func animate(to: MapView, duration: Double) {
    if duration <= 0 { anim = nil; view = to; updateZoomPct(); viewVersion &+= 1; return }
    anim = (view, to, Date(), duration)
    animating = true
  }

  /// Called by the canvas each frame: advances a view animation (force-graph tweens: quadratic out).
  func advance(_ now: Date) {
    guard let a = anim else { return }
    let t = min(1, now.timeIntervalSince(a.start) / a.duration)
    let e = t * (2 - t)
    view = MapView(k: a.from.k + (a.to.k - a.from.k) * e, cx: a.from.cx + (a.to.cx - a.from.cx) * e, cy: a.from.cy + (a.to.cy - a.from.cy) * e)
    if t >= 1 {
      anim = nil
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.animating = self.anim != nil
        self.updateZoomPct()
      }
    }
  }

  func updateZoomPct() {
    let p = Int((view.k * 100).rounded())
    if p != zoomPct { zoomPct = p }
  }

  private func after(_ s: Double, _ f: @escaping @MainActor () -> Void) {
    Task { @MainActor in try? await Task.sleep(for: .seconds(s)); f() }
  }

  // MARK: The note sheet

  var detail: BrainMemory?
  var detailError: String?
  @ObservationIgnored private var detailFor: String?

  func loadDetail(_ id: String) async {
    guard detailFor != id else { return }
    detailFor = id
    detail = nil
    detailError = nil
    guard let client else { return }
    do {
      let m = try await client.brainMemory(id)
      if detailFor == id { detail = m }
    } catch {
      if detailFor == id { detailError = error.localizedDescription }
    }
  }

  func note(_ id: String) -> BrainMap.Note? { data?.notes.first { $0.id == id } }

  /// A note's top theme: its name and colour.
  func theme(of id: String) -> (label: String, color: String)? {
    guard let data else { return nil }
    let parentOf = Dictionary(data.themes.map { ($0.id, $0.parent) }, uniquingKeysWith: { a, _ in a })
    let at = data.placement[id]
    let top = at.map { (parentOf[$0] ?? nil) ?? $0 } ?? BrainWeb.loose
    let label = data.themes.first { $0.id == top }?.label ?? (top == BrainWeb.loose ? "Loose notes" : top)
    let color = BrainWeb.themeColors(BrainWeb.tops(data).map(\.id))[top] ?? BrainWeb.looseColor
    return (label, color)
  }
}

extension Color {
  /// "#RRGGBB" (the theme hues).
  init(hexString s: String) {
    let v = UInt32(s.dropFirst(), radix: 16) ?? 0x8A97A3
    self.init(hex: v)
  }
}
