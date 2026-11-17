import Foundation
import MercuryCore
import MercuryVoice

/// The voice engine as the call drives it: MercuryVoice's `VoiceCall`, or a fake in tests.
protocol VoiceLink: AnyObject, Sendable {
  func pushAudio(pcm16: Data)
  func setMuted(muted: Bool)
  func interrupt()
  func stop()
  func toolResult(id: String, output: String)
  func say(text: String)
  func instruct(text: String)
}

extension VoiceCall: VoiceLink {}

/// An approval Mercury is waiting on in the call's chat (a permission_request).
struct CallApproval: Equatable, Identifiable, Sendable {
  var id: String
  var text: String
  var targetId: String?
}

/// How a question to Mercury ended.
enum CallAnswer: Equatable, Sendable {
  /// Mercury's reply, with the steps that failed on the way.
  case reply(String, failedSteps: [String] = [])
  case failed(String)
  case stopped
  case timedOut
}

/// Mercury's side of the call: the call's chat thread (ConversationCallChat), or a fake in tests.
@MainActor
protocol CallChat: AnyObject {
  /// Sends the question into the call's chat and waits for the reply.
  func ask(_ question: String) async -> CallAnswer
  /// What Mercury is doing right now ("Searching the web"), while it works.
  var activity: String? { get }
  /// Is a turn running in the call's chat?
  var working: Bool { get }
  /// Approvals waiting in the call's chat, oldest first.
  var approvals: [CallApproval] { get }
  func answer(_ approval: CallApproval, approved: Bool) async throws
  /// The owner said stop: the chat's turn stops.
  func stopWork() async
}

/// The live call's brain, ported from Optimus's listening mode (plugins/optimus/companion/src/voice.rs,
/// the `Brain::Voice` path): the voice chats; for anything real it calls `ask_mercury`, which goes
/// into the call's chat thread; the spoken part of Mercury's reply comes back as the tool result.
/// While Mercury works the voice gets short status updates; approvals are asked out loud (and shown
/// on screen) and only the owner's own yes counts; silence and a time limit end the call.
@MainActor @Observable
final class CallBrain {
  enum End: Equatable {
    /// The owner hung up.
    case owner
    /// The voice said goodbye (end_conversation).
    case goodbye
    /// Nobody said anything for a while.
    case idle
    case timeLimit
    /// The voice connection ended by itself, with why.
    case dropped(String)
  }

  struct Ask: Equatable { var question: String; var asked: Date; var last: Date; var updates: Int }
  struct Awaiting: Equatable { var approval: CallApproval; var askedAt: Date }
  struct Line: Identifiable, Equatable { var id: Int; var role: String; var text: String }

  private(set) var connected = false
  /// The voice is producing a response (it may not be audible yet).
  private(set) var responding = false
  /// Mercury's voice is playing on the phone.
  private(set) var mercuryAudible = false
  private(set) var ownerSpeaking = false
  private(set) var muted = false
  /// The last thing the owner said, and the last thing Mercury said.
  private(set) var ownerLine: String?
  private(set) var mercuryLine: String?
  /// The approval asked out loud, waiting for the owner's answer.
  private(set) var awaiting: Awaiting?
  /// Questions Mercury is working on, by tool-call id.
  private(set) var asks: [String: Ask] = [:]
  private(set) var ended: End?
  private(set) var transcript: [Line] = []

  @ObservationIgnored let link: VoiceLink
  @ObservationIgnored let chat: CallChat
  @ObservationIgnored let playback: CallPlayback
  @ObservationIgnored var haptic: (CallHaptic) -> Void
  @ObservationIgnored var now: () -> Date
  /// The call is over (the model hangs up CallKit and the audio).
  @ObservationIgnored var onEnd: (End) -> Void = { _ in }
  /// Judges barge-ins while Mercury speaks (is it the owner, or someone nearby?). None: every one counts.
  @ObservationIgnored var bargeIn: BargeInJudge?
  /// Mute changed (from the screen or by voice): the model syncs CallKit and the meter.
  @ObservationIgnored var onMuted: (Bool) -> Void = { _ in }

  /// Silence that ends the call, and the longest call (Optimus's idleStopSeconds, maxSessionMinutes).
  @ObservationIgnored var idleStop: TimeInterval = 60
  @ObservationIgnored var maxDuration: TimeInterval = 30 * 60

  // Not shown: the session's bookkeeping.
  @ObservationIgnored private var ready: [(id: String, output: String)] = []
  @ObservationIgnored private var notes: [String] = []
  @ObservationIgnored private var userSaid: [(at: Date, text: String)] = []
  @ObservationIgnored private var verifying: (toolId: String, approval: CallApproval, askedAt: Date, until: Date)?
  @ObservationIgnored private var askedApprovals: Set<String> = []
  @ObservationIgnored private var settled: Set<String> = []
  @ObservationIgnored private var cancelled: Set<String> = []
  @ObservationIgnored private var started: Date
  @ObservationIgnored private var lastActivity: Date
  @ObservationIgnored private var lastUpdate: Date
  @ObservationIgnored private var respondingSince: Date?
  @ObservationIgnored private var ownerSpeakingSince: Date?
  @ObservationIgnored private var spokeThisResponse = false

  init(link: VoiceLink, chat: CallChat, playback: CallPlayback, haptic: @escaping (CallHaptic) -> Void = { _ in }, now: @escaping () -> Date = { .now }) {
    self.link = link; self.chat = chat; self.playback = playback; self.haptic = haptic; self.now = now
    let t = now()
    started = t; lastActivity = t; lastUpdate = t.addingTimeInterval(-60)
  }

  /// Right after the engine starts (before it connects: the engine holds instructions until then,
  /// so the hello is on its way the moment the session opens).
  func begin() {
    link.instruct(text: "[Context, not said by the user] The user just called you from the Mercury app on their phone. Say a very short hello (a few words, like 'Hey, I'm listening') and wait for them.")
    setResponding(true)
  }

  // MARK: Engine events

  func handle(_ e: VoiceEvent) {
    guard ended == nil else { return }
    let t = now()
    switch e {
    case .connected:
      CallLog.note("connected")
      connected = true
      started = t; lastActivity = t
      haptic(.connected)
    case .audio, .levels:
      break // played and metered off the main thread by the model
    case .speechStarted:
      lastActivity = t
      ownerSpeaking = true
      ownerSpeakingSince = t
      bargeIn?.setOwnerTalking(true)
      // Barge-in: the owner talks over Mercury, so its voice stops now. While Mercury is audible
      // the gate checks it's the owner close to the phone, not someone nearby; if not yet, it
      // keeps listening for a moment (bargeInDue). When Mercury isn't audible nothing is judged.
      if mercuryAudible || playback.isPlaying || responding {
        let audible = mercuryAudible || playback.isPlaying
        if audible, let gate = bargeIn, !gate.admits() {
          CallLog.note("speechStarted while Mercury audible: held by gate")
          gate.hold()
          return
        }
        CallLog.note("speechStarted: cut in (audible=\(audible) playing=\(playback.isPlaying) responding=\(responding))")
        cutIn(audible: audible)
      }
    case .userText(let text):
      heard(text.trimmingCharacters(in: .whitespacesAndNewlines))
    case .assistantText(let text):
      let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !s.isEmpty else { return }
      mercuryLine = s
      transcript.append(Line(id: transcript.count, role: "mercury", text: s))
    case .toolCall(let id, let name, let argsJson):
      toolCall(id: id, name: name, args: (argsJson.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:])
    case .responseStarted:
      CallLog.note("response started")
      bargeIn?.setOwnerTalking(false)
      setResponding(true)
      spokeThisResponse = false
    case .responseDone:
      CallLog.note("response done (spoke=\(spokeThisResponse))")
      setResponding(false)
      deliverIfIdle()
    case .closed(let reason):
      CallLog.note("closed: \(reason)")
      finish(.dropped(reason))
    }
  }

  /// A held barge-in turned out to be the owner (the gate heard the near voice): Mercury stops.
  func bargeInDue() {
    guard ended == nil, mercuryAudible || playback.isPlaying else { return }
    cutIn(audible: true)
  }

  private func cutIn(audible: Bool) {
    bargeIn?.release()
    if audible { haptic(.bargeIn) }
    playback.flush()
    link.interrupt()
  }

  /// Mercury's voice started (true) or stopped (false) playing on the phone.
  func playbackChanged(_ on: Bool) {
    guard ended == nil, on != mercuryAudible else { return }
    mercuryAudible = on
    if !on { bargeIn?.release() }
    if on {
      lastActivity = now()
      if !spokeThisResponse { spokeThisResponse = true; haptic(.mercurySpeaks) }
    }
  }

  private func heard(_ t: String) {
    guard !t.isEmpty else { return }
    let at = now()
    lastActivity = at
    ownerSpeaking = false
    bargeIn?.setOwnerTalking(false)
    ownerLine = t
    transcript.append(Line(id: transcript.count, role: "owner", text: t))
    userSaid.append((at, t))
    if userSaid.count > 20 { userSaid.removeFirst() }
    if Self.isMute(t) { setMuted(true); return }
    if Self.isStop(t) && verifying == nil && awaiting == nil { stopAll(); return }
    if let v = verifying, let yes = Self.spokenVerdict(userSaid, since: v.askedAt) {
      verifying = nil
      awaiting = nil
      Task { await self.settle(v.approval, yes, toolId: v.toolId) }
    }
  }

  // MARK: Tools

  private func toolCall(id: String, name: String, args: [String: Any]) {
    CallLog.note("tool call \(name) (args: \(args.keys.sorted().joined(separator: ",")))")
    switch name {
    case "end_conversation", "end_call":
      // Let the goodbye finish playing (up to 5 s), then hang up. Work Mercury started keeps going.
      Task {
        for _ in 0..<50 where self.playback.isPlaying { try? await Task.sleep(for: .milliseconds(100)) }
        self.finish(.goodbye)
      }
    case "answer_approval":
      let approved = args["approved"] as? Bool ?? false
      guard let a = awaiting else {
        ready.append((id, "No approval is waiting right now."))
        deliverIfIdle()
        return
      }
      switch (approved, Self.spokenVerdict(userSaid, since: a.askedAt)) {
      case (false, _), (true, false?):
        awaiting = nil
        Task { await self.settle(a.approval, false, toolId: id) }
      case (true, true?):
        awaiting = nil
        Task { await self.settle(a.approval, true, toolId: id) }
      case (true, nil):
        // The voice says yes but the owner's words haven't come in yet: give them 3 s.
        verifying = (id, a.approval, a.askedAt, now().addingTimeInterval(3))
      }
    case "ask_mercury":
      let q = (args["question"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !q.isEmpty else {
        ready.append((id, "No question was given: ask the user what they need, then call ask_mercury with a clear request."))
        deliverIfIdle()
        return
      }
      ask(q, id: id)
    default:
      ready.append((id, "There's no tool called \(name)."))
      deliverIfIdle()
    }
  }

  private func ask(_ question: String, id: String) {
    let t = now()
    asks[id] = Ask(question: question, asked: t, last: t, updates: 0)
    transcript.append(Line(id: transcript.count, role: "ask", text: question))
    Task {
      let answer = await chat.ask(question)
      self.answered(id, answer)
    }
  }

  func answered(_ id: String, _ answer: CallAnswer) {
    guard asks.removeValue(forKey: id) != nil, !cancelled.contains(id), ended == nil else { return }
    if case .reply(let text, _) = answer { transcript.append(Line(id: transcript.count, role: "result", text: text)) }
    ready.append((id, Self.toolOutput(answer)))
    deliverIfIdle()
  }

  /// What goes back to the voice for Mercury's answer: the spoken part, and plain notes about the rest.
  static func toolOutput(_ answer: CallAnswer) -> String {
    switch answer {
    case .reply(let text, let failed):
      let parts = Spoken.split(text)
      var out = Spoken.text(parts.spoken)
      if out.isEmpty { out = "Done." }
      if !parts.chat.isEmpty {
        out += "\n[The links and details are in the user's Mercury chat: say you've put them there, don't read them out.]"
      }
      if !failed.isEmpty {
        out += "\n[Mercury's log for this request, not part of its answer: \(failed.count) step(s) failed or were stopped (\(failed.joined(separator: "; "))). Unless the answer above says Mercury checked the result, don't tell the user it's done: say what didn't work and offer to try again.]"
      }
      return out
    case .failed(let why): return "Mercury couldn't do it: \(why). Tell the user plainly."
    case .stopped: return "Mercury stopped before it finished. Tell the user plainly."
    case .timedOut: return "Mercury didn't answer in time. It will send the answer to the chat."
    }
  }

  // MARK: Approvals

  /// Answers an approval and gives the result to the voice (as the answer_approval result, or a note).
  private func settle(_ a: CallApproval, _ yes: Bool, toolId: String?) async {
    settled.insert(a.id)
    let out: String
    if !chat.approvals.contains(where: { $0.id == a.id }) {
      out = "That approval was already settled."
    } else {
      do {
        try await chat.answer(a, approved: yes)
        haptic(.approvalAnswered(approved: yes))
        out = yes ? "Approved. Mercury is carrying on; tell the user briefly." : "Declined. Tell the user it won't be done."
      } catch {
        haptic(.failed)
        out = "Couldn't reach Mercury: \(error.localizedDescription)"
      }
    }
    guard ended == nil else { return }
    if let toolId { ready.append((toolId, out)) } else { notes.append(out) }
    deliverIfIdle()
  }

  /// The owner tapped Allow or Deny on the call screen.
  func answerOnScreen(_ a: CallApproval, approved: Bool) {
    guard !settled.contains(a.id) else { return }
    let toolId = verifying?.approval.id == a.id ? verifying?.toolId : nil
    if verifying?.approval.id == a.id { verifying = nil }
    let wasAsked = awaiting?.approval.id == a.id || askedApprovals.contains(a.id)
    if awaiting?.approval.id == a.id { awaiting = nil }
    askedApprovals.insert(a.id)
    Task {
      settled.insert(a.id)
      do {
        try await chat.answer(a, approved: approved)
        haptic(.approvalAnswered(approved: approved))
        let said = approved ? "The user approved it on their screen; Mercury is carrying on." : "The user declined it on their screen; it won't be done."
        if let toolId { ready.append((toolId, approved ? "Approved. Mercury is carrying on; tell the user briefly." : "Declined. Tell the user it won't be done.")) }
        else if wasAsked { notes.append("[Status update, not said by the user] \(said) Say so in a few words.") }
      } catch {
        haptic(.failed)
        settled.remove(a.id)
      }
      deliverIfIdle()
    }
  }

  // MARK: Controls

  func setMuted(_ on: Bool) {
    guard on != muted, ended == nil else { return }
    muted = on
    link.setMuted(muted: on)
    lastActivity = now()
    haptic(.muteToggled)
    onMuted(on)
  }

  /// The orb was tapped: if Mercury is talking, it stops. True when something was cut off.
  @discardableResult
  func interrupt() -> Bool {
    guard ended == nil, mercuryAudible || playback.isPlaying || responding else { return false }
    playback.flush()
    link.interrupt()
    setResponding(false)
    mercuryAudible = false
    lastActivity = now()
    haptic(.bargeIn)
    return true
  }

  /// "Stop" / "cancel": everything halts, the call stays.
  private func stopAll() {
    cancelled.formUnion(asks.keys)
    asks.removeAll()
    ready.removeAll()
    notes.removeAll()
    playback.flush()
    link.interrupt()
    Task { await chat.stopWork() }
    link.instruct(text: "[The user stopped everything, not said by the user] All of Mercury's actions have been stopped. Say only: 'Stopped.' Then wait.")
    setResponding(true)
  }

  /// Ends the call (once): the engine stops, the model hangs up.
  func finish(_ end: End) {
    guard ended == nil else { return }
    if case .dropped(let r) = end, r == "stopped" { ended = .owner } else { ended = end }
    playback.flush()
    link.stop()
    onEnd(ended!)
  }

  // MARK: The status tick (every second)

  func tick() {
    CallLog.summary("audible=\(mercuryAudible) playing=\(playback.isPlaying) responding=\(responding)")
    guard ended == nil else { return }
    let t = now()
    if t.timeIntervalSince(started) >= maxDuration { finish(.timeLimit); return }
    if let v = verifying, t >= v.until {
      verifying = nil
      ready.append((v.toolId, "Not approved: the user hasn't clearly said yes in their own words. Ask them again."))
    }
    // A response that never started (or never said it was done) doesn't hold the call up for ever.
    if responding, !playback.isPlaying, let s = respondingSince, t.timeIntervalSince(s) > 20 { setResponding(false) }
    if ownerSpeaking, let s = ownerSpeakingSince, t.timeIntervalSince(s) > 15 { ownerSpeaking = false; bargeIn?.setOwnerTalking(false) }
    if !responding && !ready.isEmpty { deliver(); return }
    if responding || playback.isPlaying { lastActivity = t; return }
    if muted { lastActivity = t }
    if idleStop > 0, t.timeIntervalSince(lastActivity) >= idleStop, t.timeIntervalSince(lastUpdate) >= idleStop,
       asks.isEmpty, ready.isEmpty, awaiting == nil, !chat.working {
      finish(.idle)
      return
    }
    // An approval asked out loud but answered somewhere else (Mercury Desktop, another phone).
    if let a = awaiting, !chat.approvals.contains(where: { $0.id == a.approval.id }) {
      awaiting = nil
      if !settled.contains(a.approval.id) {
        notes.append("[Status update, not said by the user] That approval was answered on another screen, so there's nothing to ask any more. Say so in a few words.")
      }
    }
    if awaiting == nil, let next = chat.approvals.first(where: { !askedApprovals.contains($0.id) && !settled.contains($0.id) }) {
      askedApprovals.insert(next.id)
      awaiting = Awaiting(approval: next, askedAt: t)
      haptic(.approvalAsked)
      link.instruct(text: "[Approval needed, not said by the user] Mercury wants to: \(Self.approvalSummary(next.text)). Ask the user plainly, in one or two sentences, whether to go ahead. Then wait for their answer and call answer_approval.")
      setResponding(true)
      return
    }
    if !notes.isEmpty {
      let n = notes.joined(separator: " ")
      notes.removeAll()
      link.instruct(text: n.hasPrefix("[") ? n : "[Status update, not said by the user] \(n) Mention it in one short sentence.")
      setResponding(true)
      return
    }
    // Still working: a short update after 8 s, then every 14 s (at most 8).
    if t.timeIntervalSince(lastUpdate) > 12,
       let (id, ask) = asks.first(where: { _, a in a.updates < 8 && t.timeIntervalSince(a.updates == 0 ? a.asked : a.last) >= (a.updates == 0 ? 8 : 14) }) {
      asks[id]?.last = t
      asks[id]?.updates += 1
      lastUpdate = t
      let doing = Self.doing(chat.activity)
      let secs = Int(t.timeIntervalSince(ask.asked))
      link.instruct(text: ask.updates == 0
        ? "[Status update, not said by the user] Mercury is still \(doing). Tell the user in one short sentence that it's taking a few seconds."
        : "[Status update, not said by the user] After \(secs) seconds Mercury is still \(doing). Give one short, natural update (don't repeat yourself).")
      setResponding(true)
    }
  }

  private func deliverIfIdle() { if !responding { deliver() } }

  private func deliver() {
    guard !ready.isEmpty else { return }
    let (id, output) = ready.removeFirst()
    link.toolResult(id: id, output: output)
    setResponding(true)
  }

  private func setResponding(_ on: Bool) {
    responding = on
    respondingSince = on ? now() : nil
  }

  // MARK: Words (voice.rs)

  /// "Searching the web" → "searching the web", for "Mercury is still …".
  static func doing(_ activity: String?) -> String {
    guard let a = activity?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty else { return "working on it" }
    let s = a.hasSuffix("…") ? String(a.dropLast()) : a
    return s.prefix(1).lowercased() + s.dropFirst()
  }

  /// The approval's first line, short enough to say ("Run command: npm run deploy").
  static func approvalSummary(_ text: String) -> String {
    let first = text.split(separator: "\n").first.map(String.init) ?? text
    return first.count > 160 ? String(first.prefix(160)) + "…" : first
  }

  /// Lowercased, ASCII punctuation as spaces, padded so " word " matches whole words.
  static func normalized(_ t: String) -> String {
    " " + String(t.lowercased().map { c -> Character in
      c.isASCII && !c.isLetter && !c.isNumber && !c.isWhitespace ? " " : c
    }) + " "
  }

  static func wordCount(_ t: String) -> Int { t.split(whereSeparator: \.isWhitespace).count }

  /// "Mute" / "mute yourself" / "go on mute".
  static func isMute(_ text: String) -> Bool {
    let t = normalized(text)
    return wordCount(t) <= 4 && [" mute ", " go on mute ", " mute yourself ", " mute karo "].contains { t.contains($0) } && !t.contains(" unmute ")
  }

  /// A short "stop!" / "cancel" / "ruko" / "bas": halt everything.
  static func isStop(_ text: String) -> Bool {
    let t = normalized(text)
    return wordCount(t) <= 4
      && [" stop ", " cancel ", " halt ", " abort ", " enough ", " never mind ", " nevermind ", " ruko ", " ruk jao ", " ruk ", " bas ", " band karo ", "रुको", "रुक जाओ", "बस", "رکو", "بس"].contains { t.contains($0) }
      && !t.contains(" stop listening ")
  }

  /// Did the owner say yes (or no) out loud since the approval question? Only their transcribed
  /// speech counts, never the voice model's own reading.
  static func spokenVerdict(_ said: [(at: Date, text: String)], since: Date) -> Bool? {
    // Punctuation becomes spaces, so "don't" arrives as "don t".
    let no = [" no ", " nope ", " don t ", " don't ", " dont ", " do not ", " cancel ", " stop ", " wait ", " nahi ", " nahin ", " mat ", "नहीं", "मत", "نہیں"]
    let yes = [" yes ", " yeah ", " yep ", " yup ", " sure ", " ok ", " okay ", " go ahead ", " do it ", " approve", " confirm", " please do ", " haan ", " han ", " ha ji ", " ji ", " theek ", " thik ", " kar do ", " karo ", "हाँ", "हां", "ठीक", "कर दो", "ہاں", "جی", "ٹھیک"]
    for (at, text) in said.reversed() {
      if at < since { break }
      let t = normalized(text)
      if no.contains(where: { t.contains($0) }) { return false }
      if yes.contains(where: { t.contains($0) }) { return true }
    }
    return nil
  }
}
