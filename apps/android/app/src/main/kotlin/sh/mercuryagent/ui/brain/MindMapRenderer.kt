package sh.mercuryagent.ui.brain

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import sh.mercuryagent.core.BrainWeb

/**
 * Draws the mind map the way Mercury Desktop's NoteWeb does (force-graph's canvas), on the native
 * canvas in dp: lines first (one drawLines per opacity step, from one reused FloatArray), then dots
 * grouped by colour with one reused Paint, the selected ring, the amber pin dots, then labels in
 * draw order (hubs first) with the desktop's claim-the-space rule, stroked with a halo then filled
 * like strokeText/fillText. Dots scale with zoom; line widths, rings, pin dots and label text stay
 * the same on screen, as in force-graph. No allocation per frame once a graph is set up.
 * iOS: MindMapCanvas.swift.
 */
class MindMapRenderer {
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.BUTT }
  private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f }
  private val regularFace = Typeface.create(Typeface.DEFAULT, 400, false)
  private val mediumFace = Typeface.create(Typeface.DEFAULT, 500, false)
  private val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE; strokeWidth = 3f; strokeJoin = Paint.Join.ROUND; textSize = 10.5f; textAlign = Paint.Align.LEFT
  }
  private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; textSize = 10.5f; textAlign = Paint.Align.LEFT }

  // Per graph (rebuilt when the generation changes).
  private var generation = -1
  private var n = 0
  private var colors = IntArray(0)
  /** Node indices grouped by colour: [byColour] in order, [colourStart] the start of each group. */
  private var byColour = IntArray(0)
  private var colourStart = IntArray(0)
  private var palette = IntArray(0)
  /** Link indices grouped by opacity step (0.005), and where each step starts. */
  private var linkOrder = IntArray(0)
  private var bucketStart = IntArray(0)
  private var labels = arrayOfNulls<String>(0)
  private var widthRegular = FloatArray(0)
  private var widthLit = FloatArray(0)
  private var fadeAt = DoubleArray(0)
  private var fadeFor = -1.0
  // Per frame, reused.
  private var sx = FloatArray(0)
  private var sy = FloatArray(0)
  private var radius = FloatArray(0)
  private var pts = FloatArray(0)
  private val claims = Claims()
  private var visible = IntArray(0)
  private var visibleAlpha = FloatArray(0)
  private var visibleLit = BooleanArray(0)
  /** This frame: the lit note and its neighbours (no boxing on lookups). */
  private var nearby = BooleanArray(0)

  private fun setUp(vm: MindMapViewModel) {
    val g = vm.graph
    generation = vm.generation
    n = g.nodes.size
    val hex = g.nodes.map { it.color }.distinct()
    palette = IntArray(hex.size) { parse(hex[it]) }
    colors = IntArray(n) { hex.indexOf(g.nodes[it].color) }
    byColour = (0 until n).sortedBy { colors[it] }.toIntArray()
    colourStart = IntArray(hex.size + 1).also { s -> var c = 0; for (p in hex.indices) { s[p] = c; c += colors.count { it == p } }; s[hex.size] = n }
    val m = g.links.size
    val bucket = IntArray(m) { Math.round(BrainWeb.linkAlpha(g.links[it].w, false) * 200).toInt().coerceIn(0, 71) }
    linkOrder = (0 until m).sortedBy { bucket[it] }.toIntArray()
    bucketStart = IntArray(73).also { s -> var c = 0; for (b in 0..71) { s[b] = c; c += bucket.count { it == b } }; s[72] = m }
    labels = arrayOfNulls(n)
    widthRegular = FloatArray(n) { Float.NaN }
    widthLit = FloatArray(n) { Float.NaN }
    fadeFor = -1.0
    sx = FloatArray(n); sy = FloatArray(n); radius = FloatArray(n)
    pts = FloatArray(maxOf(4, m * 4))
    visible = IntArray(n); visibleAlpha = FloatArray(n); visibleLit = BooleanArray(n)
    nearby = BooleanArray(n)
  }

  private fun parse(hex: String): Int = 0xFF000000.toInt() or (hex.removePrefix("#").toIntOrNull(16) ?: 0x8A97A3)

  private fun label(i: Int, vm: MindMapViewModel): String =
    labels[i] ?: BrainWeb.shortLabel(vm.graph.nodes[i].label).also { labels[i] = it }

  private fun width(i: Int, vm: MindMapViewModel, lit: Boolean): Float {
    val cached = if (lit) widthLit[i] else widthRegular[i]
    if (!cached.isNaN()) return cached
    ink.typeface = if (lit) mediumFace else regularFace
    val w = ink.measureText(label(i, vm))
    if (lit) widthLit[i] = w else widthRegular[i] = w
    return w
  }

  /** [w], [h] in dp; the canvas is scaled by [density] here so everything below is in dp. */
  fun draw(canvas: Canvas, density: Float, w: Float, h: Float, vm: MindMapViewModel, dark: Boolean) {
    val g = vm.graph
    val f = vm.engine.front
    if (g.nodes.isEmpty() || f.generation != vm.generation || f.xs.size != g.nodes.size) return
    if (generation != vm.generation || n != g.nodes.size) setUp(vm)
    val s = vm.settings
    val v = vm.view
    val k = v.k.toFloat()
    val ox = (w / 2 - v.cx * v.k).toFloat(); val oy = (h / 2 - v.cy * v.k).toFloat()
    for (i in 0 until n) { sx[i] = f.xs[i] * k + ox; sy[i] = f.ys[i] * k + oy }
    val hover = vm.hoverIndex ?: -1
    nearby.fill(false)
    if (hover >= 0) { nearby[hover] = true; for (j in vm.adjacency[hover]) nearby[j] = true }
    val near = nearby
    val margin = 24f
    fun offscreen(a: Int, b: Int) = (sx[a] < -margin && sx[b] < -margin) || (sx[a] > w + margin && sx[b] > w + margin) ||
      (sy[a] < -margin && sy[b] < -margin) || (sy[a] > h + margin && sy[b] > h + margin)
    val base = if (dark) 0xDCE2E6 else 0x1E2226

    canvas.save()
    canvas.scale(density, density)

    // Lines. Unlit: rgba(base, 0.1 + min(0.25, w·0.4)), or 0.05 while a note is lit; lit: the source's colour.
    val links = g.links
    line.strokeWidth = (0.6 * s.linkWidth).toFloat()
    if (hover >= 0) {
      var c = 0
      for (li in links.indices) {
        val l = links[li]
        if (l.source == hover || l.target == hover || offscreen(l.source, l.target)) continue
        pts[c++] = sx[l.source]; pts[c++] = sy[l.source]; pts[c++] = sx[l.target]; pts[c++] = sy[l.target]
      }
      line.color = (Math.round(0.05 * 255).toInt() shl 24) or base
      if (c > 0) canvas.drawLines(pts, 0, c, line)
      line.strokeWidth = (1.6 * s.linkWidth).toFloat()
      for (li in links.indices) {
        val l = links[li]
        if (l.source != hover && l.target != hover) continue
        line.color = palette[colors[l.source]]
        canvas.drawLine(sx[l.source], sy[l.source], sx[l.target], sy[l.target], line)
      }
    } else {
      for (b in 0..71) {
        val from = bucketStart[b]; val to = bucketStart[b + 1]
        if (from == to) continue
        var c = 0
        for (o in from until to) {
          val l = links[linkOrder[o]]
          if (offscreen(l.source, l.target)) continue
          pts[c++] = sx[l.source]; pts[c++] = sy[l.source]; pts[c++] = sx[l.target]; pts[c++] = sy[l.target]
        }
        if (c == 0) continue
        line.color = (Math.round(b / 200.0 * 255).toInt() shl 24) or base
        canvas.drawLines(pts, 0, c, line)
      }
    }

    // Dots, a colour at a time; the ones away from a lit note at 0.15.
    for (i in 0 until n) radius[i] = (BrainWeb.radius(g.nodes[i].degree, s.nodeSize) * k).toFloat()
    for (p in palette.indices) {
      dot.color = palette[p]
      for (o in colourStart[p] until colourStart[p + 1]) {
        val i = byColour[o]
        val r = radius[i]
        if (sx[i] + r < 0 || sx[i] - r > w || sy[i] + r < 0 || sy[i] - r > h) continue
        dot.alpha = if (hover >= 0 && !near[i]) 38 else 255
        canvas.drawCircle(sx[i], sy[i], r, dot)
      }
    }

    // The selected (and local-graph) ring, 2.5 out, 2 wide; the amber pin dot, 1.8.
    ring.color = if (dark) 0xFFFFFFFF.toInt() else 0xFF111111.toInt()
    val ringA = vm.selected?.let { vm.index[it] } ?: -1
    val ringB = vm.local?.let { vm.index[it.id] } ?: -1
    for (i in if (ringB >= 0 && ringB != ringA) intArrayOf(ringA, ringB) else intArrayOf(ringA)) {
      if (i < 0) continue
      ring.alpha = if (hover >= 0 && !near[i]) 38 else 255
      canvas.drawCircle(sx[i], sy[i], radius[i] + 2.5f, ring)
    }
    dot.color = if (dark) 0xFFF5C451.toInt() else 0xFFA0620A.toInt()
    for (i in vm.pinned) {
      if (i >= n) continue
      dot.alpha = if (hover >= 0 && !near[i]) 38 else 255
      canvas.drawCircle(sx[i] + radius[i] * 0.75f, sy[i] - radius[i] * 0.75f, 1.8f, dot)
    }

    // Labels: fade in past the threshold (hubs a little sooner); a lit neighbourhood always; a label
    // only where no earlier one is (hubs drawn first win), except lit ones, which always draw.
    if (fadeFor != s.textFade) {
      fadeFor = s.textFade
      fadeAt = DoubleArray(n) { s.textFade / (1 + minOf(1.2, g.nodes[it].degree / 8.0)) }
    }
    val far = 160f
    claims.reset(-far - 16, h + 2 * far + 48, n)
    val selectedIndex = vm.selected?.let { vm.index[it] } ?: -1
    var count = 0
    for (i in 0 until n) {
      val x = sx[i]; val ty = sy[i] + radius[i] + 2
      if (x < -far || x > w + far || ty < -far || ty > h + far) continue
      var lit = selectedIndex == i
      if (hover >= 0) { if (!near[i]) continue; lit = true }
      val alpha = if (lit) 1.0 else ((v.k - fadeAt[i]) / (fadeAt[i] * 0.5)).coerceIn(0.0, 1.0)
      if (alpha <= 0.02) continue
      val tw = width(i, vm, lit)
      val x0 = x - tw / 2
      if (lit) claims.push(x0, ty, x0 + tw, ty + 10.5f) else if (!claims.claim(x0, ty, x0 + tw, ty + 10.5f)) continue
      if (x0 + tw < 0 || x0 > w || ty + 10.5f < 0 || ty > h) continue
      visible[count] = i; visibleAlpha[count] = alpha.toFloat(); visibleLit[count] = lit; count++
    }
    val haloColor = if (dark) 0x111315 else 0xFFFFFF
    val haloAlpha = if (dark) 0.85f else 0.9f
    val inkColor = if (dark) 0xECEFF1 else 0x16181A
    val inkAlpha = if (dark) 0.95f else 0.92f
    for (o in 0 until count) {
      val i = visible[o]
      val face = if (visibleLit[o]) mediumFace else regularFace
      halo.typeface = face; ink.typeface = face
      val text = label(i, vm)
      val tw = width(i, vm, visibleLit[o])
      val x0 = sx[i] - tw / 2
      // textBaseline "top": the baseline one ascent below the top.
      val baseline = sy[i] + radius[i] + 2 - ink.ascent()
      halo.color = (Math.round(haloAlpha * visibleAlpha[o] * 255) shl 24) or haloColor
      ink.color = (Math.round(inkAlpha * visibleAlpha[o] * 255) shl 24) or inkColor
      canvas.drawText(text, x0, baseline, halo)
      canvas.drawText(text, x0, baseline, ink)
    }
    canvas.restore()
  }
}

/**
 * The labels placed this frame (the desktop's labelsDrawn), bucketed into 16 dp rows: each row a
 * linked list through flat arrays, so a claim checks only nearby labels and nothing is allocated.
 */
internal class Claims {
  private var cap = 0
  private var top = 0f
  private var rowCount = 0
  private var count = 0
  private var links = 0
  private var x0 = FloatArray(0); private var y0 = FloatArray(0); private var x1 = FloatArray(0); private var y1 = FloatArray(0)
  private var head = IntArray(0)
  private var item = IntArray(0); private var next = IntArray(0)

  fun reset(top: Float, height: Float, capacity: Int) {
    this.top = top
    rowCount = (height / 16).toInt() + 2
    if (head.size < rowCount) head = IntArray(rowCount)
    head.fill(-1, 0, rowCount)
    if (capacity > cap) {
      x0 = FloatArray(capacity); y0 = FloatArray(capacity); x1 = FloatArray(capacity); y1 = FloatArray(capacity)
      item = IntArray(capacity * 3); next = IntArray(capacity * 3)
      cap = capacity
    }
    count = 0; links = 0
  }

  private fun row(y: Float): Int = ((y - top) / 16).toInt().coerceIn(0, rowCount - 1)

  fun push(a: Float, b: Float, c: Float, d: Float) {
    if (count >= cap) return
    val i = count++
    x0[i] = a; y0[i] = b; x1[i] = c; y1[i] = d
    var r = row(b)
    val last = row(d)
    while (r <= last && links < cap * 3) {
      item[links] = i; next[links] = head[r]; head[r] = links; links++
      r++
    }
  }

  /** Takes the space unless an earlier label overlaps it. */
  fun claim(a: Float, b: Float, c: Float, d: Float): Boolean {
    var r = row(b)
    val last = row(d)
    while (r <= last) {
      var l = head[r]
      while (l >= 0) {
        val j = item[l]
        if (a < x1[j] && c > x0[j] && b < y1[j] && d > y0[j]) return false
        l = next[l]
      }
      r++
    }
    push(a, b, c, d)
    return true
  }
}
