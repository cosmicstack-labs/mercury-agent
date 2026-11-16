import SwiftUI
import MercuryCore

/// The Bots tab's state: the roster, the questions waiting, and a capped log of what the bots are
/// doing (the live feed's events). One stream (/api/bots/events) feeds every Bots screen while one
/// of them is on screen; screens filter what they show.
@MainActor @Observable
final class BotsModel {
  var bots: [BotStatus] = []
  var available = true
  var unread = 0
  var approvals: [BotApproval] = []
  /// Recent bot events, oldest first, capped (LiveRuns.cap).
  var live: [BotActivityEvent] = []
  /// What each running bot is doing right now, in a few words (the roster's subtitle).
  var activity: [String: String] = [:]
  var loaded = false
  var error: String?
  /// Bumped when an inbox entry arrives, so open inbox lists reload.
  var inboxVersion = 0
  /// A clock (ms) for elapsed times, "ended" runs and how long questions wait.
  var now = Date().timeIntervalSince1970 * 1000

  let client: MercuryClient
  @ObservationIgnored var listener: Task<Void, Never>?
  @ObservationIgnored var clock: Task<Void, Never>?
  @ObservationIgnored var stopping: Task<Void, Never>?
  @ObservationIgnored var onScreen = 0
  /// The bots whose feed is open: reloaded after the stream reconnects.
  @ObservationIgnored var watching: [String] = []
  @ObservationIgnored var rosterReload: Task<Void, Never>?

  init(client: MercuryClient) { self.client = client }

  var layout: (fleets: [BotFleet], solo: [BotStatus]) { BotRosterLayout.organise(bots) }
  var running: Set<String> { Set(bots.filter(\.isRunning).map(\.id)) }
  func bot(_ id: String) -> BotStatus? { bots.first { $0.id == id } }

  // MARK: Loading

  func load() async {
    do {
      let r = try await client.bots()
      bots = r.bots; available = r.available; unread = r.unread ?? unread
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
    await loadApprovals()
  }

  func loadApprovals() async {
    if let a = try? await client.botApprovals() { approvals = a }
  }

  /// The recent past of some bots' feed (a fleet: all of its members), merged into the log.
  func loadActivity(_ ids: [String]) async {
    watching = ids
    if let events = try? await client.botActivity(ids) { live = LiveRuns.merge(live, events) }
  }

  func add(_ events: [BotActivityEvent]) { live = LiveRuns.merge(live, events) }

  // MARK: The stream, while a Bots screen is showing

  /// A Bots screen appeared: make sure the stream and the clock run.
  func appeared() {
    onScreen += 1
    stopping?.cancel(); stopping = nil
    if listener == nil { listen() }
    if clock == nil {
      clock = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(15))
          self?.now = Date().timeIntervalSince1970 * 1000
        }
      }
    }
    now = Date().timeIntervalSince1970 * 1000
  }

  /// A Bots screen went away. Pushing a bot shows one screen as the other leaves, so the stream
  /// closes only when none is back a moment later.
  func disappeared() {
    onScreen = max(0, onScreen - 1)
    guard onScreen == 0 else { return }
    stopping?.cancel()
    stopping = Task { [weak self] in
      try? await Task.sleep(for: .seconds(3))
      guard let self, !Task.isCancelled, self.onScreen == 0 else { return }
      self.listener?.cancel(); self.listener = nil
      self.clock?.cancel(); self.clock = nil
    }
  }

  func listen() {
    listener?.cancel()
    listener = Task { [weak self, client] in
      for await e in client.botEvents() {
        guard let self else { return }
        self.handle(e)
      }
    }
  }

  func handle(_ e: BotStreamEvent) {
    switch e {
    case .roster(let list):
      bots = list; loaded = true
      // Sent on every (re)connect: catch up on what happened while the stream was down.
      let ids = watching
      Task { await loadApprovals(); if !ids.isEmpty { await loadActivity(ids) } }
    case .activity(let ev):
      add([ev])
      if ev.kind == "thinking" || ev.kind == "queued" { return }
      activity[ev.botId] = ev.kind == "turn-end" ? nil : ev.label
      if ev.kind == "turn-end" || ev.kind == "turn-start" { reloadRoster() }
    case .approvalsChanged:
      Task { await loadApprovals() }
    case .inbox:
      inboxVersion += 1
      reloadRoster()
    }
  }

  /// The roster (states, unread counts) after a run starts or ends; bursts reload once.
  func reloadRoster() {
    rosterReload?.cancel()
    rosterReload = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(400))
      guard let self, !Task.isCancelled else { return }
      if let r = try? await self.client.bots() { self.bots = r.bots; self.unread = r.unread ?? self.unread }
      await self.loadApprovals()
    }
  }

  // MARK: Talking to bots

  /// Messages a bot. Returns why it wasn't sent, or nil. A message to a busy bot shows as queued at once.
  func send(_ text: String, to id: String) async -> String? {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    do {
      let r = try await client.messageBot(id, text)
      guard r.accepted else {
        return r.reasonCode == "target_disabled" ? "That bot is off. Turn it on to message it." : "Not sent (\((r.reasonCode ?? "refused").replacingOccurrences(of: "_", with: " ")))."
      }
      if let job = r.jobId, !live.contains(where: { $0.jobId == job }) {
        let busy = bot(id)?.isRunning == true
        add([BotActivityEvent(botId: id, jobId: job, kind: "queued", label: busy ? "Queued: runs when the current run finishes" : "Starting",
                              stepIndex: 0, at: Date().timeIntervalSince1970 * 1000, botName: bot(id)?.name, trigger: "api", prompt: text)])
      }
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  /// Answers a bot's question. The buttons go at once; a question that already went shows why.
  func answer(_ a: BotApproval, _ value: String) async -> String? {
    approvals.removeAll { $0.id == a.id }
    defer { Task { await loadApprovals() } }
    do {
      try await client.answerBot(a.id, value)
      return nil
    } catch MercuryError.server(409, let msg) {
      return msg ?? "That question is no longer waiting."
    } catch {
      return error.localizedDescription
    }
  }

  // MARK: Inbox

  func markRead(_ ids: [String]?) async {
    if let left = try? await client.markBotInboxRead(ids) { unread = left }
    reloadRoster()
  }
}
