import SwiftUI
import MercuryCore

/// Screen 2: every conversation on this Mercury, newest first, with what each is doing now.
struct ChatsView: View {
  @State var model: ChatsModel
  var connection: Connection
  var onNewChat: () -> Void = {}
  var onCall: () -> Void = {}

  var body: some View {
    List {
      Section {
        ConnectedLine(name: connection.name)
          .listRowBackground(Color.clear).listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 4, trailing: 20))
      }
      if let e = model.error, model.threads.isEmpty {
        ErrorText(text: e).listRowBackground(Color.clear)
      }
      ForEach(model.visible) { t in
        NavigationLink(value: t) { ThreadRow(thread: t, status: model.status[t.id]) }
          .listRowBackground(Theme.bg)
          .swipeActions {
            Button(role: .destructive) { Task { await model.delete(t) } } label: { Label("Delete", systemImage: "trash") }
          }
      }
    }
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
    .navigationTitle("Chats")
    .searchable(text: $model.query, prompt: "Search conversations")
    .toolbar {
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
    .onDisappear { model.listener?.cancel() }
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

struct ThreadRow: View {
  var thread: ChatThread
  var status: ChatsModel.Status?

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Circle().fill(dot ?? .clear).frame(width: 10, height: 10).padding(.top, 6)
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          if thread.voiceCall == true {
            Image(systemName: "phone").font(.system(size: 13)).foregroundStyle(Theme.ink2)
          }
          Text(thread.displayTitle).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
          Spacer(minLength: 4)
          Text(RelativeTime.short(thread.lastActivity)).font(.system(size: 13)).foregroundStyle(Theme.ink3)
        }
        if let line = subtitle {
          Text(line.text).font(.system(size: 14)).foregroundStyle(line.color).lineLimit(1)
        }
      }
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
  }

  var dot: Color? {
    switch status {
    case .working: Theme.accent
    case .needsYou: Theme.amber
    case .failed: Theme.red
    case nil: nil
    }
  }

  var subtitle: (text: String, color: Color)? {
    switch status {
    case .working: ("Working…", Theme.ink2)
    case .needsYou(let prompt): ("Needs you" + (prompt.map { ": \($0)" } ?? ""), Theme.amber)
    case .failed: ("Something went wrong", Theme.red)
    case nil: thread.voiceCall == true ? ("Voice call", Theme.ink2) : nil
    }
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
