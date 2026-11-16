import SwiftUI
import MercuryCore

/// The conversation list and what each one is doing right now: several chats can run at once
/// (ADR-037), so each row has its own marker, seeded from /api/chat/running and kept current by
/// /api/chat/activity.
@MainActor @Observable
final class ChatsModel {
  enum Status: Equatable { case working, waiting, needsYou(String?), failed }

  var threads: [ChatThread] = []
  var status: [String: Status] = [:]
  var loaded = false
  var error: String?
  var query = ""
  /// Only saved chats, newest save first (the bookmark in the toolbar).
  var savedOnly = false
  /// The chat on screen now: never unread, whatever arrives in it.
  var open: String?
  let reads: ReadMarks
  let client: MercuryClient
  var listener: Task<Void, Never>?

  /// `scope` keeps read marks apart per Mercury (the connection's id).
  init(client: MercuryClient, scope: String = "", defaults: UserDefaults = .standard) {
    self.client = client
    reads = ReadMarks(scope: scope, defaults: defaults)
  }

  var visible: [ChatThread] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    let list = savedOnly
      ? threads.filter { $0.savedAt != nil }.sorted { $0.savedAt! > $1.savedAt! }
      : threads.sorted { $0.lastActivity > $1.lastActivity }
    return q.isEmpty ? list : list.filter { $0.displayTitle.lowercased().contains(q) || ($0.preview?.lowercased().contains(q) ?? false) }
  }

  /// What the list shows: one "Saved" section, or the chats by day.
  var sections: [ChatSections.Section] {
    let list = visible
    if savedOnly { return list.isEmpty ? [] : [.init(title: "Saved", threads: list)] }
    return ChatSections.byDay(list)
  }

  var hasSaved: Bool { threads.contains { $0.savedAt != nil } }

  func isUnread(_ t: ChatThread) -> Bool { reads.isUnread(t, open: open) }
  var anyUnread: Bool { threads.contains(where: isUnread) }
  func markAllRead() { reads.markAllSeen(threads) }

  /// A chat came on screen (true), left it (false), or was seen some other way (nil, a call).
  /// Either way what it shows now has been seen, as of the later of now and its last activity
  /// (Mercury's clock may run ahead of the phone's).
  func viewing(_ id: String, open isOpen: Bool?) {
    let last = threads.first { $0.id == id }?.lastActivity ?? .distantPast
    reads.markSeen(id, at: max(.now, last))
    if isOpen == true { open = id } else if isOpen == false, open == id { open = nil }
  }

  /// Save a chat to come back to, or unsave it. Shown at once; put back if Mercury says no.
  func toggleSaved(_ t: ChatThread) async {
    guard let i = threads.firstIndex(where: { $0.id == t.id }) else { return }
    let was = threads[i].savedAt
    let saving = was == nil
    threads[i].savedAt = saving ? .now : nil
    if !hasSaved { savedOnly = false }
    do {
      let at = try await client.setThreadSaved(t.id, saved: saving)
      if let j = threads.firstIndex(where: { $0.id == t.id }) { threads[j].savedAt = saving ? (at ?? threads[j].savedAt) : nil }
      error = nil
    } catch {
      if let j = threads.firstIndex(where: { $0.id == t.id }) { threads[j].savedAt = was }
      self.error = error.localizedDescription
    }
  }

  func load() async {
    do {
      threads = try await client.threads()
      error = nil
      reads.prune(keeping: Set(threads.map(\.id)))
      if !hasSaved { savedOnly = false }
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
    await syncRunning()
  }

  /// Which chats are working or waiting right now (the activity stream only tells what changes
  /// after it opens). A marker for a chat that isn't running any more goes.
  func syncRunning() async {
    guard let turns = await client.runningTurns() else { return }
    apply(turns)
  }

  func apply(_ turns: TurnsInfo) {
    let running = Set(turns.running.compactMap { $0.sessionId ?? $0.channelId })
    let waiting = Set(turns.waiting.compactMap { $0.sessionId ?? $0.channelId })
    for (id, s) in status where (s == .working || s == .waiting) && !running.contains(id) && !waiting.contains(id) { status[id] = nil }
    for id in running { if case .needsYou? = status[id] { continue }; status[id] = .working }
    for id in waiting where status[id] == nil { status[id] = .waiting }
  }

  /// The owner's name for a chat: Mercury keeps it, whatever it would have named it.
  func rename(_ t: ChatThread, to name: String) async {
    let title = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
    guard !title.isEmpty else { return }
    do {
      let saved = try await client.renameThread(t.id, title: title)
      if let i = threads.firstIndex(where: { $0.id == t.id }) { threads[i].title = saved }
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  func listen() {
    listener?.cancel()
    listener = Task {
      for await e in client.events("/api/chat/activity") where e.name == "activity" {
        guard let data = e.data.data(using: .utf8), let a = try? JSONDecoder().decode(ActivityEvent.self, from: data) else { continue }
        apply(a)
      }
    }
  }

  func apply(_ a: ActivityEvent) {
    switch a.kind {
    case .started, .research: status[a.sessionId] = .working
    case .needs_you: status[a.sessionId] = .needsYou(a.prompt)
    case .resolved: status[a.sessionId] = .working
    case .done, .stopped: status[a.sessionId] = nil
    case .failed: status[a.sessionId] = .failed
    }
    if !threads.contains(where: { $0.id == a.sessionId }) || a.kind == .done {
      Task { await load() }
    } else if let i = threads.firstIndex(where: { $0.id == a.sessionId }) {
      threads[i].updatedAt = .now
      if let t = a.title, !t.isEmpty { threads[i].title = t }
    }
  }

  func delete(_ t: ChatThread) async {
    threads.removeAll { $0.id == t.id }
    try? await client.deleteThread(t.id)
  }
}
