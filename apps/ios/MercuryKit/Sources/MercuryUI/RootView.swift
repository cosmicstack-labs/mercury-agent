import SwiftUI
import MercuryCore

/// Connect when no Mercury is saved yet, otherwise the app.
public struct RootView: View {
  @State var store = ConnectionStore()
  /// A `mercury://pair?…` link opened from outside (the iPhone's Camera scanning the computer's QR code).
  @State var pairLink: URL?
  public init() {}

  public var body: some View {
    Group {
      if let active = store.active {
        MainView(store: store, connection: active).id(active.id)
      } else {
        ConnectView(store: store, link: $pairLink)
      }
    }
    // Already connected: the link adds another Mercury, in the connect sheet (it asks first).
    .sheet(item: Binding(get: { store.active == nil ? nil : pairLink.map(OpenedLink.init) }, set: { pairLink = $0?.url })) { l in
      ConnectView(store: store, link: .constant(l.url))
    }
    .onOpenURL { url in if PairLink.isPairLink(url) { pairLink = url } }
    .onChange(of: store.connections.count) { pairLink = nil }
    .appearance()
  }
}

private struct OpenedLink: Identifiable {
  var url: URL
  var id: String { url.absoluteString }
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
