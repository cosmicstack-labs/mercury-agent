import SwiftUI
import MercuryCore

/// What Settings → Voice shows, decided from what loaded (kept apart from the view so tests can
/// check the screen is never empty).
///
/// The screen used to go blank: GET /api/plugins/optimus answers with the plugin's *catalog* entry
/// when Optimus isn't installed (no installedVersion, no settings), so `plugin != nil` led to a form
/// with no fields. Optimus counts as installed only with an installed version and settings.
struct VoiceScreen: Equatable {
  enum Optimus: Equatable {
    /// Installed: its settings form.
    case settings
    /// Not installed (or its settings can't be read): one line saying what it adds.
    case notInstalled
    /// Couldn't ask (the providers section still shows).
    case failed(String)
  }
  enum Content: Equatable {
    case loading
    /// Nothing could load: the error and a Retry button.
    case failed(String)
    case loaded(providers: Bool, optimus: Optimus)
  }

  static func optimusInstalled(_ p: PluginDetail?) -> Bool {
    guard let p else { return false }
    return p.installedVersion != nil && !(p.settings ?? []).isEmpty
  }

  /// `providers`: the providers list (nil on a Mercury without it); errors are per load.
  static func content(loaded: Bool, providers: VoiceProviders?, providersError: String?, plugin: PluginDetail?, pluginError: String?) -> Content {
    guard loaded else { return .loading }
    let installed = optimusInstalled(plugin)
    // Nothing to show: no providers list (an error, or a Mercury without it) and Optimus couldn't be asked.
    if providers == nil, let pluginError, !installed { return .failed(providersError ?? pluginError) }
    let optimus: Optimus = installed ? .settings : pluginError.map { .failed($0) } ?? .notInstalled
    return .loaded(providers: providers != nil, optimus: optimus)
  }

  static let optimusLine = "Talking to Mercury on your computer comes with the Optimus plugin. Install it in Mercury Desktop (Plugins); it uses the same keys as above."
  static let optimusOnlyLine = "Voice comes with the Optimus plugin. Install it on your computer (Plugins in Mercury Desktop) to talk to Mercury in real time."
}

/// Voice: the voice providers' keys (calls and dictation from the phone, and Optimus on the
/// computer, one shared store), what calls and dictation use, then the Optimus plugin's own voice
/// settings when it's installed (apps/desktop/src/views/settings/Voice.tsx).
struct VoiceSettings: View {
  let client: MercuryClient
  @State var plugin: PluginDetail?
  @State var pluginError: String?
  @State var providers: VoiceProviders?
  @State var providersError: String?
  @State var loaded = false
  @State var editing: VoiceProvider?
  @State var gate: OwnerGate
  @State var moreOpen = false

  init(client: MercuryClient) {
    self.client = client
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var content: VoiceScreen.Content {
    VoiceScreen.content(loaded: loaded, providers: providers, providersError: providersError, plugin: plugin, pluginError: pluginError)
  }

  var body: some View {
    Form {
      switch content {
      case .loading:
        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
      case .failed(let why):
        Section {
          ErrorText(text: why)
          Button("Retry") { Task { await load() } }
        }
      case .loaded(let hasProviders, let optimus):
        if let providers, hasProviders { providerSections(providers) }
        else if let providersError {
          Section("Voice providers") {
            ErrorText(text: providersError)
            Button("Retry") { Task { await load() } }
          }
        }
        optimusSection(optimus, alone: !hasProviders)
      }
    }
    .navigationTitle("Voice")
    .task { await load() }
    .refreshable { await load() }
    .ownerGate(gate)
    .sheet(item: $editing) { p in
      VoiceKeySheet(client: client, provider: p) { saved in
        if let saved { apply(saved) }
        Task { await load() }
      }
    }
  }

  @ViewBuilder func providerSections(_ v: VoiceProviders) -> some View {
    let phone = v.providers.filter(\.forPhone)
    let more = v.providers.filter { !$0.forPhone }
    Section {
      ForEach(phone) { providerRow($0) }
    } header: { Text("Voice providers") } footer: {
      Text("Keys stay on your computer, shared with Optimus. Calls use OpenAI or Gemini; dictation uses OpenAI, Deepgram or ElevenLabs.")
    }
    Section("In use") {
      LabeledContent("Calls use", value: v.capabilities.callName ?? "Not set up")
      if v.capabilities.callName == nil, let s = v.capabilities.callSetup { Text(s).font(.system(size: 13)).foregroundStyle(Theme.ink3) }
      LabeledContent("Dictation uses", value: v.capabilities.dictationName ?? "Not set up")
      if v.capabilities.dictationName == nil { Text(v.capabilities.setupLine).font(.system(size: 13)).foregroundStyle(Theme.ink3) }
    }
    if !more.isEmpty {
      Section {
        DisclosureGroup("More providers for Optimus", isExpanded: $moreOpen) {
          ForEach(more) { providerRow($0) }
        }
      }
    }
  }

  @ViewBuilder func providerRow(_ p: VoiceProvider) -> some View {
    if p.source == "provider" || (p.id == "openai" && !p.canEdit) {
      NavigationLink { ModelsSettings(client: client) } label: { VoiceProviderRow(provider: p) }
    } else if p.canEdit {
      Button { editing = p } label: { VoiceProviderRow(provider: p, chevron: true) }.buttonStyle(.plain)
    } else {
      VoiceProviderRow(provider: p)
    }
  }

  @ViewBuilder func optimusSection(_ o: VoiceScreen.Optimus, alone: Bool) -> some View {
    switch o {
    case .settings:
      if let plugin {
        if let missing = plugin.missing, !missing.isEmpty {
          Section("Needs setting up") {
            ForEach(missing, id: \.key) { m in
              VStack(alignment: .leading, spacing: 3) {
                Text(m.needs).font(.system(size: 15))
                Text(m.fix).font(.system(size: 13)).foregroundStyle(Theme.ink2)
              }
            }
          }
        }
        PluginForm(pluginId: plugin.id, fields: plugin.settings ?? [], groups: plugin.settingGroups ?? [], gate: gate) { await load() }
      }
    case .notInstalled:
      Section(alone ? "" : "On your computer") {
        Text(alone ? VoiceScreen.optimusOnlyLine : VoiceScreen.optimusLine).foregroundStyle(Theme.ink2)
      }
    case .failed(let why):
      Section("On your computer") {
        ErrorText(text: "Couldn't load Optimus's voice settings. \(why)")
        Button("Retry") { Task { await load() } }
      }
    }
  }

  func apply(_ saved: VoiceKeySaved) {
    guard var v = providers else { return }
    if let p = saved.provider, let i = v.providers.firstIndex(where: { $0.id == p.id }) { v.providers[i] = p }
    if let c = saved.capabilities { v.capabilities = c }
    providers = v
  }

  func load() async {
    async let pluginLoad: Result<PluginDetail?, Error> = { do { return .success(try await client.plugin("optimus")) } catch { return .failure(error) } }()
    async let providersLoad: Result<VoiceProviders?, Error> = { do { return .success(try await client.voiceProvidersIfSupported()) } catch { return .failure(error) } }()
    switch await pluginLoad {
    case .success(let p): plugin = p; pluginError = nil
    case .failure(let e): pluginError = e.localizedDescription
    }
    switch await providersLoad {
    case .success(let v): providers = v; providersError = nil
    case .failure(let e): providersError = e.localizedDescription
    }
    loaded = true
  }
}

/// One provider: its name, what it's for, and whether its key is set.
struct VoiceProviderRow: View {
  var provider: VoiceProvider
  var chevron = false
  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(provider.name).foregroundStyle(Theme.ink)
        Text(provider.usedFor).font(.system(size: 13)).foregroundStyle(Theme.ink3)
      }
      Spacer(minLength: 8)
      HStack(spacing: 5) {
        if provider.set { Image(systemName: "checkmark.circle.fill").font(.system(size: 13)) }
        Text(provider.status).font(.system(size: 14)).lineLimit(1)
      }
      .foregroundStyle(provider.set ? Theme.ink : Theme.ink3)
      if chevron { Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink4) }
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/// Paste a provider's key: Mercury checks it with the provider, then saves it on the computer.
struct VoiceKeySheet: View {
  let client: MercuryClient
  let provider: VoiceProvider
  /// The result when something changed (nil after a remove).
  var done: (VoiceKeySaved?) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var key = ""
  @State private var busy: String?
  @State private var error: String?
  @State private var gate: OwnerGate

  init(client: MercuryClient, provider: VoiceProvider, done: @escaping (VoiceKeySaved?) -> Void) {
    self.client = client; self.provider = provider; self.done = done
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          SecureField(provider.set ? "Paste a new key" : "Paste your \(provider.name) key", text: $key)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            .onSubmit { save() }
          if let busy {
            HStack(spacing: 8) { ProgressView(); Text(busy).foregroundStyle(Theme.ink2) }
          }
          if let error { ErrorText(text: error) }
        } header: { Text(provider.usedFor) } footer: {
          VStack(alignment: .leading, spacing: 4) {
            Text(provider.set ? "Now: \(provider.status)." : "Not set yet.")
            if let note = provider.note { Text(note) }
            Text("The key is saved on your computer and shared with Optimus. It never comes back to this phone.")
          }
        }
        if provider.set {
          Section {
            Button("Remove key", role: .destructive) { remove() }.disabled(busy != nil)
          }
        }
      }
      .navigationTitle(provider.name)
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy != nil) }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { save() }.disabled(busy != nil || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .presentationDetents([.medium, .large])
    .interactiveDismissDisabled(busy != nil)
    .ownerGate(gate)
  }

  func save() {
    let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !k.isEmpty, busy == nil else { return }
    run("Checking the key with \(provider.name)…") { try await gate.run { try await client.setVoiceKey(provider.id, apiKey: k, approval: $0) } }
  }

  func remove() {
    run("Removing…") { try await gate.run { try await client.setVoiceKey(provider.id, apiKey: nil, approval: $0) } }
  }

  private func run(_ label: String, _ change: @escaping () async throws -> VoiceKeySaved) {
    busy = label; error = nil
    Task {
      do {
        let saved = try await change()
        busy = nil
        key = ""
        done(saved)
        dismiss()
      } catch {
        busy = nil
        self.error = error.localizedDescription
      }
    }
  }
}

/// A plugin's settings as a form: only the fields that apply to what's chosen, in the
/// plugin's own groups, each saved as it changes.
struct PluginForm: View {
  var pluginId: String
  var fields: [PluginField]
  var groups: [PluginDetail.Group]
  var gate: OwnerGate
  var saved: () async -> Void
  @State var values: [String: JSONValue] = [:]
  @State var error: String?

  var shown: [PluginField] { fields.filter { $0.applies(merged) } }
  var merged: [String: JSONValue] {
    var v = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.value ?? .null) })
    v.merge(values) { _, new in new }
    return v
  }

  /// The plugin's groups in its order, then anything ungrouped.
  var sections: [(id: String, label: String, fields: [PluginField])] {
    var out: [(String, String, [PluginField])] = groups.compactMap { g in
      let f = shown.filter { $0.group == g.id }
      return f.isEmpty ? nil : (g.id, g.label, f)
    }
    let known = Set(groups.map(\.id))
    let rest = shown.filter { $0.group == nil || !known.contains($0.group!) }
    if !rest.isEmpty { out.append(("", groups.isEmpty ? "" : "More", rest)) }
    return out.map { (id: $0.0, label: $0.1, fields: $0.2) }
  }

  var body: some View {
    ForEach(sections, id: \.id) { s in
      Section(s.label) {
        ForEach(s.fields) { f in
          PluginFieldRow(field: f, value: merged[f.key] ?? .null) { v in set(f, v) }
        }
      }
    }
    SettingsError(text: error)
  }

  func set(_ f: PluginField, _ v: Any) {
    let old = values[f.key]
    switch v {
    case let b as Bool: values[f.key] = .bool(b)
    case let n as Double: values[f.key] = .number(n)
    case let s as String where f.type != "secret": values[f.key] = .string(s)
    default: break
    }
    Task {
      do { try await gate.run { try await gate.client.setPluginSetting(pluginId, key: f.key, value: v, approval: $0) }; error = nil; await saved() }
      catch { values[f.key] = old; self.error = error.localizedDescription }
    }
  }
}

struct PluginFieldRow: View {
  var field: PluginField
  var value: JSONValue
  var set: (Any) -> Void
  @State var draft = ""

  var title: String { field.label ?? field.key }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      editor
      if let d = field.description, !d.isEmpty, field.type != "boolean" {
        Text(d).font(.system(size: 12)).foregroundStyle(Theme.ink3)
      }
    }
  }

  @ViewBuilder var editor: some View {
    switch field.type {
    case "boolean":
      Toggle(isOn: Binding(get: { value.bool ?? false }, set: { set($0) })) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
          if let d = field.description { Text(d).font(.system(size: 12)).foregroundStyle(Theme.ink3) }
        }
      }
    case "enum":
      Picker(title, selection: Binding(get: { value.text }, set: { set($0) })) {
        ForEach(field.options ?? [], id: \.self) { o in Text(field.optionLabels?[o] ?? o).tag(o) }
      }
    case "secret":
      HStack {
        SecureField(field.isSet == true ? "\(title) · saved" : title, text: $draft)
          .autocorrectionDisabled()
          .onSubmit { if !draft.isEmpty { set(draft); draft = "" } }
        if field.isSet == true { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent).accessibilityLabel("Saved") }
      }
    case "number":
      LabeledContent(title) {
        TextField("", text: $draft).multilineTextAlignment(.trailing)
          #if os(iOS)
          .keyboardType(.decimalPad)
          #endif
          .onAppear { draft = value.text }
          .onSubmit { if let n = Double(draft) { set(n) } }
      }
    default:
      LabeledContent(title) {
        TextField(field.options?.first ?? "", text: $draft).multilineTextAlignment(.trailing).autocorrectionDisabled()
          .onAppear { draft = value.text }
          .onSubmit { set(draft) }
      }
    }
  }
}
