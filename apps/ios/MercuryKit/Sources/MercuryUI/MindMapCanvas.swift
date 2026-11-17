import SwiftUI
import CoreText
import MercuryCore
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Draws the mind map the way Mercury Desktop's NoteWeb does (force-graph's canvas), in screen space:
/// lines first (batched by colour and opacity: a few paths, not one per line), then dots batched per
/// colour (dimmed ones apart), the selected ring, the amber pin dots, then labels in draw order
/// (hubs first) with the desktop's claim-the-space rule. Labels are cached glyph outlines, stroked
/// with a halo and filled like the desktop's strokeText/fillText. Sizes follow force-graph: dots
/// scale with zoom; line widths, rings, pin dots and label text stay the same on screen.
@MainActor
final class MindMapRenderer {
  private var labels: [String: Glyphs] = [:]
  private var shortLabels: [String: String] = [:]
  private var colors: [String: Color] = [:]
  private var sx: [CGFloat] = []
  private var sy: [CGFloat] = []
  /// Per node of the current graph: its label's outline, regular and lit (built on first use).
  private var generation = -1
  private var regular: [Glyphs?] = []
  private var lit: [Glyphs?] = []
  private var degree: [Double] = []
  private var fadeAt: [Double] = []
  private var fadeFor = -1.0
  private let claims = Claims()

  struct Glyphs {
    var path: Path
    var width: CGFloat
  }

  // The desktop's colours (NoteWeb.tsx drawNode / linkColor).
  static func lineBase(_ dark: Bool) -> (Double, Double, Double) { dark ? (220, 226, 230) : (30, 34, 38) }
  static func ring(_ dark: Bool) -> Color { dark ? Color(hex: 0xFFFFFF) : Color(hex: 0x111111) }
  static func pin(_ dark: Bool) -> Color { dark ? Color(hex: 0xF5C451) : Color(hex: 0xA0620A) }
  static func halo(_ dark: Bool) -> Color { dark ? rgba(17, 19, 21, 0.85) : rgba(255, 255, 255, 0.9) }
  static func ink(_ dark: Bool) -> Color { dark ? rgba(236, 239, 241, 0.95) : rgba(22, 24, 26, 0.92) }
  static func rgba(_ r: Double, _ g: Double, _ b: Double, _ a: Double) -> Color { Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: a) }

  func color(_ hex: String) -> Color {
    if let c = colors[hex] { return c }
    let c = Color(hexString: hex)
    colors[hex] = c
    return c
  }

  func label(_ id: String, _ text: String) -> String {
    if let s = shortLabels[id] { return s }
    let s = BrainWeb.shortLabel(text)
    shortLabels[id] = s
    return s
  }

  /// A label's outline at 10.5 pt (weight 500 when lit, 400 otherwise), top at y = 0, left at x = 0.
  func glyphs(_ text: String, medium: Bool) -> Glyphs {
    let key = (medium ? "5|" : "4|") + text
    if let g = labels[key] { return g }
    let g = Self.outline(text, medium: medium)
    labels[key] = g
    return g
  }

  static func outline(_ text: String, medium: Bool) -> Glyphs {
    #if canImport(UIKit)
    let font = UIFont.systemFont(ofSize: 10.5, weight: medium ? .medium : .regular) as CTFont
    #else
    let font = NSFont.systemFont(ofSize: 10.5, weight: medium ? .medium : .regular) as CTFont
    #endif
    let attr = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
    let line = CTLineCreateWithAttributedString(attr)
    let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    let ascent = CTFontGetAscent(font)
    let path = CGMutablePath()
    for run in (CTLineGetGlyphRuns(line) as? [CTRun]) ?? [] {
      let attrs = CTRunGetAttributes(run) as NSDictionary
      let runFont = (attrs[kCTFontAttributeName as String] as! CTFont?) ?? font
      let n = CTRunGetGlyphCount(run)
      var glyphs = [CGGlyph](repeating: 0, count: n)
      var positions = [CGPoint](repeating: .zero, count: n)
      CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
      CTRunGetPositions(run, CFRange(location: 0, length: n), &positions)
      for i in 0..<n {
        // Core Text draws y-up from the baseline; the canvas's textBaseline "top" puts the baseline one ascent down.
        var t = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: positions[i].x, ty: ascent - positions[i].y)
        if let p = CTFontCreatePathForGlyph(runFont, glyphs[i], &t) { path.addPath(p) }
      }
    }
    return Glyphs(path: Path(path), width: width)
  }

  func draw(_ ctx: GraphicsContext, size: CGSize, model m: MindMapModel, dark: Bool) {
    let g = m.graph
    let f = m.engine.front
    let n = g.nodes.count
    guard n > 0, f.generation == m.generation, f.xs.count == n else { return }
    let v = m.view, k = v.k
    let W = size.width, H = size.height
    let ox = W / 2 - v.cx * k, oy = H / 2 - v.cy * k
    if sx.count < n { sx = Array(repeating: 0, count: n); sy = sx }
    for i in 0..<n { sx[i] = CGFloat(Double(f.xs[i]) * k + ox); sy[i] = CGFloat(Double(f.ys[i]) * k + oy) }
    let s = m.settings
    let hover = m.hoverIndex
    let adj = m.adjacency
    let hoverAdj: Set<Int> = hover.map { adj[$0] } ?? []
    func near(_ i: Int) -> Bool { hover == i || hoverAdj.contains(i) }
    let margin: CGFloat = 24
    func offscreen(_ a: Int, _ b: Int) -> Bool {
      (sx[a] < -margin && sx[b] < -margin) || (sx[a] > W + margin && sx[b] > W + margin)
        || (sy[a] < -margin && sy[b] < -margin) || (sy[a] > H + margin && sy[b] > H + margin)
    }
    let base = Self.lineBase(dark)

    // Lines. Unlit: rgba(base, 0.1 + min(0.25, w·0.4)), or 0.05 while a note is lit; lit: the source's colour.
    if let h = hover {
      var faint = Path()
      var lit: [String: Path] = [:]
      for l in g.links where !offscreen(l.source, l.target) {
        if l.source == h || l.target == h {
          lit[g.nodes[l.source].color, default: Path()].addLines([CGPoint(x: sx[l.source], y: sy[l.source]), CGPoint(x: sx[l.target], y: sy[l.target])])
        } else {
          faint.move(to: CGPoint(x: sx[l.source], y: sy[l.source])); faint.addLine(to: CGPoint(x: sx[l.target], y: sy[l.target]))
        }
      }
      ctx.stroke(faint, with: .color(Self.rgba(base.0, base.1, base.2, 0.05)), lineWidth: 0.6 * s.linkWidth)
      for (c, p) in lit { ctx.stroke(p, with: .color(color(c)), lineWidth: 1.6 * s.linkWidth) }
    } else {
      // One path per opacity step of 0.005 (51 at most), the same opacity the desktop gives each line.
      var buckets = [Path?](repeating: nil, count: 72)
      for l in g.links where !offscreen(l.source, l.target) {
        let b = Int((BrainWeb.linkAlpha(w: l.w, hovering: false) * 200).rounded())
        if buckets[b] == nil { buckets[b] = Path() }
        buckets[b]!.move(to: CGPoint(x: sx[l.source], y: sy[l.source]))
        buckets[b]!.addLine(to: CGPoint(x: sx[l.target], y: sy[l.target]))
      }
      for (b, p) in buckets.enumerated() {
        if let p { ctx.stroke(p, with: .color(Self.rgba(base.0, base.1, base.2, Double(b) / 200)), lineWidth: 0.6 * s.linkWidth) }
      }
    }

    // Dots, per colour; the ones away from a lit note at 0.15.
    var dots: [String: Path] = [:]
    var dimDots: [String: Path] = [:]
    var radius = [CGFloat](repeating: 0, count: n)
    for i in 0..<n {
      let r = CGFloat(BrainWeb.radius(degree: g.nodes[i].degree, nodeSize: s.nodeSize) * k)
      radius[i] = r
      if sx[i] + r < 0 || sx[i] - r > W || sy[i] + r < 0 || sy[i] - r > H { continue }
      let rect = CGRect(x: sx[i] - r, y: sy[i] - r, width: r * 2, height: r * 2)
      if hover != nil && !near(i) { dimDots[g.nodes[i].color, default: Path()].addEllipse(in: rect) }
      else { dots[g.nodes[i].color, default: Path()].addEllipse(in: rect) }
    }
    if !dimDots.isEmpty {
      var c = ctx
      c.opacity = 0.15
      for (hex, p) in dimDots { c.fill(p, with: .color(color(hex))) }
    }
    for (hex, p) in dots { ctx.fill(p, with: .color(color(hex))) }

    // The selected (and local-graph) ring, 2.5 px out, 2 px wide; the amber pin dot, 1.8 px.
    var ringed = Set<Int>()
    if let sel = m.selected, let i = m.index[sel] { ringed.insert(i) }
    if let l = m.local, let i = m.index[l.id] { ringed.insert(i) }
    for i in ringed {
      var c = ctx
      if hover != nil && !near(i) { c.opacity = 0.15 }
      let r = radius[i] + 2.5
      c.stroke(Path(ellipseIn: CGRect(x: sx[i] - r, y: sy[i] - r, width: r * 2, height: r * 2)), with: .color(Self.ring(dark)), lineWidth: 2)
    }
    if !m.pinned.isEmpty {
      var bright = Path(), dim = Path()
      for i in m.pinned where i < n {
        let r = radius[i]
        let rect = CGRect(x: sx[i] + r * 0.75 - 1.8, y: sy[i] - r * 0.75 - 1.8, width: 3.6, height: 3.6)
        if hover != nil && !near(i) { dim.addEllipse(in: rect) } else { bright.addEllipse(in: rect) }
      }
      ctx.fill(bright, with: .color(Self.pin(dark)))
      var c = ctx
      c.opacity = 0.15
      c.fill(dim, with: .color(Self.pin(dark)))
    }

    // Labels: fade in past the threshold (hubs a little sooner); a lit neighbourhood always; a label
    // only where no earlier one is (hubs drawn first win), except lit ones, which always draw.
    // Labels well off screen are skipped (they could only claim space no on-screen label needs).
    // The loop runs over raw buffers: it's the hot path, and Debug builds (a device run from Xcode)
    // are slow with arrays of structs.
    if generation != m.generation || regular.count != n {
      generation = m.generation
      regular = Array(repeating: nil, count: n); lit = Array(repeating: nil, count: n)
      degree = g.nodes.map { Double($0.degree) }
      fadeFor = -1
    }
    if fadeFor != s.textFade {
      fadeFor = s.textFade
      fadeAt = degree.map { s.textFade / (1 + Swift.min(1.2, $0 / 8)) }
    }
    let far: CGFloat = 160
    claims.reset(top: -far - 16, height: H + 2 * far + 48, capacity: n)
    let halo = Self.halo(dark), ink = Self.ink(dark)
    let selectedIndex = m.selected.flatMap { m.index[$0] } ?? -1
    let hoverI = hover ?? -1
    var visible: [(i: Int, alpha: Double, lit: Bool)] = []
    fadeAt.withUnsafeBufferPointer { fade in
      sx.withUnsafeBufferPointer { sx in
        sy.withUnsafeBufferPointer { sy in
          var i = 0
          while i < n {
            defer { i &+= 1 }
            let x = sx[i], ty = sy[i] + radius[i] + 2
            if x < -far || x > W + far || ty < -far || ty > H + far { continue }
            var lit = selectedIndex == i
            if hoverI >= 0 {
              if !(hoverI == i || hoverAdj.contains(i)) { continue } // dimmed: no label
              lit = true
            }
            let alpha = lit ? 1 : Swift.max(0, Swift.min(1, (k - fade[i]) / (fade[i] * 0.5)))
            if alpha <= 0.02 { continue }
            let w = width(i, g, medium: lit)
            let x0 = x - w / 2
            if lit { claims.push(x0, ty, x0 + w, ty + 10.5) } else if !claims.claim(x0, ty, x0 + w, ty + 10.5) { continue }
            if x0 + w < 0 || x0 > W || ty + 10.5 < 0 || ty > H { continue }
            visible.append((i, alpha, lit))
          }
        }
      }
    }
    for v in visible {
      let gl = (v.lit ? lit[v.i] : regular[v.i])!
      var c = ctx
      c.opacity = v.alpha
      c.translateBy(x: sx[v.i] - gl.width / 2, y: sy[v.i] + radius[v.i] + 2)
      c.stroke(gl.path, with: .color(halo), style: StrokeStyle(lineWidth: 3, lineJoin: .round))
      c.fill(gl.path, with: .color(ink))
    }
  }

  /// A node's label width (building its outline the first time).
  private func width(_ i: Int, _ g: WebGraph, medium: Bool) -> CGFloat {
    if medium { if let w = lit[i]?.width { return w } } else if let w = regular[i]?.width { return w }
    let gl = glyphs(label(g.nodes[i].id, g.nodes[i].label), medium: medium)
    if medium { lit[i] = gl } else { regular[i] = gl }
    return gl.width
  }

}

/// The labels placed this frame (the desktop's labelsDrawn), bucketed into 16 pt rows: each row a
/// linked list through flat buffers, so a claim checks only nearby labels and nothing is allocated.
final class Claims {
  private var cap = 0, rowCap = 0, rowCount = 0, count = 0, links = 0
  private var top: CGFloat = 0
  private var x0 = UnsafeMutablePointer<CGFloat>.allocate(capacity: 1), y0 = UnsafeMutablePointer<CGFloat>.allocate(capacity: 1)
  private var x1 = UnsafeMutablePointer<CGFloat>.allocate(capacity: 1), y1 = UnsafeMutablePointer<CGFloat>.allocate(capacity: 1)
  private var head = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
  private var item = UnsafeMutablePointer<Int32>.allocate(capacity: 1), next = UnsafeMutablePointer<Int32>.allocate(capacity: 1)

  deinit { for p in [x0, y0, x1, y1] { p.deallocate() }; for p in [head, item, next] { p.deallocate() } }

  func reset(top: CGFloat, height: CGFloat, capacity n: Int) {
    self.top = top
    let rows = Int(height / 16) + 2
    if rows > rowCap { head.deallocate(); head = .allocate(capacity: rows); rowCap = rows }
    rowCount = rows
    head.update(repeating: -1, count: rows)
    if n > cap {
      for p in [x0, y0, x1, y1] { p.deallocate() }
      item.deallocate(); next.deallocate()
      x0 = .allocate(capacity: n); y0 = .allocate(capacity: n); x1 = .allocate(capacity: n); y1 = .allocate(capacity: n)
      item = .allocate(capacity: n * 3); next = .allocate(capacity: n * 3)
      cap = n
    }
    count = 0; links = 0
  }

  @inline(__always) private func row(_ y: CGFloat) -> Int { Swift.min(rowCount - 1, Swift.max(0, Int((y - top) / 16))) }

  func push(_ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ d: CGFloat) {
    guard count < cap else { return }
    let i = count
    x0[i] = a; y0[i] = b; x1[i] = c; y1[i] = d
    count += 1
    var r = row(b)
    let last = row(d)
    while r <= last && links < cap * 3 {
      item[links] = Int32(i); next[links] = head[r]; head[r] = Int32(links); links += 1
      r += 1
    }
  }

  /// Takes the space unless an earlier label overlaps it.
  func claim(_ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ d: CGFloat) -> Bool {
    var r = row(b)
    let last = row(d)
    while r <= last {
      var l = head[r]
      while l >= 0 {
        let j = Int(item[Int(l)])
        if a < x1[j] && c > x0[j] && b < y1[j] && d > y0[j] { return false }
        l = next[Int(l)]
      }
      r += 1
    }
    push(a, b, c, d)
    return true
  }
}

/// The canvas: redraws every display frame while something moves (the simulation, a gesture, a view
/// animation), otherwise only when what it shows changes.
struct MindMapCanvas: View {
  var model: MindMapModel
  /// Snapshots: one still frame, no timeline.
  var still = false
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    // Read here so a change redraws a still canvas.
    let _ = (model.generation, model.selected, model.pinned, model.settings, model.local, model.viewVersion, model.zoomPct)
    let dark = scheme == .dark
    if still {
      canvas(dark, Date())
    } else {
      TimelineView(.animation(minimumInterval: nil, paused: !model.live)) { tl in canvas(dark, tl.date) }
    }
  }

  private func canvas(_ dark: Bool, _ date: Date) -> some View {
    Canvas { ctx, size in
      model.size = size
      model.advance(date)
      model.engine.pull()
      model.renderer.draw(ctx, size: size, model: model, dark: dark)
    }
  }
}
