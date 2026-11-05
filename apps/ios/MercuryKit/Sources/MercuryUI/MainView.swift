import SwiftUI
import MercuryCore

/// The app once connected: Chats, Artifacts and More.
struct MainView: View {
  var store: ConnectionStore
  var connection: Connection
  @State var chats: ChatsModel

  init(store: ConnectionStore, connection: Connection) {
    self.store = store; self.connection = connection
    _chats = State(initialValue: ChatsModel(client: store.client(for: connection)))
  }

  var body: some View {
    TabView {
      NavigationStack {
        ChatsView(model: chats, connection: connection)
          .navigationDestination(for: ChatThread.self) { t in
            Text(t.displayTitle).navigationTitle(t.displayTitle) // screen 3
          }
      }
      .tabItem { Label("Chats", systemImage: "bubble.left") }

      NavigationStack { Text("Artifacts").navigationTitle("Artifacts") } // screen 6
        .tabItem { Label("Artifacts", systemImage: "square.stack.3d.up") }

      NavigationStack {
        List {
          Section("Connection") {
            ConnectedLine(name: connection.name)
            Button("Disconnect", role: .destructive) { Task { await store.remove(connection.id) } }
          }
        }
        .navigationTitle("More") // screen 7
      }
      .tabItem { Label("More", systemImage: "ellipsis") }
    }
    .id(connection.id)
  }
}
