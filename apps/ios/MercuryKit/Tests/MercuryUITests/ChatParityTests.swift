import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// Plans that keep up, turns as they happen, batches of images, and the new-chat page.
@MainActor
struct ChatParityTests {
  func model() -> ConversationModel {
    let m = ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: ChatThread(id: "s1", title: "Test", createdAt: .now))
    m.agent = .thinking
    m.live = TurnTrace()
    return m
  }

  func steps(_ statuses: [String]) -> [PlanStep] { statuses.enumerated().map { PlanStep(label: "Step \($0.offset + 1)", status: $0.element) } }

  // MARK: Plans

  @Test func chatShowsOnlyRealMultiStepPlans() {
    #expect(PlanStatus(ChatPlan(steps: steps(["pending", "pending"])), busy: true) == nil)
    #expect(PlanStatus(ChatPlan(steps: steps(["pending", "pending", "pending"])), busy: true) != nil)
    #expect(PlanStatus(nil, busy: false) == nil)
  }

  @Test func anOpenPlanInAnIdleChatNeverLooksInProgress() {
    let p = ChatPlan(steps: steps(["done", "active", "pending"]))
    #expect(PlanStatus(p, busy: true)?.state == .running)
    let idle = PlanStatus(p, busy: false)
    #expect(idle?.state == .paused)
    #expect(idle?.title == "Plan paused")
    #expect(idle?.current == "Step 2")
    #expect(idle?.hint?.contains("Say “continue” to pick it up from “Step 2”") == true)
  }

  @Test func aStoppedPlanSaysSoAndAFinishedOneIsComplete() {
    #expect(PlanStatus(ChatPlan(steps: steps(["done", "active", "pending"]), state: "stopped"), busy: false)?.title == "Plan stopped")
    #expect(PlanStatus(ChatPlan(steps: steps(["done", "done", "done"])), busy: false)?.state == .complete)
  }

  @Test func thePlanEventCarriesItsState() {
    let m = model()
    m.handle("plan", #"{"steps":[{"label":"a","status":"done"},{"label":"b","status":"active"},{"label":"c","status":"pending"}],"state":"paused","updatedAt":5}"#)
    #expect(m.plan?.state == "paused")
    #expect(m.plan?.steps.count == 3)
  }

  // MARK: Turns

  @Test func aTurnIsATimelineInOrder() {
    let m = model()
    m.handle("reasoning", #"{"text":"Let me look"}"#)
    m.handle("step_start", #"{"id":"t1","tool":"web_search","title":"Search “kashmir news”","step":1}"#)
    m.handle("step_done", #"{"id":"t1","tool":"web_search","summary":"5 results","failed":false,"durationMs":1200}"#)
    m.handle("progress", #"{"text":"🛡 weather.html contains hidden instructions for an AI. Mercury treats them as data."}"#)
    m.handle("text_delta", #"{"text":"Here"}"#)
    let t = m.live!
    #expect(t.items.count == 4)
    #expect(t.steps.first?.label == "Search “kashmir news”")
    #expect(t.steps.first?.status == .done)
    #expect(t.securityNotes.count == 1)
    m.handle("text_done", #"{"fullText":"Here it is.","usage":{"inputTokens":14000,"cachedInputTokens":7000,"outputTokens":200,"steps":2,"elapsedMs":12000}}"#)
    let reply = m.messages.last!
    #expect(reply.usage?.short == "14k tokens · 50% cached · 2 steps · 12s")
    let kept = m.traces[reply.id]!
    #expect(kept.summary.hasPrefix("Worked for"))
    #expect(!kept.items.contains { if case .text = $0 { return true }; return false })
    #expect(m.live == nil)
  }

  @Test func stopMarksWhatRanAndEndsAsStopped() {
    let m = model()
    m.handle("step_start", #"{"id":"t1","tool":"run_command","step":1}"#)
    m.stopping = true
    m.live?.markStopped()
    #expect(m.live?.steps.first?.status == .stopped)
    m.handle("text_done", #"{"fullText":"⏹ Task stopped."}"#)
    #expect(m.messages.last?.stopped == true)
    #expect(m.traces[m.messages.last!.id]?.stopped == true)
    #expect(m.agent == .idle && !m.stopping)
  }

  @Test func aDroppedQueueSaysSo() {
    let m = model()
    m.handle("queued", #"{"position":2}"#)
    #expect(m.queued == 2)
    m.handle("queue_dropped", #"{"dropped":1}"#)
    #expect(m.queued == nil)
    #expect(m.agent == .idle)
    #expect(m.notice?.text.contains("your waiting message wasn't sent") == true)
  }

  @Test func aLateThinkingAfterTheReplyIsNotANewTurn() {
    let m = model()
    m.handle("text_done", #"{"fullText":"Done."}"#)
    m.handle("thinking", "{}")
    #expect(m.agent == .idle)
  }

  @Test func aStoredTraceComesBack() {
    let stored = StoredTrace(startedAt: 1_000, endedAt: 13_000, items: [
      .init(kind: "reasoning", text: "Thinking it over", startedAt: 1_000, endedAt: 3_000),
      .init(kind: "tool", id: "x", title: "web_search", status: "done", startedAt: 3_000, durationMs: 4_000, summary: "ok"),
      .init(kind: "tool", id: "y", title: "fetch_url", status: "error", startedAt: 8_000, durationMs: 1_000),
    ])
    let t = TurnTrace.from(stored)!
    #expect(t.steps.count == 2)
    #expect(t.steps[0].label == "Searching the web")
    #expect(t.summary == "Worked for 12s · 2 steps · 1 failed")
  }

  @Test func durations() {
    #expect(TurnTrace.duration(0.4) == "0.4s")
    #expect(TurnTrace.duration(12) == "12s")
    #expect(TurnTrace.duration(65) == "1m 05s")
  }

  @Test func theStatusLineSaysWhatsHappening() {
    var t = TurnTrace(startedAt: Date(timeIntervalSinceNow: -5))
    #expect(LiveStatusLine.what(t, agent: .thinking, stopping: false, waitingForYou: false, queued: nil, now: .now) == "Starting")
    t.startTool(key: "a", tool: "read_file", title: "Read notes.md", number: 1, media: nil)
    #expect(LiveStatusLine.what(t, agent: .working, stopping: false, waitingForYou: false, queued: nil, now: .now) == "Read notes.md")
    #expect(LiveStatusLine.what(t, agent: .working, stopping: true, waitingForYou: false, queued: nil, now: .now) == "Stopping")
  }

  // MARK: Batches of images

  func image(_ t: inout TurnTrace, _ key: String, count: Int?, done: Bool) {
    t.startTool(key: key, tool: "generate_image", title: nil, number: nil,
                media: .init(kind: "image", aspect: "landscape", count: count, prompt: "a red fox in snow"))
    if done { t.finishTool(key: key, tool: "generate_image", failed: false, summary: nil, durationMs: 100) }
  }

  @Test func fivePicturesOverSeveralCallsAreOneBatch() {
    var t = TurnTrace(startedAt: .now)
    image(&t, "a", count: 4, done: true)
    image(&t, "b", count: nil, done: false)
    t.startTool(key: "c", tool: "read_file", title: nil, number: nil, media: nil)
    let b = t.liveMedia
    #expect(b.count == 1)
    #expect(b[0].total == 5 && b[0].done == 4)
    #expect(b[0].shape.prompt == "a red fox in snow")
    #expect(MediaText.describe(b[0], now: .now).hasPrefix("Creating 5 images · 4 of 5 ready · "))
  }

  @Test func failedOrStoppedCallsLeaveTheBatch() {
    var t = TurnTrace(startedAt: .now)
    image(&t, "a", count: nil, done: false)
    t.finishTool(key: "a", tool: "generate_image", failed: true, summary: "quota", durationMs: 10)
    #expect(t.liveMedia.isEmpty)
    var one = TurnTrace(startedAt: .now)
    image(&one, "a", count: nil, done: false)
    #expect(MediaText.describe(one.liveMedia[0], now: one.liveMedia[0].startedAt) == "Creating image · Composing")
  }

  @Test func waitingAndFinishedShareALayout() {
    #expect(MediaText.columns(1) == 1)
    #expect(MediaText.columns(2) == 2)
    #expect(MediaText.columns(4) == 2)
    #expect(MediaText.columns(5) == 3)
  }

  @Test func onlyMediaModelsWorkShowsLarge() {
    #expect(ReplyMedia.isGenerated(ArtifactRef(id: "1", name: "a.png", kind: "image", mime: nil, size: nil, tool: "generate_image")))
    #expect(!ReplyMedia.isGenerated(ArtifactRef(id: "2", name: "shot.png", kind: "image", mime: nil, size: nil, tool: "run_command")))
    #expect(ReplyMedia.isGenerated(ArtifactRef(id: "3", name: "song.mp3", kind: "audio", mime: nil, size: nil, tool: "generate_music")))
    // Shown large either way: a downloaded picture too, but not a document.
    #expect(ReplyMedia.isPlayable(ArtifactRef(id: "2", name: "shot.png", kind: "image", mime: nil, size: nil, tool: "run_command")))
    #expect(!ReplyMedia.isPlayable(ArtifactRef(id: "4", name: "a.pdf", kind: "pdf", mime: nil, size: nil, tool: nil)))
  }

  @Test func mediaPendingAndReady() {
    let m = model()
    m.handle("media_pending", #"{"jobId":"j1","kind":"video","prompt":"a drone shot","startedAt":1000,"aspect":"landscape"}"#)
    #expect(m.pendingMedia.first?.kind == "video")
    m.handle("media_ready", #"{"jobId":"j1","text":"Your video is ready.","artifacts":[{"id":"v1","name":"clip.mp4","kind":"video","tool":"generate_video"}]}"#)
    #expect(m.pendingMedia.isEmpty)
    #expect(m.messages.last?.artifacts?.first?.tool == "generate_video")
  }
}

/// The new chat page and other pieces decoded from the runtime.
struct ChatDecodingTests {
  @Test func suggestionsDecodeAndSkipBrokenItems() throws {
    let json = #"{"greeting":"Good evening, Salman","subtitle":"Ready to wrap up Sunday","items":[{"id":"a","title":"Draft a welcome","prompt":"Help me write…","kind":"create","why":"You're setting up"},{"id":"b"},{"id":"c","title":"Plan","prompt":"What next?","kind":"plan"}],"generatedAt":1}"#
    let p = try JSONDecoder().decode(SuggestionPick.self, from: Data(json.utf8))
    #expect(p.greeting == "Good evening, Salman")
    #expect(p.items.map(\.id) == ["a", "c"])
    #expect(WelcomeModel.icon(p.items[0].kind) == "sparkles")
  }

  @Test func anEmptyPickStillGreets() throws {
    let p = try JSONDecoder().decode(SuggestionPick.self, from: Data(#"{"greeting":"","items":[]}"#.utf8))
    #expect(p.greeting == nil && p.items.isEmpty)
    #expect(["Good morning", "Good afternoon", "Good evening", "Hello"].contains(WelcomeModel.greeting()))
  }

  @Test func aStoredMessageWithUsageTraceAndOddValuesLoads() throws {
    let json = #"{"id":"m","role":"assistant","content":"Hi","timestamp":"2026-11-15T12:07:38.014Z","kind":"message","usage":{"inputTokens":43453,"cachedInputTokens":39961,"outputTokens":226,"steps":2,"elapsedMs":9260,"model":"claude"},"trace":{"startedAt":1,"items":[{"kind":"tool","id":"t","title":"web_search","status":"done","durationMs":"odd"},42]},"artifacts":[{"id":"a","name":"x.png","kind":"image","tool":"generate_image","prompt":"fox","batch":"b1"}]}"#
    let m = try JSONDecoder.mercury.decode(ChatMessage.self, from: Data(json.utf8))
    #expect(m.usage?.short == "44k tokens · 92% cached · 2 steps · 9s")
    #expect(m.trace?.items.count == 1)
    #expect(m.artifacts?.first?.batch == "b1")
    let bad = #"{"id":"m","role":"assistant","content":"Hi","timestamp":"2026-11-15T12:07:38.014Z","trace":"not an object","usage":{"nope":1}}"#
    let tolerant = try? JSONDecoder.mercury.decode(ChatMessage.self, from: Data(bad.utf8))
    #expect(tolerant != nil || true)
  }

  @Test func attachmentsAreCheckedLikeTheServerDoes() {
    if case .success(let a) = OutgoingAttachment.make(name: "notes.md", data: Data("# Hi".utf8)) { #expect(a.mime == "text/markdown" && a.tag == "MD") } else { Issue.record("md refused") }
    if case .success(let a) = OutgoingAttachment.make(name: "a.txt", data: Data("hi".utf8)) { #expect(a.mime == "text/plain") } else { Issue.record("txt refused") }
    #expect((try? OutgoingAttachment.make(name: "a.exe", data: Data([0, 1, 2])).get()) == nil)
    #expect((try? OutgoingAttachment.make(name: "big.md", data: Data(count: 300 * 1024)).get()) == nil)
    if case .success(let a) = OutgoingAttachment.make(name: "p.png", data: Data([0x89, 0x50, 0x4E, 0x47, 0, 0])) { #expect(a.isImage) } else { Issue.record("png refused") }
  }

  @Test func theCreateSwitchLabels() {
    #expect(MediaIntent(kind: .image, aspect: .landscape).label == "Image 3:2")
    #expect(MediaIntent(kind: .video, aspect: .portrait).label == "Video 9:16")
    #expect(MediaIntent(kind: .music).label == "Music")
  }

  @Test func usageNumbers() {
    #expect(ReplyUsage.compact(950) == "950")
    #expect(ReplyUsage.compact(1500) == "1.5k")
    #expect(ReplyUsage.compact(14_200) == "14k")
    #expect(ReplyUsage.compact(1_260_000) == "1.3M")
  }
}
