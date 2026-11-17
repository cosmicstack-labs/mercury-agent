package sh.mercuryagent.core

import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt

// d3-force, ported faithfully for the mind map (Mercury Desktop draws it with force-graph, which runs
// d3-force-3d in two dimensions). Same integrator, same forces, same Barnes–Hut quadtree (d3-quadtree's
// cover/add/visit/visitAfter), same LCG for jiggle, same order of operations, so a layout settles the
// way it does on the desktop. Structure-of-arrays doubles, no objects per node, and the quadtree's
// storage is reused from tick to tick: nothing is allocated while it runs. iOS: ForceSimulation.swift.
//
// The desktop's setup (NoteWeb.tsx `applyForces` and the ForceGraph constructor):
//   velocityDecay 0.32, alphaDecay 0.018, cooldownTicks 900, warmupTicks 0, force-graph's "center" removed;
//   forces in order: link (distance = linkDistance, strength = linkForce·(0.4+min(0.6,w)), d3's bias),
//   charge (manyBody: −repel, distanceMax 400, theta 0.9), x(0) and y(0) at `center`,
//   collide (radius+1, strength 0.6, one iteration).

/** The force sliders (and node size, which sets the collide radii). */
data class ForceParams(
  val center: Double = 0.06,
  val repel: Double = 40.0,
  val linkForce: Double = 0.5,
  val linkDistance: Double = 34.0,
  val nodeSize: Double = 1.0,
)

/** d3-force's lcg: the simulation's own random source (jiggle for coincident points). */
class D3Lcg(private var s: Long = 1) {
  fun next(): Double {
    s = (1664525L * s + 1013904223L) % 4294967296L
    return s.toDouble() / 4294967296.0
  }
}

/** A seeded generator for tests and previews (splitmix64 → [0, 1)); the same numbers as iOS's SeededRandom. */
class SeededRandom(seed: Long) {
  private var s = seed + -0x61c8864680b583ebL
  fun next(): Double {
    s += -0x61c8864680b583ebL
    var z = s
    z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
    z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
    z = z xor (z ushr 31)
    return (z ushr 11).toDouble() / (1L shl 53).toDouble()
  }
}

/**
 * d3-quadtree over parallel arrays: a quad is internal (`data < 0`, four `kids`) or a leaf holding a
 * point index, with coincident points chained through `next` (newest first, like d3).
 */
internal class QuadTree {
  var cap = 0
  var kids = IntArray(0)
  var data = IntArray(0)
  var next = IntArray(0)
  var qx = DoubleArray(0)
  var qy = DoubleArray(0)
  var value = DoubleArray(0)
  var r = DoubleArray(0)
  var count = 0
  var root = -1
  var x0 = 0.0; var y0 = 0.0; var x1 = 0.0; var y1 = 0.0
  /** Children before parents (visitAfter), and the visit stack: (quad, x0, y0, x1, y1). */
  var order = IntArray(0)
  var orderCount = 0
  var sq = IntArray(0)
  var sb = DoubleArray(0)

  private fun reserve(n: Int) {
    if (n <= cap) return
    val c = maxOf(n, cap * 2, 64)
    kids = kids.copyOf(c * 4); data = data.copyOf(c); next = next.copyOf(c)
    qx = qx.copyOf(c); qy = qy.copyOf(c); value = value.copyOf(c); r = r.copyOf(c)
    order = order.copyOf(c); sq = sq.copyOf(c + 1); sb = sb.copyOf((c + 1) * 4)
    cap = c
  }

  private fun alloc(d: Int): Int {
    if (count == cap) reserve(count + 1)
    val q = count++
    data[q] = d; next[q] = -1
    val k = q * 4
    kids[k] = -1; kids[k + 1] = -1; kids[k + 2] = -1; kids[k + 3] = -1
    return q
  }

  /** `quadtree(nodes, x, y)`: addAll with d3's cover (floor of the minimum, doubled to a power of two). */
  fun build(px: DoubleArray, py: DoubleArray, n: Int) {
    count = 0; root = -1
    reserve(n * 2)
    var mx0 = Double.POSITIVE_INFINITY; var my0 = Double.POSITIVE_INFINITY
    var mx1 = Double.NEGATIVE_INFINITY; var my1 = Double.NEGATIVE_INFINITY
    for (i in 0 until n) {
      val x = px[i]; val y = py[i]
      if (x.isNaN() || y.isNaN()) continue
      if (x < mx0) mx0 = x; if (x > mx1) mx1 = x
      if (y < my0) my0 = y; if (y > my1) my1 = y
    }
    if (mx0 > mx1 || my0 > my1) { x0 = Double.NaN; y0 = Double.NaN; x1 = Double.NaN; y1 = Double.NaN; return }
    x0 = floor(mx0); y0 = floor(my0); x1 = x0 + 1; y1 = y0 + 1
    var z = x1 - x0
    while (x0 > mx1 || mx1 >= x1 || y0 > my1 || my1 >= y1) { z *= 2; x1 = x0 + z; y1 = y0 + z }
    for (i in 0 until n) add(px[i], py[i], i, px, py)
    reserve(count + 1) // the visit stack holds every quad at most once
  }

  private fun add(x: Double, y: Double, d: Int, px: DoubleArray, py: DoubleArray) {
    if (x.isNaN() || y.isNaN()) return
    val leaf = alloc(d)
    if (root < 0) { root = leaf; return }
    var node = root
    var parent = -1
    var i = 0
    var x0 = this.x0; var y0 = this.y0; var x1 = this.x1; var y1 = this.y1
    var xm: Double; var ym: Double
    while (data[node] < 0) {
      xm = (x0 + x1) / 2; val right = x >= xm; if (right) x0 = xm else x1 = xm
      ym = (y0 + y1) / 2; val bottom = y >= ym; if (bottom) y0 = ym else y1 = ym
      parent = node; i = (if (bottom) 2 else 0) or (if (right) 1 else 0)
      node = kids[parent * 4 + i]
      if (node < 0) { kids[parent * 4 + i] = leaf; return }
    }
    val xp = px[data[node]]; val yp = py[data[node]]
    if (x == xp && y == yp) {
      next[leaf] = node
      if (parent >= 0) kids[parent * 4 + i] = leaf else root = leaf
      return
    }
    var j: Int
    do {
      val p = alloc(-1)
      if (parent >= 0) kids[parent * 4 + i] = p else root = p
      parent = p
      xm = (x0 + x1) / 2; val right = x >= xm; if (right) x0 = xm else x1 = xm
      ym = (y0 + y1) / 2; val bottom = y >= ym; if (bottom) y0 = ym else y1 = ym
      i = (if (bottom) 2 else 0) or (if (right) 1 else 0)
      j = (if (yp >= ym) 2 else 0) or (if (xp >= xm) 1 else 0)
    } while (i == j)
    kids[parent * 4 + j] = node
    kids[parent * 4 + i] = leaf
  }

  /** Fills [order] with every quad, children before parents (a pre-order walk, reversed). */
  fun postOrder() {
    orderCount = 0
    if (root < 0) return
    var top = 0
    sq[top++] = root
    while (top > 0) {
      val q = sq[--top]
      if (data[q] < 0) for (c in 0 until 4) { val k = kids[q * 4 + c]; if (k >= 0) sq[top++] = k }
      order[orderCount++] = q
    }
    var a = 0; var b = orderCount - 1
    while (a < b) { val t = order[a]; order[a] = order[b]; order[b] = t; a++; b-- }
  }
}

/** The simulation itself. Not thread-safe: one owner (the engine's coroutine, or a test) drives it. */
class ForceSimulation(val n: Int, links: List<Triple<Int, Int, Double>>, params: ForceParams) {
  constructor(g: WebGraph, params: ForceParams) : this(g.nodes.size, g.links.map { Triple(it.source, it.target, it.w) }, params)

  val x = DoubleArray(n) { Double.NaN }
  val y = DoubleArray(n) { Double.NaN }
  val vx = DoubleArray(n)
  val vy = DoubleArray(n)
  /** Fixed positions (NaN: free), as d3's fx/fy. */
  val fx = DoubleArray(n) { Double.NaN }
  val fy = DoubleArray(n) { Double.NaN }
  val degree = IntArray(n)
  /** Collide radii (the drawn radius + 1). */
  val radii = DoubleArray(n)

  private val m = links.size
  private val src = IntArray(m)
  private val tgt = IntArray(m)
  private val w = DoubleArray(m)
  private val bias = DoubleArray(m)
  private val linkStrength = DoubleArray(m)
  private val linkDistance = DoubleArray(m)
  private val px = DoubleArray(n)
  private val py = DoubleArray(n)

  var alpha = 1.0
  var alphaMin = 0.001
  var alphaDecay = 0.018
  var alphaTarget = 0.0
  /** d3 stores 1 − velocityDecay: 0.32 → 0.68. */
  var velocityDecay = 1 - 0.32
  var cooldownTicks = 900
  /** force-graph's countdown. */
  var ticks = 0; private set
  var running = true; private set
  var params = params; private set

  val theta2 = 0.81
  val distanceMin2 = 1.0
  val distanceMax2 = 400.0 * 400.0
  val collideStrength = 0.6

  private val random = D3Lcg()
  private val tree = QuadTree()

  init {
    for (l in links) { degree[l.first]++; degree[l.second]++ }
    links.forEachIndexed { i, l ->
      src[i] = l.first; tgt[i] = l.second; w[i] = l.third
      // forceLink.initialize: bias = count(source) / (count(source) + count(target)).
      bias[i] = degree[l.first].toDouble() / (degree[l.first] + degree[l.second]).toDouble()
    }
    apply(params)
  }

  /** The sliders: re-initialises strengths, distances and radii (desktop's applyForces). No reheat. */
  fun apply(p: ForceParams) {
    params = p
    for (i in 0 until m) { linkStrength[i] = p.linkForce * (0.4 + minOf(0.6, w[i])); linkDistance[i] = p.linkDistance }
    for (i in 0 until n) radii[i] = BrainWeb.radius(degree[i], p.nodeSize) + 1
  }

  /** Places nodes whose x is NaN on d3's phyllotaxis, puts fixed nodes at their fx/fy, zeroes NaN speeds. */
  fun initializeMissing() {
    val initialRadius = 10.0; val initialAngle = Math.PI * (3 - sqrt(5.0))
    for (i in 0 until n) {
      if (!fx[i].isNaN()) x[i] = fx[i]
      if (!fy[i].isNaN()) y[i] = fy[i]
      if (x[i].isNaN() || y[i].isNaN()) {
        val radius = initialRadius * sqrt(0.5 + i); val angle = i * initialAngle
        x[i] = radius * cos(angle); y[i] = radius * sin(angle)
      }
      if (vx[i].isNaN() || vy[i].isNaN()) { vx[i] = 0.0; vy[i] = 0.0 }
    }
  }

  /** d3ReheatSimulation: alpha 1 and a fresh countdown. */
  fun reheat() { alpha = 1.0; resetCountdown() }
  /** force-graph's resetCountdown: the engine runs again (a drag does this without touching alpha). */
  fun resetCountdown() { ticks = 0; running = true }

  /** One animation frame of force-graph's engine: stops after [cooldownTicks], or once alpha < alphaMin. */
  fun step(): Boolean {
    if (!running) return false
    ticks++
    if (ticks > cooldownTicks || (alphaMin > 0 && alpha < alphaMin)) { running = false; return false }
    tick()
    return true
  }

  /** d3's simulation.tick(). */
  fun tick() {
    alpha += (alphaTarget - alpha) * alphaDecay
    forceLink()
    forceManyBody()
    forceCenter()
    forceCollide()
    val decay = velocityDecay
    for (i in 0 until n) {
      if (fx[i].isNaN()) { vx[i] *= decay; x[i] += vx[i] } else { x[i] = fx[i]; vx[i] = 0.0 }
      if (fy[i].isNaN()) { vy[i] *= decay; y[i] += vy[i] } else { y[i] = fy[i]; vy[i] = 0.0 }
    }
  }

  private fun jiggle(): Double = (random.next() - 0.5) * 1e-6

  private fun forceLink() {
    val alpha = alpha
    for (i in 0 until m) {
      val s = src[i]; val t = tgt[i]
      var dx = x[t] + vx[t] - x[s] - vx[s]
      if (dx == 0.0 || dx.isNaN()) dx = jiggle()
      var dy = y[t] + vy[t] - y[s] - vy[s]
      if (dy == 0.0 || dy.isNaN()) dy = jiggle()
      var l = sqrt(dx * dx + dy * dy)
      l = (l - linkDistance[i]) / l * alpha * linkStrength[i]
      dx *= l; dy *= l
      var b = bias[i]
      vx[t] -= dx * b; vy[t] -= dy * b
      b = 1 - b
      vx[s] += dx * b; vy[s] += dy * b
    }
  }

  private fun forceManyBody() {
    if (n == 0) return
    val strength = -params.repel
    val t = tree
    t.build(x, y, n)
    if (t.root < 0) return
    val kids = t.kids; val data = t.data; val next = t.next; val qx = t.qx; val qy = t.qy; val value = t.value
    // visitAfter(accumulate).
    t.postOrder()
    for (o in 0 until t.orderCount) {
      val q = t.order[o]
      if (data[q] < 0) {
        var s = 0.0; var weight = 0.0; var ax = 0.0; var ay = 0.0
        for (c in 0 until 4) {
          val k = kids[q * 4 + c]
          if (k >= 0) {
            val v = value[k]; val a = Math.abs(v)
            if (a != 0.0) { s += v; weight += a; ax += a * qx[k]; ay += a * qy[k] }
          }
        }
        qx[q] = ax / weight; qy[q] = ay / weight
        value[q] = s
      } else {
        val d = data[q]
        qx[q] = x[d]; qy[q] = y[d]
        var s = 0.0
        var c = q
        do { s += strength; c = next[c] } while (c >= 0)
        value[q] = s
      }
    }
    val a = alpha
    val sq = t.sq; val sb = t.sb
    for (i in 0 until n) {
      val nx = x[i]; val ny = y[i]
      var nvx = vx[i]; var nvy = vy[i]
      var top = 1
      sq[0] = t.root; sb[0] = t.x0; sb[1] = t.y0; sb[2] = t.x1; sb[3] = t.y1
      while (top > 0) {
        top--
        val q = sq[top]
        val k4 = top * 4
        val bx0 = sb[k4]; val by0 = sb[k4 + 1]; val bx1 = sb[k4 + 2]; val by1 = sb[k4 + 3]
        val v = value[q]
        if (v == 0.0) continue
        var dx = qx[q] - nx; var dy = qy[q] - ny
        val wq = bx1 - bx0
        var l = dx * dx + dy * dy
        if (wq * wq / theta2 < l) {
          if (l < distanceMax2) {
            if (dx == 0.0) { dx = jiggle(); l += dx * dx }
            if (dy == 0.0) { dy = jiggle(); l += dy * dy }
            if (l < distanceMin2) l = sqrt(distanceMin2 * l)
            nvx += dx * v * a / l
            nvy += dy * v * a / l
          }
          continue
        }
        if (data[q] < 0) {
          // Children, pushed 3…0 so 0 is visited first (d3's visit).
          val xm = (bx0 + bx1) / 2; val ym = (by0 + by1) / 2
          val k = q * 4
          var c = kids[k + 3]
          if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = xm; sb[o + 1] = ym; sb[o + 2] = bx1; sb[o + 3] = by1; top++ }
          c = kids[k + 2]
          if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = bx0; sb[o + 1] = ym; sb[o + 2] = xm; sb[o + 3] = by1; top++ }
          c = kids[k + 1]
          if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = xm; sb[o + 1] = by0; sb[o + 2] = bx1; sb[o + 3] = ym; top++ }
          c = kids[k]
          if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = bx0; sb[o + 1] = by0; sb[o + 2] = xm; sb[o + 3] = ym; top++ }
          continue
        }
        if (l >= distanceMax2) continue
        if (data[q] != i || next[q] >= 0) {
          if (dx == 0.0) { dx = jiggle(); l += dx * dx }
          if (dy == 0.0) { dy = jiggle(); l += dy * dy }
          if (l < distanceMin2) l = sqrt(distanceMin2 * l)
        }
        var c = q
        do {
          if (data[c] != i) {
            val wv = strength * a / l
            nvx += dx * wv; nvy += dy * wv
          }
          c = next[c]
        } while (c >= 0)
      }
      vx[i] = nvx; vy[i] = nvy
    }
  }

  private fun forceCenter() {
    // forceX(0) then forceY(0): node.vx += (0 − node.x) · strength · alpha.
    val s = params.center; val a = alpha
    for (i in 0 until n) vx[i] += (0 - x[i]) * s * a
    for (i in 0 until n) vy[i] += (0 - y[i]) * s * a
  }

  private fun forceCollide() {
    if (n == 0) return
    for (i in 0 until n) { px[i] = x[i] + vx[i]; py[i] = y[i] + vy[i] }
    val t = tree
    t.build(px, py, n)
    if (t.root < 0) return
    val kids = t.kids; val data = t.data; val rr = t.r
    // visitAfter(prepare): a leaf's radius, an internal quad's largest.
    t.postOrder()
    for (o in 0 until t.orderCount) {
      val q = t.order[o]
      if (data[q] >= 0) { rr[q] = radii[data[q]]; continue }
      var r = 0.0
      for (c in 0 until 4) { val k = kids[q * 4 + c]; if (k >= 0 && rr[k] > r) r = rr[k] }
      rr[q] = r
    }
    val strength = collideStrength
    val sq = t.sq; val sb = t.sb
    for (i in 0 until n) {
      val ri = radii[i]; val ri2 = ri * ri
      val xi = x[i] + vx[i]; val yi = y[i] + vy[i]
      var top = 1
      sq[0] = t.root; sb[0] = t.x0; sb[1] = t.y0; sb[2] = t.x1; sb[3] = t.y1
      while (top > 0) {
        top--
        val q = sq[top]
        val k4 = top * 4
        val bx0 = sb[k4]; val by0 = sb[k4 + 1]; val bx1 = sb[k4 + 2]; val by1 = sb[k4 + 3]
        var rj = rr[q]
        var r = ri + rj
        val d = data[q]
        if (d >= 0) {
          if (d > i) {
            var dx = xi - x[d] - vx[d]; var dy = yi - y[d] - vy[d]
            var l = dx * dx + dy * dy
            if (l < r * r) {
              if (dx == 0.0) { dx = jiggle(); l += dx * dx }
              if (dy == 0.0) { dy = jiggle(); l += dy * dy }
              l = sqrt(l)
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
        if (bx0 > xi + r || bx1 < xi - r || by0 > yi + r || by1 < yi - r) continue
        val xm = (bx0 + bx1) / 2; val ym = (by0 + by1) / 2
        val k = q * 4
        var c = kids[k + 3]
        if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = xm; sb[o + 1] = ym; sb[o + 2] = bx1; sb[o + 3] = by1; top++ }
        c = kids[k + 2]
        if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = bx0; sb[o + 1] = ym; sb[o + 2] = xm; sb[o + 3] = by1; top++ }
        c = kids[k + 1]
        if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = xm; sb[o + 1] = by0; sb[o + 2] = bx1; sb[o + 3] = ym; top++ }
        c = kids[k]
        if (c >= 0) { sq[top] = c; val o = top * 4; sb[o] = bx0; sb[o + 1] = by0; sb[o + 2] = xm; sb[o + 3] = ym; top++ }
      }
    }
  }

  // MARK: Placement (NoteWeb.tsx `place` and `scatter`)

  /** Scatter (in place) the given nodes on a disc of radius 60 + √count·18, still; `unpin` frees them. */
  fun scatter(idx: IntArray, unpin: Boolean, random: () -> Double) {
    val spread = 60 + sqrt(idx.size.toDouble()) * 18
    for (i in idx) {
      if (unpin) { fx[i] = Double.NaN; fy[i] = Double.NaN }
      val a = random() * Math.PI * 2
      val r = sqrt(random()) * spread
      x[i] = cos(a) * r; y[i] = sin(a) * r
      vx[i] = 0.0; vy[i] = 0.0
    }
  }

  /** A node's state carried from the graph before (desktop: the live node objects). */
  data class Carry(val x: Double, val y: Double, val vx: Double, val vy: Double, val fx: Double, val fy: Double)

  fun carry(i: Int) = Carry(x[i], y[i], vx[i], vy[i], fx[i], fy[i])

  /** The desktop's `place`: pinned notes at their pins, notes already on screen where they are (with their speed), new ones scattered. */
  fun place(ids: List<String>, pins: Map<String, Pair<Double, Double>>, live: Map<String, Carry>, random: () -> Double) {
    val fresh = ArrayList<Int>()
    ids.forEachIndexed { i, id ->
      val p = pins[id]
      val c = live[id]
      if (p != null) {
        x[i] = p.first; y[i] = p.second; fx[i] = p.first; fy[i] = p.second; vx[i] = 0.0; vy[i] = 0.0
      } else if (c != null) {
        x[i] = c.x; y[i] = c.y; vx[i] = if (c.vx.isNaN()) 0.0 else c.vx; vy[i] = if (c.vy.isNaN()) 0.0 else c.vy; fx[i] = c.fx; fy[i] = c.fy
      } else fresh.add(i)
    }
    scatter(fresh.toIntArray(), false, random)
    initializeMissing()
  }
}

/** Touch picking over the current positions: a uniform grid, rebuilt per touch (cheap: one pass). */
class HitGrid(private val xs: FloatArray, private val ys: FloatArray, private val reach: DoubleArray, count: Int) {
  private val cell: Double = maxOf(8.0, (reach.take(count).maxOrNull() ?: 1.0) * 2)
  private val cells = HashMap<Long, MutableList<Int>>()

  init {
    for (i in 0 until count) if (xs[i].isFinite() && ys[i].isFinite()) cells.getOrPut(key(cx(xs[i].toDouble()), cx(ys[i].toDouble()))) { ArrayList(2) }.add(i)
  }

  private fun cx(v: Double): Long = floor(v / cell).toLong()
  private fun key(a: Long, b: Long): Long = (a shl 32) xor (b and 0xFFFFFFFFL)

  /**
   * The node under (x, y): of those whose area holds the point, the one drawn last (topmost, as
   * force-graph's shadow canvas picks); else, with [slop] > 0, the nearest within [slop].
   */
  fun pick(x: Double, y: Double, slop: Double = 0.0): Int? {
    val span = Math.ceil(slop / cell).toLong() + 1
    val gx0 = cx(x); val gy0 = cx(y)
    var top: Int? = null
    var near: Int? = null; var nearEdge = Double.MAX_VALUE
    for (gx in gx0 - span..gx0 + span) for (gy in gy0 - span..gy0 + span) {
      for (i in cells[key(gx, gy)] ?: continue) {
        val dx = xs[i] - x; val dy = ys[i] - y
        val d = sqrt(dx * dx + dy * dy)
        if (d <= reach[i] && (top == null || i > top)) top = i
        val edge = d - reach[i]
        if (slop > 0 && edge <= slop && edge < nearEdge) { near = i; nearEdge = edge }
      }
    }
    return top ?: near
  }
}
