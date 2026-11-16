import SwiftUI

/// Mercury's palette, the same tokens as Mercury Desktop (apps/desktop/src/styles/tokens.css):
/// a near-white paper in light mode, Mercury's ground in dark mode, one accent.
/// Amber (needs you) and red (halt) are semantic and fixed. The accent is the person's tint
/// (Settings → Appearance), Mercury's green unless changed: views that draw it follow a change.
public enum Theme {
  public static let bg = Color(light: 0xF7F7F5, dark: 0x0F1113)
  public static let bgSoft = Color(light: 0xF0F0ED, dark: 0x141719)
  public static let surface = Color(light: 0xFFFFFF, dark: 0x171A1D)
  public static let surface2 = Color(light: 0xF3F3F0, dark: 0x1D2125)
  public static let ink = Color(light: 0x16181A, dark: 0xE6EAED)
  public static let ink2 = Color(light: 0x4B5157, dark: 0xAEB6BC)
  public static let ink3 = Color(light: 0x7A8187, dark: 0x7E878E)
  public static let ink4 = Color(light: 0xA3A9AE, dark: 0x545C63)
  public static var accent: Color { Appearance.shared.accent }
  /// Text and icons on the accent: white, or dark when the tint is too light for white.
  public static var onAccent: Color { Appearance.shared.onAccent }
  public static let amber = Color(light: 0xB7791F, dark: 0xF5C451)
  public static let red = Color(light: 0xC53030, dark: 0xFF6B6B)
  public static let cyan = Color(light: 0x0E7C8C, dark: 0x7FD8E8)
  public static let line = Color(light: 0x16181A, dark: 0xFFFFFF).opacity(0.08)

  public static let radius: CGFloat = 18
}

extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255
    )
  }

  /// A color that follows the system's light or dark appearance.
  init(light: UInt32, dark: UInt32) {
    #if canImport(UIKit)
    self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light)) })
    #else
    self.init(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(Color(hex: dark)) : NSColor(Color(hex: light)) })
    #endif
  }
}
