import SwiftUI
import MercuryCore

/// Live: what a bot (or a whole fleet) is doing right now, and a box to talk to it.
/// (Mercury Desktop: apps/desktop/src/views/bots/Live.tsx)
///
/// One card per run: who started it and what was asked, each step as it runs (folded past the
/// last few), what the bot is writing, how it ended. A question the bot asks sits inside its run,
/// with its buttons and how long the bot waits. The box at the bottom messages the bot (or a crew
/// member); a message to a busy bot shows as queued at once. Reply on a finished run answers it
/// with that run quoted. The recent past loads once (/api/bots/activity), then the stream adds to it.
struct LiveFeed: View {
  var model: BotsModel
  var members: [BotStatus]
  var leadId: String
  @State var target: String = ""
  @State var draft = ""
  @State var sending = false
  @State var problem: String?
  @State var loaded = false
  @FocusState var composing: Bool

  var body: some View {
    let ids = members.map(\.id)
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          LiveFeedContent(model: model, members: members, loaded: loaded, onReply: reply)
            .padding(.horizontal, 16).padding(.vertical, 12)
          Color.clear.frame(height: 1).id("end")
        }
        .scrollDismissesKeyboard(.interactively)
        .defaultScrollAnchor(.bottom)
        .onChange(of: model.live.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        .onChange(of: model.approvals.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
      }
      if let problem { ErrorText(text: problem).padding(.horizontal, 20).padding(.top, 6) }
      BotsComposer(members: members, leadId: leadId, target: $target, draft: $draft, sending: sending, focus: $composing) {
        Task { await send() }
      }
    }
    .task(id: ids.joined(separator: ",")) {
      if target.isEmpty || !ids.contains(target) { target = leadId }
      await model.loadActivity(ids)
      await model.loadApprovals()
      loaded = true
    }
  }

  func send() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    sending = true; problem = nil
    if let why = await model.send(text, to: target.isEmpty ? leadId : target) { problem = why } else { draft = "" }
    sending = false
  }

  func reply(_ run: LiveRun) {
    target = run.botId
    draft = LiveRuns.replyDraft(run)
    composing = true
  }
}

/// The feed's cards, without the scroll view (the snapshot renderer can't draw one).
struct LiveFeedContent: View {
  var model: BotsModel
  var members: [BotStatus]
  var loaded = true
  var onReply: (LiveRun) -> Void = { _ in }
  @State var older = false

  static let shownRuns = 40

  var body: some View {
    let ids = Set(members.map(\.id))
    let questions = model.approvals.filter { ids.contains($0.botId) }
    let runs = LiveRuns.runsFrom(model.live.filter { ids.contains($0.botId) }, running: model.running, approvals: questions, now: model.now)
    let shown = older ? runs : Array(runs.suffix(Self.shownRuns))
    let inRuns = Set(runs.map(\.jobId))
    // A question whose run isn't in the feed (it started before the log) still gets its card.
    let loose = questions.filter { !inRuns.contains($0.runId) }
    let fleet = members.count > 1
    LazyVStack(alignment: .leading, spacing: 14) {
      if !older && runs.count > Self.shownRuns {
        Button("Show \(runs.count - Self.shownRuns) earlier runs") { older = true }
          .buttonStyle(Pressable()).font(.system(size: 13)).foregroundStyle(Theme.ink3).frame(maxWidth: .infinity)
      }
      if loaded && runs.isEmpty && questions.isEmpty {
        BotsEmpty(title: "Nothing happening yet",
                  text: "When \(fleet ? "a bot in this fleet" : "this bot") starts a run, on its schedule, from another bot or from your message below, you'll see each step here as it happens.")
      }
      ForEach(shown) { r in
        RunCard(run: r, bot: members.first { $0.id == r.botId }, fleet: fleet,
                by: LiveRuns.startedBy(r) { id in members.first { $0.id == id }?.name ?? model.bot(id)?.name },
                questions: questions.filter { $0.runId == r.jobId }, now: model.now, client: model.client,
                answer: { a, v in await model.answer(a, v) }, onReply: { onReply(r) })
      }
      ForEach(loose) { a in
        BotQuestionCard(approval: a, now: model.now) { v in await model.answer(a, v) }
      }
    }
  }
}

/// One run: what was asked, its steps, what the bot is writing, how it ended.
struct RunCard: View {
  var run: LiveRun
  var bot: BotStatus?
  var fleet: Bool
  var by: String
  var questions: [BotApproval] = []
  var now: Double
  var client: MercuryClient?
  var answer: (BotApproval, String) async -> String? = { _, _ in nil }
  var onReply: () -> Void = {}
  @State var allSteps = false

  static let shownSteps = 6

  var body: some View {
    let active = run.state.isActive
    let fromYou = by.hasPrefix("You")
    let hidden = allSteps ? 0 : max(0, run.steps.count - Self.shownSteps)
    VStack(alignment: .trailing, spacing: 8) {
      if let prompt = run.prompt, fromYou {
        VStack(alignment: .trailing, spacing: 3) {
          Text(prompt).font(.system(size: 15)).foregroundStyle(Theme.ink).textSelection(.enabled)
          if fleet { Text("to \(run.botName)").font(.system(size: 11)).foregroundStyle(Theme.ink3) }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Theme.accent.opacity(0.12), in: UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18))
        .frame(maxWidth: 300, alignment: .trailing)
      }
      VStack(alignment: .leading, spacing: 10) {
        header(active: active, fromYou: fromYou)
        if let prompt = run.prompt, !fromYou {
          Text(prompt).font(.system(size: 14)).foregroundStyle(Theme.ink2).lineLimit(3).textSelection(.enabled)
        }
        if run.state == .queued, run.steps.isEmpty {
          Text(bot?.isRunning == true ? "Runs when the current run finishes." : "Starting…").font(.system(size: 13)).foregroundStyle(Theme.ink3)
        }
        if !run.steps.isEmpty { steps(hidden: hidden) }
        if let text = run.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
          Text(text).font(.system(size: 15)).foregroundStyle(active ? Theme.ink3 : Theme.ink2).lineLimit(active ? 4 : 6).textSelection(.enabled)
        }
        ForEach(questions) { a in
          BotQuestionCard(approval: a, now: now, inline: true) { v in await answer(a, v) }
        }
        if !active { footer }
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).stroke(border(active: active), lineWidth: run.state == .waiting ? 1.5 : 1))
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }

  func header(active: Bool, fromYou: Bool) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .center, spacing: 10) {
        BotAvatar(id: run.botId, name: run.botName, hasAvatar: bot?.hasAvatar == true, size: 28, client: client)
        Text(run.botName).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
        Spacer(minLength: 6)
        StateBadge(text: run.state.label, color: Self.tone(run.state), spinning: active && run.state != .waiting)
      }
      // Who started it, when, for how long: under the name, the width of the card.
      Text((fromYou ? "" : by + " · ") + meta(active: active)).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.ink3)
        .lineLimit(1).padding(.leading, 38).padding(.top, -6)
    }
  }

  func meta(active: Bool) -> String {
    let elapsed = max(0, (active ? now : run.updatedAt) - run.startedAt)
    var s = Self.time(run.startedAt, now: now) + " · " + LiveRuns.duration(elapsed)
    if run.stepCount > 0 { s += " · \(run.stepCount) step\(run.stepCount == 1 ? "" : "s")" }
    return s
  }

  func steps(hidden: Int) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if hidden > 0 {
        Button { withAnimation { allSteps = true } } label: {
          Label("\(hidden) earlier step\(hidden == 1 ? "" : "s")", systemImage: "chevron.right")
            .font(.system(size: 13)).foregroundStyle(Theme.ink3)
        }
        .buttonStyle(Pressable())
      }
      ForEach(Array(run.steps.suffix(run.steps.count - hidden).enumerated()), id: \.offset) { _, s in
        LiveStepRow(step: s)
      }
    }
    .padding(.leading, 10)
    .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1) }
  }

  var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let end = run.endLabel, run.state != .done {
        Text(end).font(.system(size: 13)).foregroundStyle(run.state == .failed ? Theme.red : Theme.ink3).lineLimit(3)
      }
      if run.state == .ended {
        Text("No ending was reported (Mercury restarted during the run).").font(.system(size: 13)).foregroundStyle(Theme.ink3)
      }
      HStack {
        Spacer()
        Button(action: onReply) {
          Label("Reply", systemImage: "arrowshape.turn.up.left").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink2)
            .padding(.horizontal, 10).padding(.vertical, 5).background(Theme.surface2, in: Capsule())
        }
        .buttonStyle(Pressable())
      }
    }
  }

  func border(active: Bool) -> Color {
    switch run.state {
    case .waiting: Theme.amber.opacity(0.6)
    case .failed: Theme.red.opacity(0.35)
    default: active ? Theme.accent.opacity(0.4) : Theme.line
    }
  }

  static func tone(_ s: RunState) -> Color {
    switch s {
    case .working: Theme.accent
    case .waiting, .paused: Theme.amber
    case .failed: Theme.red
    default: Theme.ink3
    }
  }

  static func time(_ ms: Double, now: Double) -> String {
    let d = Date(timeIntervalSince1970: ms / 1000)
    return Calendar.current.isDate(d, inSameDayAs: Date(timeIntervalSince1970: now / 1000))
      ? d.formatted(date: .omitted, time: .shortened)
      : d.formatted(.dateTime.day().month(.abbreviated).hour().minute())
  }
}

/// One step: the tool and how it went (running, done, failed with its error), or a note.
struct LiveStepRow: View {
  var step: LiveStep
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Group {
        switch step.status {
        case "running": Spinner(size: 11)
        case "error": Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.red)
        case "note": Image(systemName: "text.bubble").foregroundStyle(Theme.ink4)
        default: Image(systemName: "checkmark").fontWeight(.bold).foregroundStyle(Theme.accent)
        }
      }
      .font(.system(size: 11))
      .frame(width: 14)
      VStack(alignment: .leading, spacing: 2) {
        Text(step.label).font(.system(size: 13, design: step.status == "note" ? .default : .monospaced))
          .foregroundStyle(step.status == "note" ? Theme.ink3 : Theme.ink2).lineLimit(3)
        if step.status == "error", let d = step.detail, !d.isEmpty {
          Text(d).font(.system(size: 12)).foregroundStyle(Theme.red).lineLimit(4)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// A question a bot is waiting on: what it wants to do, the exact command or path, the answers,
/// and how long it waits before taking silence as a no. After reading something untrusted there
/// is no "Always".
struct BotQuestionCard: View {
  var approval: BotApproval
  var now: Double
  var inline = false
  var answer: (String) async -> String?
  @State var problem: String?
  @State var answering = false

  var body: some View {
    let ask = BotAsk(approval)
    let opts = BotQuestion.options(for: approval)
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: ask.icon).font(.system(size: 15)).foregroundStyle(Theme.amber)
          .frame(width: 34, height: 34).background(Theme.amber.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
        VStack(alignment: .leading, spacing: 1) {
          Text(ask.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
          Text(inline ? "Waits \(BotQuestion.minutesLeft(approval, now: now)) min, then it's a no" : BotQuestion.waits(approval, now: now))
            .font(.system(size: 12)).foregroundStyle(Theme.ink3)
        }
      }
      if let detail = ask.detail {
        Text(detail).font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.ink).lineLimit(8)
          .padding(10).frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10))
          .textSelection(.enabled)
      }
      if let note = ask.note {
        Text(note).font(.system(size: 14)).foregroundStyle(Theme.ink2).lineLimit(8)
      }
      if let problem { ErrorText(text: problem) }
      // Allow once is the main answer; the others sit under it, Deny last and quiet.
      VStack(spacing: 8) {
        ForEach(opts, id: \.value) { o in
          Button(o.label) { pick(o.value) }
            .buttonStyle(BotAnswerStyle(role: o.value == "yes" ? .primary : o.value == "no" ? .quiet : .secondary))
        }
      }
      .disabled(answering)
    }
    .padding(inline ? 12 : 16)
    .background(inline ? Theme.amber.opacity(0.06) : Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.amber.opacity(0.55), lineWidth: 1.5))
    .accessibilityElement(children: .contain)
  }

  func pick(_ v: String) {
    guard !answering else { return }
    answering = true
    Task { problem = await answer(v); answering = false }
  }
}

struct BotAnswerStyle: ButtonStyle {
  enum Role { case primary, secondary, quiet }
  var role: Role
  @Environment(\.isEnabled) var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15, weight: role == .primary ? .semibold : .medium))
      .lineLimit(1).minimumScaleFactor(0.8)
      .frame(maxWidth: .infinity, minHeight: role == .primary ? 44 : 40)
      .foregroundStyle(role == .primary ? Theme.onAccent : role == .quiet ? Theme.ink3 : Theme.ink)
      .background(role == .primary ? Theme.accent : role == .quiet ? Color.clear : Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
      .opacity(configuration.isPressed ? 0.8 : enabled ? 1 : 0.5)
  }
}

/// What a bot's question asks, in words, split from the exact command or path. Permission prompts
/// arrive as "Run command: …", "Write to file: …" or "Read file: …" (src/capabilities/permissions.ts).
struct BotAsk {
  var title: String
  var detail: String?
  var note: String?
  var icon: String

  init(_ a: BotApproval) {
    let text = a.prompt
    func after(_ prefix: String) -> String? {
      guard text.hasPrefix(prefix), let colon = text.firstIndex(of: ":") else { return nil }
      return String(text[text.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
    }
    if BotQuestion.isInjectionWarning(text) {
      title = "Suspicious request"; note = text; icon = "exclamationmark.shield"
    } else if let cmd = after("Run command") {
      title = "Run a command"; detail = cmd; icon = "terminal"
    } else if let path = after("Write to file") {
      title = "Write a file"; detail = path; icon = "square.and.pencil"
    } else if let path = after("Read file") {
      title = "Read a file"; detail = path; icon = "doc.text.magnifyingglass"
    } else {
      title = "\(a.botName) needs your OK"; note = text; icon = "hand.raised"
    }
  }
}

/// The box under the feed: who to send to (in a fleet), the message, Send.
struct BotsComposer: View {
  var members: [BotStatus]
  var leadId: String
  @Binding var target: String
  @Binding var draft: String
  var sending = false
  var focus: FocusState<Bool>.Binding
  /// Draws the box without a text field (the snapshot renderer can't draw one).
  var still = false
  var send: () -> Void

  var targetName: String { members.first { $0.id == target }?.name ?? members.first?.name ?? "the bot" }
  var targetLabel: some View {
    HStack(spacing: 6) {
      BotAvatar(id: target.isEmpty ? leadId : target, name: targetName, size: 18)
      Text("To \(targetName)").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink2)
      Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.ink3)
    }
    .padding(.horizontal, 10).padding(.vertical, 5).background(Theme.surface2, in: Capsule())
  }

  var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if members.count > 1 && still {
        targetLabel.padding(.leading, 4)
      } else if members.count > 1 {
        Menu {
          ForEach(members) { b in
            Button { target = b.id } label: {
              if b.id == target { Label(b.id == leadId ? "\(b.name) (lead)" : b.name, systemImage: "checkmark") }
              else { Text(b.id == leadId ? "\(b.name) (lead)" : b.name) }
            }
          }
        } label: { targetLabel }
        .accessibilityLabel("Send to \(targetName)")
        .padding(.leading, 4)
      }
      HStack(alignment: .bottom, spacing: 8) {
        Group {
          if still {
            Text(draft.isEmpty ? "Message \(targetName)…" : draft).foregroundStyle(draft.isEmpty ? Theme.ink4 : Theme.ink)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            TextField("Message \(targetName)…", text: $draft, axis: .vertical).lineLimit(1...6).focused(focus)
          }
        }
        .font(.system(size: 16)).padding(.leading, 16).padding(.vertical, 12)
        Button(action: send) {
          Group {
            if sending { Spinner(size: 14, color: Theme.onAccent) } else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)) }
          }
          .foregroundStyle(Theme.onAccent).frame(width: 36, height: 36)
          .background(Theme.accent, in: Circle()).opacity(canSend || sending ? 1 : 0.35)
        }
        .buttonStyle(Pressable())
        .disabled(!canSend)
        .accessibilityLabel("Send")
        .padding(8)
      }
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: 24))
      .overlay(RoundedRectangle(cornerRadius: 24).stroke(Theme.line))
    }
    .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
  }
}
