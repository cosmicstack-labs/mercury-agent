import Foundation
import MercuryCore

/// Runs the mind map's force simulation off the main thread, one tick per 1/60 s (force-graph ticks
/// once per animation frame), and hands positions to the renderer through a lock-guarded triple
/// buffer of Float arrays: the simulation writes its own back buffer, swaps it with the shared one,
/// and the renderer swaps the shared one for its front buffer when there's a newer one. Nothing is
/// allocated per tick (buffers resize only when the graph changes).
final class MindMapEngine: @unchecked Sendable {
  struct Frame {
    var generation = -1
    var xs: [Float] = []
    var ys: [Float] = []
  }

  private let queue = DispatchQueue(label: "sh.mercuryagent.mindmap.simulation", qos: .userInteractive)
  // Queue-only state.
  private var sim: ForceSimulation?
  private var ids: [String] = []
  private var generation = -1
  private var timer: DispatchSourceTimer?
  private var paused = false
  private var back = Frame()
  private var drag: (index: Int, x: Double, y: Double, fx: Double, fy: Double, dragged: Bool)?
  // Shared.
  private let lock = NSLock()
  private var shared = Frame()
  private var sharedVersion = 0
  // Main-only.
  private(set) var front = Frame()
  private var frontVersion = 0

  /// Called on the main queue when the engine starts or stops ticking.
  var onRunning: (@MainActor @Sendable (Bool) -> Void)?
  /// Scatter's randomness (Math.random on the desktop); tests and snapshots seed it.
  var random: () -> Double = { Double.random(in: 0..<1) }

  /// New dots and lines (desktop: graphData(place(next, live))): keeps where the notes already on
  /// screen are, puts pinned ones at their pins, scatters new ones, alpha 1. Waits for the queue (one
  /// tick at most) so the renderer has the new positions on its next frame.
  func load(_ g: WebGraph, generation: Int, params: ForceParams, pins: [String: (Double, Double)]) {
    queue.sync {
      var live: [String: ForceSimulation.Carry] = [:]
      if let old = sim { for (i, id) in ids.enumerated() { live[id] = old.carry(i) } }
      let s = ForceSimulation(g, params: params)
      s.place(ids: g.nodes.map(\.id), pins: pins, live: live, random: random)
      sim = s
      ids = g.nodes.map(\.id)
      self.generation = generation
      drag = nil
      publish()
      startTimer()
    }
  }

  /// The force sliders and node size: re-initialise the forces, then d3ReheatSimulation.
  func setParams(_ p: ForceParams) {
    queue.async { [self] in
      guard let sim else { return }
      sim.apply(p)
      sim.reheat()
      startTimer()
    }
  }

  /// Reset layout: unpin everything, scatter every dot, reheat.
  func resetLayout() {
    queue.async { [self] in
      guard let sim else { return }
      sim.scatter(Array(0..<sim.n), unpin: true, random: random)
      sim.reheat()
      publish()
      startTimer()
    }
  }

  // MARK: Dragging a dot (force-graph's d3-drag handlers)

  /// Drag start: remember where it was, fix it where it is.
  func dragStart(_ i: Int) {
    queue.async { [self] in
      guard let sim, i < sim.n else { return }
      drag = (i, sim.x[i], sim.y[i], sim.fx[i], sim.fy[i], false)
      sim.fx[i] = sim.x[i]; sim.fy[i] = sim.y[i]
    }
  }

  /// Drag: fx = x = the start + the finger's travel / zoom; past 5 px the engine runs gently (alphaTarget 0.3).
  func dragMove(dx: Double, dy: Double, screenDistance: Double) {
    queue.async { [self] in
      guard let sim, let d = drag else { return }
      let nx = d.x + dx, ny = d.y + dy
      sim.fx[d.index] = nx; sim.x[d.index] = nx
      sim.fy[d.index] = ny; sim.y[d.index] = ny
      if !d.dragged && screenDistance <= 5 { publish(); return }
      drag?.dragged = true
      sim.alphaTarget = 0.3
      sim.resetCountdown()
      publish()
      startTimer()
    }
  }

  enum DragEnd: Sendable {
    /// Moved: pinned here (rounded, as the desktop saves pins).
    case pinned(x: Double, y: Double)
    /// Held without moving: a press.
    case pressed
    /// The graph changed under the finger.
    case lost
  }

  /// Drag end: release the target heat; a real drag pins the dot where it was let go (onNodeDragEnd).
  /// `done` hears what happened, on the main queue.
  func dragEnd(_ done: @escaping @MainActor @Sendable (DragEnd) -> Void) {
    queue.async { [self] in
      guard let sim, let d = drag else {
        DispatchQueue.main.async { MainActor.assumeIsolated { done(.lost) } }
        return
      }
      drag = nil
      if d.fx.isNaN { sim.fx[d.index] = .nan }
      if d.fy.isNaN { sim.fy[d.index] = .nan }
      if sim.alphaTarget != 0 { sim.alphaTarget = 0; sim.resetCountdown(); startTimer() }
      var result = DragEnd.pressed
      if d.dragged {
        sim.fx[d.index] = sim.x[d.index]; sim.fy[d.index] = sim.y[d.index]
        result = .pinned(x: sim.x[d.index].rounded(), y: sim.y[d.index].rounded())
        publish()
      }
      let r = result
      DispatchQueue.main.async { MainActor.assumeIsolated { done(r) } }
    }
  }

  // MARK: Running

  /// Stop ticking while the screen is away (desktop: pauseAnimation), go on when it's back.
  func setPaused(_ p: Bool) {
    queue.async { [self] in
      paused = p
      if p { stopTimer(notify: false) } else if sim?.running == true { startTimer() }
    }
  }

  /// Snapshots and tests: tick to rest right here (no timer).
  func settleNow(maxTicks: Int = 900) {
    queue.sync {
      guard let sim else { return }
      var n = 0
      while n < maxTicks && sim.step() { n += 1 }
      publish()
    }
  }

  private func startTimer() {
    guard timer == nil, !paused, sim?.running == true else { return }
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: .nanoseconds(16_666_667), leeway: .milliseconds(1))
    t.setEventHandler { [weak self] in self?.frame() }
    timer = t
    t.resume()
    notify(true)
  }

  private func stopTimer(notify n: Bool) {
    timer?.cancel()
    timer = nil
    if n { notify(false) }
  }

  private func frame() {
    guard let sim else { stopTimer(notify: true); return }
    if sim.step() { publish() } else { stopTimer(notify: true) }
  }

  private func notify(_ running: Bool) {
    guard let cb = onRunning else { return }
    DispatchQueue.main.async { MainActor.assumeIsolated { cb(running) } }
  }

  private func publish() {
    guard let sim else { return }
    let n = sim.n
    if back.xs.count != n { back.xs = Array(repeating: 0, count: n); back.ys = Array(repeating: 0, count: n) }
    back.generation = generation
    // Take the arrays out of the frame while writing (no copy: they move), then put them back.
    var xs: [Float] = [], ys: [Float] = []
    swap(&xs, &back.xs); swap(&ys, &back.ys)
    xs.withUnsafeMutableBufferPointer { xb in
      ys.withUnsafeMutableBufferPointer { yb in
        let x = sim.x.p, y = sim.y.p
        var i = 0
        while i < n { xb[i] = Float(x[i]); yb[i] = Float(y[i]); i &+= 1 }
      }
    }
    swap(&xs, &back.xs); swap(&ys, &back.ys)
    lock.lock()
    swap(&back, &shared)
    sharedVersion &+= 1
    lock.unlock()
  }

  /// Main thread: the newest positions, if there are newer ones than last time.
  @discardableResult
  func pull() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard sharedVersion != frontVersion else { return false }
    swap(&front, &shared)
    frontVersion = sharedVersion
    return true
  }
}
