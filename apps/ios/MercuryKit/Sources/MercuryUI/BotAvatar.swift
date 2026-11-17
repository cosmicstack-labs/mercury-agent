import SwiftUI
import MercuryCore

/// A bot's face, as Mercury Desktop draws it (apps/desktop/src/components/BotAvatar.tsx): the
/// avatar the runtime stores when there is one; otherwise a face drawn from the id, a shape
/// (circle, squircle, shield, hexagon) in a two-tone gradient with two eyes and a smile. Same id,
/// same hue, on every device. Always coloured, never white or black.
struct BotAvatar: View {
  var id: String
  var name: String
  var hasAvatar = false
  var size: CGFloat = 32
  var dimmed = false
  var client: MercuryClient?

  @State var image: Image?

  var body: some View {
    Group {
      if let image {
        image.resizable().scaledToFill().frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.28))
      } else {
        BotFace(id: id).frame(width: size, height: size)
      }
    }
    .opacity(dimmed ? 0.55 : 1)
    .accessibilityLabel(name)
    .task(id: hasAvatar ? id : "") {
      guard hasAvatar, let client else { image = nil; return }
      image = await BotAvatarCache.shared.image(id, client: client)
    }
  }
}

/// Avatars fetched once per bot per launch.
@MainActor
final class BotAvatarCache {
  static let shared = BotAvatarCache()
  var images: [String: Image?] = [:]

  func image(_ id: String, client: MercuryClient) async -> Image? {
    if let hit = images[id] { return hit }
    let data = try? await client.botAvatar(id)
    #if canImport(UIKit)
    let img = data.flatMap(UIImage.init(data:)).map(Image.init(uiImage:))
    #else
    let img = data.flatMap(NSImage.init(data:)).map(Image.init(nsImage:))
    #endif
    images[id] = img
    return img
  }
}

/// The drawn face. Its numbers come from an FNV-1a hash of the id, as on the desktop.
struct BotFace: View {
  var id: String

  struct Look: Equatable {
    var hue: Double
    var hue2: Double
    var shape: Int
    var eyeGap: Double
    var mouth: Int
  }

  /// FNV-1a over UTF-16 code units (JavaScript's charCodeAt), as an unsigned 32-bit number.
  static func hash(_ s: String) -> UInt32 {
    var h: UInt32 = 2166136261
    for u in s.utf16 { h ^= UInt32(u); h = h &* 16777619 }
    return h
  }

  /// The hue matches the desktop exactly. Shape, eyes and mouth use unsigned shifts: the desktop's
  /// signed `>>` gives a negative index for half of all ids, which drew no shape at all.
  static func look(_ id: String) -> Look {
    let h = hash(id)
    let hue = Double(h % 360)
    return Look(hue: hue, hue2: Double((UInt32(hue) + 28 + ((h >> 9) % 40)) % 360), shape: Int((h >> 3) % 4),
                eyeGap: 9 + Double((h >> 12) % 5), mouth: Int((h >> 16) % 3))
  }

  var body: some View {
    let l = Self.look(id)
    Canvas { ctx, size in
      let k = size.width / 100
      func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * k, y: y * k) }
      // The shape at 88%, stroked wide with round joins so every corner is soft.
      var shape = Self.shapePath(l.shape)
      shape = shape.applying(CGAffineTransform(translationX: 6, y: 6).scaledBy(x: 0.88, y: 0.88).concatenating(CGAffineTransform(scaleX: k, y: k)))
      let fill = GraphicsContext.Shading.linearGradient(
        Gradient(colors: [Self.hsl(l.hue, 0.70, 0.62), Self.hsl(l.hue2, 0.72, 0.44)]),
        startPoint: .zero, endPoint: CGPoint(x: size.width, y: size.height))
      ctx.fill(shape, with: fill)
      ctx.stroke(shape, with: fill, style: StrokeStyle(lineWidth: 10 * 0.88 * k, lineJoin: .round))

      let tri = l.shape == 2
      let eyeY: Double = tri ? 36 : 44
      let mouthY: Double = tri ? 52 : 60
      for x in [50 - l.eyeGap, 50 + l.eyeGap] {
        ctx.fill(Path(ellipseIn: CGRect(x: (x - 5.2) * k, y: (eyeY - 5.2) * k, width: 10.4 * k, height: 10.4 * k)), with: .color(.white))
      }
      var mouth = Path()
      switch l.mouth {
      case 0:
        mouth.move(to: p(40, mouthY)); mouth.addQuadCurve(to: p(60, mouthY), control: p(50, mouthY + 9))
        ctx.stroke(mouth, with: .color(.white), style: StrokeStyle(lineWidth: 4.5 * k, lineCap: .round))
      case 1:
        mouth.move(to: p(38, mouthY - 1)); mouth.addQuadCurve(to: p(62, mouthY - 1), control: p(50, mouthY + 12)); mouth.closeSubpath()
        ctx.fill(mouth, with: .color(.white))
      default:
        mouth.move(to: p(44, mouthY)); mouth.addQuadCurve(to: p(56, mouthY), control: p(50, mouthY + 5))
        ctx.stroke(mouth, with: .color(.white), style: StrokeStyle(lineWidth: 4.5 * k, lineCap: .round))
      }
    }
  }

  /// The desktop's four SVG paths, in its 100 x 100 box.
  static func shapePath(_ i: Int) -> Path {
    var p = Path()
    func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }
    switch i {
    case 0:
      p.addEllipse(in: CGRect(x: 4, y: 4, width: 92, height: 92))
    case 1: // squircle
      p.move(to: pt(50, 4))
      p.addCurve(to: pt(96, 50), control1: pt(86, 4), control2: pt(96, 14))
      p.addCurve(to: pt(50, 96), control1: pt(96, 86), control2: pt(86, 96))
      p.addCurve(to: pt(4, 50), control1: pt(14, 96), control2: pt(4, 86))
      p.addCurve(to: pt(50, 4), control1: pt(4, 14), control2: pt(14, 4))
      p.closeSubpath()
    case 2: // shield
      p.move(to: pt(14, 10)); p.addLine(to: pt(86, 10))
      p.addCurve(to: pt(94, 21), control1: pt(92, 10), control2: pt(96, 15))
      p.addLine(to: pt(60, 88))
      p.addCurve(to: pt(40, 88), control1: pt(56, 96), control2: pt(44, 96))
      p.addLine(to: pt(6, 21))
      p.addCurve(to: pt(14, 10), control1: pt(4, 15), control2: pt(8, 10))
      p.closeSubpath()
    default: // hexagon
      p.move(to: pt(50, 3)); p.addLine(to: pt(91, 26)); p.addLine(to: pt(91, 74)); p.addLine(to: pt(50, 97))
      p.addLine(to: pt(9, 74)); p.addLine(to: pt(9, 26)); p.closeSubpath()
    }
    return p
  }

  static func hsl(_ h: Double, _ s: Double, _ l: Double) -> Color {
    let c = (1 - abs(2 * l - 1)) * s
    let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
    let m = l - c / 2
    let (r, g, b): (Double, Double, Double) = switch h {
    case ..<60: (c, x, 0)
    case ..<120: (x, c, 0)
    case ..<180: (0, c, x)
    case ..<240: (0, x, c)
    case ..<300: (x, 0, c)
    default: (c, 0, x)
    }
    return Color(.sRGB, red: r + m, green: g + m, blue: b + m)
  }
}
