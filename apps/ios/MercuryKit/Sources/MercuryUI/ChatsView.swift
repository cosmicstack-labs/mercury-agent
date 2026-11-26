import SwiftUI
import MercuryCore

/// The side panel, laid out like Grok's (and Android's ChatDrawer): at the top the connected
/// Mercury, its logo and friendly name (tap: the switcher, to switch, rename, pick a logo or add
/// another) and a » button that closes the panel; Call Mercury, Bots, Artifacts, Brain (the mind
/// map) and Saved; "Conversations" (or "Results", or "Saved") over the chats, newest first, each row
/// the title alone, with small day labels between them ("Today", "3 days ago", "October"). All of it
/// is one scrolling list; pinned at the bottom over a fade, Settings, Search (filters live on
/// titles and messages) and a white New chat button. Better than Grok, quietly: a dot before a
/// title only when the chat works (green, pulsing), needs you (amber) or failed (red); unread
/// titles semibold with a dot at the end; matches emphasised; swipe for Delete (with Undo) or
/// Save; long-press for Rename, Save, Delete.
struct ChatDrawer: View {
  @Bindable var model: ChatsModel
  var connection: Connection
  var connections: [Connection] = []
  var online: Bool?
  /// The chat on screen: a soft highlight.
  var current: String?
  var onOpen: (ChatThread) -> Void = { _ in }
  var onNewChat: () -> Void = {}
  /// Call Mercury: closes the panel and starts a voice call in the chat on screen.
  var onCall: () -> Void = {}
  var onBots: () -> Void = {}
  var onArtifacts: () -> Void = {}
  /// Brain: the second brain's mind map.
  var onBrain: () -> Void = {}
  var onSettings: () -> Void = {}
  var onClose: () -> Void = {}
  var onSwitch: (String) -> Void = { _ in }
  var onAddMercury: () -> Void = {}
  /// Snapshots: laid out directly (the renderer can't draw lists or text fields), this many rows.
  var still = false
  var stillLimit = 10
  var stillScroll: CGFloat = 0
  /// For the switcher's Edit (rename, logo); nil in Snapshots.
  var store: ConnectionStore?
  @State private var switching = false
  @State private var renaming: ChatThread?
  @State private var newTitle = ""
  @FocusState private var searching: Bool

  var body: some View {
    ZStack(alignment: .bottom) {
      if still { stillPanel } else { list }
      bottomBar
    }
    .background(Theme.bg)
    // The status bar's strip stays the panel's ground while the list scrolls under it.
    .overlay(alignment: .top) { Color.clear.frame(height: 0).background(Theme.bg.ignoresSafeArea(edges: .top)) }
    .sheet(isPresented: $switching) {
      if let store {
        MercurySwitcher(store: store, current: connection.id, onSwitch: onSwitch, onAdd: onAddMercury)
          .presentationDetents([.medium, .large])
      }
    }
    .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Chat name", text: $newTitle)
      Button("Save") { if let t = renaming { Task { await model.rename(t, to: newTitle) } } }
        .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
      Button("Cancel", role: .cancel) {}
    } message: { Text("Up to 120 characters. Mercury keeps the name you choose.") }
  }

  /// The panel's top, which scrolls with the chats: the Mercury, the nav rows, the list's label.
  @ViewBuilder private var top: some View {
    header.padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 10)
    DrawerNavRow(icon: "phone", label: "Call Mercury", action: onCall)
    DrawerNavRow(icon: "sparkles", label: "Bots", action: onBots)
    DrawerNavRow(icon: "folder", label: "Artifacts", action: onArtifacts)
    DrawerNavRow(icon: "brain", label: "Brain", action: onBrain)
    DrawerNavRow(icon: model.savedOnly ? "bookmark.fill" : "bookmark", label: "Saved", selected: model.savedOnly) {
      withAnimation(.snappy) { model.savedOnly.toggle() }
    }
    HStack {
      Text(history.label).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink3).accessibilityAddTraits(.isHeader)
      Spacer()
      if model.anyUnread && history.query.isEmpty {
        Button { model.markAllRead() } label: { Image(systemName: "checkmark.circle").font(.system(size: 16)).foregroundStyle(Theme.ink3) }
          .buttonStyle(.plain).accessibilityLabel("Mark all as read")
      }
    }
    .padding(.leading, 24).padding(.trailing, 20).padding(.top, 18).padding(.bottom, 4)
  }

  // MARK: The header

  /// The connected Mercury, its logo and friendly name (tap: the switcher), and » to close the panel.
  private var header: some View {
    HStack(spacing: 10) {
      Button { switching = true } label: {
        HStack(spacing: 12) {
          LogoBadge(id: connection.logoId, size: 44)
          VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
              Text(connection.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
              Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.ink3)
            }
            Text(online == true ? "Online" : online == false ? "Offline" : "Connecting…").font(.system(size: 13)).foregroundStyle(Theme.ink3)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(PressButtonStyle())
      .accessibilityHint("Switch Mercury, rename it, or add another")
      Spacer(minLength: 8)
      RoundIconButton(icon: "chevron.right.2", label: "Close chats", action: onClose)
    }
  }

  // MARK: The bottom bar

  /// Settings, Search and New chat float over the list on glass (the chats scroll under them); a
  /// short fade under the bar keeps the last row from fighting the buttons.
  private var bottomBar: some View {
    VStack(spacing: 0) {
      UndoBar(thread: model.deleted.last) { model.undoDelete($0) }
      GlassGroup(spacing: 10) {
        HStack(spacing: 10) {
          RoundIconButton(icon: "gearshape", label: "Settings", action: onSettings)
          search
          RoundIconButton(icon: "square.and.pencil", label: "New chat", filled: true, action: onNewChat)
        }
      }
      .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 10)
    }
    .background(alignment: .bottom) {
      let o = LiquidGlass.available ? 0.6 : 0.92
      LinearGradient(stops: [.init(color: Theme.bg.opacity(0), location: 0), .init(color: Theme.bg.opacity(o), location: 0.4), .init(color: Theme.bg.opacity(o), location: 1)],
                     startPoint: .top, endPoint: .bottom)
        .padding(.top, -24).ignoresSafeArea(edges: .bottom).allowsHitTesting(false)
    }
  }

  private var search: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(Theme.ink3)
      if still {
        Text(model.query.isEmpty ? "Search" : model.query).foregroundStyle(model.query.isEmpty ? Theme.ink3 : Theme.ink)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        TextField("Search", text: $model.query)
          .focused($searching).submitLabel(.search).autocorrectionDisabled()
          .onSubmit { searching = false }
      }
      if !model.query.isEmpty {
        Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.ink4) }
          .buttonStyle(.plain).accessibilityLabel("Clear search")
      }
    }
    .font(.system(size: 16))
    .padding(.horizontal, 16).frame(height: 48)
    .glassSurface(in: Capsule(), interactive: true)
  }

  // MARK: The history

  private var history: ChatHistory { model.history }

  /// One list from the top of the panel to the last chat (Grok's panel scrolls as a whole); only
  /// the bottom bar stays put. Chats are lazy rows with stable ids, so 590 of them scroll smoothly.
  private var list: some View {
    let h = history
    return List {
      top.plainRow()
      if !model.loaded && model.threads.isEmpty {
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40).plainRow()
      } else if let e = model.error, model.threads.isEmpty {
        LoadError(message: e) { Task { await model.load() } }.plainRow()
      } else {
        if let e = model.error {
          InlineError(message: e) { Task { await model.load() } }.plainRow()
        }
        ForEach(h.sections, id: \.title) { section in
          if let title = section.title { DayLabel(title: title).plainRow() }
          ForEach(section.threads) { row($0, h) }
        }
        if model.loaded && h.isEmpty {
          Text(h.query.isEmpty ? (h.savedOnly ? "No saved chats yet. Long-press a chat to save it." : "No chats yet. Ask Mercury anything.") : "No chats match “\(h.query)”.")
            .font(.system(size: 14)).foregroundStyle(Theme.ink3).padding(.horizontal, 24).padding(.vertical, 12).plainRow()
        }
      }
      // Room to scroll the last chats out from under the bottom bar.
      Color.clear.frame(height: 90).plainRow()
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .environment(\.defaultMinListRowHeight, 0)
    .scrollDismissesKeyboard(.immediately)
    .refreshable { await model.load() }
    .animation(.snappy(duration: 0.25), value: h)
  }

  private func row(_ t: ChatThread, _ h: ChatHistory) -> some View {
    let saved = t.savedAt != nil
    return Button { searching = false; onOpen(t) } label: {
      HistoryLine(thread: t, look: RowLook.of(status: model.status[t.id], unread: model.isUnread(t)), query: h.query)
    }
    .buttonStyle(HistoryRowStyle(selected: t.id == current))
    .listRowBackground(Theme.bg)
    .listRowSeparator(.hidden)
    .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button(role: .destructive) { withAnimation(.snappy) { model.delete(t) } } label: { Label("Delete", systemImage: "trash") }
    }
    .swipeActions(edge: .leading) {
      Button { Task { await model.toggleSaved(t) } } label: {
        Label(saved ? "Unsave" : "Save", systemImage: saved ? "bookmark.slash" : "bookmark")
      }
      .tint(Theme.ink3)
    }
    .contextMenu {
      Button { rename(t) } label: { Label("Rename", systemImage: "pencil") }
      Button { Task { await model.toggleSaved(t) } } label: {
        Label(saved ? "Unsave" : "Save", systemImage: saved ? "bookmark.slash" : "bookmark")
      }
      Button(role: .destructive) { withAnimation(.snappy) { model.delete(t) } } label: { Label("Delete", systemImage: "trash") }
    }
  }

  /// The same panel without a List, for the Snapshots tool (`stillScroll`: as if scrolled that far).
  private var stillPanel: some View {
    let h = history
    return VStack(alignment: .leading, spacing: 0) {
      top
      if !model.loaded && model.threads.isEmpty {
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
      } else if let e = model.error, model.threads.isEmpty {
        LoadError(message: e) { }
      } else {
        let shown = Set(h.threads.prefix(stillLimit).map(\.id))
        ForEach(h.sections, id: \.title) { section in
          let rows = section.threads.filter { shown.contains($0.id) }
          if !rows.isEmpty {
            if let title = section.title { DayLabel(title: title) }
            ForEach(rows) { t in
              HistoryLine(thread: t, look: RowLook.of(status: model.status[t.id], unread: model.isUnread(t)), query: h.query)
                .background(t.id == current ? Theme.surface2 : .clear, in: RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 10)
            }
          }
        }
        if h.isEmpty {
          Text(h.query.isEmpty ? "No chats yet. Ask Mercury anything." : "No chats match “\(h.query)”.")
            .font(.system(size: 14)).foregroundStyle(Theme.ink3).padding(.horizontal, 24).padding(.vertical, 12)
        }
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .offset(y: -stillScroll)
    .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
    .clipped()
  }

  func rename(_ t: ChatThread) {
    newTitle = t.displayTitle == "New chat" ? "" : t.displayTitle
    renaming = t
  }
}

/// A history row's press and selection: a soft rounded highlight, nothing else.
struct HistoryRowStyle: ButtonStyle {
  var selected: Bool
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(selected || configuration.isPressed ? Theme.surface2 : .clear, in: RoundedRectangle(cornerRadius: 14))
      .contentShape(RoundedRectangle(cornerRadius: 14))
  }
}

/// One line: the title (matches emphasised), a status dot before it, an unread dot after it.
struct HistoryLine: View {
  var thread: ChatThread
  var look: RowLook
  var query = ""

  var body: some View {
    HStack(spacing: 10) {
      if let m = look.marker {
        StatusDot(color: Self.color(m), running: m == .working, hollow: m == .waiting, size: 8)
      }
      Text(ChatSearch.emphasised(thread.displayTitle, query))
        .font(.system(size: 17, weight: look.unread ? .semibold : .regular)).foregroundStyle(Theme.ink).lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      if look.unread {
        Circle().fill(Theme.ink).frame(width: 7, height: 7).accessibilityLabel("Unread")
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(minHeight: 48)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  static func color(_ m: RowLook.Marker) -> Color {
    switch m {
    case .working: Theme.green
    case .needsYou: Theme.amber
    case .failed: Theme.red
    case .waiting: Theme.ink3
    }
  }
}

/// A small muted label over a day's chats: "Today", "3 days ago", "October".
struct DayLabel: View {
  var title: String
  var body: some View {
    Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink3)
      .padding(.leading, 24).padding(.top, 14).padding(.bottom, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

/// Bots, Artifacts, Saved: a large icon and label, no background (a soft one while Saved filters).
struct DrawerNavRow: View {
  var icon: String
  var label: String
  var selected = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 16) {
        Image(systemName: icon).font(.system(size: 20)).foregroundStyle(Theme.ink).frame(width: 26)
        Text(label).font(.system(size: 18)).foregroundStyle(Theme.ink)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14).frame(height: 52)
    }
    .buttonStyle(HistoryRowStyle(selected: selected))
    .padding(.horizontal, 10)
  }
}

/// A 48pt round button floating over content: Liquid Glass on iOS 26 (a thin material below), or
/// `filled` ink glass (white on dark) for the main action, as `.glassProminent` tints it.
struct RoundIconButton: View {
  var icon: String
  var label: String
  var filled = false
  var size: CGFloat = 48
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 18, weight: .medium))
        .foregroundStyle(filled ? Theme.onAccent : Theme.ink)
        .frame(width: size, height: size)
        .contentShape(Circle())
    }
    .buttonStyle(PressButtonStyle())
    .glassSurface(in: Circle(), interactive: true, tint: filled ? Theme.accent : nil)
    .accessibilityLabel(label)
  }
}

/// "Deleted “…” · Undo" for the few seconds before Mercury deletes it.
struct UndoBar: View {
  var thread: ChatThread?
  var undo: (ChatThread) -> Void
  var body: some View {
    Group {
      if let t = thread {
        HStack {
          Text("Deleted “\(t.displayTitle)”").font(.system(size: 14)).foregroundStyle(Theme.bg).lineLimit(1)
          Spacer(minLength: 8)
          Button("Undo") { withAnimation(.snappy) { undo(t) } }.font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.bg)
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).frame(height: 44)
        .background(Theme.ink, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12).padding(.vertical, 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.snappy, value: thread?.id)
  }
}

struct LoadError: View {
  var message: String
  var retry: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Couldn't load your chats").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
      Text(message).font(.system(size: 14)).foregroundStyle(Theme.ink3)
      Button("Retry", action: retry).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
        .padding(.horizontal, 16).frame(height: 36).overlay(Capsule().stroke(Theme.ink4))
        .buttonStyle(.plain)
    }
    .padding(.horizontal, 22).padding(.vertical, 20)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

struct InlineError: View {
  var message: String
  var retry: () -> Void
  var body: some View {
    HStack {
      Text("Couldn't refresh: \(message)").font(.system(size: 13)).foregroundStyle(Theme.ink3).lineLimit(2)
      Spacer(minLength: 8)
      Button("Retry", action: retry).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).buttonStyle(.plain)
    }
    .padding(.horizontal, 22).padding(.vertical, 6)
  }
}

extension View {
  /// A row that isn't a chat: no separator, the panel's ground, no insets.
  func plainRow() -> some View {
    listRowBackground(Theme.bg).listRowSeparator(.hidden).listRowInsets(EdgeInsets())
  }
}

/// What a waiting question asks, in the card's words ("Run a command"), else as it came.
func askLine(_ prompt: String) -> String {
  let d = Described(kind: "permission_request", text: prompt)
  return d.title == "Allow this?" ? prompt.components(separatedBy: "\n").first ?? prompt : d.title
}

/// A chat's marker: steady for needs-you or failed, breathing while it runs, hollow while it waits.
struct StatusDot: View {
  var color: Color
  var running = false
  var hollow = false
  var size: CGFloat = 9
  @State private var on = false
  var body: some View {
    ZStack {
      if running {
        Circle().fill(color.opacity(0.3)).frame(width: size, height: size).scaleEffect(on ? 1.9 : 1).opacity(on ? 0 : 1)
      }
      if hollow { Circle().stroke(color, lineWidth: 1.5).frame(width: size - 1, height: size - 1) }
      else { Circle().fill(color).frame(width: size, height: size) }
    }
    .frame(width: size, height: size)
    .onAppear { if running { withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true } } }
    .accessibilityHidden(true)
  }
}

enum RelativeTime {
  /// "now", "2m", "1h", "Yesterday", "Mon", "3 Nov"
  static func short(_ d: Date, now: Date = .now) -> String {
    let s = now.timeIntervalSince(d)
    if s < 60 { return "now" }
    if s < 3600 { return "\(Int(s / 60))m" }
    let cal = Calendar.current
    if cal.isDateInToday(d) { return "\(Int(s / 3600))h" }
    if cal.isDateInYesterday(d) { return "Yesterday" }
    if s < 6 * 86400 { return d.formatted(.dateTime.weekday(.abbreviated)) }
    return d.formatted(.dateTime.day().month(.abbreviated))
  }
}

/// A slide-over panel from the leading edge, as in the ChatGPT and Grok apps: about 88% of the
/// width, a dimmed scrim over the rest, and it follows your finger (an edge swipe opens it, a swipe
/// back or a tap on the scrim closes it). The keyboard goes away as it opens.
struct SideDrawer<Main: View, Panel: View>: View {
  @Binding var open: Bool
  /// The edge swipe works only where it makes sense (the chat, not a pushed screen).
  var edgeEnabled = true
  @ViewBuilder var main: () -> Main
  @ViewBuilder var panel: () -> Panel
  @GestureState private var drag: CGFloat = 0
  @State private var dragging = false

  var body: some View {
    GeometryReader { geo in
      let width = min(geo.size.width * 0.88, 400)
      let x = min(max((open ? width : 0) + drag, 0), width)
      let progress = width > 0 ? x / width : 0
      ZStack(alignment: .leading) {
        main()
          .allowsHitTesting(!open)
          .accessibilityHidden(open)
        Color.black.opacity(0.4 * progress).ignoresSafeArea()
          .allowsHitTesting(open)
          .onTapGesture { withAnimation(.snappy(duration: 0.28)) { open = false } }
          .accessibilityAddTraits(.isButton).accessibilityLabel("Close chats")
          .accessibilityHidden(!open)
        panel()
          .frame(width: width)
          .background(Theme.bg.ignoresSafeArea())
          .offset(x: x - width)
          .accessibilityHidden(!open && x == 0)
        if !open && edgeEnabled {
          Color.clear.frame(width: 22).contentShape(Rectangle())
            .gesture(dragGesture(width: width))
        }
      }
      .simultaneousGesture(open ? dragGesture(width: width) : nil)
      .onChange(of: open) { _, now in if now { dismissKeyboard() } }
    }
  }

  private func dragGesture(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 12)
      .updating($drag) { v, state, _ in
        // Sideways only: a vertical scroll in the list never moves the panel.
        guard abs(v.translation.width) > abs(v.translation.height) else { return }
        state = v.translation.width
      }
      .onChanged { _ in if !dragging { dragging = true; dismissKeyboard() } }
      .onEnded { v in
        dragging = false
        guard abs(v.translation.width) > abs(v.translation.height) else { return }
        let end = (open ? width : 0) + v.predictedEndTranslation.width
        withAnimation(.snappy(duration: 0.28)) { open = end > width / 2 }
      }
  }
}

/// Puts the keyboard away (UIKit's first responder), as Android's Keyboard.kt does: when the side
/// panel opens, another screen comes up, a menu or sheet opens, or a call starts.
@MainActor func dismissKeyboard() {
  #if canImport(UIKit)
  UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
  #endif
}
