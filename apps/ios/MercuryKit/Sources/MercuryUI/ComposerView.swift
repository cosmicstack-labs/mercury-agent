import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import MercuryCore

/// The message box. The + menu adds a photo or a file (image, PDF, TXT or Markdown), sets the next
/// message to make an image, a video or music (ADR-042), and picks how hard the model thinks in
/// this chat (ADR-041). What's set shows as small chips above the text, each one tap to remove.
/// The mic dictates live into the box (DictationModel): greyed out, with what to add, when this
/// Mercury has no speech service that can. Send, or stop while Mercury works on this chat.
struct Composer: View {
  @Bindable var model: ConversationModel
  var focus: FocusState<Bool>.Binding
  /// Snapshots: the text as plain text (the renderer can't draw text fields).
  var still = false
  /// A voice call: the round button's job while the box is empty (nil: Send stays, greyed).
  var onCall: (() -> Void)? = nil
  @State private var picking = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var importing = false
  @State private var choosingModel = false

  private var stopMode: Bool { model.busy && !model.canSend }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let n = model.dictation.notice { DictationNotice(text: n) { model.dictation.notice = nil }.padding(.horizontal, 10).padding(.top, 10) }
      if hasChips { chips.padding(.horizontal, 10).padding(.top, 10) }
      // Row 1: the text.
      Group {
        if still {
          Text(model.draft.isEmpty ? placeholder : model.draft).foregroundStyle(model.draft.isEmpty ? Theme.ink3 : Theme.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          TextField(placeholder, text: $model.draft, axis: .vertical)
            .lineLimit(1...6).focused(focus)
        }
      }
      .font(.system(size: 17)).padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 8)
      // Row 2: + and the model on the left; the mic and the one round button on the right.
      GlassGroup(spacing: 8) {
        HStack(spacing: 8) {
          plusMenu
          ModelPill(name: model.catalog?.pill ?? "Auto", busy: model.switching) { dismissKeyboard(); choosingModel = true }
          Spacer(minLength: 4)
          DictationButton(dictation: model.dictation)
          actionButton
        }
      }
      .padding(.horizontal, 10).padding(.bottom, 10)
    }
    // The card floats over the chat on glass (a thin material below iOS 26); the messages scroll under it.
    .glassSurface(in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 8)
    .sheet(isPresented: $choosingModel) { ModelSheet(model: model) }
    .photosPicker(isPresented: $picking, selection: $photos, maxSelectionCount: max(1, OutgoingAttachment.maxFiles - model.attachments.count), matching: .images)
    .onChange(of: photos) { _, items in
      guard !items.isEmpty else { return }
      photos = []
      Task { for item in items { await addPhoto(item) } }
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: Self.fileTypes, allowsMultipleSelection: true) { result in
      guard case .success(let urls) = result else { return }
      for url in urls { addFile(url) }
    }
    .task { if model.model == nil { await model.loadComposerInfo() } }
    .task { if model.catalog == nil { await model.loadModels() } }
    .task { await model.dictation.load() }
    .onDisappear { model.dictation.cancel() }
  }

  private var placeholder: String {
    if model.dictation.active { return "Listening…" }
    return switch model.media?.kind {
    case .image?: "Describe the image"
    case .video?: "Describe the video"
    case .music?: "Describe the music"
    case nil: model.code ? "Describe what to build" : "Ask anything"
    }
  }

  /// One round button, as on Android: Stop while this chat works, Send with something to send,
  /// else a voice call.
  private enum Action { case stop, send, call }
  private var action: Action {
    if stopMode { return .stop }
    if model.canSend || onCall == nil { return .send }
    return .call
  }

  private var actionButton: some View {
    let a = action
    return Button {
      switch a {
      case .stop: Task { await model.stop() }
      case .send: Task { await model.send() }
      case .call: onCall?()
      }
    } label: {
      Image(systemName: a == .stop ? "stop.fill" : a == .send ? "arrow.up" : "waveform")
        .font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.onAccent)
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .contentTransition(.symbolEffect(.replace))
    }
    .buttonStyle(PressButtonStyle())
    // Ink glass, as `.glassProminent` tints it: the one prominent action.
    .glassSurface(in: Circle(), interactive: true, tint: Theme.accent)
    .opacity(model.stopping ? 0.45 : a == .send && !model.canSend ? 0.35 : 1)
    .disabled((a == .send && !model.canSend) || model.stopping)
    .accessibilityLabel(a == .stop ? (model.stopping ? "Stopping" : "Stop this chat") : a == .send ? "Send" : "Voice call")
    .animation(.snappy(duration: 0.2), value: a)
  }

  // MARK: Chips

  private var ownEffort: String? {
    guard let e = model.model?.effort, e.source == "chat", let c = e.chat, !(model.model?.reasoningLevels ?? []).isEmpty else { return nil }
    return c
  }

  private var hasChips: Bool { !model.attachments.isEmpty || model.media != nil || ownEffort != nil }

  private var chips: some View {
    // Wraps onto a second line rather than scrolling (four files at most).
    FlowRow(spacing: 6) {
      ForEach(model.attachments) { a in
        FileChip(tag: a.tag, name: a.name) { model.attachments.removeAll { $0.id == a.id } }
      }
      if let m = model.media {
        ModeChip(icon: Self.icon(m.kind), text: m.label, tint: Theme.ink) { model.media = nil }
      }
      if let e = ownEffort {
        ModeChip(icon: "gauge.with.dots.needle.67percent", text: "Effort: \(ChatEffort.label(e))", tint: Theme.ink2) { Task { await model.setEffort(nil) } }
      }
    }
  }

  static func icon(_ k: MediaIntent.Kind) -> String {
    switch k { case .image: "photo"; case .video: "film"; case .music: "music.note" }
  }

  // MARK: The + menu

  private var plusMenu: some View {
    Menu {
      Section {
        Button { picking = true } label: { Label("Photo", systemImage: "photo.on.rectangle") }
        Button { importing = true } label: { Label("File", systemImage: "doc") }
      }
      .disabled(model.attachments.count >= OutgoingAttachment.maxFiles)
      Section("Your next message") { createItems }
      if let m = model.model, let levels = m.reasoningLevels, !levels.isEmpty {
        effortMenu(m, levels)
      }
    } label: {
      Image(systemName: "plus").font(.system(size: 19, weight: .regular)).foregroundStyle(Theme.ink)
        .frame(width: 40, height: 40).contentShape(Circle())
    }
    .menuIndicator(.hidden)
    .fixedSize()
    .glassSurface(in: Circle(), interactive: true)
    .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
    .accessibilityLabel("Add a file, create media or set thinking effort")
  }

  @ViewBuilder
  private var createItems: some View {
    let a = model.mediaAvailable ?? .unknown
    Button { model.media = nil } label: { check("Normal answer", model.media == nil) }
    Menu {
      ForEach(MediaIntent.Aspect.allCases, id: \.self) { asp in
        Button { model.media = MediaIntent(kind: .image, aspect: asp) } label: {
          check(asp.rawValue.capitalized, model.media == MediaIntent(kind: .image, aspect: asp))
        }
      }
    } label: { Label("Image" + (a.using[.image].map { " · \($0)" } ?? ""), systemImage: "photo") }
      .disabled(!a.image)
    Menu {
      ForEach([MediaIntent.Aspect.landscape, .portrait], id: \.self) { asp in
        Button { model.media = MediaIntent(kind: .video, aspect: asp) } label: {
          check(asp.rawValue.capitalized, model.media == MediaIntent(kind: .video, aspect: asp))
        }
      }
    } label: { Label("Video" + (a.using[.video].map { " · \($0)" } ?? ""), systemImage: "film") }
      .disabled(!a.video)
    Button { model.media = MediaIntent(kind: .music) } label: {
      Label { Text("Music" + (a.using[.music].map { " · \($0)" } ?? "")) } icon: { Image(systemName: model.media?.kind == .music ? "checkmark" : "music.note") }
    }
    .disabled(!a.music)
    if model.mediaAvailable != nil && !a.any {
      Text("No media models on your Mercury's providers")
    }
  }

  private func effortMenu(_ m: ChatModelInfo, _ levels: [String]) -> some View {
    let e = m.currentEffort
    return Menu {
      Section("Thinking effort · this chat") {
        Button { Task { await model.setEffort(nil) } } label: {
          check("Model default · \(ChatEffort.label(e.modelDefault))", e.chat == nil)
        }
        ForEach(["auto"] + levels, id: \.self) { level in
          Button { Task { await model.setEffort(level) } } label: {
            if let hint = ChatEffort.hint(level) {
              Label { Text(ChatEffort.label(level)); Text(hint) } icon: { if e.chat == level { Image(systemName: "checkmark") } }
            } else {
              check(ChatEffort.label(level), e.chat == level)
            }
          }
        }
      }
      if e.chatUnsupported == true { Text("This model can't use the chat's pick; its default applies") }
    } label: {
      Label("Thinking effort · \(e.effective == "auto" ? "Auto" : ChatEffort.label(e.effective))", systemImage: "gauge.with.dots.needle.67percent")
    }
  }

  private func check(_ title: String, _ on: Bool) -> some View {
    Label { Text(title) } icon: { if on { Image(systemName: "checkmark") } }
  }

  // MARK: Files

  static let fileTypes: [UTType] = [.image, .pdf, .plainText, UTType(filenameExtension: "md") ?? .plainText, UTType(filenameExtension: "markdown") ?? .plainText, .text]

  private func addFile(_ url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else { model.error = "Couldn't read \(url.lastPathComponent)."; return }
    let name = url.lastPathComponent
    if OutgoingAttachment.sniffImage(data) == nil, let img = ImagePrep.jpeg(data) {
      model.attach((name as NSString).deletingPathExtension + ".jpg", img)
    } else {
      model.attach(name, data)
    }
  }

  private func addPhoto(_ item: PhotosPickerItem) async {
    guard let data = try? await item.loadTransferable(type: Data.self) else { model.error = "Couldn't load that photo."; return }
    let n = model.attachments.filter(\.isImage).count + 1
    // HEIC and very large photos become a JPEG the runtime takes (png, jpeg, gif, webp; 8 MB).
    if OutgoingAttachment.sniffImage(data) != nil && data.count <= OutgoingAttachment.maxImageBytes {
      model.attach("photo-\(n)." + (OutgoingAttachment.sniffImage(data)!.components(separatedBy: "/").last ?? "jpg"), data)
    } else if let jpeg = ImagePrep.jpeg(data) {
      model.attach("photo-\(n).jpg", jpeg)
    } else {
      model.error = "That photo's format isn't supported."
    }
  }
}

/// The composer's mic: dictates live into the box. Greyed out when this Mercury can't (a tap says
/// what to add); while listening, filled, with a ring that follows the voice. Tap again to stop.
struct DictationButton: View {
  var dictation: DictationModel

  var body: some View {
    let on = dictation.active
    Button { dictation.tap() } label: {
      ZStack {
        if on {
          TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
            let level = CGFloat(dictation.meter.read(now: ctx.date).mic)
            Circle().stroke(Theme.accent.opacity(0.35), lineWidth: 3)
              .frame(width: 36, height: 36).scaleEffect(1 + 0.32 * level)
          }
        }
        Image(systemName: on ? "waveform" : "mic")
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(on ? Theme.onAccent : Theme.ink2)
          .frame(width: 36, height: 36)
          .glassSurface(in: Circle(), interactive: true, tint: on ? Theme.accent : nil)
          .opacity(dictation.phase == .stopping ? 0.6 : 1)
      }
      .opacity(on || dictation.available || dictation.capabilities == nil ? 1 : 0.35)
    }
    .buttonStyle(PressButtonStyle())
    .accessibilityLabel(label)
    .accessibilityHint(dictation.available || on ? "" : (dictation.unavailableReason ?? ""))
  }

  private var label: String {
    switch dictation.phase {
    case .idle: dictation.available ? "Dictate" : "Dictate, unavailable"
    case .starting, .listening: "Stop dictating"
    case .stopping: "Finishing dictation"
    }
  }
}

/// Why the mic is greyed out or why dictation stopped: one line above the text, tap to dismiss.
struct DictationNotice: View {
  var text: String
  var dismiss: () -> Void
  var body: some View {
    Button(action: dismiss) {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "mic.slash").font(.system(size: 13)).foregroundStyle(Theme.ink3).padding(.top, 1)
        Text(text).font(.system(size: 13)).foregroundStyle(Theme.ink2).multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.ink3).padding(.top, 3)
      }
      .padding(10)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(text). Dismiss")
  }
}

/// A setting for the next message (Image 3:2, Effort: High): tap to remove.
struct ModeChip: View {
  var icon: String
  var text: String
  var tint: Color
  var remove: () -> Void
  var body: some View {
    Button(action: remove) {
      HStack(spacing: 6) {
        Image(systemName: icon).font(.system(size: 12))
        Text(text).font(.system(size: 13, weight: .medium)).lineLimit(1)
        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).opacity(0.6)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 10).frame(height: 32)
      .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
    }
    .buttonStyle(PressButtonStyle())
    .accessibilityLabel("\(text). Remove")
  }
}

/// Lays children out left to right, wrapping onto new lines.
struct FlowRow: Layout {
  var spacing: CGFloat = 6
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(proposal.width ?? .infinity, subviews)
    return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0)))
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in arrange(bounds.width, subviews) {
      var x = bounds.minX
      for i in row.items {
        let s = subviews[i].sizeThatFits(.unspecified)
        subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
        x += s.width + spacing
      }
      y += row.height + spacing
    }
  }
  private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
    var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
    var cur: (items: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
    for i in subviews.indices {
      let s = subviews[i].sizeThatFits(.unspecified)
      if !cur.items.isEmpty && cur.width + spacing + s.width > width { rows.append(cur); cur = ([], 0, 0) }
      cur.width += (cur.items.isEmpty ? 0 : spacing) + s.width
      cur.height = max(cur.height, s.height)
      cur.items.append(i)
    }
    if !cur.items.isEmpty { rows.append(cur) }
    return rows
  }
}

/// Photos the runtime can't take as they are (HEIC, or over 8 MB) as a JPEG, longest side at most 2560.
enum ImagePrep {
  static func jpeg(_ data: Data, maxSide: CGFloat = 2560) -> Data? {
    #if canImport(UIKit)
    guard let img = UIImage(data: data) else { return nil }
    let scale = min(1, maxSide / max(img.size.width, img.size.height))
    let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
    let out = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    return out.jpegData(compressionQuality: 0.85)
    #else
    guard let rep = NSBitmapImageRep(data: data) else { return nil }
    return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    #endif
  }
}

/// The model Mercury answers with ("Auto" on its configured default): tap to pick another.
struct ModelPill: View {
  var name: String
  var busy = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if busy { ProgressView().controlSize(.mini) } else { Image(systemName: "sparkles").font(.system(size: 13)) }
        Text(name).font(.system(size: 15, weight: .medium)).lineLimit(1).frame(maxWidth: 150, alignment: .leading).fixedSize(horizontal: true, vertical: false)
        Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.ink3)
      }
      .foregroundStyle(Theme.ink)
      .padding(.horizontal, 12).frame(height: 40)
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .glassSurface(in: Capsule(), interactive: true)
    .accessibilityLabel("Model: \(name). Change the model")
  }
}

/// The model picker: Auto (Mercury's configured default) first, then every model by family, the
/// current one ticked, a search when there are many. Mercury has one model for every chat, so the
/// sheet says a pick changes it everywhere.
struct ModelSheet: View {
  var model: ConversationModel
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  var body: some View {
    NavigationStack {
      List {
        if let c = model.catalog {
          Section {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
              let d = c.defaultChoice
              row("Auto", d.map { "Mercury's default · \($0.title)" } ?? "Mercury's default model", on: c.isAuto, enabled: d != nil) { pick(nil) }
            }
          } footer: { Text("Changes the model for Mercury, in every chat.") }
          ForEach(c.notices, id: \.self) { Text($0).foregroundStyle(Theme.amber).font(.system(size: 13)) }
          ForEach(ModelMenu.groups(c.models, query: query), id: \.title) { g in
            Section(g.models.count > 1 ? "\(g.title) · \(g.models.count)" : g.title) {
              ForEach(g.models) { m in
                row(m.title, m.title != m.model ? m.model : ModelMenu.providerName(m.name), on: m.isCurrent && !c.isAuto, enabled: m.available) { pick(m) }
              }
            }
          }
        } else {
          ProgressView().frame(maxWidth: .infinity)
        }
      }
      .navigationTitle("Model")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .searchable(text: $query, prompt: "Search models")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
    .task { await model.loadModels() }
  }

  private func row(_ title: String, _ detail: String?, on: Bool, enabled: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(title).foregroundStyle(Theme.ink).lineLimit(1)
          if let detail { Text(detail).font(.system(size: 13)).foregroundStyle(Theme.ink3).lineLimit(1) }
        }
        Spacer()
        if on { Image(systemName: "checkmark").foregroundStyle(Theme.ink) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!enabled).opacity(enabled ? 1 : 0.4)
  }

  private func pick(_ m: ModelChoice?) {
    dismiss()
    Task { await model.pickModel(m) }
  }
}
