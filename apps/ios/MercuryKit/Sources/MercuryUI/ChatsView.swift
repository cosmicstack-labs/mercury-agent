import SwiftUI
import MercuryCore

/// Screen 2: every conversation on this Mercury, newest first, with what each is doing now.
struct ChatsView: View {
  @State var model: ChatsModel
  var connection: Connection
  var onNewChat: () -> Void = {}
  var onCall: () -> Void = {}
  @State var renaming: ChatThread?
  @State var newTitle = ""

  var body: some View {
    List {
      Section {
        HStack(spacing: 8) {
          ConnectedLine(name: connection.name)
          Spacer(minLength: 8)
          if model.anyUnread && !model.savedOnly { MarkAllRead { model.markAllRead() } }
        }
        .listRowBackground(Color.clear).listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 4, trailing: 16))
      }
      if let e = model.error, model.threads.isEmpty {
        ErrorText(text: e).listRowBackground(Color.clear)
      }
      ForEach(model.sections, id: \.title) { section in
        Section {
          ForEach(section.threads) { t in row(t) }
        } header: {
          // Saved-only has one section, named by the screen title already.
          if !model.savedOnly { ChatSectionHeader(title: section.title) }
        }
      }
      if model.savedOnly && model.sections.isEmpty && !model.query.isEmpty {
        Text("No saved chats match.").font(.system(size: 14)).foregroundStyle(Theme.ink3)
          .listRowBackground(Color.clear).listRowSeparator(.hidden)
      }
    }
    .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Chat name", text: $newTitle)
      Button("Save") { if let t = renaming { Task { await model.rename(t, to: newTitle) } } }
        .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
      Button("Cancel", role: .cancel) {}
    } message: { Text("Up to 120 characters. Mercury keeps the name you choose.") }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Theme.bg)
    .overlay {
      if model.loaded && model.threads.isEmpty && model.error == nil {
        EmptyChats(onNewChat: onNewChat)
      } else if !model.loaded {
        ProgressView()
      }
    }
    .navigationTitle(model.savedOnly ? "Saved" : "Chats")
    .searchable(text: $model.query, prompt: "Search conversations")
    .toolbar {
      if model.hasSaved {
        ToolbarItem(placement: Self.leading) {
          Button { withAnimation(.snappy) { model.savedOnly.toggle() } } label: {
            Image(systemName: model.savedOnly ? "bookmark.fill" : "bookmark")
              .foregroundStyle(model.savedOnly ? Theme.accent : Theme.ink2)
          }
          .accessibilityLabel(model.savedOnly ? "Show all chats" : "Show saved chats")
        }
      }
      ToolbarItem(placement: .primaryAction) {
        Button(action: onCall) { Image(systemName: "phone") }
          .accessibilityLabel("Call Mercury")
      }
      ToolbarItem(placement: .primaryAction) {
        Button(action: onNewChat) {
          Image(systemName: "plus").font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.onAccent)
            .frame(width: 34, height: 34).background(Theme.accent, in: RoundedRectangle(cornerRadius: 11))
        }
        .accessibilityLabel("New chat")
      }
    }
    .refreshable { await model.load() }
    .task { await model.load(); model.listen() }
    // Asked here, once, so tapping Call never waits on the microphone prompt.
    .task { CallMic.askEarly() }
    .onDisappear { model.listener?.cancel() }
  }

  #if os(iOS)
  static let leading = ToolbarItemPlacement.topBarLeading
  #else
  static let leading = ToolbarItemPlacement.navigation
  #endif

  func row(_ t: ChatThread) -> some View {
    let saved = t.savedAt != nil
    return NavigationLink(value: t) { ThreadRow(thread: t, status: model.status[t.id], unread: model.isUnread(t)) }
      .listRowBackground(Theme.bg)
      .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
      .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
      .swipeActions(edge: .leading) {
        Button { Task { await model.toggleSaved(t) } } label: {
          Label(saved ? "Unsave" : "Save", systemImage: saved ? "bookmark.slash" : "bookmark")
        }
        .tint(Theme.accent)
      }
      .swipeActions {
        Button(role: .destructive) { Task { await model.delete(t) } } label: { Label("Delete", systemImage: "trash") }
        Button { rename(t) } label: { Label("Rename", systemImage: "pencil") }.tint(Theme.ink3)
      }
      .contextMenu {
        Button { Task { await model.toggleSaved(t) } } label: {
          Label(saved ? "Unsave" : "Save", systemImage: saved ? "bookmark.slash" : "bookmark")
        }
        Button { rename(t) } label: { Label("Rename", systemImage: "pencil") }
        Button(role: .destructive) { Task { await model.delete(t) } } label: { Label("Delete", systemImage: "trash") }
      }
  }

  func rename(_ t: ChatThread) {
    newTitle = t.displayTitle == "New chat" ? "" : t.displayTitle
    renaming = t
  }
}

/// A day's heading in the list ("TODAY"), small and quiet like Mercury Desktop's.
struct ChatSectionHeader: View {
  var title: String
  var body: some View {
    Text(title.uppercased()).font(.system(size: 12, weight: .semibold)).kerning(0.4).foregroundStyle(Theme.ink3)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 6)
      .accessibilityAddTraits(.isHeader)
  }
}

/// Shown only while some chat has something new.
struct MarkAllRead: View {
  var action: () -> Void
  var body: some View {
    Button("Mark all as read", action: action)
      .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.accent)
      .buttonStyle(.plain)
  }
}

struct ConnectedLine: View {
  var name: String
  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(Theme.accent).frame(width: 8, height: 8)
      Text("Connected to \(name)").font(.system(size: 13)).foregroundStyle(Theme.ink2).lineLimit(1)
    }
  }
}

/// A chat in the list: its name and when it last moved, then what it's doing, or else its last
/// message. Unread chats have a bold name and a dot at the end, as in Mail and Messages.
struct ThreadRow: View {
  var thread: ChatThread
  var status: ChatsModel.Status?
  var unread = false

  var body: some View {
    // Rows line up with the screen title; a status dot only appears when there's a status.
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        if let dot {
          StatusDot(color: dot, running: status == .working, hollow: status == .waiting)
            .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
        }
        if thread.voiceCall == true {
          Image(systemName: "phone").font(.system(size: 13)).foregroundStyle(Theme.ink2)
        }
        Text(thread.displayTitle).font(.system(size: 16, weight: unread ? .bold : .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
        Spacer(minLength: 4)
        if thread.savedAt != nil {
          Image(systemName: "bookmark.fill").font(.system(size: 11)).foregroundStyle(Theme.ink3)
            .accessibilityLabel("Saved")
        }
        Text(RelativeTime.short(thread.lastActivity)).font(.system(size: 13))
          .foregroundStyle(unread ? Theme.accent : Theme.ink3).fixedSize()
      }
      HStack(alignment: .top, spacing: 8) {
        if let line = subtitle {
          Text(line.text).font(.system(size: 14)).foregroundStyle(line.color).lineLimit(line.lines)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          Spacer(minLength: 0)
        }
        if unread {
          Circle().fill(Theme.accent).frame(width: 10, height: 10).padding(.top, 4)
            .accessibilityLabel("Unread")
        }
      }
    }
    .accessibilityElement(children: .combine)
  }

  var dot: Color? {
    switch status {
    case .working: Theme.accent
    case .waiting: Theme.ink3
    case .needsYou: Theme.amber
    case .failed: Theme.red
    case nil: nil
    }
  }

  /// What a waiting question asks, in the card's words ("Run a command"), else as it came.
  static func ask(_ prompt: String) -> String {
    let d = Described(kind: "permission_request", text: prompt)
    return d.title == "Allow this?" ? prompt.components(separatedBy: "\n").first ?? prompt : d.title
  }

  /// The second line: a status while there is one (one line), else the last message (two).
  var subtitle: (text: String, color: Color, lines: Int)? {
    switch status {
    case .working: ("Working…", Theme.ink2, 1)
    case .waiting: ("Waiting for another chat to finish", Theme.ink3, 1)
    case .needsYou(let prompt): ("Needs you" + (prompt.map { ": \(Self.ask($0))" } ?? ""), Theme.amber, 1)
    case .failed: ("Something went wrong", Theme.red, 1)
    case nil:
      if let p = thread.previewLine { (p, Theme.ink2, 2) }
      else if thread.voiceCall == true { ("Voice call", Theme.ink2, 1) }
      else { nil }
    }
  }
}

/// A chat's marker: steady for needs-you or failed, breathing while it runs, hollow while it waits.
struct StatusDot: View {
  var color: Color
  var running = false
  var hollow = false
  @State private var on = false
  var body: some View {
    ZStack {
      if running {
        Circle().fill(color.opacity(0.3)).frame(width: 9, height: 9).scaleEffect(on ? 1.9 : 1).opacity(on ? 0 : 1)
      }
      if hollow { Circle().stroke(color, lineWidth: 1.5).frame(width: 8, height: 8) }
      else { Circle().fill(color).frame(width: 9, height: 9) }
    }
    .frame(width: 9, height: 9)
    .onAppear { if running { withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true } } }
    .accessibilityHidden(true)
  }
}

struct EmptyChats: View {
  var onNewChat: () -> Void
  var body: some View {
    VStack(spacing: 14) {
      MarkTile(size: 56)
      Text("No conversations yet").font(.system(size: 18, weight: .semibold))
      Text("Ask Mercury anything. It keeps working even when you close the app.")
        .font(.system(size: 15)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center).frame(maxWidth: 280)
      Button("Start a chat", action: onNewChat).buttonStyle(PrimaryButtonStyle()).frame(width: 200)
    }
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
