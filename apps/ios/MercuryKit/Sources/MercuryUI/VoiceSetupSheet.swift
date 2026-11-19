import SwiftUI
import MercuryCore

/// "Set up voice" (VoiceSetup in MercuryCore decides when it shows and what's on it): pick a voice,
/// paste its key, Mercury checks it with the provider and saves it on the computer, then the phone
/// carries on with what the owner was doing (the call, the dictation). Nothing is kept on the phone.
/// Only what happens before a call starts lives here; the call itself is VoiceCallModel's.
@MainActor @Observable
final class VoiceSetupModel {
  enum Stage: Equatable {
    case loading
    case failed(String)
    case choose
    /// Paste the key.
    case key(VoiceProvider)
    /// Saving and checking (or waiting for the owner's approval: `gate.question`).
    case checking(VoiceProvider)
    /// "✓ Voice is ready"; `next` is what follows.
    case ready(name: String, next: VoiceSetup.Next)
    /// Can't be changed from the phone (set in ~/.mercury/.env).
    case locked(VoiceProvider, String)
    /// Saved, but what was asked still isn't there.
    case missing(String)
  }

  let client: MercuryClient
  let trigger: VoiceSetup.Trigger
  let gate: OwnerGate
  var plan: VoiceSetup.Plan?
  var stage: Stage = .loading
  var key = ""
  var keyError: String?
  var moreOpen = false
  /// Called with what to do next; the sheet closes first.
  @ObservationIgnored var onContinue: (VoiceSetup.Next) -> Void = { _ in }
  @ObservationIgnored private var continuing: Task<Void, Never>?

  /// How long "Voice is ready" shows before the call or dictation starts.
  static let readyPause: Duration = .milliseconds(800)

  init(client: MercuryClient, trigger: VoiceSetup.Trigger) {
    self.client = client; self.trigger = trigger
    gate = OwnerGate(client: client)
  }

  func load() async {
    do {
      guard let v = try await client.voiceProviders() else {
        stage = .failed("This Mercury can't set up voice yet. Update Mercury on your computer.")
        return
      }
      plan = VoiceSetup.plan(trigger, providers: v.providers)
      stage = .choose
    } catch {
      stage = .failed(error.localizedDescription)
    }
  }

  func pick(_ c: VoiceSetup.Choice) {
    switch c.state {
    case .ready: startTalking()
    case .add: key = ""; keyError = nil; stage = .key(c.provider)
    case .locked:
      stage = .locked(c.provider, c.provider.note ?? "\(c.provider.name)'s key is set on your computer, so it's changed there.")
    }
  }

  /// A voice is already set: go straight on.
  func startTalking() {
    onContinue(trigger == .dictation ? .startDictation : trigger == .call ? .startCall : .done)
  }

  func back() {
    keyError = nil
    stage = .choose
    Task { await load() }
  }

  func save() {
    guard case .key(let p) = stage else { return }
    let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !k.isEmpty else { keyError = "Paste a key."; return }
    keyError = nil
    stage = .checking(p)
    let client = client
    Task {
      do {
        let saved = try await gate.run { approval in
          p.id == "openai" ? try await client.setOpenAIVoiceKey(k, approval: approval)
                           : try await client.setVoiceKey(p.id, apiKey: k, approval: approval)
        }
        key = ""
        finished(VoiceSetup.next(after: trigger, caps: saved.capabilities), name: p.name)
      } catch MercuryError.server(409, let message) {
        stage = .locked(p, message ?? "\(p.name)'s key is set on your computer, so it's changed there.")
      } catch {
        keyError = error.localizedDescription
        stage = .key(p)
      }
    }
  }

  func finished(_ next: VoiceSetup.Next, name: String) {
    switch next {
    case .stillMissing(let why):
      stage = .missing(why)
    case .done:
      stage = .ready(name: name, next: next)
    case .startCall, .startDictation:
      stage = .ready(name: name, next: next)
      continuing = Task { [weak self] in
        try? await Task.sleep(for: Self.readyPause)
        guard let self, !Task.isCancelled else { return }
        self.onContinue(next)
      }
    }
  }

  func cancel() { continuing?.cancel() }
}

struct VoiceSetupSheet: View {
  @State var model: VoiceSetupModel
  @Environment(\.dismiss) private var dismiss

  init(client: MercuryClient, trigger: VoiceSetup.Trigger, onContinue: @escaping (VoiceSetup.Next) -> Void) {
    let m = VoiceSetupModel(client: client, trigger: trigger)
    m.onContinue = onContinue
    _model = State(initialValue: m)
  }

  /// Snapshots and tests: a model already in a state. `still`: no navigation or scroll view (the renderer can't draw them).
  init(model: VoiceSetupModel, still: Bool = false) { _model = State(initialValue: model); self.still = still }

  var still = false

  var body: some View {
    if still {
      VStack(alignment: .leading, spacing: 20) { content }
        .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bg)
    } else {
      sheet
    }
  }

  private var sheet: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) { content }
          .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24)
          .animation(.snappy(duration: 0.25), value: model.stage)
      }
      .scrollBounceBehavior(.basedOnSize)
      .background(Theme.bg)
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { model.cancel(); dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .interactiveDismissDisabled(isChecking)
    .sensoryFeedback(.success, trigger: isReady) { _, now in now }
    .task { if model.stage == .loading { await model.load() } }
    .onDisappear { model.cancel() }
  }

  private var isChecking: Bool { if case .checking = model.stage { true } else { false } }
  private var isReady: Bool { if case .ready = model.stage { true } else { false } }

  @ViewBuilder private var content: some View {
    switch model.stage {
    case .loading:
      header
      ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
    case .failed(let why):
      header
      ErrorText(text: why)
      Button("Try again") { model.stage = .loading; Task { await model.load() } }.buttonStyle(SecondaryButtonStyle())
    case .choose:
      header
      if let plan = model.plan { choices(plan) }
    case .key(let p):
      keyStep(p)
    case .checking(let p):
      checking(p)
    case .ready(let name, let next):
      ready(name, next)
    case .locked(let p, let why):
      VoiceSetupMark(id: p.id, size: 52)
      Text(p.name).font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.ink)
      Text(why).font(.system(size: 15)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
      Button("Use a different voice") { model.back() }.buttonStyle(PrimaryButtonStyle())
    case .missing(let why):
      header
      Text(why).font(.system(size: 15)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
      Button("Use a different voice") { model.back() }.buttonStyle(PrimaryButtonStyle())
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(VoiceSetup.title).font(.system(size: 28, weight: .semibold)).foregroundStyle(Theme.ink)
      Text(VoiceSetup.subtitle).font(.system(size: 15)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder private func choices(_ plan: VoiceSetup.Plan) -> some View {
    if let ready = plan.ready {
      VoiceChoiceRow(choice: ready) { model.pick(ready) }
      if plan.trigger != .settings {
        Button("Start talking") { model.startTalking() }.buttonStyle(PrimaryButtonStyle())
      }
      let others = (plan.choices + plan.more).filter { $0.id != ready.id && $0.state != .ready }
      if !others.isEmpty {
        Text("Or add another voice").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink3).padding(.top, 4)
        ForEach(others) { c in VoiceChoiceRow(choice: c) { model.pick(c) } }
      }
    } else {
      VStack(spacing: 10) {
        ForEach(plan.choices) { c in VoiceChoiceRow(choice: c) { model.pick(c) } }
      }
      if !plan.more.isEmpty {
        DisclosureGroup(isExpanded: $model.moreOpen) {
          VStack(spacing: 10) {
            ForEach(plan.more) { c in VoiceChoiceRow(choice: c) { model.pick(c) } }
          }
          .padding(.top, 10)
        } label: {
          Text("More options").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2)
        }
        .tint(Theme.ink2)
      }
    }
  }

  @ViewBuilder private func keyStep(_ p: VoiceProvider) -> some View {
    Button { model.back() } label: {
      Label("All voices", systemImage: "chevron.left").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2)
    }
    .buttonStyle(.plain)
    HStack(spacing: 14) {
      VoiceSetupMark(id: p.id, size: 48)
      VStack(alignment: .leading, spacing: 2) {
        Text("Your \(p.name) key").font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink)
        Text(VoiceSetup.blurb(p.id)).font(.system(size: 14)).foregroundStyle(Theme.ink3)
      }
    }
    HStack(spacing: 8) {
      SecureField("Paste your key", text: $model.key)
        .autocorrectionDisabled()
        #if os(iOS)
        .textInputAutocapitalization(.never)
        .textContentType(.password)
        #endif
        .onSubmit { model.save() }
        .font(.system(size: 16)).foregroundStyle(Theme.ink)
        .padding(.horizontal, 14).frame(minHeight: 50)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 14))
      PasteButton(payloadType: String.self) { strings in
        let s = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        Task { @MainActor in model.key = s; model.keyError = nil }
      }
      .labelStyle(.titleOnly)
      .buttonBorderShape(.capsule)
      .tint(Theme.accent)
    }
    if let e = model.keyError { ErrorText(text: e) }
    if let url = VoiceSetup.keyPage(p.id) {
      Link(destination: url) {
        Label("Get a key", systemImage: "arrow.up.right").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
      }
    }
    Button("Save and check") { model.save() }
      .buttonStyle(PrimaryButtonStyle())
      .disabled(model.key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    Text(p.id == "openai"
         ? "Saved on your computer as your OpenAI key (Settings → Models). It never comes back to this phone."
         : "Saved on your computer and shared with Optimus. It never comes back to this phone.")
      .font(.system(size: 13)).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder private func checking(_ p: VoiceProvider) -> some View {
    VStack(spacing: 14) {
      if let q = model.gate.question {
        Image(systemName: "lock.shield").font(.system(size: 30)).foregroundStyle(Theme.ink2)
        Text("Approve on your computer · code \(q.code)").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
          .multilineTextAlignment(.center)
        Text(q.code).font(.system(size: 34, weight: .semibold, design: .monospaced)).kerning(6).foregroundStyle(Theme.ink)
          .accessibilityLabel("Code \(q.code.map(String.init).joined(separator: " "))")
        Text("Keys from your phone need your go-ahead on \(q.where_). It carries on as soon as it's approved.")
          .font(.system(size: 14)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
        HStack(spacing: 8) { ProgressView(); Text("Waiting…").foregroundStyle(Theme.ink3) }
      } else {
        VoiceSetupMark(id: p.id, size: 52)
        HStack(spacing: 8) { ProgressView(); Text("Checking your key…").font(.system(size: 16)).foregroundStyle(Theme.ink2) }
      }
    }
    .frame(maxWidth: .infinity).padding(.top, 24)
  }

  @ViewBuilder private func ready(_ name: String, _ next: VoiceSetup.Next) -> some View {
    VStack(spacing: 12) {
      Image(systemName: "checkmark.circle.fill").font(.system(size: 52)).foregroundStyle(Theme.ink)
        .symbolEffect(.bounce, value: name)
      Text("Voice is ready").font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.ink)
      Text(next == .startCall ? "Calling Mercury…" : next == .startDictation ? "Listening in a moment…" : "Mercury talks with \(name) now.")
        .font(.system(size: 15)).foregroundStyle(Theme.ink2)
    }
    .frame(maxWidth: .infinity).padding(.top, 24)
    switch next {
    case .startCall: Button("Start talking") { model.cancel(); model.onContinue(.startCall) }.buttonStyle(PrimaryButtonStyle())
    case .startDictation: Button("Start dictating") { model.cancel(); model.onContinue(.startDictation) }.buttonStyle(PrimaryButtonStyle())
    default: Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle())
    }
  }
}

/// One voice: its mark, name and one line, as a large row.
struct VoiceChoiceRow: View {
  var choice: VoiceSetup.Choice
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        VoiceSetupMark(id: choice.provider.id, size: 44)
        VStack(alignment: .leading, spacing: 3) {
          Text(choice.provider.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink)
          Text(choice.line).font(.system(size: 14)).foregroundStyle(choice.state == .ready ? Theme.ink2 : Theme.ink3)
            .lineLimit(2).multilineTextAlignment(.leading)
        }
        Spacer(minLength: 8)
        Image(systemName: choice.state == .ready ? "checkmark.circle.fill" : choice.state == .locked ? "lock" : "chevron.right")
          .font(.system(size: choice.state == .ready ? 20 : 14, weight: .semibold))
          .foregroundStyle(choice.state == .ready ? Theme.ink : Theme.ink4)
      }
      .padding(.horizontal, 16).padding(.vertical, 14)
      .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
    .buttonStyle(PressButtonStyle())
    .accessibilityElement(children: .combine)
    .accessibilityHint(choice.state == .add ? "Add a key" : "")
  }
}

/// A plain monochrome monogram for a voice provider (no brand logos).
struct VoiceSetupMark: View {
  var id: String
  var size: CGFloat
  var letter: String {
    switch id {
    case "openai": "O"
    case "gemini": "G"
    case "deepgram": "D"
    case "elevenlabs": "11"
    default: String(id.prefix(1)).uppercased()
    }
  }
  var body: some View {
    Text(letter)
      .font(.system(size: size * (letter.count > 1 ? 0.36 : 0.44), weight: .semibold, design: .rounded))
      .foregroundStyle(Theme.ink)
      .frame(width: size, height: size)
      .background(Theme.surface3, in: Circle())
  }
}

/// Snapshots: the sheet's states.
@MainActor
public enum VoiceSetupGallery {
  static let client = MercuryClient(baseURL: URL(string: "http://localhost")!)

  static func providers(openai: Bool = false, geminiEnv: Bool = false) -> [VoiceProvider] {
    [
      VoiceProvider(id: "openai", name: "OpenAI", uses: ["calls", "dictation", "optimus"], set: openai, source: openai ? "provider" : nil,
                    hint: openai ? "wxyz" : nil, canEdit: false),
      VoiceProvider(id: "gemini", name: "Google Gemini", env: "GEMINI_API_KEY", uses: ["calls", "optimus"], set: geminiEnv,
                    source: geminiEnv ? "env" : nil, canEdit: !geminiEnv),
      VoiceProvider(id: "elevenlabs", name: "ElevenLabs", env: "ELEVENLABS_API_KEY", uses: ["dictation", "optimus"], set: false, canEdit: true),
      VoiceProvider(id: "deepgram", name: "Deepgram", env: "DEEPGRAM_API_KEY", uses: ["dictation", "optimus"], set: false, canEdit: true),
    ]
  }

  static func sheet(_ trigger: VoiceSetup.Trigger, _ f: (VoiceSetupModel) -> Void) -> AnyView {
    let m = VoiceSetupModel(client: client, trigger: trigger)
    f(m)
    return AnyView(VStack(spacing: 0) {
      Spacer(minLength: 0).frame(height: 120)
      VoiceSetupSheet(model: m, still: true)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 28, topTrailingRadius: 28))
    }
    .background(Theme.ink.opacity(0.18)))
  }

  static var gemini: VoiceProvider { providers()[1] }

  public static func screens() -> [(name: String, view: AnyView)] {
    [
      ("11a-voice-setup-call", sheet(.call) { $0.plan = VoiceSetup.plan(.call, providers: providers()); $0.stage = .choose }),
      ("11b-voice-setup-mic-more", sheet(.dictation) {
        $0.plan = VoiceSetup.plan(.dictation, providers: providers()); $0.moreOpen = true; $0.stage = .choose
      }),
      ("11c-voice-setup-openai-ready", sheet(.call) { $0.plan = VoiceSetup.plan(.call, providers: providers(openai: true)); $0.stage = .choose }),
      ("11d-voice-setup-key", sheet(.call) { $0.key = ""; $0.stage = .key(gemini) }),
      ("11e-voice-setup-key-rejected", sheet(.call) {
        $0.key = "AIzaSyBad"; $0.keyError = "Gemini didn't accept that key (API key not valid)."; $0.stage = .key(gemini)
      }),
      ("11f-voice-setup-checking", sheet(.call) { $0.stage = .checking(gemini) }),
      ("11g-voice-setup-approval", sheet(.call) {
        $0.gate.question = .waiting(code: "ABC123")
        $0.stage = .checking(gemini)
      }),
      ("11h-voice-setup-ready", sheet(.call) { $0.stage = .ready(name: "Google Gemini", next: .startCall) }),
      ("11i-voice-setup-env", sheet(.call) {
        $0.stage = .locked(providers(geminiEnv: true)[1], "Google Gemini's key is set on the computer (GEMINI_API_KEY in ~/.mercury/.env), which always wins. Change or remove it there.")
      }),
    ]
  }
}
