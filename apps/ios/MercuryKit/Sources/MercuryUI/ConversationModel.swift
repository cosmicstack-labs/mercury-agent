import SwiftUI
import MercuryCore

/// One conversation: its messages, the turn as it happens (thinking, steps, the reply as it
/// streams), its plan, the questions it waits on, and the composer's state (files, the Create
/// switch, the chat's thinking effort). apps/desktop/src/app/events.ts is the reference.
@MainActor @Observable
final class ConversationModel {
  enum Agent: Equatable { case idle, thinking, working, streaming }

  /// A step as the voice call and older callers read it (from the live trace).
  struct Step: Identifiable, Equatable { var id: Int; var tool: String; var label: String; var done = false; var failed = false; var summary: String? }
  struct Prompt: Identifiable, Equatable {
    struct Option: Equatable, Hashable { var value: String; var label: String }
    var id: String; var kind: String; var text: String; var options: [Option]; var targetId: String?
  }
  /// A line from the runtime about this chat (a stall, a dropped message).
  struct Notice: Equatable { var text: String; var warning: Bool }

  var threadId: String?
  var title: String
  /// When the owner saved this chat to come back to (nil: not saved).
  var savedAt: Date?
  var messages: [ChatMessage] = []
  /// Finished replies' thought processes, by message id.
  var traces: [String: TurnTrace] = [:]
  var agent: Agent = .idle
  /// The running turn, in order. Nil when nothing runs.
  var live: TurnTrace?
  var streaming = ""
  var plan: ChatPlan?
  var prompts: [Prompt] = []
  var pendingArtifacts: [ArtifactRef] = []
  /// Videos and songs being made in the background for this chat.
  var pendingMedia: [PendingMedia] = []
  var queued: Int?
  /// Stop was pressed; the turn ends when the runtime confirms (or after a few seconds).
  var stopping = false
  var notice: Notice?
  var error: String?
  var loaded = false

  // Composer
  var draft = ""
  var attachments: [OutgoingAttachment] = []
  /// The Create switch for the next message (image, video or music).
  var media: MediaIntent?
  var model: ChatModelInfo?
  var mediaAvailable: MediaAvailability?
  /// An effort picked before the chat existed: applied when it's created.
  var pendingEffort: String?
  /// Code (the top bar's Ask | Code): each message is a coding turn (POST /api/chat/send
  /// `programming: "auto"`: Mercury plans or executes, works with files and commands, verifies),
  /// in Mercury's project folder (`cwd`, from GET /api/workspace/info), as Mercury Desktop's Code
  /// view sends it. Ask is a normal chat.
  var code = false {
    didSet { if code && workspace == nil { Task { await loadWorkspace() } } }
  }
  /// The folder Code works in (nil until loaded, or on an older runtime: the turn then runs in
  /// whatever folder Mercury is in).
  var workspace: WorkspaceInfo?
  /// The models Mercury offers and which runs (the composer's model pill).
  var catalog: ModelCatalog?
  /// A model switch is on its way.
  var switching = false
  /// Live dictation into `draft` (the composer's mic).
  let dictation = DictationModel()
  /// The owner's go-ahead for a change an older Mercury gates (Allow All).
  let gate: OwnerGate
  /// Ask Me / Allow All: the model sheet's Permissions and the indicator by the model pill.
  let permissions: PermissionModel

  let client: MercuryClient
  var listener: Task<Void, Never>?
  var onChange: () -> Void = {}
  /// Set while a voice call runs in this conversation: what's sent is said on that call.
  var callId: String?
  /// A call was asked for from outside the chat (the side panel, a Home Screen quick action):
  /// the chat's screen starts it and clears this.
  var callRequested = false
  /// The ring the requested call answers (ADR-046): Mercury called, so it says why first.
  var ringInvite: RingInvite?
  /// "Set up voice" is showing (a call or the mic was tapped on a Mercury that can't do it yet).
  var voiceSetup: VoiceSetup.Trigger?
  var titleCheck: Task<Void, Never>?
  var stopFallback: Task<Void, Never>?
  /// A turn ended, with Mercury's reply when it gave one (a voice call reads it aloud).
  var onTurnEnd: (ChatMessage?) -> Void = { _ in }
  /// When the last reply landed: a late "thinking" right after it is not a new turn.
  var lastReplyAt: Date?
  /// This chat was seen: it came on screen (true), left it (false), or was seen without a screen
  /// changing (nil). The list marks it read (ChatsModel.viewing).
  var onSeen: (_ id: String, _ open: Bool?) -> Void = { _, _ in }

  init(client: MercuryClient, thread: ChatThread?) {
    self.client = client
    threadId = thread?.id
    title = thread?.displayTitle ?? "New chat"
    savedAt = thread?.savedAt
    gate = OwnerGate(client: client)
    permissions = PermissionModel(client: client, gate: gate)
    dictation.conversation = self
  }

  var busy: Bool { agent != .idle || stopping }
  var canSend: Bool { !draft.trimmed.isEmpty || !attachments.isEmpty }

  /// The running turn's tool steps, newest last.
  var steps: [Step] {
    (live?.steps ?? []).map { Step(id: $0.number, tool: $0.tool, label: $0.label, done: $0.status != .running, failed: $0.status == .error, summary: $0.summary) }
  }

  // MARK: Loading

  func load() async {
    guard let id = threadId else { loaded = true; return }
    do {
      let t = try await client.thread(id)
      setMessages(t.messages)
      title = t.displayTitle
      savedAt = t.savedAt
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
    listen()
    await catchUp(id)
  }

  /// Messages from the runtime: what a person reads, with each reply's stored thought process.
  func setMessages(_ all: [ChatMessage]) {
    messages = all.filter(\.isShown)
    traces = [:]
    for m in messages where m.role == "assistant" {
      if let s = m.trace, let t = TurnTrace.from(s), t.hasProcess { traces[m.id] = t }
    }
  }

  /// What happened while this screen wasn't watching: questions still waiting, the plan, a place
  /// in line, the reply being worked on, videos on their way. Each is optional (older runtimes).
  func catchUp(_ id: String) async {
    async let pending = client.pendingPrompts(id)
    async let plan = client.plan(id)
    async let queue = client.queuePosition(id)
    async let snap = client.liveTurn(id)
    async let jobs = client.mediaJobs(id)
    for e in await pending where threadId == id { handle(e.name, e.data) }
    if let p = await plan, threadId == id { self.plan = p }
    if let q = await queue, threadId == id { queued = q; if agent == .idle { agent = .thinking } }
    if let s = await snap, threadId == id { restore(s) }
    let j = await jobs
    if threadId == id { pendingMedia = j }
  }

  /// The runtime's snapshot of a reply still being worked on, onto the screen.
  func restore(_ s: LiveSnapshot) {
    guard s.running else {
      // It finished while away: the reply is in the messages now.
      if busy && queued == nil && !stopping { live = nil; streaming = ""; agent = .idle }
      return
    }
    let t = TurnTrace.live(s)
    live = t
    streaming = s.text ?? ""
    agent = t.runningStep != nil ? .working : streaming.isEmpty ? .thinking : .streaming
  }

  func listen() {
    guard let id = threadId else { return }
    listener?.cancel()
    listener = Task {
      let q = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id
      for await e in client.events("/api/chat/events?sessionId=\(q)") { handle(e.name, e.data) }
    }
  }

  // MARK: Sending

  func send() async {
    // Sending ends dictation: what's in the box (the live words too) is what's sent.
    dictation.cancel()
    let text = draft.trimmed
    let files = attachments
    guard !text.isEmpty || !files.isEmpty else { return }
    // One tap is one message: the same words again while the first is still on its way (a second
    // tap, an idea picked again while a slow new chat is created) are dropped, not sent twice.
    if files.isEmpty && inFlight.contains(text) { draft = ""; return }
    // The Create switch is for a real ask: never a command or a voice call.
    let intent = callId == nil && !text.isEmpty && !text.hasPrefix("/") && !text.hasPrefix("#") ? media : nil
    let keptMedia = media
    draft = ""; attachments = []; media = nil
    error = nil
    let shown = text.isEmpty ? "(Attached: \(files.map(\.name).joined(separator: ", ")))" : text
    var optimistic = ChatMessage(role: "user", content: shown)
    if !files.isEmpty { optimistic.attachments = files.map { SentAttachment(name: $0.name, kind: $0.isImage ? "image" : "document", mime: $0.mime) } }
    // Shown at once, before the chat exists: the welcome and its ideas go away, so nothing invites
    // a second tap while a slow POST /api/chat/threads runs.
    messages.append(optimistic)
    agent = .thinking
    live = TurnTrace()
    stopping = false
    notice = nil
    if files.isEmpty { inFlight.insert(text) }
    defer { if files.isEmpty { inFlight.remove(text) } }
    do {
      let id = try await ensureThread()
      let coding = code && callId == nil
      if coding && workspace == nil { await loadWorkspace() }
      try await client.sendMessage(text, sessionId: id, attachments: files, media: intent, voiceCall: callId,
                                   programming: coding ? "auto" : nil, cwd: coding ? workspace?.cwd : nil)
      onChange()
    } catch {
      self.error = error.localizedDescription
      messages.removeAll { $0.id == optimistic.id }
      if live?.hasProcess != true { live = nil; agent = .idle }
      draft = text; attachments = files; media = keptMedia
    }
  }

  /// Mercury's project folder, for Code (quietly nothing on an older runtime).
  func loadWorkspace() async {
    if let w = try? await client.workspaceInfo() { workspace = w }
  }

  /// Messages on their way (text as typed): the same one again before it lands is a double send.
  @ObservationIgnored var inFlight: Set<String> = []
  /// The one POST /api/chat/threads for a new chat: sends racing here all wait for it.
  @ObservationIgnored var creating: Task<String, Error>?

  /// This chat's id, creating it on Mercury first when it's new: once, however many sends race here.
  func ensureThread() async throws -> String {
    if let threadId { return threadId }
    if let creating { return try await creating.value }
    let task = Task { @MainActor [client] in try await client.createThread().id }
    creating = task
    do {
      let id = try await task.value
      creating = nil
      if threadId == nil {
        threadId = id
        // A chat you start yourself is never "new" in the list.
        onSeen(id, nil)
        listen()
        if let e = pendingEffort {
          pendingEffort = nil
          _ = try? await client.setEffort(sessionId: id, level: e)
        }
      }
      return threadId ?? id
    } catch {
      creating = nil
      throw error
    }
  }

  /// The model pill's list: every model Mercury offers, the current one, the default ("Auto").
  func loadModels() async {
    if let c = try? await client.modelCatalog(sessionId: threadId) { catalog = c }
  }

  /// Switches Mercury's model (`pick` nil: back to the configured default, "Auto"). Mercury has
  /// one model for every chat, so this changes it everywhere; the sheet says so.
  func pickModel(_ pick: ModelChoice?) async {
    guard let c = catalog, let t = ModelMenu.target(c, pick) else { return }
    switching = true
    defer { switching = false }
    do {
      try await client.switchModel(provider: t.provider, model: t.model)
      await loadModels()
      await loadComposerInfo()
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Deletes this chat on Mercury. True once it's gone.
  func delete() async -> Bool {
    guard let id = threadId else { return false }
    do {
      try await client.deleteThread(id)
      listener?.cancel()
      onChange()
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }

  /// Stop: what was running shows as stopped at once, this chat's turn is asked to stop (others
  /// keep running), and the turn ends when the runtime confirms, or after a few seconds if it never does.
  func stop() async {
    guard !stopping, let id = threadId else { return }
    stopping = true
    live?.markStopped()
    do {
      try await client.stop(threadId: id)
    } catch {
      stopping = false
      self.error = error.localizedDescription
      return
    }
    stopFallback?.cancel()
    stopFallback = Task {
      try? await Task.sleep(for: .seconds(8))
      if !Task.isCancelled, stopping { finishStopped() }
    }
  }

  func answer(_ p: Prompt, _ value: String) async {
    do {
      try await client.answer(promptId: p.id, action: value, targetId: p.targetId)
      prompts.removeAll { $0.id == p.id }
    } catch { self.error = error.localizedDescription }
  }

  /// The owner's name for this chat; Mercury keeps it.
  func rename(_ name: String) async {
    let t = name.trimmed
    guard let id = threadId, !t.isEmpty else { return }
    do { title = try await client.renameThread(id, title: t); onChange() }
    catch { self.error = error.localizedDescription }
  }

  /// Save this chat to come back to, or unsave it (the same bookmark as the list's and Desktop's).
  func toggleSaved() async {
    guard let id = threadId else { return }
    let was = savedAt
    let saving = was == nil
    savedAt = saving ? .now : nil
    do {
      let at = try await client.setThreadSaved(id, saved: saving)
      savedAt = saving ? (at ?? savedAt) : nil
      onChange()
    } catch {
      savedAt = was
      self.error = error.localizedDescription
    }
  }

  /// What the title area says under the name: a question waiting beats work in progress.
  var titleStatus: TitleStatus? {
    if !prompts.isEmpty { return .needsYou }
    return agent != .idle && !stopping ? .working : nil
  }
  enum TitleStatus { case working, needsYou }

  // MARK: Composer

  /// The model's efforts and which media this Mercury can make, for the composer's menu.
  func loadComposerInfo() async {
    async let m = try? client.chatModel(sessionId: threadId)
    async let a = try? client.mediaAvailability()
    if let m = await m { model = m; if let e = pendingEffort { model?.effort = Self.withPending(m.currentEffort, e) } }
    mediaAvailable = await a
  }

  /// This chat's thinking effort: a level, "auto", or nil for the model's default.
  func setEffort(_ level: String?) async {
    guard let id = threadId else {
      pendingEffort = level
      if let m = model { model?.effort = level.map { Self.withPending(m.currentEffort, $0) } ?? ChatEffort(effective: m.currentEffort.modelDefault, source: "model", modelDefault: m.currentEffort.modelDefault, chat: nil) }
      return
    }
    do {
      if let e = try await client.setEffort(sessionId: id, level: level) { model?.effort = e }
      if let m = try? await client.chatModel(sessionId: id) { model = m }
    } catch { self.error = error.localizedDescription }
  }

  static func withPending(_ e: ChatEffort, _ level: String) -> ChatEffort {
    ChatEffort(effective: level, source: "chat", modelDefault: e.modelDefault, chat: level)
  }

  func attach(_ name: String, _ data: Data) {
    guard attachments.count < OutgoingAttachment.maxFiles else { error = AttachmentProblem.tooMany.errorDescription; return }
    switch OutgoingAttachment.make(name: name, data: data) {
    case .success(let a): attachments.append(a); error = nil
    case .failure(let p): error = p.errorDescription
    }
  }

  // MARK: Events

  func handle(_ event: String, _ raw: String) {
    let data = (raw.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    if let s = data["sessionId"] as? String, let id = threadId, s != id { return }
    let now = Date.now
    switch event {
    case "status":
      // The runtime's live status: Ask Me / Allow All changed anywhere (Desktop, a terminal, a phone).
      permissions.apply(status: data)
    case "queued":
      queued = data["position"] as? Int ?? 1
      if agent == .idle { agent = .thinking }
      if live == nil { live = TurnTrace() }
    case "queue_dropped":
      // A stop took this chat's waiting message(s) out of line (ADR-038): they won't run.
      let wasWaiting = queued != nil
      queued = nil
      if stopping { finishStopped(); break }
      if wasWaiting && streaming.isEmpty && live?.hasProcess != true { live = nil; agent = .idle }
      let n = data["dropped"] as? Int ?? 1
      notice = Notice(text: "Stopped before it started: " + (n == 1 ? "your waiting message wasn't sent." : "\(n) waiting messages weren't sent."), warning: false)
    case "thinking":
      // Sent every few seconds while a turn makes progress. It starts a turn on screen only when
      // none is showing, and never turns Working or Writing back into Thinking.
      queued = nil
      if agent == .idle {
        if live == nil, let last = lastReplyAt, now.timeIntervalSince(last) < 2.5 { break }
        agent = .thinking
      }
      if live == nil { live = TurnTrace() } else { live?.touch(now) }
    case "phase":
      if let p = data["phase"] as? String, !p.isEmpty, live != nil || agent != .idle {
        let d = data["detail"] as? String ?? ""
        let hidden = Rx.match(#"^(stall|step budget|verification gate|execute guard|completion contract)$"#, d, caseless: true) != nil
        ensureLive().setPhase(d.isEmpty || hidden ? p : "\(p) · \(d)", now: now)
      }
    case "reasoning":
      queued = nil
      if data["done"] as? Bool == true { live?.endReasoning(now); break }
      if let t = data["text"] as? String, !t.isEmpty { ensureLive().addReasoning(t, now: now); if agent == .idle { agent = .thinking } }
    case "progress":
      // "Checking my work…", or Mercury's own warning about hidden instructions: a note in the turn.
      if let t = data["text"] as? String, !t.trimmed.isEmpty {
        if live == nil && agent == .idle {
          // Between turns: a line of its own, so it's never lost.
          messages.append(ChatMessage(role: "system", content: t))
        } else { ensureLive().addNote(t, now: now) }
      }
    case "notice":
      if let m = data["message"] as? String { notice = Notice(text: m, warning: data["level"] as? String == "warning") }
    case "step_start":
      queued = nil
      let tool = data["tool"] as? String ?? ""
      ensureLive().startTool(key: data["id"] as? String, tool: tool, title: data["title"] as? String,
                             number: (data["step"] ?? data["stepNumber"]) as? Int, media: TurnTrace.MediaShape(data["media"]), now: now)
      agent = .working
    case "step_done":
      let tool = data["tool"] as? String ?? ""
      let summary = data["summary"] as? String
      let failed = Self.stepFailed(data, summary)
      let shown = failed ? ((data["reason"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? summary) : summary
      live?.finishTool(key: data["id"] as? String, tool: tool, failed: failed, summary: shown, durationMs: data["durationMs"] as? Double, now: now)
    case "text_delta":
      queued = nil
      agent = .streaming
      let t = data["text"] as? String ?? ""
      streaming += t
      ensureLive().addText(t, now: now)
    case "text_done":
      queued = nil
      notice = nil
      let text = (data["fullText"] ?? data["text"]) as? String ?? streaming
      // The runtime's reply to a stop is its "⏹ Task stopped" note: the turn ends as stopped.
      if Self.isStopNote(text) || (stopping && text.trimmed.isEmpty) { finishStopped(); break }
      var reply: ChatMessage?
      if !text.isEmpty {
        var m = ChatMessage(role: "assistant", content: text, artifacts: pendingArtifacts.isEmpty ? nil : pendingArtifacts)
        m.usage = ReplyUsage(json: data["usage"])
        if let t = live, t.hasProcess { traces[m.id] = t.finished(now: now) }
        messages.append(m)
        reply = m
      }
      lastReplyAt = now
      finishTurn(reply: reply)
    case "plan":
      let steps = (data["steps"] as? [[String: Any]] ?? []).map { PlanStep(label: $0["label"] as? String ?? "", status: $0["status"] as? String ?? "pending") }
      let state = data["state"] as? String
      if !steps.isEmpty { plan = ChatPlan(steps: steps, updatedAt: data["updatedAt"] as? Double ?? now.timeIntervalSince1970 * 1000, state: state == "paused" || state == "stopped" ? state : nil) }
    case "artifacts":
      let items = (data["items"] as? [[String: Any]] ?? []).compactMap(Self.artifact)
      guard !items.isEmpty else { break }
      if agent == .idle, let i = messages.lastIndex(where: { $0.role == "assistant" }), i == messages.count - 1 {
        messages[i].artifacts = (messages[i].artifacts ?? []) + items
      } else {
        pendingArtifacts += items
      }
    case "media_pending":
      guard let job = data["jobId"] as? String else { break }
      let p = PendingMedia(jobId: job, kind: data["kind"] as? String == "music" ? "music" : "video", aspect: data["aspect"] as? String,
                           prompt: data["prompt"] as? String, startedAt: data["startedAt"] as? Double)
      pendingMedia = pendingMedia.filter { $0.jobId != job } + [p]
    case "media_ready":
      // A video or song made in the background, after its turn ended: a message of its own.
      if let job = data["jobId"] as? String { pendingMedia.removeAll { $0.jobId == job } }
      let items = (data["artifacts"] as? [[String: Any]] ?? []).compactMap(Self.artifact)
      messages.append(ChatMessage(role: "assistant", content: data["text"] as? String ?? "", artifacts: items.isEmpty ? nil : items))
      onChange()
    case "permission_request", "permission_continue", "choice_prompt":
      let options: [Prompt.Option] = (data["options"] as? [Any] ?? []).map {
        if let v = $0 as? String { return .init(value: v, label: Self.optionLabel(v)) }
        let o = $0 as? [String: Any] ?? [:]
        let v = o["value"] as? String ?? ""
        return .init(value: v, label: o["label"] as? String ?? v)
      }
      let text = (data["prompt"] ?? data["question"]) as? String ?? ""
      let id = data["id"] as? String ?? UUID().uuidString
      if let i = prompts.firstIndex(where: { $0.id == id }) {
        prompts[i] = Prompt(id: id, kind: event, text: text, options: options, targetId: data["targetId"] as? String)
      } else {
        prompts.append(Prompt(id: id, kind: event, text: text, options: options, targetId: data["targetId"] as? String))
      }
    case "permission_resolved", "choice_resolved":
      if let id = data["id"] as? String { prompts.removeAll { $0.id == id } }
    case "error":
      queued = nil
      notice = nil
      messages.append(ChatMessage(role: "system", content: data["message"] as? String ?? "Something went wrong."))
      stopping = false
      finishTurn()
    default:
      break
    }
  }

  /// The running turn's trace, started if events arrive before one is showing.
  func ensureLive() -> TurnTraceRef {
    if live == nil { live = TurnTrace() }
    return TurnTraceRef(model: self)
  }

  func finishTurn(reply: ChatMessage? = nil) {
    streaming = ""
    live = nil
    pendingArtifacts = []
    queued = nil
    agent = .idle
    // A turn that finished on its own while Stop was on its way is over too.
    stopping = false
    stopFallback?.cancel()
    onChange()
    // A reply heard on a voice call has been "read".
    if callId != nil, let id = threadId { onSeen(id, nil) }
    onTurnEnd(reply)
    refreshTitle()
  }

  /// End the turn as stopped: keep what was written, mark the steps, say so.
  func finishStopped() {
    let partial = streaming
    let trace = live
    let wasBusy = agent != .idle
    stopping = false
    stopFallback?.cancel()
    defer { finishTurn() }
    guard wasBusy || !partial.isEmpty || trace != nil else { return }
    let m = ChatMessage(role: "assistant", content: partial, stopped: true)
    if let t = trace, t.hasProcess { traces[m.id] = t.finished(stopped: true) }
    if !partial.isEmpty || traces[m.id] != nil { messages.append(m) }
  }

  /// Mercury names a thread from its first message, then again in the background once the
  /// first answer is in (no event says so), so look a few times after a turn.
  func refreshTitle() {
    guard let id = threadId else { return }
    titleCheck?.cancel()
    titleCheck = Task {
      for wait in [0.5, 4, 10] {
        try? await Task.sleep(for: .seconds(wait))
        guard !Task.isCancelled, let t = try? await client.threads().first(where: { $0.id == id }) else { continue }
        if t.displayTitle != title { title = t.displayTitle; onChange() }
      }
    }
  }

  /// The note the runtime sends back when a turn is stopped (agent.ts, "⏹ Task stopped. …").
  nonisolated static func isStopNote(_ text: String) -> Bool {
    text.range(of: #"^\s*⏹\s*Task (stopped|halted)\b"#, options: .regularExpression) != nil
  }

  /// Is a step's result a failure? The runtime says so now; older ones only by the text.
  nonisolated static func stepFailed(_ data: [String: Any], _ summary: String?) -> Bool {
    if let f = data["failed"] as? Bool { return f }
    guard let s = summary?.trimmed, !s.isEmpty else { return false }
    return Rx.match(#"^(error|failed|denied|blocked|HTTP [45]\d\d\b|Request to .* timed out)"#, s, caseless: true) != nil
  }

  nonisolated static func optionLabel(_ v: String) -> String {
    switch v { case "yes": "Allow once"; case "always": "Always allow"; case "no": "Deny"; default: v }
  }

  /// A friendly name for a tool while it runs.
  nonisolated static func label(_ tool: String) -> String {
    switch tool {
    case "web_search", "search": "Searching the web"
    case "fetch_url", "web_fetch", "read_url": "Reading a page"
    case "run_command", "bash", "shell": "Running a command"
    case "read_file": "Reading a file"
    case "write_file", "edit_file": "Writing a file"
    case "generate_image": "Creating an image"
    case "generate_video": "Creating a video"
    case "generate_music": "Creating music"
    case "generate_speech": "Creating a voice"
    default: tool.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }

  nonisolated static func artifact(_ d: [String: Any]) -> ArtifactRef? {
    guard let data = try? JSONSerialization.data(withJSONObject: d) else { return nil }
    return try? JSONDecoder().decode(ArtifactRef.self, from: data)
  }
}

/// Mutates the model's running trace in place (so `ensureLive().addText(…)` reads naturally).
@MainActor
struct TurnTraceRef {
  let model: ConversationModel
  func touch(_ now: Date = .now) { model.live?.touch(now) }
  func setPhase(_ p: String, now: Date) { model.live?.setPhase(p, now: now) }
  func addReasoning(_ t: String, now: Date) { model.live?.addReasoning(t, now: now) }
  func addNote(_ t: String, now: Date) { model.live?.addNote(t, now: now) }
  func addText(_ t: String, now: Date) { model.live?.addText(t, now: now) }
  func startTool(key: String?, tool: String, title: String?, number: Int?, media: TurnTrace.MediaShape?, now: Date) {
    model.live?.startTool(key: key, tool: tool, title: title, number: number, media: media, now: now)
  }
}
