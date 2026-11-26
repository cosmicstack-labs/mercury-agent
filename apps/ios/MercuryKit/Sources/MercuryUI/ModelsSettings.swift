import SwiftUI
import MercuryCore

/// Models: the model Mercury chats with, the ones learning and bot crews use, and every
/// provider with its key (apps/desktop/src/views/settings/Models.tsx).
struct ModelsSettings: View {
  let client: MercuryClient
  @State var settings: ProviderSettings?
  @State var error: String?
  @State var gate: OwnerGate
  /// Voice providers (calls and dictation), on a Mercury that has them.
  @State var voice: VoiceProviders?

  init(client: MercuryClient) {
    self.client = client
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var ready: [ProviderInfo] { settings?.providers.filter { $0.configured && $0.enabled } ?? [] }

  func label(_ id: String?) -> String {
    guard let id else { return "Same as chat" }
    return settings?.providers.first { $0.id == id }?.label ?? id
  }

  var body: some View {
    List {
      SettingsError(text: error)
      if let s = settings {
        Section {
          NavigationLink {
            DefaultModelPicker(client: client, providers: ready, current: s.default, gate: gate) { await load() }
          } label: {
            LabeledContent("Chat", value: "\(label(s.default.provider)) · \(s.default.model)")
          }
          rolePicker("Learning", value: s.roles.learning) { try await client.setModelRoles(learning: .some($0), approval: $1) }
          rolePicker("Bot crews", value: s.roles.crew) { try await client.setModelRoles(crew: .some($0), approval: $1) }
        } header: { Text("Models in use") } footer: {
          Text("Learning is the background work that improves Mercury after each chat. Bot crews are the bots a lead bot hands work to.")
        }
        Section("Providers") {
          ForEach(s.providers) { p in
            NavigationLink { ProviderDetail(client: client, provider: p, gate: gate) { await load() } } label: { ProviderRow(provider: p) }
          }
        }
        if let voice {
          Section {
            NavigationLink { VoiceSettings(client: client) } label: { VoiceSummaryRow(capabilities: voice.capabilities) }
          } header: { Text("Voice") } footer: {
            Text("Calls and dictation use their own providers: OpenAI (above), Gemini, Deepgram or ElevenLabs.")
          }
        }
      } else if error == nil {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
      }
    }
    .navigationTitle("Models")
    .task { await load() }
    .refreshable { await load() }
    .ownerGate(gate)
  }

  func rolePicker(_ title: String, value: String?, set: @escaping (String?, String?) async throws -> SaveResult) -> some View {
    Picker(title, selection: Binding(get: { value ?? "" }, set: { v in
      Task {
        do { _ = try await gate.run { try await set(v.isEmpty ? nil : v, $0) }; await load() }
        catch { self.error = error.localizedDescription }
      }
    })) {
      Text("Same as chat").tag("")
      ForEach(ready) { Text($0.label).tag($0.id) }
    }
  }

  func load() async {
    do { settings = try await client.providerSettings(); error = nil }
    catch { self.error = error.localizedDescription }
    voice = (try? await client.voiceProvidersIfSupported()) ?? nil
  }
}

/// "Voice" with what calls and dictation use, for the Models screen and the model picker.
struct VoiceSummaryRow: View {
  var capabilities: VoiceCapabilities
  var title = "Voice"

  var line: String {
    let calls = capabilities.callName.map { "Calls: \($0)" } ?? "Calls: not set up"
    let dictation = capabilities.dictationName.map { "Dictation: \($0)" } ?? "Dictation: not set up"
    return "\(calls) · \(dictation)"
  }

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "waveform").foregroundStyle(Theme.ink2).frame(width: 22)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).foregroundStyle(Theme.ink)
        Text(line).font(.system(size: 13)).foregroundStyle(Theme.ink3).lineLimit(2)
      }
    }
  }
}

struct ProviderRow: View {
  var provider: ProviderInfo
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Text(provider.label).font(.system(size: 16))
        if provider.isDefault { Text("Default").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.onAccent).padding(.horizontal, 6).padding(.vertical, 2).background(Theme.accent, in: Capsule()) }
      }
      if !provider.configured { StatusText(text: "Not set up", tone: .off) }
      else if !provider.enabled { StatusText(text: "Off", tone: .off) }
      else { StatusText(text: provider.model.isEmpty ? "Ready" : provider.model, tone: .good) }
    }
  }
}

/// The chat model: a provider, then one of the models it offers.
struct DefaultModelPicker: View {
  let client: MercuryClient
  var providers: [ProviderInfo]
  var current: ProviderSettings.Default
  var gate: OwnerGate
  var saved: () async -> Void
  @State var models: [String: [String]] = [:]
  @State var loading: String?
  @State var error: String?
  @Environment(\.dismiss) var dismiss

  var body: some View {
    List {
      SettingsError(text: error)
      if providers.isEmpty {
        Text("Set up a provider first.").foregroundStyle(Theme.ink3)
      }
      ForEach(providers) { p in
        Section(p.label) {
          if let list = models[p.id] {
            ForEach(list, id: \.self) { m in
              Button { pick(p.id, m) } label: {
                HStack {
                  Text(m).foregroundStyle(Theme.ink).lineLimit(1)
                  Spacer()
                  if current.provider == p.id && current.model == m { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                }
              }
            }
          } else if loading == p.id {
            ProgressView()
          } else {
            Button("Show models") { Task { await fetch(p.id) } }
          }
        }
      }
    }
    .navigationTitle("Chat model")
    .task { if let p = providers.first(where: { $0.id == current.provider }) { await fetch(p.id) } }
  }

  func fetch(_ id: String) async {
    loading = id
    defer { loading = nil }
    do {
      let r = try await client.checkProvider(id)
      if r.ok { models[id] = r.models ?? [] } else { error = r.error ?? "That provider didn't answer." }
    } catch { self.error = error.localizedDescription }
  }

  func pick(_ provider: String, _ model: String) {
    Task {
      do {
        _ = try await gate.run { try await client.setModelRoles(defaultProvider: provider, model: model, approval: $0) }
        await saved()
        dismiss()
      } catch { self.error = error.localizedDescription }
    }
  }
}

/// One provider: its key and address, checked live before saving, on or off.
struct ProviderDetail: View {
  let client: MercuryClient
  @State var provider: ProviderInfo
  var gate: OwnerGate
  var saved: () async -> Void
  @State var key = ""
  @State var baseUrl = ""
  @State var check: ProviderCheck?
  @State var busy = false
  @State var error: String?
  @State var note: String?
  @State var confirmForget = false

  init(client: MercuryClient, provider: ProviderInfo, gate: OwnerGate, saved: @escaping () async -> Void) {
    self.client = client; self.gate = gate; self.saved = saved
    _provider = State(initialValue: provider)
    _baseUrl = State(initialValue: provider.baseUrl)
  }

  var body: some View {
    Form {
      Section { Text(provider.blurb).font(.system(size: 14)).foregroundStyle(Theme.ink2) }
      if provider.signInOnly {
        Section { Text("Sign in to \(provider.label) in Mercury Desktop on your computer.").foregroundStyle(Theme.ink2) }
      } else {
        Section {
          if provider.needsKey {
            SecureField(provider.hasKey ? provider.apiKey : (provider.keyHint ?? "API key"), text: $key)
              .textContentType(.password).autocorrectionDisabled()
          }
          if provider.needsBaseUrl {
            TextField("Address", text: $baseUrl).autocorrectionDisabled()
              #if os(iOS)
              .keyboardType(.URL).textInputAutocapitalization(.never)
              #endif
          }
          if let check {
            if check.ok { StatusText(text: "Works · \(check.models?.count ?? 0) models", tone: .good) }
            else { StatusText(text: check.error ?? "That didn't work.", tone: .warn) }
          }
        } header: { Text("Connection") } footer: {
          if let url = provider.keyUrl.flatMap(URL.init(string:)) { Link("Get a key", destination: url) }
        }
        Section {
          Button("Check") { Task { await runCheck() } }.disabled(busy)
          Button("Save") { Task { await save() } }.disabled(busy || (key.isEmpty && baseUrl == provider.baseUrl))
        }
        if provider.configured {
          Section {
            Toggle("Use this provider", isOn: Binding(get: { provider.enabled }, set: { v in Task { await setEnabled(v) } }))
            if provider.hasKey { Button("Forget the key", role: .destructive) { confirmForget = true } }
          }
        }
      }
      if let note { Section { StatusText(text: note, tone: .good) } }
      SettingsError(text: error)
    }
    .navigationTitle(provider.label)
    .confirmationDialog("Forget the \(provider.label) key?", isPresented: $confirmForget, titleVisibility: .visible) {
      Button("Forget", role: .destructive) { Task { await forget() } }
    }
  }

  func runCheck() async {
    busy = true; defer { busy = false }
    do { check = try await client.checkProvider(provider.id, apiKey: key.isEmpty ? nil : key, baseUrl: provider.needsBaseUrl ? baseUrl : nil); error = nil }
    catch { self.error = error.localizedDescription }
  }

  func save() async {
    busy = true; defer { busy = false }
    do {
      let r = try await gate.run { try await client.saveProvider(provider.id, apiKey: key.isEmpty ? nil : key, baseUrl: provider.needsBaseUrl ? baseUrl : nil, approval: $0) }
      if let e = r.error { error = e; return }
      key = ""; error = nil
      note = r.restartRequired == true ? "Saved. Mercury uses it after a restart." : "Saved."
      await reload()
    } catch { self.error = error.localizedDescription }
  }

  func setEnabled(_ on: Bool) async {
    do { _ = try await gate.run { try await client.saveProvider(provider.id, enabled: on, approval: $0) }; await reload() }
    catch { self.error = error.localizedDescription }
  }

  func forget() async {
    do { _ = try await gate.run { try await client.forgetProviderKey(provider.id, approval: $0) }; await reload() }
    catch { self.error = error.localizedDescription }
  }

  func reload() async {
    await saved()
    if let p = try? await client.providerSettings().providers.first(where: { $0.id == provider.id }) { provider = p }
  }
}
