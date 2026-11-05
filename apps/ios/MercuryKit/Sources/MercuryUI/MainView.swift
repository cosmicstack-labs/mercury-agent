import SwiftUI
import MercuryCore

/// The app once connected: Chats, Artifacts and More.
struct MainView: View {
  var store: ConnectionStore
  var connection: Connection
  @State var chats: ChatsModel
  @State var path = NavigationPath()

  enum Route: Hashable { case newChat }

  func conversation(_ t: ChatThread?) -> some View {
    let m = ConversationModel(client: store.client(for: connection), thread: t)
    m.onChange = { [chats] in Task { await chats.load() } }
    return ConversationView(model: m)
  }

  init(store: ConnectionStore, connection: Connection) {
    self.store = store; self.connection = connection
    _chats = State(initialValue: ChatsModel(client: store.client(for: connection)))
  }

  var body: some View {
    TabView {
      NavigationStack(path: $path) {
        ChatsView(model: chats, connection: connection, onNewChat: { path.append(Route.newChat) })
          .navigationDestination(for: ChatThread.self) { t in conversation(t) }
          .navigationDestination(for: Route.self) { _ in conversation(nil) }
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
