import SwiftUI
import MercuryCore

/// Connect when no Mercury is saved yet, otherwise the app.
public struct RootView: View {
  @State var store = ConnectionStore()
  public init() {}

  public var body: some View {
    Group {
      if let active = store.active {
        ConnectedPlaceholder(store: store, connection: active)
      } else {
        ConnectView(store: store)
      }
    }
    .tint(Theme.accent)
  }
}

/// Stands in for the Chats screen (screen 2) until it's built.
struct ConnectedPlaceholder: View {
  var store: ConnectionStore
  var connection: Connection
  @State var health: String = "Checking…"

  var body: some View {
    VStack(spacing: 14) {
      MarkTile(size: 64)
      Text("Connected to \(connection.name)").font(.system(size: 22, weight: .bold))
      Text(health).font(.system(size: 15)).foregroundStyle(Theme.ink2)
      Button("Disconnect") { Task { await store.remove(connection.id) } }.foregroundStyle(Theme.red)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
    .task {
      do {
        let h = try await store.client(for: connection).health()
        health = "Mercury \(h.version ?? "") is online"
      } catch { health = error.localizedDescription }
    }
  }
}
