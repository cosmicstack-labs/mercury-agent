import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The phone's own look: light, dark or the system's, kept on this device only. The app is
/// monochrome (Theme), so there is no tint to pick.
@Observable
public final class Appearance: @unchecked Sendable {
  public static let shared = Appearance()

  public enum Mode: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark
    public var id: String { rawValue }
    public var label: String { rawValue.capitalized }
    public var scheme: ColorScheme? { self == .light ? .light : self == .dark ? .dark : nil }
  }

  public var mode: Mode { didSet { defaults.set(mode.rawValue, forKey: Self.modeKey) } }

  static let modeKey = "appearance.theme"
  /// Where the old tint was kept: cleared, so a phone that had one doesn't carry it around.
  static let oldTintKey = "appearance.tint"
  @ObservationIgnored let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    mode = Mode(rawValue: defaults.string(forKey: Self.modeKey) ?? "") ?? .system
    defaults.removeObject(forKey: Self.oldTintKey)
  }

  #if canImport(UIKit)
  /// UIKit's own pieces (alerts, menus, the keyboard) follow the windows' style; their tint is ink.
  @MainActor
  public func applyToWindows() {
    let style: UIUserInterfaceStyle = mode == .light ? .light : mode == .dark ? .dark : .unspecified
    let tint = UIColor(Theme.accent)
    for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
      for w in scene.windows {
        w.overrideUserInterfaceStyle = style
        w.tintColor = tint
      }
    }
  }
  #endif
}
