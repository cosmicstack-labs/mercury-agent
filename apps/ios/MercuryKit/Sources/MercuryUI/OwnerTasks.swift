import SwiftUI
import AVFoundation
import MercuryCore

// MARK: - The tasks (apps/desktop/src/components/OwnerTasks.tsx)

/// Owner tasks (ADR-048): something only the owner can do — type the letters of a CAPTCHA, listen to
/// an audio one, read out a code, finish a step on a page — with the picture or sound and a box for
/// the answer. Loaded when the app connects, kept current by `owner_task` events on the activity
/// stream (Notifier routes them here), dropped when they expire. The first answer from any app or
/// channel wins; a 409 or 404 just means it's gone.
@MainActor @Observable
final class OwnerTasksModel {
  static let shared = OwnerTasksModel()

  private(set) var items: [OwnerTask] = []
  /// The sheet is up. A new task brings it up; swiping it down leaves the "needs you" row in the chat.
  var presented = false
  @ObservationIgnored private(set) var client: MercuryClient?
  @ObservationIgnored var now: () -> Date = { .now }
  @ObservationIgnored private var scope: String?
  @ObservationIgnored private var ticker: Task<Void, Never>?

  init() {}

  /// Waiting and not yet expired, oldest first.
  var live: [OwnerTask] {
    let t = now()
    return items.filter { $0.isPending && $0.expiresAt > t }
  }

  /// One Mercury (`scope`: its connection id). Switching to another drops the old one's tasks.
  func connect(_ client: MercuryClient, scope: String) async {
    if self.scope != scope { items = []; presented = false }
    self.scope = scope
    self.client = client
    await refresh()
  }

  /// What's waiting now (on connect, and back in the foreground, when the stream may have missed some).
  func refresh() async {
    guard let client, let pending = try? await client.ownerTasks() else { return } // an older Mercury has none
    replace(pending)
  }

  func replace(_ tasks: [OwnerTask]) {
    let had = Set(items.map(\.id))
    items = tasks.filter(\.isPending)
    prune()
    if items.contains(where: { !had.contains($0.id) }) { presented = true }
    schedule()
  }

  func apply(_ e: OwnerTaskEvent) {
    if e.isOpen { upsert(e.task) } else { remove(e.task.id) }
  }

  func upsert(_ t: OwnerTask) {
    let isNew = !items.contains { $0.id == t.id }
    if let i = items.firstIndex(where: { $0.id == t.id }) { items[i] = t } else { items.append(t) }
    prune()
    if isNew && items.contains(where: { $0.id == t.id }) { presented = true }
    schedule()
  }

  func remove(_ id: String) {
    items.removeAll { $0.id == id }
    if items.isEmpty { presented = false }
  }

  /// Drops what expired or was settled.
  func prune() {
    let t = now()
    items.removeAll { !$0.isPending || $0.expiresAt <= t }
    if items.isEmpty { presented = false }
  }

  /// Wakes when the next one expires (at most a minute away, so a changed clock catches up).
  private func schedule() {
    ticker?.cancel()
    guard let next = items.map(\.expiresAt).min() else { ticker = nil; return }
    let wait = min(60, max(0.5, next.timeIntervalSince(now()) + 0.2))
    ticker = Task { [weak self] in
      try? await Task.sleep(for: .seconds(wait))
      guard !Task.isCancelled, let self else { return }
      self.prune()
      self.schedule()
    }
  }

  /// Send / Done. A "done" task with nothing typed says "done". Throws only what the owner should see.
  func answer(_ t: OwnerTask, _ text: String) async throws {
    guard let client else { return }
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    _ = try await client.answerOwnerTask(t.id, answer: t.answerKind == .done && value.isEmpty ? "done" : value)
    remove(t.id) // sent, or answered elsewhere / gone: either way it's settled
  }

  /// Skip.
  func decline(_ t: OwnerTask) async throws {
    guard let client else { return }
    _ = try await client.declineOwnerTask(t.id)
    remove(t.id)
  }

  /// Opens the sheet (a tapped notification about a task).
  func show() { presented = true }

  /// The "needs you" row shows in the chat: tasks wait and the sheet is down.
  var waitingInChat: Bool { !presented && !live.isEmpty }

  /// Mercury's phone notification for a task (src/core/agent.ts): "Mercury needs you: <title>",
  /// its body "<prompt>\nCode <code>". It carries no chat, so this is how a tap finds the task.
  nonisolated static func isTaskNotice(title: String, body: String) -> Bool {
    title.hasPrefix("Mercury needs you") && body.range(of: #"(?m)^Code [A-Z0-9]{4,10}$"#, options: .regularExpression) != nil
  }

  /// "expires in 4 min" (never less than 1).
  nonisolated static func minutesLeft(_ t: OwnerTask, now: Date) -> Int {
    max(1, Int((t.expiresAt.timeIntervalSince(now) / 60).rounded()))
  }
}

// MARK: - The sheet

/// Everything waiting, one card each, in a sheet over whatever is on screen.
struct OwnerTasksSheet: View {
  var model: OwnerTasksModel

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { ctx in
      ScrollView { OwnerTasksList(model: model, now: ctx.date).padding(16) }
        .scrollDismissesKeyboard(.interactively)
    }
    .background(Theme.bg)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}

/// The sheet's content: "Needs you" and the cards.
struct OwnerTasksList: View {
  var model: OwnerTasksModel
  var now: Date

  var body: some View {
    let tasks = model.live
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Circle().fill(Theme.amber).frame(width: 8, height: 8)
          .overlay(Circle().stroke(Theme.amber.opacity(0.35), lineWidth: 4))
          .accessibilityHidden(true)
        Text("Needs you").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink)
        if tasks.count > 1 {
          Text("\(tasks.count)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink3)
        }
        Spacer(minLength: 4)
        Button { model.presented = false } label: { Image(systemName: "xmark").frame(width: 30, height: 30) }
          .buttonStyle(IconButtonStyle()).accessibilityLabel("Later")
      }
      ForEach(tasks) { t in
        OwnerTaskCard(task: t, now: now, model: model)
      }
    }
    .animation(.snappy, value: tasks.map(\.id))
  }
}

/// One task: who asks and what, the page it's for, the picture or sound, the answer box, Skip and Send.
struct OwnerTaskCard: View {
  var task: OwnerTask
  var now: Date
  var model: OwnerTasksModel

  @State private var answer = ""
  @State private var busy = false
  @State private var error: String?
  @State private var image: PlatformImage?
  @State private var audio: Data?
  @State private var mediaFailed = false
  @FocusState private var focused: Bool

  private var canSend: Bool { task.answerKind == .done || !answer.trimmed.isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "puzzlepiece.extension").font(.system(size: 16)).foregroundStyle(Theme.amber)
          .padding(.top, 1).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 4) {
          Text("\(task.who) needs you: \(task.title)").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
          if !task.prompt.isEmpty {
            Text(task.prompt).font(.system(size: 15)).foregroundStyle(Theme.ink2).textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
          }
          if let link = task.link {
            Link(destination: link) {
              Label { Text(link.absoluteString).lineLimit(1).truncationMode(.middle) } icon: { Image(systemName: "arrow.up.right.square") }
                .font(.system(size: 13)).foregroundStyle(Theme.ink2)
            }
            .accessibilityHint("Opens in Safari")
          }
        }
      }
      if let media = task.media { mediaView(media) }
      if task.answerKind == .text {
        TextField("Your answer", text: $answer)
          .font(.system(size: 17, design: .monospaced))
          .autocorrectionDisabled()
          #if os(iOS)
          // CAPTCHA answers are case-sensitive: what's typed is what's sent.
          .textInputAutocapitalization(.never)
          .keyboardType(.asciiCapable)
          #endif
          .textContentType(nil)
          .submitLabel(.send)
          .focused($focused)
          .onSubmit(send)
          .onChange(of: answer) { _, v in if v.count > 2000 { answer = String(v.prefix(2000)) } }
          .padding(.horizontal, 12).frame(minHeight: 44)
          .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 11))
          .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.line))
          .accessibilityLabel("Your answer")
      }
      if let error { Text(error).font(.system(size: 13)).foregroundStyle(Theme.red) }
      HStack(spacing: 8) {
        Button("Skip") { decline() }.buttonStyle(AnswerButtonStyle(quiet: true))
        Spacer(minLength: 0)
        Button(action: send) {
          Label(task.answerKind == .done ? "Done" : "Send", systemImage: task.answerKind == .done ? "checkmark" : "paperplane.fill")
            .opacity(busy ? 0.5 : 1)
        }
        .buttonStyle(AnswerButtonStyle(primary: true))
        .disabled(!canSend)
      }
      .disabled(busy)
      Text("Code \(task.code) · expires in \(OwnerTasksModel.minutesLeft(task, now: now)) min · never a password or PIN")
        .font(.system(size: 12)).foregroundStyle(Theme.ink4)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
    .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.amber.opacity(0.4)))
    .task(id: task.id) { await loadMedia() }
    .onAppear { if task.answerKind == .text && task.id == model.live.first?.id { focused = true } }
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func mediaView(_ media: OwnerTask.Media) -> some View {
    Group {
      if media.kind == .image, let image {
        Image(platform: image).resizable().interpolation(.none).aspectRatio(contentMode: .fit)
          .frame(maxHeight: 200)
          .accessibilityLabel("What to solve")
      } else if media.kind == .audio, let audio {
        OwnerTaskAudio(data: audio)
      } else if mediaFailed {
        Label("Couldn't load it", systemImage: "exclamationmark.triangle").font(.system(size: 13)).foregroundStyle(Theme.ink3)
          .padding(.vertical, 18)
      } else {
        ProgressView().padding(.vertical, 24)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(8)
    // White under the picture, as on Desktop: CAPTCHAs are drawn for a white page.
    .background(media.kind == .image ? Color.white.opacity(0.95) : Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
  }

  private func loadMedia() async {
    guard let media = task.media, let client = model.client else { return }
    guard let data = try? await client.ownerTaskMedia(task) else { mediaFailed = true; return }
    if media.kind == .image {
      if let img = PlatformImage(data: data) { image = img } else { mediaFailed = true }
    } else {
      audio = data
    }
  }

  private func send() {
    guard canSend, !busy else { return }
    run { try await model.answer(task, answer) }
  }

  private func decline() {
    guard !busy else { return }
    run { try await model.decline(task) }
  }

  private func run(_ work: @escaping () async throws -> Void) {
    busy = true
    error = nil
    Task {
      do { try await work() } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

/// An audio CAPTCHA: play / pause and how far it got. It plays even with the ring switch on silent.
struct OwnerTaskAudio: View {
  var data: Data
  @State private var player: AVAudioPlayer?
  @State private var playing = false
  @State private var progress: Double = 0
  @State private var failed = false

  var body: some View {
    HStack(spacing: 12) {
      Button(action: toggle) {
        Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: 14)).foregroundStyle(Theme.onAccent)
          .frame(width: 38, height: 38).background(Theme.accent, in: Circle())
      }
      .buttonStyle(PressButtonStyle())
      .accessibilityLabel(playing ? "Pause" : "Play")
      .disabled(failed)
      VStack(alignment: .leading, spacing: 4) {
        ProgressView(value: progress).tint(Theme.ink2)
        Text(failed ? "Can't play this sound" : "Listen, then type what you hear").font(.system(size: 12)).foregroundStyle(Theme.ink3)
      }
    }
    .padding(.horizontal, 4)
    .task(id: playing) {
      while playing, !Task.isCancelled, let p = player {
        progress = p.duration > 0 ? p.currentTime / p.duration : 0
        if !p.isPlaying { playing = false; progress = 0; break }
        try? await Task.sleep(for: .milliseconds(200))
      }
    }
    .onDisappear { player?.stop(); playing = false }
  }

  private func toggle() {
    if player == nil {
      guard let p = try? AVAudioPlayer(data: data) else { failed = true; return }
      player = p
    }
    guard let player else { return }
    if playing { player.pause(); playing = false; return }
    #if os(iOS)
    // A call already owns the audio session; otherwise play past the silent switch.
    let s = AVAudioSession.sharedInstance()
    if s.category != .playAndRecord { try? s.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers]); try? s.setActive(true) }
    #endif
    playing = player.play()
  }
}

// MARK: - In the chat

/// "Mercury needs you" pinned above the message box while a task waits and its sheet is down:
/// tapping it brings the sheet back.
struct OwnerTasksRow: View {
  var model: OwnerTasksModel

  var body: some View {
    let tasks = model.live
    if model.waitingInChat {
      Button { model.show() } label: {
        HStack(spacing: 10) {
          Circle().fill(Theme.amber).frame(width: 8, height: 8)
            .overlay(Circle().stroke(Theme.amber.opacity(0.35), lineWidth: 4))
            .accessibilityHidden(true)
          Text(tasks.count == 1 ? "\(tasks[0].who) needs you: \(tasks[0].title)" : "\(tasks.count) things need you")
            .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
          Spacer(minLength: 4)
          Text("Open").font(.system(size: 13)).foregroundStyle(Theme.ink3)
          Image(systemName: "chevron.up").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink3)
        }
        .padding(.horizontal, 14).frame(minHeight: 44)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line))
        .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
      }
      .buttonStyle(PressButtonStyle())
      .accessibilityLabel("Needs you")
      .accessibilityHint("Opens what Mercury needs you to do")
    }
  }
}
