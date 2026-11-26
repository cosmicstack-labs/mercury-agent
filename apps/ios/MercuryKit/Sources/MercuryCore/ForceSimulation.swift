import Foundation

// d3-force, ported faithfully for the mind map (Mercury Desktop draws it with force-graph, which runs
// d3-force-3d in two dimensions). Same integrator, same forces, same Barnes–Hut quadtree (d3-quadtree's
// cover/add/visit/visitAfter), same LCG for jiggle, same order of operations, so a layout settles the
// way it does on the desktop. Structure-of-arrays Doubles, no objects per node, and the quadtree's
// storage is reused from tick to tick: nothing is allocated while it runs.
//
// The desktop's setup (NoteWeb.tsx `applyForces` and the ForceGraph constructor):
//   velocityDecay 0.32, alphaDecay 0.018, cooldownTicks 900, warmupTicks 0, force-graph's "center" removed;
//   forces in order: link (distance = linkDistance, strength = linkForce·(0.4+min(0.6,w)), d3's bias),
//   charge (manyBody: −repel, distanceMax 400, theta 0.9), x(0) and y(0) at `center`,
//   collide (radius+1, strength 0.6, one iteration).

/// The force sliders (and node size, which sets the collide radii).
public struct ForceParams: Sendable, Equatable {
  public var center: Double
  public var repel: Double
  public var linkForce: Double
  public var linkDistance: Double
  public var nodeSize: Double
  public init(center: Double = 0.06, repel: Double = 40, linkForce: Double = 0.5, linkDistance: Double = 34, nodeSize: Double = 1) {
    self.center = center; self.repel = repel; self.linkForce = linkForce; self.linkDistance = linkDistance; self.nodeSize = nodeSize
  }
}

/// d3-force's lcg: the simulation's own random source (jiggle for coincident points).
public struct D3LCG: Sendable {
  var s: UInt64
  public init(seed: UInt64 = 1) { s = seed }
  public mutating func next() -> Double {
    s = (1664525 &* s &+ 1013904223) % 4294967296
    return Double(s) / 4294967296
  }
}

/// A seeded generator for tests and snapshots (scatter takes any `() -> Double`).
public struct SeededRandom: Sendable {
  var s: UInt64
  public init(seed: UInt64) { s = seed &+ 0x9E3779B97F4A7C15 }
  /// splitmix64 → [0, 1).
  public mutating func next() -> Double {
    s &+= 0x9E3779B97F4A7C15
    var z = s
    z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
    z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
    z ^= z >> 31
    return Double(z >> 11) / Double(1 << 53)
  }
}

/// Raw storage for the hot loops. Array subscripts are slow in unoptimised (Debug) builds, which is
/// what a device build from Xcode runs; pointer subscripts are transparent and stay fast there.
public struct Field<T>: RandomAccessCollection {
  public let p: UnsafeMutablePointer<T>
  public let count: Int
  public var startIndex: Int { 0 }
  public var endIndex: Int { count }
  public subscript(i: Int) -> T {
    get { p[i] }
    nonmutating set { p[i] = newValue }
  }
  static func make(_ n: Int, _ v: T) -> Field<T> {
    let p = UnsafeMutablePointer<T>.allocate(capacity: Swift.max(1, n))
    p.initialize(repeating: v, count: Swift.max(1, n))
    return Field(p: p, count: n)
  }
  func free() { p.deallocate() }
}

/// d3-quadtree over parallel buffers: a quad is internal (`data < 0`, four `kids`) or a leaf holding a
/// point index, with coincident points chained through `next` (newest first, like d3). Storage is
/// kept from build to build.
final class QuadTree {
  var cap = 0
  var kids: UnsafeMutablePointer<Int32> = .allocate(capacity: 1)
  var data: UnsafeMutablePointer<Int32> = .allocate(capacity: 1)
  var next: UnsafeMutablePointer<Int32> = .allocate(capacity: 1)
  /// Per-quad accumulators: manyBody's centre of charge and value; collide's radius.
  var qx: UnsafeMutablePointer<Double> = .allocate(capacity: 1)
  var qy: UnsafeMutablePointer<Double> = .allocate(capacity: 1)
  var value: UnsafeMutablePointer<Double> = .allocate(capacity: 1)
  var r: UnsafeMutablePointer<Double> = .allocate(capacity: 1)
  var count = 0
  var root: Int32 = -1
  var x0 = 0.0, y0 = 0.0, x1 = 0.0, y1 = 0.0
  /// Children before parents (visitAfter), and a visit stack, both reused.
  var order: UnsafeMutablePointer<Int32> = .allocate(capacity: 1)
  var orderCount = 0
  var stackCap = 0
  var sq: UnsafeMutablePointer<Int32> = .allocate(capacity: 1)
  var sb: UnsafeMutablePointer<Double> = .allocate(capacity: 4)
  var top = 0

  deinit {
    for p in [kids, data, next, order, sq] as [UnsafeMutablePointer<Int32>] { p.deallocate() }
    for p in [qx, qy, value, r, sb] as [UnsafeMutablePointer<Double>] { p.deallocate() }
  }

  private static func grown<T>(_ p: UnsafeMutablePointer<T>, _ old: Int, _ new: Int) -> UnsafeMutablePointer<T> {
    let q = UnsafeMutablePointer<T>.allocate(capacity: new)
    if old > 0 { q.moveInitialize(from: p, count: old) }
    p.deallocate()
    return q
  }

  private func reserve(_ n: Int) {
    if n <= cap { return }
    let c = Swift.max(n, cap * 2, 64)
    kids = Self.grown(kids, cap * 4, c * 4); data = Self.grown(data, cap, c); next = Self.grown(next, cap, c)
    qx = Self.grown(qx, cap, c); qy = Self.grown(qy, cap, c); value = Self.grown(value, cap, c); r = Self.grown(r, cap, c)
    order = Self.grown(order, cap, c)
    cap = c
  }

  @inline(__always) private func alloc(_ d: Int32) -> Int32 {
    if count == cap { reserve(count + 1) }
    let q = count
    count += 1
    data[q] = d; next[q] = -1
    let k = q * 4
    kids[k] = -1; kids[k + 1] = -1; kids[k + 2] = -1; kids[k + 3] = -1
    return Int32(q)
  }

  // The visit stack: (quad, x0, y0, x1, y1).
  @inline(__always) func push(_ q: Int32, _ a: Double, _ b: Double, _ c: Double, _ d: Double) {
    if top == stackCap {
      let n = Swift.max(64, stackCap * 2)
      sq = Self.grown(sq, stackCap, n); sb = Self.grown(sb, stackCap * 4, n * 4)
      stackCap = n
    }
    sq[top] = q
    let k = top * 4
    sb[k] = a; sb[k + 1] = b; sb[k + 2] = c; sb[k + 3] = d
    top += 1
  }

  /// `quadtree(nodes, x, y)`: addAll with d3's cover (floor of the minimum, doubled to a power of two).
  func build(_ px: UnsafeMutablePointer<Double>, _ py: UnsafeMutablePointer<Double>, _ n: Int) {
    count = 0; root = -1
    reserve(n * 2)
    var mx0 = Double.infinity, my0 = Double.infinity, mx1 = -Double.infinity, my1 = -Double.infinity
    var i = 0
    while i < n {
      let x = px[i], y = py[i]
      if x.isNaN || y.isNaN { i &+= 1; continue }
      if x < mx0 { mx0 = x }; if x > mx1 { mx1 = x }
      if y < my0 { my0 = y }; if y > my1 { my1 = y }
      i &+= 1
    }
    if mx0 > mx1 || my0 > my1 { x0 = .nan; y0 = .nan; x1 = .nan; y1 = .nan; return }
    // cover(x0, y0) on an empty tree, then cover(x1, y1).
    x0 = mx0.rounded(.down); y0 = my0.rounded(.down); x1 = x0 + 1; y1 = y0 + 1
    var z = x1 - x0
    while x0 > mx1 || mx1 >= x1 || y0 > my1 || my1 >= y1 {
      z *= 2
      x1 = x0 + z; y1 = y0 + z
    }
    i = 0; while i < n { add(px[i], py[i], Int32(i), px, py); i &+= 1 }
    ensureStack(count + 1)
  }

  /// Every quad is pushed at most once per visit: room for all of them means no checks while visiting.
  func ensureStack(_ n: Int) {
    if n <= stackCap { return }
    let c = Swift.max(n, stackCap * 2, 64)
    sq = Self.grown(sq, stackCap, c); sb = Self.grown(sb, stackCap * 4, c * 4)
    stackCap = c
  }

  private func add(_ x: Double, _ y: Double, _ d: Int32, _ px: UnsafeMutablePointer<Double>, _ py: UnsafeMutablePointer<Double>) {
    if x.isNaN || y.isNaN { return }
    let leaf = alloc(d)
    if root < 0 { root = leaf; return }
    var node = root
    var parent: Int32 = -1
    var i = 0
    var x0 = self.x0, y0 = self.y0, x1 = self.x1, y1 = self.y1
    var xm = 0.0, ym = 0.0
    while data[Int(node)] < 0 {
      xm = (x0 + x1) / 2; let right = x >= xm; if right { x0 = xm } else { x1 = xm }
      ym = (y0 + y1) / 2; let bottom = y >= ym; if bottom { y0 = ym } else { y1 = ym }
      parent = node; i = (bottom ? 2 : 0) | (right ? 1 : 0)
      node = kids[Int(parent) * 4 + i]
      if node < 0 { kids[Int(parent) * 4 + i] = leaf; return }
    }
    let xp = px[Int(data[Int(node)])], yp = py[Int(data[Int(node)])]
    if x == xp && y == yp {
      next[Int(leaf)] = node
      if parent >= 0 { kids[Int(parent) * 4 + i] = leaf } else { root = leaf }
      return
    }
    var j = 0
    repeat {
      let p = alloc(-1)
      if parent >= 0 { kids[Int(parent) * 4 + i] = p } else { root = p }
      parent = p
      xm = (x0 + x1) / 2; let right = x >= xm; if right { x0 = xm } else { x1 = xm }
      ym = (y0 + y1) / 2; let bottom = y >= ym; if bottom { y0 = ym } else { y1 = ym }
      i = (bottom ? 2 : 0) | (right ? 1 : 0)
      j = (yp >= ym ? 2 : 0) | (xp >= xm ? 1 : 0)
    } while i == j
    kids[Int(parent) * 4 + j] = node
    kids[Int(parent) * 4 + i] = leaf
  }

  /// Fills `order` with every quad, children before parents (d3's visitAfter).
  func postOrder() {
    orderCount = 0
    guard root >= 0 else { return }
    // A pre-order walk (parent first), reversed: every quad lands after its children.
    top = 0
    push(root, 0, 0, 0, 0)
    while top > 0 {
      top -= 1
      let q = sq[top]
      if data[Int(q)] < 0 {
        for c in 0..<4 { let k = kids[Int(q) * 4 + c]; if k >= 0 { push(k, 0, 0, 0, 0) } }
      }
      order[orderCount] = q
      orderCount += 1
    }
    var a = 0, b = orderCount - 1
    while a < b { let t = order[a]; order[a] = order[b]; order[b] = t; a += 1; b -= 1 }
  }
}

/// The simulation itself. Not thread-safe: one owner (the engine's queue, or a test) drives it.
public final class ForceSimulation {
  public let n: Int
  public let x: Field<Double>
  public let y: Field<Double>
  public let vx: Field<Double>
  public let vy: Field<Double>
  /// Fixed positions (NaN: free), as d3's fx/fy.
  public let fx: Field<Double>
  public let fy: Field<Double>
  public let degree: [Int]
  /// Collide radii (the drawn radius + 1).
  public let radii: Field<Double>

  let m: Int
  let src: Field<Int>
  let tgt: Field<Int>
  let w: Field<Double>
  let bias: Field<Double>
  let linkStrength: Field<Double>
  let linkDistance: Field<Double>
  let px: Field<Double>
  let py: Field<Double>

  public var alpha = 1.0
  public var alphaMin = 0.001
  public var alphaDecay = 0.018
  public var alphaTarget = 0.0
  /// d3 stores 1 − velocityDecay: 0.32 → 0.68.
  public var velocityDecay = 1 - 0.32
  public var cooldownTicks = 900
  /// force-graph's countdown.
  public private(set) var ticks = 0
  public private(set) var running = true
  public private(set) var params: ForceParams

  public let theta2 = 0.81
  public let distanceMin2 = 1.0
  public let distanceMax2 = 400.0 * 400.0
  public let collideStrength = 0.6

  var random = D3LCG()
  let tree = QuadTree()

  /// `links`: (source index, target index, w).
  public init(count: Int, links: [(Int, Int, Double)], params: ForceParams) {
    n = count
    m = links.count
    x = .make(count, .nan); y = .make(count, .nan)
    vx = .make(count, 0); vy = .make(count, 0)
    fx = .make(count, .nan); fy = .make(count, .nan)
    radii = .make(count, 0)
    px = .make(count, 0); py = .make(count, 0)
    src = .make(m, 0); tgt = .make(m, 0); w = .make(m, 0); bias = .make(m, 0)
    linkStrength = .make(m, 0); linkDistance = .make(m, 0)
    var deg = Array(repeating: 0, count: count)
    for l in links { deg[l.0] += 1; deg[l.1] += 1 }
    degree = deg
    for (i, l) in links.enumerated() {
      src[i] = l.0; tgt[i] = l.1; w[i] = l.2
      // forceLink.initialize: bias = count(source) / (count(source) + count(target)).
      bias[i] = Double(deg[l.0]) / Double(deg[l.0] + deg[l.1])
    }
    self.params = params
    apply(params)
  }

  deinit {
    for f in [x, y, vx, vy, fx, fy, radii, px, py, w, bias, linkStrength, linkDistance] { f.free() }
    src.free(); tgt.free()
  }

  public convenience init(_ g: WebGraph, params: ForceParams) {
    self.init(count: g.nodes.count, links: g.links.map { ($0.source, $0.target, $0.w) }, params: params)
  }

  /// The sliders: re-initialises strengths, distances and radii (desktop's applyForces). No reheat.
  public func apply(_ p: ForceParams) {
    params = p
    for i in 0..<m {
      linkStrength[i] = p.linkForce * (0.4 + Swift.min(0.6, w[i]))
      linkDistance[i] = p.linkDistance
    }
    for i in 0..<n { radii[i] = BrainWeb.radius(degree: degree[i], nodeSize: p.nodeSize) + 1 }
  }

  /// Places nodes whose x is NaN on d3's phyllotaxis, puts fixed nodes at their fx/fy, zeroes NaN speeds.
  public func initializeMissing() {
    let initialRadius = 10.0, initialAngle = Double.pi * (3 - 5.0.squareRoot())
    for i in 0..<n {
      if !fx[i].isNaN { x[i] = fx[i] }
      if !fy[i].isNaN { y[i] = fy[i] }
      if x[i].isNaN || y[i].isNaN {
        let radius = initialRadius * (0.5 + Double(i)).squareRoot(), angle = Double(i) * initialAngle
        x[i] = radius * cos(angle); y[i] = radius * sin(angle)
      }
      if vx[i].isNaN || vy[i].isNaN { vx[i] = 0; vy[i] = 0 }
    }
  }

  /// d3ReheatSimulation: alpha 1 and a fresh countdown.
  public func reheat() { alpha = 1; resetCountdown() }
  /// force-graph's resetCountdown: the engine runs again (a drag does this without touching alpha).
  public func resetCountdown() { ticks = 0; running = true }

  /// One animation frame of force-graph's engine: stops after `cooldownTicks`, or once alpha < alphaMin.
  /// Returns whether it ticked.
  @discardableResult
  public func step() -> Bool {
    guard running else { return false }
    ticks += 1
    if ticks > cooldownTicks || (alphaMin > 0 && alpha < alphaMin) { running = false; return false }
    tick()
    return true
  }

  /// d3's simulation.tick().
  public func tick() {
    alpha += (alphaTarget - alpha) * alphaDecay
    forceLink()
    forceManyBody()
    forceCenter()
    forceCollide()
    let x = x.p, y = y.p, vx = vx.p, vy = vy.p, fx = fx.p, fy = fy.p, decay = velocityDecay
    var i = 0
    while i < n {
      if fx[i].isNaN { vx[i] *= decay; x[i] += vx[i] } else { x[i] = fx[i]; vx[i] = 0 }
      if fy[i].isNaN { vy[i] *= decay; y[i] += vy[i] } else { y[i] = fy[i]; vy[i] = 0 }
      i &+= 1
    }
  }

  @inline(__always) func jiggle() -> Double { (random.next() - 0.5) * 1e-6 }

  func forceLink() {
    let x = x.p, y = y.p, vx = vx.p, vy = vy.p, src = src.p, tgt = tgt.p
    let dist = linkDistance.p, str = linkStrength.p, bias = bias.p, alpha = alpha
    var i = 0
    while i < m {
      let s = src[i], t = tgt[i]
      var dx = x[t] + vx[t] - x[s] - vx[s]
      if dx == 0 || dx.isNaN { dx = jiggle() }
      var dy = y[t] + vy[t] - y[s] - vy[s]
      if dy == 0 || dy.isNaN { dy = jiggle() }
      var l = (dx * dx + dy * dy).squareRoot()
      l = (l - dist[i]) / l * alpha * str[i]
      dx *= l; dy *= l
      var b = bias[i]
      vx[t] -= dx * b; vy[t] -= dy * b
      b = 1 - b
      vx[s] += dx * b; vy[s] += dy * b
      i &+= 1
    }
  }

  func forceManyBody() {
    guard n > 0 else { return }
    let strength = -params.repel
    let x = x.p, y = y.p, vx = vx.p, vy = vy.p
    let t = tree
    t.build(x, y, n)
    if t.root < 0 { return }
    let kids = t.kids, data = t.data, next = t.next, qx = t.qx, qy = t.qy, value = t.value
    // visitAfter(accumulate).
    t.postOrder()
    var o = 0
    while o < t.orderCount {
      let q = Int(t.order[o])
      if data[q] < 0 {
        var s = 0.0, weight = 0.0, ax = 0.0, ay = 0.0
        for c in 0..<4 {
          let k = Int(kids[q * 4 + c])
          if k >= 0 {
            let v = value[k], a = abs(v)
            if a != 0 { s += v; weight += a; ax += a * qx[k]; ay += a * qy[k] }
          }
        }
        qx[q] = ax / weight; qy[q] = ay / weight
        value[q] = s
      } else {
        let d = Int(data[q])
        qx[q] = x[d]; qy[q] = y[d]
        var s = 0.0
        var c = Int32(q)
        repeat { s += strength; c = next[Int(c)] } while c >= 0
        value[q] = s
      }
      o &+= 1
    }
    let a = alpha, theta2 = theta2, dMin2 = distanceMin2, dMax2 = distanceMax2
    let sq = t.sq, sb = t.sb, root = t.root, tx0 = t.x0, ty0 = t.y0, tx1 = t.x1, ty1 = t.y1
    // Hot loop: while loops and raw pointers only (fast in Debug builds too).
    var i = 0
    while i < n {
      let nx = x[i], ny = y[i]
      var nvx = vx[i], nvy = vy[i]
      var top = 1
      sq[0] = root; sb[0] = tx0; sb[1] = ty0; sb[2] = tx1; sb[3] = ty1
      while top > 0 {
        top -= 1
        let q = Int(sq[top])
        let k4 = top &* 4
        let bx0 = sb[k4], by0 = sb[k4 &+ 1], bx1 = sb[k4 &+ 2], by1 = sb[k4 &+ 3]
        let v = value[q]
        if v == 0 { continue }
        var dx = qx[q] - nx, dy = qy[q] - ny
        let wq = bx1 - bx0
        var l = dx * dx + dy * dy
        if wq * wq / theta2 < l {
          if l < dMax2 {
            if dx == 0 { dx = jiggle(); l += dx * dx }
            if dy == 0 { dy = jiggle(); l += dy * dy }
            if l < dMin2 { l = (dMin2 * l).squareRoot() }
            nvx += dx * v * a / l
            nvy += dy * v * a / l
          }
          continue
        }
        if data[q] < 0 {
          // Children, pushed 3…0 so 0 is visited first (d3's visit).
          let xm = (bx0 + bx1) / 2, ym = (by0 + by1) / 2
          let k = q &* 4
          var c = kids[k &+ 3]
          if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = xm; sb[o &+ 1] = ym; sb[o &+ 2] = bx1; sb[o &+ 3] = by1; top &+= 1 }
          c = kids[k &+ 2]
          if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = bx0; sb[o &+ 1] = ym; sb[o &+ 2] = xm; sb[o &+ 3] = by1; top &+= 1 }
          c = kids[k &+ 1]
          if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = xm; sb[o &+ 1] = by0; sb[o &+ 2] = bx1; sb[o &+ 3] = ym; top &+= 1 }
          c = kids[k]
          if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = bx0; sb[o &+ 1] = by0; sb[o &+ 2] = xm; sb[o &+ 3] = ym; top &+= 1 }
          continue
        }
        if l >= dMax2 { continue }
        if Int(data[q]) != i || next[q] >= 0 {
          if dx == 0 { dx = jiggle(); l += dx * dx }
          if dy == 0 { dy = jiggle(); l += dy * dy }
          if l < dMin2 { l = (dMin2 * l).squareRoot() }
        }
        var c = q
        repeat {
          if Int(data[c]) != i {
            let wv = strength * a / l
            nvx += dx * wv; nvy += dy * wv
          }
          c = Int(next[c])
        } while c >= 0
      }
      vx[i] = nvx; vy[i] = nvy
      i &+= 1
    }
  }

  func forceCenter() {
    // forceX(0) then forceY(0): node.vx += (0 − node.x) · strength · alpha.
    let s = params.center, a = alpha, x = x.p, y = y.p, vx = vx.p, vy = vy.p
    var i = 0; while i < n { vx[i] += (0 - x[i]) * s * a; i &+= 1 }
    i = 0; while i < n { vy[i] += (0 - y[i]) * s * a; i &+= 1 }
  }

  func forceCollide() {
    guard n > 0 else { return }
    let x = x.p, y = y.p, vx = vx.p, vy = vy.p, px = px.p, py = py.p, radii = radii.p
    var i = 0; while i < n { px[i] = x[i] + vx[i]; py[i] = y[i] + vy[i]; i &+= 1 }
    let t = tree
    t.build(px, py, n)
    if t.root < 0 { return }
    let kids = t.kids, data = t.data, rr = t.r
    // visitAfter(prepare): a leaf's radius, an internal quad's largest.
    t.postOrder()
    var o = 0
    while o < t.orderCount {
      let q = Int(t.order[o])
      if data[q] >= 0 { rr[q] = radii[Int(data[q])]; o &+= 1; continue }
      var r = 0.0
      for c in 0..<4 { let k = Int(kids[q * 4 + c]); if k >= 0 && rr[k] > r { r = rr[k] } }
      rr[q] = r
      o &+= 1
    }
    let strength = collideStrength
    let sq = t.sq, sb = t.sb, root = t.root, tx0 = t.x0, ty0 = t.y0, tx1 = t.x1, ty1 = t.y1
    i = 0
    while i < n {
      let ri = radii[i], ri2 = ri * ri
      let xi = x[i] + vx[i], yi = y[i] + vy[i]
      var top = 1
      sq[0] = root; sb[0] = tx0; sb[1] = ty0; sb[2] = tx1; sb[3] = ty1
      while top > 0 {
        top -= 1
        let q = Int(sq[top])
        let k4 = top &* 4
        let bx0 = sb[k4], by0 = sb[k4 &+ 1], bx1 = sb[k4 &+ 2], by1 = sb[k4 &+ 3]
        var rj = rr[q]
        var r = ri + rj
        let d = Int(data[q])
        if d >= 0 {
          if d > i {
            var dx = xi - x[d] - vx[d], dy = yi - y[d] - vy[d]
            var l = dx * dx + dy * dy
            if l < r * r {
              if dx == 0 { dx = jiggle(); l += dx * dx }
              if dy == 0 { dy = jiggle(); l += dy * dy }
              l = l.squareRoot()
              l = (r - l) / l * strength
              dx *= l; dy *= l
              rj *= rj
              r = rj / (ri2 + rj)
              vx[i] += dx * r; vy[i] += dy * r
              r = 1 - r
              vx[d] -= dx * r; vy[d] -= dy * r
            }
          }
          continue
        }
        if bx0 > xi + r || bx1 < xi - r || by0 > yi + r || by1 < yi - r { continue }
        let xm = (bx0 + bx1) / 2, ym = (by0 + by1) / 2
        let k = q &* 4
        var c = kids[k &+ 3]
        if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = xm; sb[o &+ 1] = ym; sb[o &+ 2] = bx1; sb[o &+ 3] = by1; top &+= 1 }
        c = kids[k &+ 2]
        if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = bx0; sb[o &+ 1] = ym; sb[o &+ 2] = xm; sb[o &+ 3] = by1; top &+= 1 }
        c = kids[k &+ 1]
        if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = xm; sb[o &+ 1] = by0; sb[o &+ 2] = bx1; sb[o &+ 3] = ym; top &+= 1 }
        c = kids[k]
        if c >= 0 { sq[top] = c; let o = top &* 4; sb[o] = bx0; sb[o &+ 1] = by0; sb[o &+ 2] = xm; sb[o &+ 3] = ym; top &+= 1 }
      }
      i &+= 1
    }
  }

  // MARK: Placement (NoteWeb.tsx `place` and `scatter`)

  /// Scatter (in place) the given nodes on a disc of radius 60 + √count·18, still; `unpin` frees them.
  public func scatter(_ idx: [Int], unpin: Bool, random: () -> Double) {
    let spread = 60 + Double(idx.count).squareRoot() * 18
    for i in idx {
      if unpin { fx[i] = .nan; fy[i] = .nan }
      let a = random() * Double.pi * 2
      let r = random().squareRoot() * spread
      x[i] = cos(a) * r; y[i] = sin(a) * r
      vx[i] = 0; vy[i] = 0
    }
  }

  /// A node's state carried from the graph before (desktop: the live node objects).
  public struct Carry: Sendable {
    public var x, y, vx, vy, fx, fy: Double
    public init(x: Double, y: Double, vx: Double, vy: Double, fx: Double, fy: Double) {
      self.x = x; self.y = y; self.vx = vx; self.vy = vy; self.fx = fx; self.fy = fy
    }
  }

  /// The desktop's `place`: pinned notes at their pins, notes already on screen where they are
  /// (with their speed), new ones scattered.
  public func place(ids: [String], pins: [String: (Double, Double)], live: [String: Carry], random: () -> Double) {
    var fresh: [Int] = []
    for (i, id) in ids.enumerated() {
      if let p = pins[id] {
        x[i] = p.0; y[i] = p.1; fx[i] = p.0; fy[i] = p.1; vx[i] = 0; vy[i] = 0
      } else if let c = live[id] {
        x[i] = c.x; y[i] = c.y; vx[i] = c.vx.isNaN ? 0 : c.vx; vy[i] = c.vy.isNaN ? 0 : c.vy; fx[i] = c.fx; fy[i] = c.fy
      } else {
        fresh.append(i)
      }
    }
    scatter(fresh, unpin: false, random: random)
    initializeMissing()
  }

  public func carry(_ i: Int) -> Carry { Carry(x: x[i], y: y[i], vx: vx[i], vy: vy[i], fx: fx[i], fy: fy[i]) }
}

/// Touch picking over the current positions: a uniform grid, rebuilt per touch (cheap: one pass).
public struct HitGrid {
  let cell: Double
  var cells: [Int64: [Int]] = [:]
  let xs: [Float], ys: [Float], reach: [Double]

  /// `reach[i]`: how far from its centre node i takes a touch, in graph units (desktop: radius + 3).
  public init(xs: [Float], ys: [Float], reach: [Double], count: Int) {
    self.xs = xs; self.ys = ys; self.reach = reach
    let maxReach = reach.prefix(count).max() ?? 1
    cell = Swift.max(8, maxReach * 2)
    for i in 0..<count where xs[i].isFinite && ys[i].isFinite {
      cells[key(Double(xs[i]), Double(ys[i])), default: []].append(i)
    }
  }

  func key(_ x: Double, _ y: Double) -> Int64 {
    let cx = Int64((x / cell).rounded(.down)), cy = Int64((y / cell).rounded(.down))
    return (cx << 32) ^ (cy & 0xFFFF_FFFF)
  }

  /// The node under (x, y): of those whose area holds the point, the one drawn last (topmost, as
  /// force-graph's shadow canvas picks); else, with `slop` > 0, the nearest within `slop`.
  public func pick(x: Double, y: Double, slop: Double = 0) -> Int? {
    let span = Int((slop / cell).rounded(.up)) + 1
    let cx = Int64((x / cell).rounded(.down)), cy = Int64((y / cell).rounded(.down))
    var top: Int?
    var near: (Int, Double)?
    for gx in (cx - Int64(span))...(cx + Int64(span)) {
      for gy in (cy - Int64(span))...(cy + Int64(span)) {
        for i in cells[(gx << 32) ^ (gy & 0xFFFF_FFFF)] ?? [] {
          let d = ((Double(xs[i]) - x) * (Double(xs[i]) - x) + (Double(ys[i]) - y) * (Double(ys[i]) - y)).squareRoot()
          if d <= reach[i] { if top == nil || i > top! { top = i } }
          let edge = d - reach[i]
          if slop > 0, edge <= slop, near == nil || edge < near!.1 { near = (i, edge) }
        }
      }
    }
    return top ?? near?.0
  }
}
