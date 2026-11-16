import SwiftUI
import QuickLook
import MercuryCore

/// Screen 3: one conversation. Messages with each reply's thought process, the turn as it happens,
/// pictures as they're made, then pinned above the message box: the plan and anything Mercury
/// needs you for. A new chat opens with suggestions and the cursor in the box.
struct ConversationView: View {
  @State var model: ConversationModel
  @FocusState var composing: Bool
  @State var preview: URL?
  @State var call: VoiceCallModel?
  @State var renaming = false
  @State var newTitle = ""
  @State var welcome: WelcomeModel?
  /// The bottom of the conversation is on screen: the jump-to-latest button hides.
  @State var atEnd = true

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            if model.loaded && model.messages.isEmpty && !model.busy, let welcome {
              WelcomeView(model: welcome) { prompt in
                model.draft = prompt
                composing = true
              }
            }
            let days = DaySeparators.make(model.messages)
            ForEach(model.messages) { m in
              if let day = days[m.id] { DaySeparator(label: day) }
              MessageView(message: m, client: model.client, trace: model.traces[m.id], open: { a in open(a) }, edit: { text in
                model.draft = text
                composing = true
              })
            }
            if let live = model.live, model.busy {
              LiveTurn(model: model, trace: live)
            }
            if !model.pendingMedia.isEmpty { PendingMediaList(jobs: model.pendingMedia) }
            if let n = model.notice { NoticeRow(notice: n) }
            if let e = model.error { ErrorText(text: e) }
            // Whether this is on screen says whether the newest is (works on iOS 17, unlike
            // onScrollGeometryChange). A lazy stack makes it a little before it scrolls in.
            Color.clear.frame(height: 1).id("end")
              .onAppear { atEnd = true }
              .onDisappear { atEnd = false }
          }
          .padding(.horizontal, 16).padding(.vertical, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .overlay(alignment: .bottomTrailing) {
          if !atEnd && !model.messages.isEmpty {
            JumpToLatest { withAnimation(.snappy) { proxy.scrollTo("end", anchor: .bottom) } }
              .padding(.trailing, 16).padding(.bottom, 12)
              .transition(.scale(scale: 0.6).combined(with: .opacity))
          }
        }
        .animation(.snappy(duration: 0.2), value: atEnd)
        .onChange(of: model.messages.count) { proxy.scrollTo("end", anchor: .bottom) }
        .onChange(of: model.streaming) { proxy.scrollTo("end", anchor: .bottom) }
        .onChange(of: model.live?.items.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        .task {
          if model.threadId == nil {
            if welcome == nil { welcome = WelcomeModel(client: model.client) }
            // A new chat: ready to type.
            composing = true
          }
          await model.load()
          proxy.scrollTo("end", anchor: .bottom)
        }
      }
      VStack(spacing: 8) {
        if let plan = model.plan { PlanCard(plan: plan, busy: model.busy, threadId: model.threadId) }
        if !model.prompts.isEmpty { NeedsYouCard(prompts: model.prompts) { p, v in await model.answer(p, v) } }
      }
      .padding(.horizontal, 16)
      .padding(.top, model.plan != nil || !model.prompts.isEmpty ? 6 : 0)
      .animation(.snappy, value: model.prompts.map(\.id))
      Composer(model: model, focus: $composing)
    }
    .background(Theme.bg)
    .navigationTitle(model.title)
    #if os(iOS)
    .navigationBarTitleDisplayMode(.inline)
    // The composer takes the bottom of the screen, as in other chat apps.
    .toolbar(.hidden, for: .tabBar)
    #endif
    .toolbar {
      ToolbarItem(placement: .principal) {
        ConversationTitle(title: model.title, status: model.titleStatus, saved: model.savedAt != nil, canEdit: model.threadId != nil,
                          rename: { newTitle = model.title == "New chat" ? "" : model.title; renaming = true },
                          toggleSaved: { Task { await model.toggleSaved() } })
      }
    }
    .alert("Rename chat", isPresented: $renaming) {
      TextField("Chat name", text: $newTitle)
      Button("Save") { Task { await model.rename(String(newTitle.trimmed.prefix(120))) } }
        .disabled(newTitle.trimmed.isEmpty)
      Button("Cancel", role: .cancel) {}
    } message: { Text("Up to 120 characters. Mercury keeps the name you choose.") }
    // A call over this conversation keeps listening to it.
    .onDisappear {
      if call == nil { model.listener?.cancel() }
      if Notifier.shared.viewing == model.threadId { Notifier.shared.viewing = nil }
      // What was on screen has been read, replies that came while it was open too.
      if let id = model.threadId { model.onSeen(id, false) }
    }
    // Nothing is announced for the chat on screen, and it's never unread in the list.
    .onAppear {
      Notifier.shared.viewing = model.threadId
      if let id = model.threadId { model.onSeen(id, true) }
    }
    .onChange(of: model.threadId) { _, id in
      Notifier.shared.viewing = id
      if let id { model.onSeen(id, true) }
    }
    .quickLookPreview($preview)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          // The call takes the mic: dictation stops.
          model.dictation.cancel()
          call = VoiceCallModel(conversation: model)
        } label: { Image(systemName: "phone") }
          .accessibilityLabel("Start a voice call")
      }
    }
    .callCover($call)
    .environment(\.mercuryClient, model.client)
  }

  func open(_ a: ArtifactRef) {
    Task {
      do { preview = try await model.client.download(a.id, name: a.name) }
      catch { model.error = error.localizedDescription }
    }
  }
}

struct MessageView: View {
  var message: ChatMessage
  var client: MercuryClient
  var trace: TurnTrace? = nil
  var open: (ArtifactRef) -> Void = { _ in }
  /// Puts a message of yours back in the box to change and send again (nil: no Edit).
  var edit: ((String) -> Void)? = nil

  var body: some View {
    switch message.role {
    case "user":
      VStack(alignment: .trailing, spacing: 6) {
        if let files = message.attachments, !files.isEmpty { SentAttachments(items: files, client: client) }
        if !Self.isAttachedOnly(message) {
          // A long press copies or edits it (the menu replaces text selection, which would hide it).
          Text(message.content).font(.system(size: 16)).foregroundStyle(Theme.ink)
            .padding(.horizontal, 15).padding(.vertical, 11)
            .background(Theme.surface2, in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20))
            .menuPreviewShape(UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20))
            .contextMenu {
              Button { Pasteboard.copy(message.content) } label: { Label("Copy", systemImage: "doc.on.doc") }
              if let edit { Button { edit(message.content) } label: { Label("Edit", systemImage: "pencil") } }
            }
        }
      }
      .frame(maxWidth: 300, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
    case "system":
      if TurnTrace.isSecurity(message.content) {
        SecurityNotice(text: message.content)
      } else {
        Label(message.content, systemImage: "exclamationmark.triangle").font(.system(size: 14)).foregroundStyle(Theme.ink2)
          .padding(12).frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
      }
    default:
      VStack(alignment: .leading, spacing: 10) {
        if let trace {
          ForEach(trace.securityNotes, id: \.self) { SecurityNotice(text: $0) }
          ThoughtProcess(trace: trace)
        }
        if !message.content.isEmpty {
          Markdown(text: message.content)
            .contextMenu { replyMenu }
        }
        if message.stopped == true {
          Label("Stopped", systemImage: "stop.circle").font(.system(size: 13)).foregroundStyle(Theme.ink3)
        }
        if let a = message.artifacts, !a.isEmpty { ReplyMedia(artifacts: a, client: client, openFile: open, fresh: MediaReveal.isFresh(message)) }
        if !message.content.trimmed.isEmpty { ReplyActions(message: message) }
      }
    }
  }

  /// Copy, and what the reply cost (tokens, cache, steps, time): Mercury Desktop shows it on hover.
  @ViewBuilder
  var replyMenu: some View {
    Button { Pasteboard.copy(message.content) } label: { Label("Copy", systemImage: "doc.on.doc") }
    if let u = message.usage {
      Section(u.short) {
        ForEach(u.detail, id: \.self) { Text($0) }
      }
    }
  }

  /// A message that was only files: the files say it, not "(Attached: …)".
  static func isAttachedOnly(_ m: ChatMessage) -> Bool {
    (m.attachments?.isEmpty == false) && m.content.hasPrefix("(Attached: ")
  }
}

/// Under a finished reply: copy it, share it, and what it cost. The same as the long-press menu,
/// one tap away, as in other chat apps (Mercury Desktop shows these on hover).
struct ReplyActions: View {
  var message: ChatMessage
  @State var copied = false
  @State var info = false

  var body: some View {
    HStack(spacing: 2) {
      Button {
        Pasteboard.copy(message.content)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: copied ? "checkmark" : "doc.on.doc")
          if copied { Text("Copied").font(.system(size: 12, weight: .medium)) }
        }
        .foregroundStyle(copied ? Theme.accent : Theme.ink3)
        .frame(minWidth: 32, minHeight: 30).contentShape(Rectangle())
      }
      .accessibilityLabel(copied ? "Copied" : "Copy")
      .sensoryFeedback(.impact(weight: .light), trigger: copied) { _, now in now }
      ShareLink(item: message.content) {
        Image(systemName: "square.and.arrow.up").foregroundStyle(Theme.ink3).frame(width: 32, height: 30).contentShape(Rectangle())
      }
      .accessibilityLabel("Share")
      if let u = message.usage {
        Button { info = true } label: {
          Image(systemName: "info.circle").foregroundStyle(Theme.ink3).frame(width: 32, height: 30).contentShape(Rectangle())
        }
        .accessibilityLabel("Details")
        .popover(isPresented: $info) {
          VStack(alignment: .leading, spacing: 6) {
            Text(u.short).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            ForEach(u.detail, id: \.self) { Text($0).font(.system(size: 13)).foregroundStyle(Theme.ink2) }
          }
          .padding(14)
          .presentationCompactAdaptation(.popover)
        }
      }
    }
    .font(.system(size: 13, weight: .medium))
    .buttonStyle(.plain)
    .padding(.leading, -8)
    .animation(.snappy(duration: 0.2), value: copied)
  }
}

/// Between messages from different days: "Yesterday", "Mon 3 Nov".
struct DaySeparator: View {
  var label: String
  var body: some View {
    HStack(spacing: 10) {
      Rectangle().fill(Theme.line).frame(height: 1)
      Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink3).fixedSize()
      Rectangle().fill(Theme.line).frame(height: 1)
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

/// Back to the newest message, shown while scrolled up from it.
struct JumpToLatest: View {
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: "chevron.down").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
        .frame(width: 40, height: 40)
        .background(Theme.surface, in: Circle())
        .overlay(Circle().stroke(Theme.line))
        .shadow(color: .black.opacity(0.14), radius: 8, y: 3)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Jump to latest")
  }
}

/// The conversation's name in the bar: tap for Rename and Save. Under it, a word while the
/// chat works or waits on you, so it shows even with the plan and questions scrolled away.
struct ConversationTitle: View {
  var title: String
  var status: ConversationModel.TitleStatus?
  var saved = false
  var canEdit = true
  var rename: () -> Void = {}
  var toggleSaved: () -> Void = {}

  var body: some View {
    VStack(spacing: 1) {
      if canEdit {
        Menu {
          Button(action: rename) { Label("Rename", systemImage: "pencil") }
          Button(action: toggleSaved) { Label(saved ? "Unsave" : "Save", systemImage: saved ? "bookmark.slash" : "bookmark") }
        } label: { name }
        .menuStyle(.button).buttonStyle(.plain)
        .accessibilityHint("Rename or save this chat")
      } else {
        name
      }
      if let status {
        Text(status == .working ? "Working…" : "Needs you")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(status == .working ? Theme.accent : Theme.amber)
          .transition(.opacity)
      }
    }
    .animation(.snappy, value: status)
    .frame(maxWidth: 240)
  }

  var name: some View {
    HStack(spacing: 4) {
      if saved { Image(systemName: "bookmark.fill").font(.system(size: 11)).foregroundStyle(Theme.ink3) }
      Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
      if canEdit { Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.ink3) }
    }
  }
}

/// The turn that's running: its timeline, then the one status line, ticking every second.
struct LiveTurn: View {
  var model: ConversationModel
  var trace: TurnTrace
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      VStack(alignment: .leading, spacing: 12) {
        TurnTimeline(trace: trace, live: true, now: ctx.date)
        LiveStatusLine(trace: trace, agent: model.agent, stopping: model.stopping, waitingForYou: !model.prompts.isEmpty, queued: model.queued, now: ctx.date)
      }
    }
  }
}

/// Videos and songs being made in the background: their placeholders until they arrive.
struct PendingMediaList: View {
  var jobs: [PendingMedia]
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      VStack(alignment: .leading, spacing: 12) {
        ForEach(jobs) { j in
          VStack(alignment: .leading, spacing: 4) {
            MediaPlaceholder(shape: .init(kind: j.kind, aspect: j.aspect, prompt: j.prompt),
                             startedAt: j.startedAt.map(TurnTrace.date) ?? ctx.date, now: ctx.date)
            Text("It will appear here when it's ready. You can keep chatting.").font(.system(size: 11)).foregroundStyle(Theme.ink4)
          }
          .transition(.opacity)
        }
      }
    }
  }
}

/// A line from the runtime about this chat: a stall warning, a dropped message.
struct NoticeRow: View {
  var notice: ConversationModel.Notice
  var body: some View {
    Label(notice.text, systemImage: notice.warning ? "exclamationmark.triangle" : "info.circle")
      .font(.system(size: 13)).foregroundStyle(notice.warning ? Theme.amber : Theme.ink3)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

enum Pasteboard {
  static func copy(_ s: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = s
    #else
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(s, forType: .string)
    #endif
  }
}

/// A file Mercury made, shown under the reply.
struct ArtifactCard: View {
  var artifact: ArtifactRef
  var client: MercuryClient
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: ArtifactCard.icon(artifact.kind, artifact.mime)).font(.system(size: 20)).foregroundStyle(Theme.accent)
        .frame(width: 44, height: 44).background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
      VStack(alignment: .leading, spacing: 2) {
        Text(artifact.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
        Text(ArtifactCard.caption(artifact)).font(.system(size: 12)).foregroundStyle(Theme.ink3)
      }
      Spacer(minLength: 0)
    }
    .padding(10).background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
  }

  static func icon(_ kind: String?, _ mime: String?) -> String {
    switch kind ?? "" {
    case "image": "photo"
    case "video": "play.rectangle"
    case "audio": "waveform"
    case "pdf": "doc.richtext"
    case "document": "doc.text"
    default: mime?.hasPrefix("image/") == true ? "photo" : "doc"
    }
  }

  static func caption(_ a: ArtifactRef) -> String {
    let kind = (a.kind ?? "file").uppercased()
    guard let size = a.size else { return kind }
    return "\(kind) · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))"
  }
}

extension View {
  /// The long-press preview takes the bubble's shape, not a rectangle (iOS only).
  @ViewBuilder func menuPreviewShape<S: Shape>(_ shape: S) -> some View {
    #if os(iOS)
    contentShape(.contextMenuPreview, shape)
    #else
    self
    #endif
  }
}
