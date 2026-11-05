import SwiftUI
import QuickLook
import MercuryCore

/// Screen 3: one conversation. Messages, the reply as it streams, what Mercury is doing,
/// its plan, files it made, and the composer (send, or stop while it works).
struct ConversationView: View {
  @State var model: ConversationModel
  @FocusState var composing: Bool
  @State var preview: URL?
  @State var call: VoiceCallModel?

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            ForEach(model.messages) { m in
              MessageView(message: m, client: model.client) { a in
                Task {
                  do { preview = try await model.client.download(a.id, name: a.name) }
                  catch { model.error = error.localizedDescription }
                }
              }
            }
            if model.busy { LiveTurn(model: model) }
            ForEach(model.prompts) { p in PromptCard(prompt: p) { v in Task { await model.answer(p, v) } } }
            if let e = model.error { ErrorText(text: e) }
            Color.clear.frame(height: 1).id("end")
          }
          .padding(.horizontal, 16).padding(.vertical, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: model.messages.count) { proxy.scrollTo("end", anchor: .bottom) }
        .onChange(of: model.streaming) { proxy.scrollTo("end", anchor: .bottom) }
        .onChange(of: model.prompts.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        .task { await model.load(); proxy.scrollTo("end", anchor: .bottom) }
      }
      .overlay { if model.loaded && model.messages.isEmpty && !model.busy { NewChatHint() } }
      if !model.plan.isEmpty { PlanBar(plan: model.plan) }
      Composer(model: model, focus: $composing)
    }
    .background(Theme.bg)
    .navigationTitle(model.title)
    #if os(iOS)
    .navigationBarTitleDisplayMode(.inline)
    #endif
    // A call over this conversation keeps listening to it.
    .onDisappear { if call == nil { model.listener?.cancel() } }
    .quickLookPreview($preview)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button { call = VoiceCallModel(conversation: model) } label: { Image(systemName: "phone") }
          .accessibilityLabel("Start a voice call")
      }
    }
    .callCover($call)
  }
}

struct MessageView: View {
  var message: ChatMessage
  var client: MercuryClient
  var open: (ArtifactRef) -> Void = { _ in }

  var body: some View {
    switch message.role {
    case "user":
      Text(message.content).font(.system(size: 16)).foregroundStyle(Theme.ink)
        .padding(.horizontal, 15).padding(.vertical, 11)
        .background(Theme.surface2, in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20))
        .frame(maxWidth: 300, alignment: .trailing).frame(maxWidth: .infinity, alignment: .trailing)
        .textSelection(.enabled)
    case "system":
      Label(message.content, systemImage: "exclamationmark.triangle").font(.system(size: 14)).foregroundStyle(Theme.ink2)
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    default:
      VStack(alignment: .leading, spacing: 10) {
        Markdown(text: message.content)
        if message.stopped == true {
          Text("Stopped").font(.system(size: 13)).foregroundStyle(Theme.ink3)
        }
        ForEach(message.artifacts ?? []) { a in
          Button { open(a) } label: { ArtifactCard(artifact: a, client: client) }.buttonStyle(.plain)
            .accessibilityHint("Opens a preview")
        }
      }
    }
  }
}

/// Mercury's replies are Markdown; the inline parts render natively, paragraphs and lists keep their breaks.
struct Markdown: View {
  var text: String
  var body: some View {
    let parsed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    Text(parsed).font(.system(size: 16)).lineSpacing(3).foregroundStyle(Theme.ink).tint(Theme.accent)
      .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
  }
}

/// What Mercury is doing in the turn that's running: waiting, the steps, then the reply as it streams.
struct LiveTurn: View {
  var model: ConversationModel
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !model.steps.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(model.steps.suffix(4)) { s in
            HStack(spacing: 8) {
              Image(systemName: s.failed ? "xmark.circle" : s.done ? "checkmark.circle" : "circle.dotted")
                .foregroundStyle(s.failed ? Theme.red : s.done ? Theme.accent : Theme.ink3).font(.system(size: 13))
              Text(s.label).font(.system(size: 14)).foregroundStyle(Theme.ink2).lineLimit(1)
            }
          }
        }
        .padding(10).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
      }
      if !model.streaming.isEmpty {
        Markdown(text: model.streaming)
      } else {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(model.queued.map { _ in "Waiting for another chat to finish…" } ?? (model.agent == .working ? "Working…" : "Thinking…"))
            .font(.system(size: 14)).foregroundStyle(Theme.ink3)
        }
      }
    }
  }
}

struct PlanBar: View {
  var plan: [ConversationModel.PlanStep]
  var body: some View {
    let done = plan.filter { $0.status == "done" }.count
    let active = plan.first { $0.status == "active" } ?? plan.first { $0.status == "pending" }
    HStack(spacing: 10) {
      ProgressRing(fraction: Double(done) / Double(max(plan.count, 1))).frame(width: 16, height: 16)
      Text("Plan").font(.system(size: 14, weight: .semibold))
      Text("\(done) of \(plan.count)").font(.system(size: 13)).foregroundStyle(Theme.ink3)
      if let a = active { Text("· \(a.label)").font(.system(size: 14)).foregroundStyle(Theme.ink2).lineLimit(1) }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14).frame(height: 44)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
    .padding(.horizontal, 12).padding(.bottom, 6)
    .accessibilityElement(children: .combine)
  }
}

struct ProgressRing: View {
  var fraction: Double
  var body: some View {
    ZStack {
      Circle().stroke(Theme.accent.opacity(0.25), lineWidth: 2)
      Circle().trim(from: 0, to: fraction).stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
    }
  }
}

struct Composer: View {
  @Bindable var model: ConversationModel
  var focus: FocusState<Bool>.Binding

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("Message Mercury", text: $model.draft, axis: .vertical)
        .font(.system(size: 16)).lineLimit(1...6).focused(focus)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .onSubmit { Task { await model.send() } }
      Button {
        Task { if model.busy && !model.canSend { await model.stop() } else { await model.send() } }
      } label: {
        Image(systemName: model.busy && !model.canSend ? "stop.fill" : "arrow.up")
          .font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.onAccent)
          .frame(width: 36, height: 36)
          .background(model.busy && !model.canSend ? Theme.ink : Theme.accent, in: Circle())
          .opacity(model.busy || model.canSend ? 1 : 0.35)
      }
      .disabled(!model.busy && !model.canSend)
      .accessibilityLabel(model.busy && !model.canSend ? "Stop Mercury" : "Send")
      .padding(6)
    }
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22))
    .overlay(RoundedRectangle(cornerRadius: 22).stroke(Theme.line))
    .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 8)
  }
}

struct NewChatHint: View {
  var body: some View {
    VStack(spacing: 12) {
      MarkTile(size: 56)
      Text("What should Mercury do?").font(.system(size: 18, weight: .semibold))
      Text("It runs on your Mercury and keeps going if you close the app.")
        .font(.system(size: 14)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center).frame(maxWidth: 260)
    }
    .allowsHitTesting(false)
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
