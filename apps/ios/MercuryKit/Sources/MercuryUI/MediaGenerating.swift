import SwiftUI
import MercuryCore

// Media on its way (ADR-042), as Mercury Desktop draws it (components/MediaSkeleton.tsx and the
// media-* rules in styles/base.css): a placeholder in the shape of what is coming, so nothing
// jumps when it lands. Pictures and video are a soft colour field drifting under a light sweep
// with a breathing icon; sound is moving bars; the words shimmer. Each tile of a batch turns into
// a tick as its picture is ready, and the finished media arrives from soft to sharp. Under Reduce
// Motion everything holds still. The motion is a function of time (one TimelineView per piece),
// so each frame only moves a few gradients.

/// Media on its way: a grid of tiles for pictures and video, a row of bars for music and voice.
/// `quiet`: no status line of its own (inside a running turn the turn's status line says it once).
struct MediaPlaceholder: View {
  var shape: TurnTrace.MediaShape
  var startedAt: Date
  var now: Date
  var done = 0
  var quiet = false

  var body: some View {
    let elapsed = max(0, now.timeIntervalSince(startedAt))
    let total = max(shape.count ?? 1, 1)
    let line = MediaText.describe(MediaBatch(id: "", shape: shape, startedAt: startedAt, done: done, total: total), now: now)
    if shape.kind == "music" || shape.kind == "speech" {
      HStack(spacing: 12) {
        Image(systemName: shape.kind == "music" ? "music.note" : "waveform").font(.system(size: 15)).foregroundStyle(Theme.accent)
          .frame(width: 36, height: 36).background(Theme.accent.opacity(0.12), in: Circle())
        VStack(alignment: .leading, spacing: 6) {
          SoundBars().frame(height: 28)
          HStack(spacing: 8) {
            ShimmerText(text: line + "…").font(.system(size: 12))
            Spacer(minLength: 4)
            Text(TurnTrace.duration(elapsed)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink4)
          }
        }
      }
      .padding(.horizontal, 14).padding(.vertical, 12)
      .background(Theme.ink.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
      .frame(maxWidth: 420, alignment: .leading)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(line)
    } else {
      let tiles = min(total, MediaText.maxTiles)
      let cols = shape.kind == "video" ? 1 : MediaText.columns(tiles)
      let width = Self.maxWidth(shape, tiles: tiles)
      VStack(alignment: .leading, spacing: 6) {
        TileGrid(count: tiles, columns: cols, ratio: MediaText.ratio(shape, tiles: tiles)) { i in
          GeneratingTile(kind: shape.kind, index: i, ready: i < done, small: tiles > 4)
            .overlay(alignment: .bottomTrailing) {
              if i == tiles - 1 && total > tiles {
                Text("+\(total - tiles)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink3)
                  .padding(.horizontal, 5).padding(.vertical, 1).background(Theme.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: 5)).padding(6)
              }
            }
        }
        .frame(maxWidth: width)
        if !quiet {
          HStack(spacing: 8) {
            ShimmerText(text: line + "…").font(.system(size: 12))
            Spacer(minLength: 4)
            Text(TurnTrace.duration(elapsed)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink4)
          }
          .frame(maxWidth: width)
        }
        if let p = shape.prompt, !p.isEmpty {
          Text(p).font(.system(size: 12)).foregroundStyle(Theme.ink4).lineLimit(1).frame(maxWidth: width, alignment: .leading)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(line)
    }
  }

  static func maxWidth(_ s: TurnTrace.MediaShape, tiles: Int) -> CGFloat {
    if s.kind == "video" { return s.aspect == "portrait" ? 240 : 520 }
    return tiles == 1 ? (s.aspect == "portrait" ? 240 : 340) : 520
  }
}

/// One waiting tile: the drifting field, the sweep and a breathing icon; once its picture is
/// ready it settles into the accent with a tick (300 ms, as Desktop's .media-tile-ready).
struct GeneratingTile: View {
  var kind: String
  var index = 0
  var ready = false
  var small = false

  var body: some View {
    ZStack {
      if ready {
        Image(systemName: "checkmark").font(.system(size: small ? 16 : 20, weight: .semibold)).foregroundStyle(Theme.accent)
          .transition(.scale(scale: 0.6).combined(with: .opacity))
      } else {
        GeneratingField(kind: kind, index: index, small: small).transition(.opacity)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ready ? Theme.accent.opacity(0.08) : Theme.ink.opacity(0.035))
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(ready ? Theme.accent.opacity(0.3) : Theme.line))
    .animation(.easeOut(duration: 0.3), value: ready)
  }
}

/// The moving part of a waiting picture: Desktop's .media-aurora (accent and cyan glows drifting
/// over 7 s, there and back), .media-sweep (a slanted light crossing every 2.2 s) and
/// .media-icon (breathing over 2.4 s). Tiles are offset in time, as Desktop staggers them.
struct GeneratingField: View {
  var kind: String
  var index = 0
  var small = false
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.stillMedia) private var stillMedia
  private var reduceMotion: Bool { systemReduceMotion || stillMedia }
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion)) { ctx in
      let t = reduceMotion ? 0 : ctx.date.timeIntervalSinceReferenceDate
      let m = MediaMotion(t: t, index: index, still: reduceMotion)
      GeometryReader { g in
        let w = g.size.width, h = g.size.height
        ZStack {
          // The colour field: three soft glows on a canvas 1.8× the tile, drifting up and left.
          ZStack {
            glow(Theme.accent.opacity(0.22), cx: 0.25, cy: 0.30, rx: 0.60, ry: 0.55, w: w, h: h)
            glow(Theme.cyan.opacity(0.20), cx: 0.75, cy: 0.70, rx: 0.55, ry: 0.50, w: w, h: h)
            glow(Theme.accent.opacity(0.12), cx: 0.60, cy: 0.20, rx: 0.45, ry: 0.45, w: w, h: h)
          }
          .frame(width: w * 1.8, height: h * 1.8)
          .offset(x: -0.8 * w * m.drift + 0.4 * w, y: -0.8 * h * m.drift + 0.4 * h)
          .scaleEffect(1 + 0.08 * m.drift)
          .frame(width: w, height: h)
          // The light passing over it.
          if !reduceMotion {
            sweep(w: w, h: h, x: m.sweep)
          }
          Image(systemName: kind == "video" ? "movieclapper" : "photo")
            .font(.system(size: small ? 20 : 28, weight: .light))
            .foregroundStyle(Theme.ink.opacity(0.3))
            .opacity(m.breathe.opacity)
            .scaleEffect(m.breathe.scale)
        }
        .frame(width: w, height: h)
        .clipped()
      }
    }
    .accessibilityHidden(true)
  }

  /// A radial glow (CSS: radial-gradient(rx ry at cx cy, colour, transparent 70%)) on the 1.8× canvas.
  func glow(_ c: Color, cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat, w: CGFloat, h: CGFloat) -> some View {
    let (W, H) = (w * 1.8, h * 1.8)
    return EllipticalGradient(stops: [.init(color: c, location: 0), .init(color: c.opacity(0), location: 0.7)], center: .center)
      .frame(width: 2 * rx * W, height: 2 * ry * H)
      .position(x: cx * W, y: cy * H)
      .frame(width: W, height: H)
  }

  /// A band of light 105° across (CSS linear-gradient(105deg …) at 250% wide), at `x` of the tile.
  func sweep(w: CGFloat, h: CGFloat, x: CGFloat) -> some View {
    let peak = scheme == .dark ? 0.09 : 0.18
    let side = scheme == .dark ? 0.05 : 0.10
    let band = w * 2.5
    return LinearGradient(stops: [
      .init(color: .white.opacity(0), location: 0.3),
      .init(color: .white.opacity(side), location: 0.45),
      .init(color: .white.opacity(peak), location: 0.5),
      .init(color: .white.opacity(side), location: 0.55),
      .init(color: .white.opacity(0), location: 0.7),
    ], startPoint: .leading, endPoint: .trailing)
      .frame(width: band, height: h * 1.6)
      .rotationEffect(.degrees(15))
      .position(x: x * w, y: h / 2)
      .frame(width: w, height: h)
  }
}

/// Desktop's keyframes as functions of time, so every frame is cheap and a tile can be drawn at
/// any moment (the Snapshots tool draws one). `still`: Reduce Motion.
struct MediaMotion {
  /// 0…1…0 over 7 s each way, eased (media-drift, ease-in-out, alternate).
  var drift: CGFloat
  /// Where the sweep's centre is, in tile widths (media-sweep: off the left edge to off the right, 2.2 s).
  var sweep: CGFloat
  /// The icon (media-breathe: opacity .45→.8, scale 1→1.06 over 2.4 s).
  var breathe: (opacity: Double, scale: CGFloat)

  init(t: Double, index: Int, still: Bool = false) {
    if still {
      drift = 0.35; sweep = -1; breathe = (0.6, 1)
      return
    }
    // Desktop starts each tile's drift 2.3 s further on and its sweep 0.18 s later.
    let d = (t + Double(index) * 2.3).truncatingRemainder(dividingBy: 14) / 7
    let u = d < 1 ? d : 2 - d
    drift = CGFloat(Self.ease(u))
    let s = (t - Double(index) * 0.18).truncatingRemainder(dividingBy: 2.2) / 2.2
    let p = s < 0 ? s + 1 : s
    // background-position 120% → -120% of a 250% band: its centre goes from -0.55 to 3.05 widths.
    sweep = CGFloat(-0.55 + 3.6 * p)
    let b = Self.ease(abs(((t / 2.4).truncatingRemainder(dividingBy: 1)) * 2 - 1))
    breathe = (0.8 - 0.35 * b, CGFloat(1.06 - 0.06 * b))
  }

  /// CSS ease-in-out, closely enough.
  static func ease(_ x: Double) -> Double { x * x * (3 - 2 * x) }
}

/// Sound on its way: Desktop's .media-bar, 32 bars rising and falling (1.1 s, staggered).
struct SoundBars: View {
  var count = 32
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.stillMedia) private var stillMedia
  private var reduceMotion: Bool { systemReduceMotion || stillMedia }

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { ctx in
      let t = ctx.date.timeIntervalSinceReferenceDate
      GeometryReader { g in
        HStack(alignment: .bottom, spacing: 3) {
          ForEach(0..<count, id: \.self) { i in
            let base = 0.3 + Double((i * 37) % 70) / 100
            Capsule().fill(Theme.ink.opacity(0.25))
              .frame(width: 3, height: g.size.height * base)
              .scaleEffect(y: reduceMotion ? 1 : Self.scale(t: t, i: i), anchor: .bottom)
          }
        }
        .frame(maxHeight: .infinity, alignment: .bottom)
      }
    }
    .accessibilityHidden(true)
  }

  /// .35 → 1 and back (ease-in-out, alternate), each bar of eight 0.11 s behind the last.
  static func scale(t: Double, i: Int) -> CGFloat {
    let p = (t - Double(i % 8) * 0.11).truncatingRemainder(dividingBy: 2.2) / 1.1
    let q = p < 0 ? p + 2 : p
    let u = q < 1 ? q : 2 - q
    return CGFloat(0.35 + 0.65 * MediaMotion.ease(u))
  }
}

/// Words of something in progress: a soft light passing over them (Desktop's .shimmer-text,
/// 2.4 s). Plain grey under Reduce Motion. Set the font and line limit outside.
struct ShimmerText: View {
  var text: String
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.stillMedia) private var stillMedia
  private var reduceMotion: Bool { systemReduceMotion || stillMedia }

  var body: some View {
    let plain = Text(text).lineLimit(1)
    if reduceMotion {
      plain.foregroundStyle(Theme.ink3)
    } else {
      plain.foregroundStyle(Theme.ink3)
        .overlay {
          TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
            let p = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
            GeometryReader { g in
              let w = g.size.width
              // background-position 100% → -150% of a 250% gradient: the light goes from -0.25 to 3.5 widths.
              LinearGradient(colors: [Theme.ink.opacity(0), Theme.ink, Theme.ink.opacity(0)], startPoint: .leading, endPoint: .trailing)
                .frame(width: w * 0.5)
                .position(x: w * (-0.25 + 3.75 * p), y: g.size.height / 2)
            }
          }
          .mask(plain)
          .allowsHitTesting(false)
        }
    }
  }
}

/// The real thing arriving: from soft to sharp (Desktop's .media-reveal: blur 18 → 0,
/// a little saturated and large → as it is, 700 ms). `active`: it was just made; each item
/// reveals once, however often it scrolls back into view. Under Reduce Motion it fades in.
struct MediaReveal: ViewModifier {
  var id: String
  var active: Bool
  var delay: Double = 0
  @State private var shown: Bool
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.stillMedia) private var stillMedia
  private var reduceMotion: Bool { systemReduceMotion || stillMedia }

  nonisolated(unsafe) static var revealed: Set<String> = []

  init(id: String, active: Bool, delay: Double = 0) {
    self.id = id; self.active = active; self.delay = delay
    _shown = State(initialValue: !active || MediaReveal.revealed.contains(id))
  }

  func body(content: Content) -> some View {
    content
      .blur(radius: shown || reduceMotion ? 0 : 18)
      .saturation(shown || reduceMotion ? 1 : 1.3)
      .scaleEffect(shown || reduceMotion ? 1 : 1.02)
      .opacity(shown ? 1 : 0.6)
      .onAppear {
        guard !shown else { return }
        MediaReveal.revealed.insert(id)
        let curve: Animation = reduceMotion ? .easeOut(duration: 0.3) : .timingCurve(0.2, 0.7, 0.2, 1, duration: 0.7)
        withAnimation(curve.delay(delay)) { shown = true }
      }
  }

  /// Just made: the reply landed under a minute ago (Desktop's isFresh).
  static func isFresh(_ m: ChatMessage, now: Date = .now) -> Bool {
    now.timeIntervalSince(m.timestamp) < 60
  }
}

extension View {
  func mediaReveal(id: String, active: Bool, delay: Double = 0) -> some View {
    modifier(MediaReveal(id: id, active: active, delay: delay))
  }
}

extension EnvironmentValues {
  /// Media placeholders held still, as under Reduce Motion (the Snapshots tool shows both).
  var stillMedia: Bool {
    get { self[StillMediaKey.self] }
    set { self[StillMediaKey.self] = newValue }
  }
}

private struct StillMediaKey: EnvironmentKey { static let defaultValue = false }
