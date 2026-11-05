import SwiftUI

/// The Mercury mark (assets/brand/mark.svg): the round face with its wings, stem and smile.
/// Drawn in the mark's own 338 x 443 viewBox and scaled to fit.
public struct MercuryMark: View {
  var color: Color
  public init(color: Color = Theme.accent) { self.color = color }

  public var body: some View {
    Canvas { ctx, size in
      let s = min(size.width / 338, size.height / 443)
      ctx.translateBy(x: (size.width - 338 * s) / 2, y: (size.height - 443 * s) / 2)
      ctx.scaleBy(x: s, y: s)
      ctx.translateBy(x: -342, y: -292)
      let stroke = StrokeStyle(lineWidth: 25, lineCap: .round, lineJoin: .round)
      var wing = Path()
      wing.move(to: CGPoint(x: 393, y: 414))
      wing.addCurve(to: CGPoint(x: 396, y: 325), control1: CGPoint(x: 378, y: 372), control2: CGPoint(x: 376, y: 334))
      wing.addCurve(to: CGPoint(x: 452, y: 363), control1: CGPoint(x: 413, y: 318), control2: CGPoint(x: 434, y: 338))
      ctx.stroke(wing, with: .color(color), style: stroke)
      ctx.stroke(wing.applying(CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 1022, ty: 0)), with: .color(color), style: stroke)
      ctx.stroke(Path(ellipseIn: CGRect(x: 511 - 136.5, y: 495 - 136.5, width: 273, height: 273)), with: .color(color), style: stroke)
      var stem = Path()
      stem.move(to: CGPoint(x: 511, y: 631.5)); stem.addLine(to: CGPoint(x: 511, y: 699.5))
      stem.move(to: CGPoint(x: 480.5, y: 677)); stem.addLine(to: CGPoint(x: 542.5, y: 677))
      ctx.stroke(stem, with: .color(color), style: stroke)
      ctx.fill(Path(ellipseIn: CGRect(x: 430, y: 476, width: 42, height: 42)), with: .color(color))
      ctx.fill(Path(ellipseIn: CGRect(x: 550, y: 476, width: 42, height: 42)), with: .color(color))
      var smile = Path()
      smile.move(to: CGPoint(x: 492, y: 540))
      smile.addQuadCurve(to: CGPoint(x: 531, y: 540), control: CGPoint(x: 511.5, y: 561))
      ctx.stroke(smile, with: .color(color), style: StrokeStyle(lineWidth: 20, lineCap: .round))
    }
    .accessibilityHidden(true)
  }
}
