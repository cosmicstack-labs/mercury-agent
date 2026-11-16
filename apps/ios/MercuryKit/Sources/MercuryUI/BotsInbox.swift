import SwiftUI
import MercuryCore

/// The inbox for every bot: questions waiting first, then what the bots did, newest first.
struct BotsInboxScreen: View {
  var model: BotsModel
  var body: some View {
    BotsInboxList(model: model, botIds: nil)
      .background(Theme.bg)
      .navigationTitle("Inbox")
      .onAppear { model.appeared() }
      .onDisappear { model.disappeared() }
  }
}

/// What the bots did for you, kept until you read it: results (the bot's own summary and the files
/// it delivered), failures a bot reported, and runs that need you. Runs where nothing was new
/// aren't here; History has every run. (Mercury Desktop: views/bots/Inbox.tsx)
struct BotsInboxList: View {
  var model: BotsModel
  /// Some bots (one bot, or a fleet), or every bot when nil.
  var botIds: [String]?
  @State var entries: [BotInboxEntry]?
  @State var unreadOnly = false

  var body: some View {
    ScrollView {
      BotsInboxContent(model: model, botIds: botIds, entries: entries, unreadOnly: $unreadOnly) { ids in
        entries = entries?.map { e in ids == nil || ids!.contains(e.id) ? { var x = e; x.read = true; return x }() : e }
        Task { await model.markRead(ids) }
      }
      .padding(.horizontal, 16).padding(.vertical, 12)
    }
    .refreshable { await load() }
    .task(id: "\(unreadOnly)|\(model.inboxVersion)|\(botIds?.joined(separator: ",") ?? "")") { await load() }
  }

  func load() async {
    // A fleet: the inbox of each member, merged.
    let wanted: [String?] = botIds.map { $0.map(Optional.some) } ?? [nil]
    var all: [BotInboxEntry] = []
    for id in wanted {
      if let r = try? await model.client.botInbox(bot: id, unreadOnly: unreadOnly, limit: 200) { all += r.entries }
    }
    entries = all.sorted { $0.at > $1.at }
    await model.loadApprovals()
  }
}

struct BotsInboxContent: View {
  var model: BotsModel
  var botIds: [String]?
  var entries: [BotInboxEntry]?
  @Binding var unreadOnly: Bool
  var markRead: ([String]?) -> Void

  var body: some View {
    let questions = model.approvals.filter { botIds == nil || botIds!.contains($0.botId) }
    let unread = (entries ?? []).filter { !$0.read }
    LazyVStack(alignment: .leading, spacing: 12) {
      HStack {
        BotsTabs(selection: Binding(get: { unreadOnly ? Filter.unread : .all }, set: { unreadOnly = $0 == .unread })).frame(width: 170)
        Spacer()
        if !unread.isEmpty {
          Button { markRead(unread.map(\.id)) } label: {
            Label("Mark all read", systemImage: "checkmark.circle").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink2)
          }
          .buttonStyle(Pressable())
        }
      }
      ForEach(questions) { a in
        BotQuestionCard(approval: a, now: model.now) { v in await model.answer(a, v) }
      }
      if let entries {
        if entries.isEmpty {
          BotsEmpty(title: unreadOnly ? "Nothing unread" : "Nothing here yet",
                    text: "When a bot finishes something, reports a problem or needs you, it lands here, even while the app is closed. Runs with nothing new stay quiet.")
        }
        ForEach(Self.byDay(entries), id: \.day) { group in
          BotsSectionTitle(text: group.day)
          ForEach(group.entries) { e in
            InboxCard(entry: e, bot: model.bot(e.botId), client: model.client) { if !e.read { markRead([e.id]) } }
          }
        }
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
      }
    }
  }

  enum Filter: String, CaseIterable { case all = "All", unread = "Unread" }

  static func byDay(_ entries: [BotInboxEntry], now: Date = .now) -> [(day: String, entries: [BotInboxEntry])] {
    var out: [(day: String, entries: [BotInboxEntry])] = []
    let cal = Calendar.current
    for e in entries {
      let d = Date(timeIntervalSince1970: e.at / 1000)
      let day = cal.isDateInToday(d) ? "Today" : cal.isDateInYesterday(d) ? "Yesterday" : d.formatted(.dateTime.weekday(.wide).day().month(.abbreviated))
      if out.last?.day == day { out[out.count - 1].entries.append(e) } else { out.append((day, [e])) }
    }
    return out
  }
}

struct InboxCard: View {
  var entry: BotInboxEntry
  var bot: BotStatus?
  var client: MercuryClient?
  var onOpen: () -> Void = {}
  @State var expanded = false

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      BotAvatar(id: entry.botId, name: entry.botName, hasAvatar: bot?.hasAvatar == true, size: 32, client: client)
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Image(systemName: icon).font(.system(size: 13)).foregroundStyle(color)
          Text(entry.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(expanded ? nil : 2)
          Spacer(minLength: 4)
          if !entry.read { Circle().fill(Theme.accent).frame(width: 7, height: 7) }
          Text(Date(timeIntervalSince1970: entry.at / 1000).formatted(date: .omitted, time: .shortened))
            .font(.system(size: 12)).foregroundStyle(Theme.ink4)
        }
        if !entry.summary.isEmpty && entry.summary != entry.title {
          Text(Self.inline(entry.summary)).font(.system(size: 14)).foregroundStyle(Theme.ink2).lineLimit(expanded ? nil : 4)
        }
        if !entry.files.isEmpty || entry.complete == true || (entry.kind == "needs-you" && entry.reasonCode != nil) {
          FlowChips(files: entry.files.map { ($0 as NSString).lastPathComponent },
                    tags: (entry.complete == true ? ["job done"] : []) + (entry.kind == "needs-you" ? [entry.reasonCode?.replacingOccurrences(of: "_", with: " ")].compactMap { $0 } : []))
        }
      }
    }
    .padding(14)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(entry.read ? Theme.line : Theme.accent.opacity(0.45)))
    .contentShape(Rectangle())
    .onTapGesture { withAnimation { expanded.toggle() }; onOpen() }
    .accessibilityElement(children: .combine)
  }

  var icon: String {
    switch entry.kind {
    case "result": "checkmark.circle.fill"
    case "failed": "xmark.octagon.fill"
    default: "exclamationmark.triangle.fill"
    }
  }

  var color: Color {
    switch entry.kind {
    case "result": Theme.accent
    case "failed": Theme.red
    default: Theme.amber
    }
  }

  /// Bold, italic, code and links; block markdown stays as text.
  static func inline(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
  }
}

/// File names and small tags, wrapping.
struct FlowChips: View {
  var files: [String]
  var tags: [String]
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(files, id: \.self) { f in
        Label(f, systemImage: "doc").font(.system(size: 12)).foregroundStyle(Theme.ink2).lineLimit(1)
          .padding(.horizontal, 8).padding(.vertical, 4).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 7))
      }
      if !tags.isEmpty {
        HStack(spacing: 6) { ForEach(tags, id: \.self) { StateBadge(text: $0, color: $0 == "job done" ? Theme.accent : Theme.amber) } }
      }
    }
  }
}

// MARK: - History

/// Every finished run, newest first, across the fleet for a lead. Open one to see what it was
/// asked, each step it took and what it concluded. (Mercury Desktop: views/bots/Activity.tsx)
struct BotsHistory: View {
  var model: BotsModel
  var members: [BotStatus]
  @State var runs: [BotRunRecord]?
  @State var filter: Filter = .all
  @State var open: BotRunRecord?

  enum Filter: String, CaseIterable { case all = "All", completed = "Done", failed = "Failed" }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 10) {
        BotsTabs(selection: $filter).frame(width: 220)
        if let runs {
          let shown = runs.filter { filter == .all || (filter == .failed ? $0.state == "failed" : $0.state == "completed") }
          if shown.isEmpty { BotsEmpty(title: "No runs yet", text: "Finished runs show up here, with every step they took.") }
          ForEach(shown) { r in
            Button { open = r } label: { HistoryRow(run: r, bot: members.first { $0.id == r.botId }, fleet: members.count > 1, client: model.client) }
              .buttonStyle(Pressable())
          }
        } else {
          ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
        }
      }
      .padding(.horizontal, 16).padding(.vertical, 12)
    }
    .refreshable { await load() }
    .task(id: members.map(\.id).joined(separator: ",")) { await load() }
    .sheet(item: $open) { r in
      NavigationStack { RunTranscriptView(client: model.client, run: r, botName: members.first { $0.id == r.botId }?.name ?? r.botId) }
    }
  }

  func load() async {
    var all: [BotRunRecord] = []
    for b in members { all += (try? await model.client.botJournal(b.id, limit: 60)) ?? [] }
    runs = all.sorted { $0.startedAt > $1.startedAt }
  }
}

struct HistoryRow: View {
  var run: BotRunRecord
  var bot: BotStatus?
  var fleet: Bool
  var client: MercuryClient?

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      if fleet { BotAvatar(id: run.botId, name: bot?.name ?? run.botId, hasAvatar: bot?.hasAvatar == true, size: 26, client: client) }
      VStack(alignment: .leading, spacing: 6) {
        Text(run.summary ?? run.error ?? run.reasonCode ?? run.state).font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(2)
          .multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 8) {
          Text(meta).font(.system(size: 12)).foregroundStyle(Theme.ink3).lineLimit(1)
          Spacer(minLength: 4)
          StateBadge(text: run.label, color: failed ? Theme.red : run.outcome == "quiet" ? Theme.ink3 : run.state == "completed" ? Theme.accent : Theme.ink3)
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(failed ? Theme.red.opacity(0.3) : Theme.line))
  }

  var failed: Bool { run.state == "failed" || run.outcome == "failed" }

  var meta: String {
    var parts: [String] = []
    if fleet { parts.append(bot?.name ?? run.botId) }
    parts.append(Date(timeIntervalSince1970: run.startedAt / 1000).formatted(.dateTime.day().month(.abbreviated).hour().minute()))
    parts.append(Self.trigger(run.trigger))
    parts.append(LiveRuns.duration(run.durationMs))
    return parts.joined(separator: " · ")
  }

  static func trigger(_ t: String) -> String {
    switch t {
    case "api", "web", "chat": "from you"
    case "cron": "schedule"
    case "mailbox": "from the fleet"
    default: t
    }
  }
}

/// One run read back: what it was asked, its thought process, what it concluded, what it delivered.
struct RunTranscriptView: View {
  var client: MercuryClient
  var run: BotRunRecord
  var botName: String
  @State var transcript: BotRunTranscript?
  @State var error: String?
  @Environment(\.dismiss) var dismiss

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 8) {
          StateBadge(text: run.label, color: run.state == "failed" ? Theme.red : Theme.accent)
          Text("\(LiveRuns.duration(run.durationMs)) · \(run.steps ?? 0) steps · \(Self.compact(run.tokensIn + run.tokensOut)) tok")
            .font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.ink3)
        }
        if let error { Text("No transcript for this run (\(error)).").font(.system(size: 14)).foregroundStyle(Theme.ink3) }
        if let t = transcript {
          if !t.prompt.isEmpty { section("Asked") { Text(t.prompt).font(.system(size: 15)).foregroundStyle(Theme.ink2).textSelection(.enabled) } }
          section("Thought process · \(t.trace.count) step\(t.trace.count == 1 ? "" : "s")") {
            if t.trace.isEmpty { Text("Answered without tools.").font(.system(size: 14)).foregroundStyle(Theme.ink4) }
            VStack(alignment: .leading, spacing: 8) {
              ForEach(Array(t.trace.enumerated()), id: \.offset) { _, s in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  Image(systemName: s.ok ? "checkmark" : "exclamationmark.circle.fill").font(.system(size: 11, weight: .bold))
                    .foregroundStyle(s.ok ? Theme.accent : Theme.red).frame(width: 14)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(s.name).font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.ink)
                    if let arg = s.arg, !arg.isEmpty { Text(arg).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink3).lineLimit(4) }
                  }
                }
              }
            }
          }
          section(t.record.report == "no_update" ? "Nothing new" : t.record.report == "failure" ? "Couldn't do it" : "Concluded") {
            Markdown(text: t.output.isEmpty ? (t.record.summary ?? "(no output)") : t.output)
          }
          if let files = t.record.deliverables, !files.isEmpty {
            section("Delivered") { FlowChips(files: files.map { ($0 as NSString).lastPathComponent }, tags: []) }
          }
        } else if error == nil {
          ProgressView().frame(maxWidth: .infinity)
        }
      }
      .padding(16)
    }
    .background(Theme.bg)
    .navigationTitle(botName)
    #if os(iOS)
    .navigationBarTitleDisplayMode(.inline)
    #endif
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    .task {
      do { transcript = try await client.botRun(run.botId, run.runId) } catch { self.error = error.localizedDescription }
    }
  }

  func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased()).font(.system(size: 12, weight: .semibold)).tracking(0.6).foregroundStyle(Theme.ink4)
      content()
    }
  }

  static func compact(_ n: Int) -> String {
    n >= 1_000_000 ? String(format: "%.1fM", Double(n) / 1e6) : n >= 1000 ? String(format: "%.1fk", Double(n) / 1e3) : "\(n)"
  }
}
