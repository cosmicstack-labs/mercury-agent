import SwiftUI
import MercuryCore

/// The conversation list and what each one is doing right now (from /api/chat/activity).
@MainActor @Observable
final class ChatsModel {
  enum Status: Equatable { case working, needsYou(String?), failed }

  var threads: [ChatThread] = []
  var status: [String: Status] = [:]
  var loaded = false
  var error: String?
  var query = ""
  let client: MercuryClient
  var listener: Task<Void, Never>?

  init(client: MercuryClient) { self.client = client }

  var visible: [ChatThread] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    let list = threads.sorted { $0.lastActivity > $1.lastActivity }
    return q.isEmpty ? list : list.filter { $0.displayTitle.lowercased().contains(q) }
  }

  func load() async {
    do {
      threads = try await client.threads()
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
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
