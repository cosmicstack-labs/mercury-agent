import SwiftUI
import MercuryCore

/// The app once connected: Chats, Bots, Artifacts and More.
struct MainView: View {
  var store: ConnectionStore
  var connection: Connection
  @State var chats: ChatsModel
  @State var path = NavigationPath()
  @State var artifacts: ArtifactsModel
  @State var bots: BotsModel
  @State var call: VoiceCallModel?
  @State var tab = 0
  @State var notifier = Notifier.shared

  enum Route: Hashable { case newChat }

  func conversation(_ t: ChatThread?) -> some View {
    let m = ConversationModel(client: store.client(for: connection), thread: t)
    m.onChange = { [chats] in Task { await chats.load() } }
    m.onSeen = { [chats] id, open in chats.viewing(id, open: open) }
    return ConversationView(model: m)
  }

  init(store: ConnectionStore, connection: Connection) {
    self.store = store; self.connection = connection
    _chats = State(initialValue: ChatsModel(client: store.client(for: connection), scope: connection.id))
    _artifacts = State(initialValue: ArtifactsModel(client: store.client(for: connection)))
    _bots = State(initialValue: BotsModel(client: store.client(for: connection)))
  }

  var body: some View {
    TabView(selection: $tab) {
      NavigationStack(path: $path) {
        ChatsView(model: chats, connection: connection, onNewChat: { path.append(Route.newChat) }, onCall: {
          let m = ConversationModel(client: store.client(for: connection), thread: nil)
          m.onChange = { [chats] in Task { await chats.load() } }
          // A call is you talking: its chat isn't new to you when it ends.
          m.onSeen = { [chats] id, _ in chats.viewing(id, open: nil) }
          let c = VoiceCallModel(conversation: m)
          // No conversation screen sits under this call: it closes the stream when it ends.
          c.ownsConversation = true
          call = c
        })
          .navigationDestination(for: ChatThread.self) { t in conversation(t) }
          .navigationDestination(for: Route.self) { _ in conversation(nil) }
      }
      .tabItem { Label("Chats", systemImage: "bubble.left") }
      .tag(0)
      .callCover($call)

      NavigationStack { BotsView(model: bots) }
        .tabItem { Label("Bots", systemImage: "person.2") }
        .tag(1)

      NavigationStack { ArtifactsView(model: artifacts) }
        .tabItem { Label("Artifacts", systemImage: "square.stack.3d.up") }
        .tag(2)

      NavigationStack { MoreView(store: store, connection: connection) }
      .tabItem { Label("More", systemImage: "ellipsis") }
      .tag(3)
    }
    .task(id: connection.id) { notifier.start(store.client(for: connection)) }
    // A tapped notification opens its chat.
    .onChange(of: notifier.open) { _, id in
      guard let id else { return }
      notifier.open = nil
      Task {
        if !chats.threads.contains(where: { $0.id == id }) { await chats.load() }
        guard let t = chats.threads.first(where: { $0.id == id }) else { return }
        tab = 0
        path = NavigationPath()
        path.append(t)
      }
    }
  }
}
