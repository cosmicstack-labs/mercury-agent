import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The phone's own look: its tint (Mercury's green unless changed) and light or dark, kept on
/// this device only. Mercury Desktop has the same tints (apps/desktop/src/styles/tokens.css,
/// `data-tint`): each preset is a light and a dark shade picked to read on its ground. Any view
/// that draws `Theme.accent` follows a change at once (it reads this observable store).
@Observable
public final class Appearance: @unchecked Sendable {
  public static let shared = Appearance()

  public enum Mode: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark
    public var id: String { rawValue }
    public var label: String { rawValue.capitalized }
    public var scheme: ColorScheme? { self == .light ? .light : self == .dark ? .dark : nil }
  }

  /// The chosen tint as "#RRGGBB" (a preset's light shade, or a custom colour). Nil: Mercury's own.
  public private(set) var tintHex: String?
  public var mode: Mode { didSet { if persists { defaults.set(mode.rawValue, forKey: Self.modeKey) } } }

  /// The tint and the colour of text on it, each with a light and a dark shade.
  public private(set) var accent: Color
  public private(set) var onAccent: Color
  /// The same, as numbers (for drawing by hand: the call orb).
  public private(set) var pair: Tint.Pair

  static let tintKey = "appearance.tint"
  static let modeKey = "appearance.theme"
  @ObservationIgnored let defaults: UserDefaults
  @ObservationIgnored var persists = true

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let hex = defaults.string(forKey: Self.tintKey)
    let pair = Tint.pair(for: hex)
    tintHex = pair == Tint.mercury.pair ? nil : hex
    mode = Mode(rawValue: defaults.string(forKey: Self.modeKey) ?? "") ?? .system
    self.pair = pair
    accent = Color(light: pair.light, dark: pair.dark)
    onAccent = Color(light: pair.onLight, dark: pair.onDark)
  }

  /// Picks a tint ("#RRGGBB"); nil goes back to Mercury's green.
  public func setTint(_ hex: String?) {
    let pair = Tint.pair(for: hex)
    let normal = pair == Tint.mercury.pair ? nil : hex.flatMap(Tint.rgb).map(Tint.hex)
    guard normal != tintHex else { return }
    tintHex = normal
    self.pair = pair
    accent = Color(light: pair.light, dark: pair.dark)
    onAccent = Color(light: pair.onLight, dark: pair.onDark)
    if persists {
      if let normal { defaults.set(normal, forKey: Self.tintKey) } else { defaults.removeObject(forKey: Self.tintKey) }
    }
  }

  /// The preset the tint is, if it is one.
  public var preset: Tint.Preset? { Tint.presets.first { $0.pair == pair } }

  /// Shows a tint without remembering it (the Snapshots tool), then puts the old one back.
  @MainActor
  public func previewing<T>(_ hex: String?, _ body: () throws -> T) rethrows -> T {
    let old = tintHex
    persists = false
    setTint(hex)
    defer { setTint(old); persists = true }
    return try body()
  }

  /// The accent in one appearance (for drawing by hand).
  public func accent(dark: Bool) -> Color { Color(hex: dark ? pair.dark : pair.light) }

  #if canImport(UIKit)
  /// UIKit's own pieces (alerts, menus, the keyboard) follow the windows' tint and style.
  @MainActor
  public func applyToWindows() {
    let style: UIUserInterfaceStyle = mode == .light ? .light : mode == .dark ? .dark : .unspecified
    let tint = UIColor(accent)
    for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
      for w in scene.windows {
        w.overrideUserInterfaceStyle = style
        w.tintColor = tint
      }
    }
  }
  #endif
}

/// Tints: presets, hex, and legibility (WCAG contrast). Pure, so it's tested.
public enum Tint {
  /// A tint in both appearances, and the text colour on each.
  public struct Pair: Equatable, Sendable {
    public var light: UInt32, dark: UInt32, onLight: UInt32, onDark: UInt32
  }

  public struct Preset: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var light: UInt32
    public var dark: UInt32
    public var pair: Pair { Pair(light: light, dark: dark, onLight: Tint.on(light), onDark: Tint.on(dark)) }
    public var hex: String { Tint.hex(light) }
  }

  /// The grounds a tint must read on (Theme.bg).
  public static let lightGround: UInt32 = 0xF7F7F5
  public static let darkGround: UInt32 = 0x0F1113
  /// Dark text on a light tint: Mercury's ground, not pure black.
  public static let darkText: UInt32 = 0x0F1113

  /// Mercury's own green, first. Teal, violet, amber and graphite are Mercury Desktop's tints.
  public static let mercury = Preset(id: "mercury", name: "Mercury", light: 0x1A9E6E, dark: 0x34E1A1)
  public static let presets: [Preset] = [
    mercury,
    Preset(id: "teal", name: "Teal", light: 0x0E7C8C, dark: 0x7FD8E8),
    Preset(id: "blue", name: "Blue", light: 0x1F6FD1, dark: 0x6AA8FF),
    Preset(id: "indigo", name: "Indigo", light: 0x4B47C6, dark: 0x9D9AFF),
    Preset(id: "violet", name: "Violet", light: 0x6D4CCC, dark: 0xB19CFF),
    Preset(id: "pink", name: "Pink", light: 0xC0367A, dark: 0xFF8AC4),
    Preset(id: "red", name: "Red", light: 0xC8323F, dark: 0xFF7A85),
    Preset(id: "orange", name: "Orange", light: 0xB9531A, dark: 0xFF9F5C),
    Preset(id: "amber", name: "Amber", light: 0xA0620A, dark: 0xF5C451),
    Preset(id: "green", name: "Green", light: 0x3A862E, dark: 0x8BD97A),
    Preset(id: "graphite", name: "Graphite", light: 0x4B5157, dark: 0xAEB6BC),
  ]

  /// A preset by its hex; any other colour is used as given, made legible on each ground.
  public static func pair(for hex: String?) -> Pair {
    guard let hex, let rgb = rgb(hex) else { return mercury.pair }
    if let p = presets.first(where: { $0.light == rgb }) { return p.pair }
    let light = legible(rgb, on: lightGround)
    let dark = legible(rgb, on: darkGround)
    return Pair(light: light, dark: dark, onLight: on(light), onDark: on(dark))
  }

  /// "#1A9E6E", "1a9e6e", "#19E" → 0x1A9E6E.
  public static func rgb(_ hex: String) -> UInt32? {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
    return v
  }

  public static func hex(_ rgb: UInt32) -> String { String(format: "#%06X", rgb & 0xFFFFFF) }

  /// A SwiftUI colour as "#RRGGBB" (sRGB, clamped).
  public static func hex(_ color: Color) -> String {
    let r = color.resolve(in: EnvironmentValues())
    func byte(_ v: Float) -> UInt32 { UInt32((min(max(v, 0), 1) * 255).rounded()) }
    return hex(byte(r.red) << 16 | byte(r.green) << 8 | byte(r.blue))
  }

  /// WCAG relative luminance.
  public static func luminance(_ rgb: UInt32) -> Double {
    func ch(_ v: UInt32) -> Double {
      let c = Double(v & 0xFF) / 255
      return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * ch(rgb >> 16) + 0.7152 * ch(rgb >> 8) + 0.0722 * ch(rgb)
  }

  /// WCAG contrast ratio, 1…21.
  public static func contrast(_ a: UInt32, _ b: UInt32) -> Double {
    let (x, y) = (luminance(a), luminance(b))
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)
  }

  /// Text on a tint: white while it reads (3:1, the bar for bold UI text), else dark.
  public static func on(_ tint: UInt32) -> UInt32 {
    let white = contrast(tint, 0xFFFFFF)
    return white >= 3 || white >= contrast(tint, darkText) ? 0xFFFFFF : darkText
  }

  /// The colour moved toward white or black, a tenth at a time, until it reads on `ground` (3:1).
  public static func legible(_ rgb: UInt32, on ground: UInt32, minimum: Double = 3) -> UInt32 {
    let toward: UInt32 = luminance(ground) > 0.5 ? 0x000000 : 0xFFFFFF
    var c = rgb
    var k = 0.0
    while contrast(c, ground) < minimum && k < 1 {
      k += 0.1
      c = mix(rgb, toward, k)
    }
    return c
  }

  static func mix(_ a: UInt32, _ b: UInt32, _ t: Double) -> UInt32 {
    func ch(_ s: UInt32) -> UInt32 {
      let x = Double((a >> s) & 0xFF), y = Double((b >> s) & 0xFF)
      return UInt32((x + (y - x) * t).rounded()) << s
    }
    return ch(16) | ch(8) | ch(0)
  }
}
