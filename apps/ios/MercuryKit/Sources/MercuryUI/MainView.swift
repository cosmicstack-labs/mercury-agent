import SwiftUI
import MercuryCore

/// The app once connected: Chats, Artifacts and More.
struct MainView: View {
  var store: ConnectionStore
  var connection: Connection
  @State var chats: ChatsModel
  @State var path = NavigationPath()
  @State var artifacts: ArtifactsModel
  @State var call: VoiceCallModel?

  enum Route: Hashable { case newChat }

  func conversation(_ t: ChatThread?) -> some View {
    let m = ConversationModel(client: store.client(for: connection), thread: t)
    m.onChange = { [chats] in Task { await chats.load() } }
    return ConversationView(model: m)
  }

  init(store: ConnectionStore, connection: Connection) {
    self.store = store; self.connection = connection
    _chats = State(initialValue: ChatsModel(client: store.client(for: connection)))
    _artifacts = State(initialValue: ArtifactsModel(client: store.client(for: connection)))
  }

  var body: some View {
    TabView {
      NavigationStack(path: $path) {
        ChatsView(model: chats, connection: connection, onNewChat: { path.append(Route.newChat) }, onCall: {
          let m = ConversationModel(client: store.client(for: connection), thread: nil)
          m.onChange = { [chats] in Task { await chats.load() } }
          let c = VoiceCallModel(conversation: m)
          // No conversation screen sits under this call: it closes the stream when it ends.
          c.ownsConversation = true
          call = c
        })
          .navigationDestination(for: ChatThread.self) { t in conversation(t) }
          .navigationDestination(for: Route.self) { _ in conversation(nil) }
      }
      .tabItem { Label("Chats", systemImage: "bubble.left") }
      .callCover($call)

      NavigationStack { ArtifactsView(model: artifacts) }
        .tabItem { Label("Artifacts", systemImage: "square.stack.3d.up") }

      NavigationStack { MoreView(store: store, connection: connection) }
      .tabItem { Label("More", systemImage: "ellipsis") }
    }
  }
}
