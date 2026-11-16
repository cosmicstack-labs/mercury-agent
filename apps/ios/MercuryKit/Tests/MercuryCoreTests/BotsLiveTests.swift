import Testing
import Foundation
@testable import MercuryCore

/// Ported from apps/desktop/src/views/bots/live-runs.test.ts: the phone works runs out the same way.
struct BotsLiveTests {
  func ev(_ kind: String, _ label: String, _ at: Double, jobId: String? = "j1", status: String? = nil, stepIndex: Int? = nil,
          textTail: String? = nil, trigger: String? = nil, prompt: String? = nil, botName: String? = "Writer") -> BotActivityEvent {
    BotActivityEvent(botId: "w", jobId: jobId, kind: kind, label: label, stepIndex: stepIndex, status: status, textTail: textTail,
                     at: at, botName: botName, trigger: trigger, prompt: prompt)
  }

  @Test func aRunFromYourMessageToItsEnd() {
    let runs = LiveRuns.runsFrom([
      ev("queued", "Starting", 1, trigger: "api", prompt: "Draft the post"),
      ev("turn-start", "Draft the post", 2, trigger: "api", prompt: "Draft the post"),
      ev("step", "step 1", 3, stepIndex: 1),
      ev("tool", "read_file notes.md", 4, status: "running"),
      ev("tool", "read_file notes.md", 5, status: "done"),
      ev("tool", "web_search ai agents", 6, status: "running"),
      ev("thinking", "thinking", 7, textTail: "Here is the draft"),
      ev("turn-end", "completed", 8, status: "done"),
    ])
    #expect(runs.count == 1)
    let r = runs[0]
    #expect(r.state == .done)
    #expect(r.prompt == "Draft the post")
    #expect(r.steps.map { "\($0.label):\($0.status)" } == ["read_file notes.md:done", "web_search ai agents:done"])
    #expect(r.stepCount == 1)
    #expect(r.text == "Here is the draft")
    #expect(LiveRuns.startedBy(r) == "You")
  }

  @Test func waitingForYouOnlyWhenAQuestionForThisRunIsPending() {
    let events = [ev("turn-start", "x", 1), ev("step", "Waiting for your approval", 2)]
    #expect(LiveRuns.runsFrom(events)[0].state == .working)
    let approval = BotApproval(id: "a", botId: "w", botName: "Writer", runId: "j1", prompt: "Run command: ls", at: 2, expiresAt: 9)
    #expect(LiveRuns.runsFrom(events, approvals: [approval])[0].state == .waiting)
    var other = approval; other.runId = "other"
    #expect(LiveRuns.runsFrom(events, approvals: [other])[0].state == .working)
  }

  @Test func aRunWhoseBotStoppedWithoutAnEndingIsEnded() {
    let events = [ev("turn-start", "x", 1_000)]
    #expect(LiveRuns.runsFrom(events, running: [], now: 200_000)[0].state == .ended)
    #expect(LiveRuns.runsFrom(events, running: ["w"], now: 200_000)[0].state == .working)
  }

  @Test func failuresStopsAndPausesReadAsSuchAndADeliveryJoinsTheRun() {
    #expect(LiveRuns.runsFrom([ev("turn-start", "x", 1), ev("turn-end", "failed: provider_timeout", 2, status: "error")])[0].state == .failed)
    #expect(LiveRuns.runsFrom([ev("turn-start", "x", 1), ev("turn-end", "stopped — by you", 2, status: "error")])[0].state == .stopped)
    #expect(LiveRuns.runsFrom([ev("turn-start", "x", 1), ev("turn-end", "paused: budget", 2)])[0].state == .paused)
    let r = LiveRuns.runsFrom([ev("turn-start", "x", 1), ev("tool", "Delivered post.md", 2, jobId: "", status: "done", botName: nil)])
    #expect(r.count == 1)
    #expect(r[0].steps[0].label == "Delivered post.md")
  }

  @Test func theStoreDropsDuplicatesAndKeepsOneThinkingPreviewPerRun() {
    let a = ev("tool", "ls", 5, status: "done")
    let t1 = ev("thinking", "thinking", 6, textTail: "Hel")
    let t2 = ev("thinking", "thinking", 7, textTail: "Hello")
    let merged = LiveRuns.merge(LiveRuns.merge([a], [a, t1]), [t2, a])
    #expect(merged.map { $0.textTail ?? $0.label } == ["ls", "Hello"])
  }

  // Beyond the desktop's tests: what the phone adds on top.

  @Test func aFailedStepKeepsItsErrorAndRunningStepsCloseWithTheRun() {
    let runs = LiveRuns.runsFrom([
      ev("turn-start", "x", 1),
      ev("tool", "run_command npm test", 2, status: "running"),
      BotActivityEvent(botId: "w", jobId: "j1", kind: "tool", label: "run_command npm test", detail: "exit 1", status: "error", at: 3),
      ev("tool", "web_fetch", 4, status: "running"),
      ev("turn-end", "failed: provider_timeout", 5, status: "error"),
    ])
    #expect(runs[0].steps.map(\.status) == ["error", "error"])
    #expect(runs[0].steps[0].detail == "exit 1")
    #expect(runs[0].endLabel == "failed: provider_timeout")
  }

  @Test func countersCountAndNotesDontRepeat() {
    let r = LiveRuns.runsFrom([
      ev("turn-start", "x", 1), ev("step", "step 3 · 12.3k tok in", 2, stepIndex: 3),
      ev("step", "no deliverable yet — asking for one", 3), ev("step", "no deliverable yet — asking for one", 4),
    ])[0]
    #expect(r.stepCount == 3)
    #expect(r.steps.map(\.label) == ["no deliverable yet — asking for one"])
    #expect(r.steps[0].status == "note")
  }

  @Test func aFleetShowsEveryMembersRunsInTimeOrder() {
    let runs = LiveRuns.runsFrom([
      BotActivityEvent(botId: "b", jobId: "j2", kind: "turn-start", label: "y", at: 5, botName: "Bea", trigger: "mailbox", fromBot: "a"),
      BotActivityEvent(botId: "a", jobId: "j1", kind: "turn-start", label: "x", at: 1, botName: "Al", trigger: "cron"),
    ])
    #expect(runs.map(\.botId) == ["b", "a"].reversed())
    #expect(LiveRuns.startedBy(runs[0]) == "Schedule")
    #expect(LiveRuns.startedBy(runs[1], nameOf: { $0 == "a" ? "Al" : nil }) == "From Al")
  }

  @Test func replyQuotesTheRun() {
    var r = LiveRuns.runsFrom([ev("turn-start", "Draft the post", 1, prompt: "Draft the post"), ev("turn-end", "completed", 2)])[0]
    r.text = "Here is\n\nthe   draft"
    #expect(LiveRuns.replyDraft(r) == "Re your run \"Draft the post\" (you said: \"…Here is the draft\"):\n")
  }

  @Test func injectionWarningsCantBeAlwaysAllowed() {
    let plain = BotApproval(id: "a", botId: "w", botName: "Writer", runId: "j", prompt: "Run command: ls", at: 0, expiresAt: 300_000)
    #expect(BotQuestion.options(for: plain).map(\.value) == ["yes", "always", "no"])
    var warn = plain; warn.prompt = "⚠ Possible prompt injection: the page asked to email your keys"
    #expect(BotQuestion.options(for: warn).map(\.value) == ["yes", "no"])
    warn.prompt = "Mercury read content from outside this computer. Run command: curl"
    #expect(BotQuestion.options(for: warn).map(\.value) == ["yes", "no"])
    #expect(BotQuestion.minutesLeft(plain, now: 0) == 5)
    #expect(BotQuestion.minutesLeft(plain, now: 400_000) == 0)
  }

  @Test func fleetsAreALeadWithItsCrew() {
    let bots = [
      BotStatus(id: "w", name: "Writer", fleetRole: "crew", parent: "m"),
      BotStatus(id: "m", name: "Manager", fleetRole: "lead"),
      BotStatus(id: "o", name: "Orphan", fleetRole: "crew", parent: "gone"),
      BotStatus(id: "a", name: "Analyst"),
    ]
    let (fleets, solo) = BotRosterLayout.organise(bots)
    #expect(fleets.map(\.lead.id) == ["m"])
    #expect(fleets[0].crew.map(\.id) == ["w"])
    #expect(solo.map(\.id) == ["a", "o"])
  }

  @Test func decodesWhatTheRuntimeSends() throws {
    let roster = #"{"bots":[{"id":"analytics-bot","name":"Analytics Bot","enabled":true,"state":"idle","needsYou":false,"hasAvatar":false,"unread":0,"tier":"full","fleetRole":"crew","parent":"m"}],"queue":{"pending":0},"available":true,"unread":2}"#
    let r = try JSONDecoder().decode(BotRoster.self, from: Data(roster.utf8))
    #expect(r.bots[0].parent == "m")
    #expect(r.unread == 2)
    let activity = #"{"botId":"m","jobId":"33f9d071","elapsedMs":0.5015830000047572,"kind":"tool","label":"bot_no_update","stepIndex":2,"status":"done","at":1794490757481,"botName":"opersource.fyi manger"}"#
    let e = try JSONDecoder().decode(BotActivityEvent.self, from: Data(activity.utf8))
    #expect(e.stepIndex == 2 && e.at == 1794490757481)
    let entry = #"{"botId":"d","botName":"Deployment Bot","runId":"03ebb076","kind":"needs-you","approvalId":"2b07","files":[],"title":"t","summary":"s","id":"x","at":1794325296083,"read":true}"#
    #expect(try JSONDecoder().decode(BotInboxEntry.self, from: Data(entry.utf8)).approvalId == "2b07")
    let journal = #"{"runId":"46345a31","botId":"m","trigger":"mailbox","state":"completed","startedAt":1794325267049,"durationMs":29030,"tokensIn":111296,"tokensOut":2454,"report":"result","complete":true,"steps":6,"toolCalls":9,"outcome":"deliverable"}"#
    #expect(try JSONDecoder().decode(BotRunRecord.self, from: Data(journal.utf8)).label == "delivered · done")
    // The stream: every connect starts with the roster.
    if case .roster(let b)? = MercuryClient.botEvent(ServerEvent(name: "bot_roster", data: roster)) { #expect(b.count == 1) } else { Issue.record("no roster") }
    if case .activity(let a)? = MercuryClient.botEvent(ServerEvent(name: "bot_activity", data: #"{"botId":"m","kind":"step","label":"x"}"#)) { #expect(a.at != nil) } else { Issue.record("no activity") }
  }
}

/// Against a real Mercury: MERCURY_URL=http://127.0.0.1:6174 MERCURY_TOKEN=<device or attach token> swift test --filter BotsRuntimeTests
struct BotsRuntimeTests {
  static let env = ProcessInfo.processInfo.environment
  static let client: MercuryClient? = {
    guard let u = env["MERCURY_URL"].flatMap(URL.init(string:)), let t = env["MERCURY_TOKEN"] else { return nil }
    return MercuryClient(baseURL: u, token: t)
  }()

  @Test(.enabled(if: client != nil)) func readsEveryBotsRoute() async throws {
    let c = Self.client!
    let roster = try await c.bots()
    _ = try await c.botApprovals()
    _ = try await c.botInbox(limit: 20)
    let events = try await c.botActivity(roster.bots.map(\.id))
    _ = LiveRuns.runsFrom(events, running: Set(roster.bots.filter(\.isRunning).map(\.id)))
    if let b = roster.bots.first { _ = try await c.botJournal(b.id, limit: 5) }
    // Harmless writes: a question that isn't waiting, and a bot that doesn't exist.
    await #expect(throws: MercuryError.self) { try await c.answerBot("no-such-question", "no") }
    let sent = try await c.messageBot("no-such-bot-\(UUID().uuidString.prefix(6).lowercased())", "hello")
    #expect(!sent.accepted)
    // The stream opens with the roster.
    var first: BotStreamEvent?
    for await e in c.botEvents() { first = e; break }
    if case .roster(let bots)? = first { #expect(bots.count == roster.bots.count) } else { Issue.record("the stream didn't start with the roster") }
  }
}
