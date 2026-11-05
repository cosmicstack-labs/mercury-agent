import SwiftUI
import MercuryCore

/// Connect when no Mercury is saved yet, otherwise the app.
public struct RootView: View {
  @State var store = ConnectionStore()
  public init() {}

  public var body: some View {
    Group {
      if let active = store.active {
        MainView(store: store, connection: active)
      } else {
        ConnectView(store: store)
      }
    }
    .tint(Theme.accent)
  }
}
