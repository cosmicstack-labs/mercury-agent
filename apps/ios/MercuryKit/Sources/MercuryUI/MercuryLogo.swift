import SwiftUI
import MercuryCore

/// One of the playful Mercury logos a connection wears (`ConnectionLogos.ids`): the Mercury mark
/// (MercuryMark.swift: the round face, its wings, the stem) on a round colour plate, dressed up:
/// sunglasses, a party hat, headphones… All vector, drawn in the mark's own coordinates on a 660-unit
/// square centred on the face, so it stays crisp from 24 to 96 pt. Android: MercuryLogo.kt draws the
/// same shapes from the same numbers.
public struct MercuryLogo: View {
  var id: String
  public init(_ id: String) { self.id = id }

  public var body: some View {
    let look = LogoLook.of(id)
    Canvas { ctx, size in
      let s = min(size.width, size.height) / LogoLook.side
      ctx.translateBy(x: (size.width - LogoLook.side * s) / 2, y: (size.height - LogoLook.side * s) / 2)
      ctx.scaleBy(x: s, y: s)
      ctx.translateBy(x: -LogoLook.origin.x, y: -LogoLook.origin.y)
      look.draw(in: &ctx)
    }
    .aspectRatio(1, contentMode: .fit)
    .accessibilityLabel("\(LogoLook.of(id).name) Mercury")
  }
}

/// A logo's plate, the mark's colour, and what it wears (under the mark or over it).
struct LogoLook {
  enum Op {
    case fill(String, UInt32)
    case stroke(String, UInt32, CGFloat)
    case fillCircle(CGFloat, CGFloat, CGFloat, UInt32)
    case strokeCircle(CGFloat, CGFloat, CGFloat, UInt32, CGFloat)
    case fillEllipse(CGFloat, CGFloat, CGFloat, CGFloat, UInt32)
    case fillRound(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, UInt32)
    case strokeRound(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, UInt32, CGFloat)
  }

  var name: String
  var plate: UInt32
  var mark: UInt32 = 0xFFFFFFFF
  var eyes = true
  var smile = true
  var under: [Op] = []
  var over: [Op] = []

  static let side: CGFloat = 660
  static let origin = CGPoint(x: 181, y: 152)

  static func of(_ id: String) -> LogoLook { all[id] ?? all[ConnectionLogos.ids[0]]! }

  static func name(_ id: String) -> String { of(id).name }

  // MARK: Drawing

  func draw(in ctx: inout GraphicsContext) {
    let c = CGPoint(x: Self.origin.x + Self.side / 2, y: Self.origin.y + Self.side / 2)
    ctx.fill(Path(ellipseIn: CGRect(x: c.x - Self.side / 2, y: c.y - Self.side / 2, width: Self.side, height: Self.side)), with: .color(Self.color(plate)))
    for op in under { Self.run(op, &ctx) }
    let m = Self.color(mark)
    let w = StrokeStyle(lineWidth: 26, lineCap: .round, lineJoin: .round)
    for d in Self.markStrokes { ctx.stroke(SVGPath.parse(d), with: .color(m), style: w) }
    ctx.stroke(Path(ellipseIn: CGRect(x: 511 - 136.5, y: 495 - 136.5, width: 273, height: 273)), with: .color(m), style: w)
    if eyes {
      ctx.fill(Path(ellipseIn: CGRect(x: 430, y: 476, width: 42, height: 42)), with: .color(m))
      ctx.fill(Path(ellipseIn: CGRect(x: 550, y: 476, width: 42, height: 42)), with: .color(m))
    }
    if smile { ctx.stroke(SVGPath.parse(Self.smile), with: .color(m), style: StrokeStyle(lineWidth: 20, lineCap: .round)) }
    for op in over { Self.run(op, &ctx) }
  }

  static func run(_ op: Op, _ ctx: inout GraphicsContext) {
    func style(_ w: CGFloat) -> StrokeStyle { StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round) }
    switch op {
    case let .fill(d, c): ctx.fill(SVGPath.parse(d), with: .color(color(c)))
    case let .stroke(d, c, w): ctx.stroke(SVGPath.parse(d), with: .color(color(c)), style: style(w))
    case let .fillCircle(x, y, r, c): ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)), with: .color(color(c)))
    case let .strokeCircle(x, y, r, c, w): ctx.stroke(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)), with: .color(color(c)), style: style(w))
    case let .fillEllipse(x, y, rx, ry, c): ctx.fill(Path(ellipseIn: CGRect(x: x - rx, y: y - ry, width: 2 * rx, height: 2 * ry)), with: .color(color(c)))
    case let .fillRound(x, y, w, h, r, c): ctx.fill(Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r), with: .color(color(c)))
    case let .strokeRound(x, y, w, h, r, c, lw): ctx.stroke(Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r), with: .color(color(c)), style: style(lw))
    }
  }

  /// 0xAARRGGBB.
  static func color(_ argb: UInt32) -> Color {
    Color(.sRGB, red: Double((argb >> 16) & 0xFF) / 255, green: Double((argb >> 8) & 0xFF) / 255,
          blue: Double(argb & 0xFF) / 255, opacity: Double((argb >> 24) & 0xFF) / 255)
  }

  /// The wings and the stem (assets/brand/mark.svg).
  static let markStrokes = [
    "M393 414 C378 372 376 334 396 325 C413 318 434 338 452 363",
    "M629 414 C644 372 646 334 626 325 C609 318 588 338 570 363",
    "M511 631.5 L511 699.5 M480.5 677 L542.5 677",
  ]
  static let smile = "M492 540 Q511.5 561 531 540"

  /// A heart centred on (x, y), about 76 wide and 54 tall.
  static func heart(_ x: CGFloat, _ y: CGFloat) -> String {
    "M\(x) \(y + 24) C\(x - 38) \(y - 2) \(x - 34) \(y - 30) \(x - 17) \(y - 30) C\(x - 7) \(y - 30) \(x) \(y - 22) \(x) \(y - 15) "
      + "C\(x) \(y - 22) \(x + 7) \(y - 30) \(x + 17) \(y - 30) C\(x + 34) \(y - 30) \(x + 38) \(y - 2) \(x) \(y + 24) Z"
  }

  // MARK: The set (the same order and numbers as Android's MercuryLogo.kt)

  static let all: [String: LogoLook] = [
    "shades": LogoLook(name: "Shades", plate: 0xFF0CA678, eyes: false, over: [
      .fillRound(403, 470, 96, 60, 22, 0xFF111418),
      .fillRound(523, 470, 96, 60, 22, 0xFF111418),
      .stroke("M497 490 Q511 480 525 490", 0xFF111418, 12),
      .stroke("M405 488 L378 478", 0xFF111418, 12),
      .stroke("M617 488 L644 478", 0xFF111418, 12),
      .stroke("M418 490 L434 478", 0x8CFFFFFF, 7),
      .stroke("M538 490 L554 478", 0x8CFFFFFF, 7),
    ]),
    "party": LogoLook(name: "Party", plate: 0xFFF03E3E, over: [
      .fill("M450 388 L511 222 L572 388 Q511 406 450 388 Z", 0xFFFFD43B),
      .fill("M482.3 300 L539.7 300 L547.7 322 L474.3 322 Z", 0xFF4C6EF5),
      .fill("M465.8 345 L556.2 345 L564.3 367 L457.7 367 Z", 0xFF4C6EF5),
      .fillCircle(511, 220, 20, 0xFFFFFFFF),
      .fillCircle(420, 300, 8, 0xFFFFD43B),
      .fillCircle(612, 262, 7, 0xFFFFFFFF),
      .fillCircle(640, 330, 6, 0xFF4C6EF5),
    ]),
    "headphones": LogoLook(name: "Headphones", plate: 0xFF4263EB, over: [
      .stroke("M352 440 C352 245 670 245 670 440", 0xFF141833, 24),
      .fillRound(322, 430, 60, 132, 28, 0xFF141833),
      .fillRound(640, 430, 60, 132, 28, 0xFF141833),
      .fillRound(338, 452, 16, 88, 8, 0xFF91A7FF),
      .fillRound(668, 452, 16, 88, 8, 0xFF91A7FF),
    ]),
    "wizard": LogoLook(name: "Wizard", plate: 0xFF7048E8, over: [
      .fill("M440 372 Q482 280 552 200 Q560 290 584 372 Z", 0xFF23164F),
      .fillEllipse(511, 374, 150, 24, 0xFF23164F),
      .fill("M515 294 L520.3 308.7 L535.9 309.2 L523.6 318.8 L527.9 333.8 L515 325 L502.1 333.8 L506.4 318.8 L494.1 309.2 L509.7 308.7 Z", 0xFFFFD43B),
      .fillCircle(470, 342, 5, 0xFFFFD43B),
      .fillCircle(553, 260, 4, 0xFFFFD43B),
    ]),
    "astronaut": LogoLook(name: "Astronaut", plate: 0xFF1B2A4A, under: [
      .fillCircle(511, 468, 182, 0x1FFFFFFF),
    ], over: [
      .strokeCircle(511, 468, 182, 0xFFDCE6F5, 22),
      .stroke("M598 342 Q630 368 645 406", 0xB3FFFFFF, 14),
      .fillCircle(300, 300, 5, 0xFFFFFFFF),
      .fillCircle(724, 600, 4, 0xFFFFFFFF),
      .fillCircle(700, 250, 6, 0xFFFFD43B),
    ]),
    "chef": LogoLook(name: "Chef", plate: 0xFFF76707, over: [
      .strokeCircle(468, 322, 42, 0xFFD9480F, 14),
      .strokeCircle(511, 298, 50, 0xFFD9480F, 14),
      .strokeCircle(554, 322, 42, 0xFFD9480F, 14),
      .strokeRound(448, 340, 126, 48, 10, 0xFFD9480F, 14),
      .fillCircle(468, 322, 42, 0xFFFFFFFF),
      .fillCircle(511, 298, 50, 0xFFFFFFFF),
      .fillCircle(554, 322, 42, 0xFFFFFFFF),
      .fillRound(448, 340, 126, 48, 10, 0xFFFFFFFF),
      .stroke("M481 352 L481 376 M511 352 L511 376 M541 352 L541 376", 0xFFF2B48C, 6),
    ]),
    "crown": LogoLook(name: "Crown", plate: 0xFFC2255C, over: [
      .fill("M446 388 L440 312 L480 342 L511 290 L542 342 L582 312 L576 388 Q511 400 446 388 Z", 0xFFFCC419),
      .stroke("M446 388 L440 312 L480 342 L511 290 L542 342 L582 312 L576 388 Q511 400 446 388 Z", 0xFFFCC419, 10),
      .fillCircle(440, 306, 11, 0xFFFCC419),
      .fillCircle(511, 284, 12, 0xFFFCC419),
      .fillCircle(582, 306, 11, 0xFFFCC419),
      .fillCircle(511, 362, 12, 0xFF3BC9DB),
      .fillCircle(470, 368, 7, 0xFFFFFFFF),
      .fillCircle(552, 368, 7, 0xFFFFFFFF),
    ]),
    "sleepy": LogoLook(name: "Sleepy", plate: 0xFF5C677D, eyes: false, smile: false, over: [
      .stroke("M429 495 Q451 515 473 495", 0xFFFFFFFF, 15),
      .stroke("M549 495 Q571 515 593 495", 0xFFFFFFFF, 15),
      .strokeCircle(511, 552, 10, 0xFFFFFFFF, 10),
      .stroke("M650 288 L678 288 L650 316 L678 316", 0xFFFFFFFF, 11),
      .stroke("M690 244 L710 244 L690 264 L710 264", 0xCCFFFFFF, 9),
    ]),
    "wink": LogoLook(name: "Wink", plate: 0xFFF59F00, mark: 0xFF2B1D00, eyes: false, smile: false, over: [
      .fillCircle(451, 497, 21, 0xFF2B1D00),
      .stroke("M549 505 Q571 483 593 505", 0xFF2B1D00, 15),
      .stroke("M478 534 Q511 584 544 534", 0xFF2B1D00, 20),
      .fillCircle(418, 548, 16, 0x8CFF6B6B),
      .fillCircle(604, 548, 16, 0x8CFF6B6B),
    ]),
    "hearts": LogoLook(name: "Heart eyes", plate: 0xFFE64980, eyes: false, smile: false, over: [
      .fill(heart(451, 499), 0xFFA61E4D),
      .fill(heart(571, 499), 0xFFA61E4D),
      .stroke("M478 540 Q511 584 544 540", 0xFFFFFFFF, 20),
      .fill(heart(660, 300), 0x99FFFFFF),
    ]),
    "ninja": LogoLook(name: "Ninja", plate: 0xFF2B2F36, over: [
      .fillRound(378, 412, 266, 40, 8, 0xFFE03131),
      .stroke("M640 428 Q676 410 700 384", 0xFFE03131, 16),
      .stroke("M640 436 Q680 448 702 474", 0xFFE03131, 16),
      .fillCircle(642, 432, 15, 0xFFE03131),
    ]),
    "pirate": LogoLook(name: "Pirate", plate: 0xFF1098AD, eyes: false, smile: false, over: [
      .stroke("M392 430 L640 528", 0xFF15171A, 10),
      .fillEllipse(571, 499, 32, 28, 0xFF15171A),
      .fillCircle(451, 497, 21, 0xFFFFFFFF),
      .stroke("M490 545 Q515 560 538 538", 0xFFFFFFFF, 18),
      .strokeCircle(386, 432, 12, 0xFFFCC419, 7),
    ]),
  ]
}

/// The few SVG path commands the logos use (absolute M, L, Q, C, Z), parsed into a Path.
enum SVGPath {
  static func parse(_ d: String) -> Path {
    var path = Path()
    var nums: [CGFloat] = []
    var cmd: Character = "M"
    func flush() {
      var i = 0
      func p() -> CGPoint { defer { i += 2 }; return CGPoint(x: nums[i], y: nums[i + 1]) }
      switch cmd {
      case "M": while i + 1 < nums.count { let pt = p(); if i == 2 { path.move(to: pt) } else { path.addLine(to: pt) } }
      case "L": while i + 1 < nums.count { path.addLine(to: p()) }
      case "Q": while i + 3 < nums.count { let c = p(); path.addQuadCurve(to: p(), control: c) }
      case "C": while i + 5 < nums.count { let c1 = p(); let c2 = p(); path.addCurve(to: p(), control1: c1, control2: c2) }
      case "Z": path.closeSubpath()
      default: break
      }
      nums = []
    }
    var token = ""
    func number() { if let v = Double(token) { nums.append(CGFloat(v)) }; token = "" }
    for ch in d {
      if ch.isLetter { number(); flush(); cmd = ch }
      else if ch == " " || ch == "," { number() }
      else if ch == "-" && !token.isEmpty { number(); token = "-" }
      else { token.append(ch) }
    }
    number(); flush()
    return path
  }
}

/// A logo on its own, sized: the drawer's header, the switcher's rows, Settings.
struct LogoBadge: View {
  var id: String
  var size: CGFloat = 44
  var body: some View { MercuryLogo(id).frame(width: size, height: size) }
}
