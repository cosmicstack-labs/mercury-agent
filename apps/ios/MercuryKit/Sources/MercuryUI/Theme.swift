import SwiftUI

/// Mercury on iPhone is monochrome, like the Android app and the ChatGPT and Grok apps: white
/// paper in light mode, true black in dark mode, greys for surfaces, and ink (black on light,
/// white on dark) for primary actions. Mercury's green lives only in the mark and the small
/// "working" dots; amber (needs you) and red (failed) are the only other colours.
/// The same values as Android's `mercuryColorScheme` (apps/android/…/ui/theme/Color.kt).
public enum Theme {
  public static let bg = Color(Palette.bg)
  /// The side panel and other quiet grounds.
  public static let bgSoft = Color(Palette.bgSoft)
  public static let surface = Color(Palette.surface)
  public static let surface2 = Color(Palette.surface2)
  /// The selected row, the pressed row.
  public static let surface3 = Color(Palette.surface3)
  public static let ink = Color(Palette.ink)
  public static let ink2 = Color(Palette.ink2)
  public static let ink3 = Color(Palette.ink3)
  public static let ink4 = Color(Palette.ink4)
  /// Primary actions: ink.
  public static let accent = Color(Palette.accent)
  /// Text and icons on `accent`.
  public static let onAccent = Color(Palette.onAccent)
  /// Mercury's green: the mark, "working" and "connected" dots. Nowhere else.
  public static let green = Color(Palette.green)
  public static let amber = Color(Palette.amber)
  public static let red = Color(Palette.red)
  /// A neutral stand-in where cyan used to mark thinking: the app stays monochrome.
  public static let cyan = ink3
  public static let line = Color(light: 0x000000, dark: 0xFFFFFF).opacity(0.08)

  public static let radius: CGFloat = 18
}

/// Theme's numbers, light and dark, kept apart so tests can check them without drawing.
public enum Palette {
  public typealias Pair = (light: UInt32, dark: UInt32)
  public static let bg: Pair = (0xFFFFFF, 0x000000)
  public static let bgSoft: Pair = (0xF9F9F9, 0x0E0E0E)
  public static let surface: Pair = (0xFFFFFF, 0x141414)
  public static let surface2: Pair = (0xF4F4F4, 0x1E1E1E)
  public static let surface3: Pair = (0xE8E8E8, 0x282828)
  public static let ink: Pair = (0x0D0D0D, 0xECECEC)
  public static let ink2: Pair = (0x5D5D5D, 0xA3A3A3)
  public static let ink3: Pair = (0x7A7A7A, 0x8E8E8E)
  public static let ink4: Pair = (0xABABAB, 0x5E5E5E)
  public static let accent: Pair = (0x0D0D0D, 0xF2F2F2)
  public static let onAccent: Pair = (0xFFFFFF, 0x000000)
  public static let green: Pair = (0x1A9E6E, 0x34E1A1)
  public static let amber: Pair = (0xB7791F, 0xF5C451)
  public static let red: Pair = (0xC53030, 0xFF6B6B)
  /// Everything but the status colours: greys only.
  public static let monochrome: [Pair] = [bg, bgSoft, surface, surface2, surface3, ink, ink2, ink3, ink4, accent, onAccent]
}

extension Color {
  init(_ p: Palette.Pair) { self.init(light: p.light, dark: p.dark) }

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
