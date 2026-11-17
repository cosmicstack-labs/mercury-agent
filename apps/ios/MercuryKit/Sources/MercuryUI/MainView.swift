import SwiftUI
import MercuryCore

/// The app once connected, chat-first like the ChatGPT and Grok apps (and Mercury for Android):
/// one conversation fills the screen; the menu button or a swipe from the leading edge opens the
/// side panel (search, New chat, Bots, Artifacts, Brain, the history, and the connected Mercury, which
/// a gear for Settings). Bots, Artifacts and Settings push over the chat; back returns to it.
struct MainView: View {
  var store: ConnectionStore
  var connection: Connection
  @State var chats: ChatsModel
  @State var path = NavigationPath()
  @State var artifacts: ArtifactsModel
  @State var bots: BotsModel
  /// Brain → Mind map: kept while connected, so the layout stays put between visits (desktop keeps it mounted).
  @State var brain: MindMapModel
  @State var conversation: ConversationModel
  /// A new identity for each chat opened, so its screen starts fresh.
  @State var conversationKey = UUID()
  @State var drawer = false
  @State var online: Bool?
  @State var notifier = Notifier.shared
  @State var adding = false
  @State var quickActions = HomeScreenActions.shared

  enum Route: Hashable { case bots, artifacts, brain, settings }

  init(store: ConnectionStore, connection: Connection) {
    self.store = store; self.connection = connection
    let client = store.client(for: connection)
    let chats = ChatsModel(client: client, scope: connection.id)
    _chats = State(initialValue: chats)
    _artifacts = State(initialValue: ArtifactsModel(client: client))
    _bots = State(initialValue: BotsModel(client: client))
    _brain = State(initialValue: MindMapModel(client: client))
    _conversation = State(initialValue: Self.makeConversation(client: client, thread: nil, chats: chats))
  }

  static func makeConversation(client: MercuryClient, thread: ChatThread?, chats: ChatsModel) -> ConversationModel {
    let m = ConversationModel(client: client, thread: thread)
    m.onChange = { [chats] in Task { await chats.load() } }
    m.onSeen = { [chats] id, open in chats.viewing(id, open: open) }
    return m
  }

  /// Opens a chat (nil: a new one) in place of the one on screen.
  func open(_ thread: ChatThread?) {
    dismissKeyboard()
    if let thread, thread.id == conversation.threadId, path.isEmpty {
      withAnimation(.snappy(duration: 0.28)) { drawer = false }
      return
    }
    // The chat left behind stops listening unless a call keeps it.
    if conversation.callId == nil { conversation.listener?.cancel() }
    conversation = Self.makeConversation(client: store.client(for: connection), thread: thread, chats: chats)
    conversationKey = UUID()
    path = NavigationPath()
    withAnimation(.snappy(duration: 0.28)) { drawer = false }
  }

  func go(_ r: Route) {
    dismissKeyboard()
    path = NavigationPath()
    path.append(r)
    withAnimation(.snappy(duration: 0.28)) { drawer = false }
  }

  /// Call Mercury from the side panel or a Home Screen quick action: back to the chat on screen
  /// (a new one when none is open) and a voice call in it, as the chat's own call button starts.
  func call() {
    dismissKeyboard()
    path = NavigationPath()
    withAnimation(.snappy(duration: 0.28)) { drawer = false }
    conversation.callRequested = true
  }

  var body: some View {
    SideDrawer(open: $drawer, edgeEnabled: path.isEmpty) {
      NavigationStack(path: $path) {
        ConversationView(
          model: conversation,
          onMenu: { dismissKeyboard(); withAnimation(.snappy(duration: 0.28)) { drawer = true } },
          onNewChat: { open(nil) },
          onDeleted: { Task { await chats.load() }; open(nil) }
        )
        .id(conversationKey)
        .navigationDestination(for: Route.self) { r in
          switch r {
          case .bots: BotsView(model: bots)
          case .artifacts: ArtifactsView(model: artifacts)
          case .brain: MindMapScreen(model: brain) { if !path.isEmpty { path.removeLast() } }
          case .settings: MoreView(store: store, connection: connection)
          }
        }
      }
    } panel: {
      ChatDrawer(
        model: chats, connection: connection, connections: store.connections, online: online, current: conversation.threadId,
        onOpen: { open($0) }, onNewChat: { open(nil) }, onCall: { call() },
        onBots: { go(.bots) }, onArtifacts: { go(.artifacts) }, onBrain: { go(.brain) }, onSettings: { go(.settings) },
        onClose: { withAnimation(.snappy(duration: 0.28)) { drawer = false } },
        onSwitch: { id in store.activate(id) },
        onAddMercury: { adding = true }
      )
    }
    .sheet(isPresented: $adding) { ConnectView(store: store) }
    .onChange(of: store.connections.count) { adding = false }
    .onChange(of: path.count) { dismissKeyboard() }
    .task { await chats.load(); chats.listen() }
    // Asked here, once, so tapping Call never waits on the microphone prompt.
    .task { CallMic.askEarly() }
    .task(id: connection.id) {
      let client = store.client(for: connection)
      while !Task.isCancelled {
        online = (try? await client.health()) != nil
        try? await Task.sleep(for: .seconds(online == true ? 60 : 15))
      }
    }
    .task(id: connection.id) { notifier.start(store.client(for: connection)) }
    // Coming back to the panel refreshes the list.
    .onChange(of: drawer) { _, isOpen in if isOpen { Task { await chats.load() } } }
    // The Home Screen's Call Mercury quick action (at launch, or while running).
    .onChange(of: quickActions.call, initial: true) { _, on in
      guard on else { return }
      quickActions.call = false
      call()
    }
    // A tapped notification opens its chat.
    .onChange(of: notifier.open) { _, id in
      guard let id else { return }
      notifier.open = nil
      Task {
        if !chats.threads.contains(where: { $0.id == id }) { await chats.load() }
        guard let t = chats.threads.first(where: { $0.id == id }) else { return }
        open(t)
      }
    }
  }
}

/// The Home Screen quick actions (`UIApplicationShortcutItems` in the app's Info.plist): the app's
/// scene delegate sets what was picked, the connected screen acts on it.
@MainActor @Observable
public final class HomeScreenActions {
  public static let shared = HomeScreenActions()
  /// The shortcut item type of Call Mercury.
  public static let callType = "sh.mercuryagent.call"
  /// Call Mercury was picked and not yet started.
  public var call = false

  /// Takes a shortcut item's type; whether it was one of Mercury's.
  @discardableResult
  public func perform(_ type: String) -> Bool {
    guard type == Self.callType else { return false }
    call = true
    return true
  }
}
