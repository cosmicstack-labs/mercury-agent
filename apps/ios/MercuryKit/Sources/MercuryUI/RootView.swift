import SwiftUI
import MercuryCore

/// Connect when no Mercury is saved yet, otherwise the app.
public struct RootView: View {
  @State var store = ConnectionStore()
  public init() {}

  public var body: some View {
    Group {
      if let active = store.active {
        MainView(store: store, connection: active).id(active.id)
      } else {
        ConnectView(store: store)
      }
    }
    .appearance()
  }
}

extension View {
  /// Ink as the tint and the person's light or dark (Settings → Appearance), on everything under it and on
  /// UIKit's own pieces (alerts, menus), the moment they change.
  public func appearance() -> some View { modifier(AppearanceModifier()) }
}

struct AppearanceModifier: ViewModifier {
  @State private var look = Appearance.shared
  func body(content: Content) -> some View {
    content
      .tint(Theme.accent)
      #if canImport(UIKit)
      .onAppear { look.applyToWindows() }
      .onChange(of: look.mode) { look.applyToWindows() }
      #else
      .preferredColorScheme(look.mode.scheme)
      #endif
  }
}
