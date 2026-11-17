import SwiftUI
import MercuryCore

// Settings → Plugins: what's installed (on/off, updates), what's in the catalog (Install), and each
// plugin's page (what it can reach, its settings, update, remove). Plugins run code on the computer:
// every change from the phone goes through the owner's approval (OwnerGate), and installing or
// turning on one that uses the screen asks first (Plugins.consent). Mirrors Mercury Desktop's
// Plugins view (apps/desktop/src/views/plugins).

// MARK: Install / turn on

/// Install or turn on one plugin: ask first, wait for the owner's approval if the computer wants
/// it, do it, then watch until the plugin is running (or say why it isn't).
@MainActor @Observable
final class PluginActionModel {
  enum Kind: Equatable { case install, enable }
  enum Stage: Equatable {
    /// The confirm sheet (Plugins.consent).
    case confirm
    /// Installing, starting… (`gate.question` set: waiting for the owner's approval).
    case working(String)
    case done(Plugins.After)
    case failed(String)
  }

  let client: MercuryClient
  let plugin: PluginDetail
  let kind: Kind
  let consent: Plugins.Consent
  let gate: OwnerGate
  var stage: Stage = .confirm
  /// The plugin as it is after the change.
  var result: PluginDetail?
  @ObservationIgnored var pollEvery: Duration = .seconds(1)
  @ObservationIgnored var pollTimes = 20
  @ObservationIgnored private var task: Task<Void, Never>?

  init(client: MercuryClient, plugin: PluginDetail, kind: Kind, computer: String) {
    self.client = client; self.plugin = plugin; self.kind = kind
    consent = Plugins.consent(for: plugin, computer: computer, enabling: kind == .enable)
    gate = OwnerGate(client: client)
  }

  var name: String { plugin.name }
  var isWorking: Bool { if case .working = stage { true } else { false } }

  func start() {
    guard !isWorking else { return }
    task = Task { await run() }
  }

  func cancel() { task?.cancel() }

  func run() async {
    stage = .working(kind == .install ? "Installing \(name)…" : "Turning on \(name)…")
    let (client, id, kind) = (client, plugin.id, kind)
    do {
      _ = try await gate.run { approval -> Bool in
        if kind == .install { _ = try await client.installPlugin(id, approval: approval) }
        else { try await client.setPluginEnabled(id, true, approval: approval) }
        return true
      }
      stage = .working("Starting \(name)…")
      var after = Plugins.After.missing
      for i in 0..<max(1, pollTimes) {
        if let p = try? await client.plugin(id) { result = p }
        after = Plugins.after(result)
        if after != .starting && after != .missing { break }
        if i < pollTimes - 1 { try await Task.sleep(for: pollEvery) }
      }
      stage = .done(after)
    } catch is CancellationError {
      return
    } catch {
      stage = .failed(Plugins.friendlyError(error.localizedDescription, plugin: plugin))
    }
  }
}

/// The confirm sheet, then progress, the owner's approval and the result, in one sheet.
struct PluginActionSheet: View {
  @State var model: PluginActionModel
  var still = false
  /// Called when the sheet closes (reload what's behind it).
  var finished: () -> Void = {}
  @Environment(\.dismiss) private var dismiss

  init(model: PluginActionModel, still: Bool = false, finished: @escaping () -> Void = {}) {
    _model = State(initialValue: model); self.still = still; self.finished = finished
  }

  var body: some View {
    if still {
      VStack(alignment: .leading, spacing: 18) { content }
        .padding(.horizontal, 20).padding(.vertical, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bg)
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) { content }
          .padding(.horizontal, 20).padding(.top, 28).padding(.bottom, 24)
          .animation(.snappy(duration: 0.25), value: model.stage)
      }
      .scrollBounceBehavior(.basedOnSize)
      .background(Theme.bg)
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
      .interactiveDismissDisabled(model.isWorking)
      .sensoryFeedback(.success, trigger: model.stage == .done(.running)) { _, now in now }
      .onDisappear { finished() }
    }
  }

  @ViewBuilder private var content: some View {
    switch model.stage {
    case .confirm: confirm
    case .working(let label): working(label)
    case .done(let after): done(after)
    case .failed(let why):
      PluginMark(name: model.name, size: 52)
      Text("\(model.kind == .install ? "Couldn't install" : "Couldn't turn on") \(model.name)").font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink)
      Text(why).font(.system(size: 15)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
      if why.contains("needs a desktop computer") {
        // Trying again won't change the computer.
        Button("Close") { dismiss() }.buttonStyle(PrimaryButtonStyle())
      } else {
        Button("Try again") { model.start() }.buttonStyle(PrimaryButtonStyle())
        Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle())
      }
    }
  }

  @ViewBuilder private var confirm: some View {
    HStack(spacing: 14) {
      PluginMark(name: model.name, size: 52)
      VStack(alignment: .leading, spacing: 3) {
        Text(model.consent.title).font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.ink)
        if let t = model.plugin.tier { Text(t == "official" ? "Official plugin" : t == "community" ? "Community plugin" : "Local plugin").font(.system(size: 14)).foregroundStyle(Theme.ink3) }
      }
    }
    switch model.consent {
    case .controlsComputer(_, let body):
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "cursorarrow.rays").font(.system(size: 20, weight: .medium)).foregroundStyle(Theme.ink)
          .frame(width: 28)
        Text(body).font(.system(size: 16)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    case .access(_, let lines):
      VStack(alignment: .leading, spacing: 10) {
        Text("It can").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink3)
        ForEach(lines, id: \.self) { l in
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(Theme.ink3).frame(width: 5, height: 5).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
            Text(l).font(.system(size: 15)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
    PluginProminentButton(title: model.kind == .install ? "Install" : "Turn on") { model.start() }
    Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle())
  }

  @ViewBuilder private func working(_ label: String) -> some View {
    VStack(spacing: 14) {
      if let q = model.gate.question {
        Image(systemName: "lock.shield").font(.system(size: 30)).foregroundStyle(Theme.ink2)
        Text("Approve on your computer · code \(q.code)").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
          .multilineTextAlignment(.center)
        Text(q.code).font(.system(size: 34, weight: .semibold, design: .monospaced)).kerning(6).foregroundStyle(Theme.ink)
          .accessibilityLabel("Code \(q.code.map(String.init).joined(separator: " "))")
        Text("Plugins run on your computer, so changes from your phone need your go-ahead on \(q.where_). It carries on as soon as it's approved.")
          .font(.system(size: 14)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 8) { ProgressView(); Text("Waiting…").foregroundStyle(Theme.ink3) }
      } else {
        PluginMark(name: model.name, size: 56)
        HStack(spacing: 8) { ProgressView(); Text(label).font(.system(size: 16)).foregroundStyle(Theme.ink2) }
        if model.kind == .install, label.hasPrefix("Installing") {
          Text("Your computer is downloading it. This can take a minute.").font(.system(size: 13)).foregroundStyle(Theme.ink3)
            .multilineTextAlignment(.center)
        }
      }
    }
    .frame(maxWidth: .infinity).padding(.top, 24)
  }

  @ViewBuilder private func done(_ after: Plugins.After) -> some View {
    VStack(spacing: 12) {
      Image(systemName: after == .running || after == .needsSetup ? "checkmark.circle.fill" : after == .starting || after == .missing ? "clock" : "exclamationmark.triangle")
        .font(.system(size: 52)).foregroundStyle(Theme.ink)
      Text(doneTitle(after)).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
      Text(doneLine(after)).font(.system(size: 15)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity).padding(.top, 20)
    Button(after == .needsSetup ? "Set it up" : "Done") { dismiss() }.buttonStyle(PrimaryButtonStyle())
  }

  func doneTitle(_ a: Plugins.After) -> String {
    switch a {
    case .running: "\(model.name) is running"
    case .needsSetup: "\(model.name) is installed"
    case .starting, .missing: "\(model.name) is installed"
    case .failed: "\(model.name) didn't start"
    }
  }

  func doneLine(_ a: Plugins.After) -> String {
    switch a {
    case .running: model.kind == .install ? "Installed and turned on." : "Turned on."
    case .needsSetup: "It needs a few settings before it can do everything."
    case .starting, .missing: "It's still starting on your computer."
    case .failed(let why): why
    }
  }
}

/// The one prominent action: ink Liquid Glass on iOS 26, the solid button below.
struct PluginProminentButton: View {
  var title: String
  var action: () -> Void
  var body: some View {
    #if compiler(>=6.2)
    if #available(iOS 26.0, macOS 26.0, *) {
      Button(action: action) { Text(title).font(.system(size: 16, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 40) }
        .buttonStyle(.glassProminent).tint(Theme.accent).foregroundStyle(Theme.onAccent)
    } else {
      Button(title, action: action).buttonStyle(PrimaryButtonStyle())
    }
    #else
    Button(title, action: action).buttonStyle(PrimaryButtonStyle())
    #endif
  }
}

/// A plain monogram for a plugin (no logos).
struct PluginMark: View {
  var name: String
  var size: CGFloat
  var body: some View {
    Text(String(name.prefix(1)).uppercased())
      .font(.system(size: size * 0.44, weight: .semibold, design: .rounded))
      .foregroundStyle(Theme.ink)
      .frame(width: size, height: size)
      .background(Theme.surface3, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// What a sheet is for: which plugin, install or turn on.
struct PluginActionTarget: Identifiable {
  var plugin: PluginDetail
  var kind: PluginActionModel.Kind
  var id: String { "\(plugin.id):\(kind)" }
}

// MARK: The list

/// Settings → Plugins.
struct PluginsSettings: View {
  let client: MercuryClient
  /// The computer's name, for "…on <name>".
  let computer: String
  @State var list: PluginList?
  @State var error: String?
  @State var canManage = false
  @State var gate: OwnerGate
  @State var busy: Set<String> = []
  @State var action: PluginActionTarget?
  @State var actionError: String?

  init(client: MercuryClient, computer: String, list: PluginList? = nil, canManage: Bool = false) {
    self.client = client; self.computer = computer
    _list = State(initialValue: list); _canManage = State(initialValue: canManage)
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var body: some View {
    Form {
      if let list {
        rows(list)
      } else if let error {
        Section {
          ErrorText(text: error)
          Button("Retry") { Task { await load() } }
        }
      } else {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
      }
    }
    .navigationTitle("Plugins")
    .task { await load() }
    .refreshable { await load(refresh: true) }
    .ownerGate(gate)
    .sheet(item: $action) { t in
      PluginActionSheet(model: PluginActionModel(client: client, plugin: t.plugin, kind: t.kind, computer: computer)) {
        Task { await load() }
      }
    }
  }

  @ViewBuilder func rows(_ list: PluginList) -> some View {
    let installed = Plugins.installed(list.items)
    let available = Plugins.available(list.items)
    if list.safeMode == true {
      Section { Text("Mercury is in safe mode, so plugins are off until it restarts normally.").foregroundStyle(Theme.ink2) }
    }
    SettingsError(text: actionError)
    Section {
      if installed.isEmpty {
        Text("No plugins yet.").foregroundStyle(Theme.ink3)
      }
      ForEach(installed) { p in
        HStack(spacing: 12) {
          NavigationLink { detail(p) } label: { PluginRow(plugin: p) }
          if canManage {
            if busy.contains(p.id) { ProgressView() }
            else {
              Toggle("", isOn: Binding(get: { p.enabled }, set: { toggle(p, $0) }))
                .labelsHidden().accessibilityLabel("\(p.name) on")
            }
          }
        }
      }
    } header: { Text("Installed") } footer: {
      if !canManage { Text("To install or change plugins from your phone, update Mercury on your computer.") }
    }
    if !available.isEmpty {
      Section {
        ForEach(available) { p in
          HStack(spacing: 12) {
            NavigationLink { detail(p) } label: { PluginRow(plugin: p) }
            if canManage && p.status != "incompatible" {
              Button("Install") { action = PluginActionTarget(plugin: p, kind: .install) }
                .buttonStyle(.borderless).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 12).padding(.vertical, 6).background(Theme.surface3, in: Capsule())
            }
          }
        }
      } header: { Text("Available") } footer: {
        if let e = list.catalogError { Text("The catalog couldn't be checked: \(e)") }
      }
    }
  }

  func detail(_ p: PluginDetail) -> some View {
    PluginDetailScreen(client: client, computer: computer, plugin: p, canManage: canManage)
  }

  func toggle(_ p: PluginDetail, _ on: Bool) {
    actionError = nil
    if on { action = PluginActionTarget(plugin: p, kind: .enable); return }
    busy.insert(p.id)
    Task {
      do { _ = try await gate.run { try await client.setPluginEnabled(p.id, false, approval: $0); return true } }
      catch { actionError = Plugins.friendlyError(error.localizedDescription, plugin: p) }
      busy.remove(p.id)
      await load()
    }
  }

  func load(refresh: Bool = false) async {
    async let features = try? await client.health().features
    do {
      list = try await client.pluginList(refresh: refresh)
      error = nil
    } catch {
      if list == nil { self.error = error.localizedDescription }
    }
    canManage = Plugins.canManage(await features)
  }
}

/// A plugin's name, version or what it does, its state, and "Update available".
struct PluginRow: View {
  var plugin: PluginDetail
  var body: some View {
    HStack(spacing: 12) {
      PluginMark(name: plugin.name, size: 36)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(plugin.name).font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.ink)
          if let v = plugin.installedVersion ?? plugin.latestVersion {
            Text(v).font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.ink3)
          }
        }
        let line = Plugins.statusLine(plugin)
        if !line.text.isEmpty {
          Text(line.text).font(.system(size: 13)).lineLimit(2)
            .foregroundStyle(line.tone == .good ? Theme.ink2 : line.tone == .warn ? Theme.amber : Theme.ink3)
        }
        if Plugins.updateAvailable(plugin) {
          Text("Update available").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
            .padding(.horizontal, 8).padding(.vertical, 3).background(Theme.surface3, in: Capsule())
            .padding(.top, 2)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: One plugin

/// A plugin's page: what it is and can reach, Install or on/off, its settings, Update, Remove.
struct PluginDetailScreen: View {
  let client: MercuryClient
  let computer: String
  @State var plugin: PluginDetail
  @State var canManage: Bool
  @State var gate: OwnerGate
  @State var busy: String?
  @State var error: String?
  @State var action: PluginActionTarget?
  @State var confirmRemove = false
  @State var loadedOnce = false
  @Environment(\.dismiss) private var dismiss

  init(client: MercuryClient, computer: String, plugin: PluginDetail, canManage: Bool) {
    self.client = client; self.computer = computer
    _plugin = State(initialValue: plugin); _canManage = State(initialValue: canManage)
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var installed: Bool { Plugins.isInstalled(plugin) }

  var body: some View {
    Form {
      Section {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 14) {
            PluginMark(name: plugin.name, size: 52)
            VStack(alignment: .leading, spacing: 3) {
              Text(plugin.name).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink)
              Text(subtitle).font(.system(size: 13)).foregroundStyle(Theme.ink3)
            }
          }
          if let d = plugin.description, !d.isEmpty {
            Text(d).font(.system(size: 15)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
          }
          if installed {
            let line = Plugins.statusLine(plugin)
            StatusText(text: line.text, tone: line.tone == .good ? .good : line.tone == .warn ? .warn : .off)
          } else if plugin.status == "incompatible" {
            Text(plugin.incompatibleReason.map { Plugins.friendlyError("can't be installed here: \($0)", plugin: plugin) } ?? "It can't be installed on this computer.")
              .font(.system(size: 14)).foregroundStyle(Theme.amber)
          }
        }
        .padding(.vertical, 6)
      }
      if canManage { actions }
      Section("What it can do") {
        ForEach(Plugins.accessLines(plugin, computer: computer), id: \.self) { l in
          Text(l).font(.system(size: 15)).foregroundStyle(Theme.ink2)
        }
        if Plugins.controlsComputer(plugin) {
          Text("It asks before anything that submits, sends or deletes.").font(.system(size: 15)).foregroundStyle(Theme.ink2)
        }
      }
      if installed {
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
        if let fields = plugin.settings, !fields.isEmpty {
          PluginForm(pluginId: plugin.id, fields: fields, groups: plugin.settingGroups ?? [], gate: gate) { await load() }
        }
        if canManage {
          Section {
            Button("Uninstall \(plugin.name)", role: .destructive) { confirmRemove = true }.disabled(busy != nil)
          } footer: { Text("Its settings stay on your computer in case you install it again.") }
        }
      }
    }
    .navigationTitle(plugin.name)
    #if os(iOS)
    .navigationBarTitleDisplayMode(.inline)
    #endif
    .task { if !loadedOnce { loadedOnce = true; await load() } }
    .refreshable { await load() }
    .ownerGate(gate)
    .sheet(item: $action) { t in
      PluginActionSheet(model: PluginActionModel(client: client, plugin: t.plugin, kind: t.kind, computer: computer)) {
        Task { await load() }
      }
    }
    .confirmationDialog("Uninstall \(plugin.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
      Button("Uninstall", role: .destructive) { change("remove") { try await client.uninstallPlugin(plugin.id, approval: $0) } }
    } message: { Text("Mercury stops using it on \(computer).") }
  }

  var subtitle: String {
    var parts: [String] = []
    if let v = plugin.installedVersion { parts.append("Version \(v)") }
    else if let v = plugin.latestVersion { parts.append("Version \(v)") }
    if let t = plugin.tier { parts.append(t == "official" ? "Official" : t == "community" ? "Community" : "Local") }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder var actions: some View {
    Section {
      if !installed {
        if plugin.status != "incompatible" {
          PluginProminentButton(title: "Install \(plugin.name)") { action = PluginActionTarget(plugin: plugin, kind: .install) }
            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        }
      } else {
        HStack {
          Toggle(isOn: Binding(get: { plugin.enabled }, set: { on in
            if on { action = PluginActionTarget(plugin: plugin, kind: .enable) }
            else { change("disable") { try await client.setPluginEnabled(plugin.id, false, approval: $0) } }
          })) { Text("On") }
          .disabled(busy != nil)
        }
        if Plugins.updateAvailable(plugin) {
          Button {
            change("update") { try await client.updatePlugin(plugin.id, approval: $0) }
          } label: {
            HStack {
              Text("Update to \(plugin.latestVersion ?? "the latest version")")
              Spacer()
              if busy == "update" { ProgressView() }
            }
          }
          .disabled(busy != nil)
        }
      }
      if let error { ErrorText(text: error) }
    }
  }

  func change(_ what: String, _ run: @escaping (String?) async throws -> Void) {
    busy = what; error = nil
    Task {
      do {
        _ = try await gate.run { try await run($0); return true }
        busy = nil
        if what == "remove" { dismiss(); return }
      } catch {
        busy = nil
        self.error = Plugins.friendlyError(error.localizedDescription, plugin: plugin)
      }
      await load()
    }
  }

  func load() async {
    if let p = try? await client.plugin(plugin.id) { plugin = p }
    if !canManage { canManage = Plugins.canManage(try? await client.health().features) }
  }
}

// MARK: Snapshots

/// Snapshots: the confirm sheets, waiting for approval, installing and the results.
@MainActor
public enum PluginsGallery {
  static let client = MercuryClient(baseURL: URL(string: "http://localhost")!)

  static var optimus: PluginDetail {
    PluginDetail(id: "optimus", name: "Optimus", description: "Mercury uses your computer like a person: sees the screen, moves the mouse, types and opens apps.",
                 kind: "out-of-process", tier: "official", status: "available", latestVersion: "0.5.2",
                 permissions: PluginPermissions(network: ["api.openai.com", "api.x.ai", "generativelanguage.googleapis.com", "api.deepgram.com"], secrets: ["GEMINI_API_KEY"]))
  }

  static var weather: PluginDetail {
    PluginDetail(id: "weather", name: "Weather", description: "Forecasts and rain alerts.", kind: "in-process", tier: "community", status: "available",
                 latestVersion: "1.2.0", tools: ["weather__forecast", "weather__alerts"], permissions: PluginPermissions(network: ["api.open-meteo.com"]))
  }

  static func sheet(_ p: PluginDetail, _ kind: PluginActionModel.Kind = .install, _ f: (PluginActionModel) -> Void = { _ in }) -> AnyView {
    let m = PluginActionModel(client: client, plugin: p, kind: kind, computer: "Salman's MacBook Pro")
    f(m)
    return AnyView(VStack(spacing: 0) {
      Spacer(minLength: 0).frame(height: 120)
      PluginActionSheet(model: m, still: true)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 28, topTrailingRadius: 28))
    }
    .background(Theme.ink.opacity(0.18)))
  }

  /// The list's rows, as the Form shows them (the renderer can't draw a Form).
  static var rows: AnyView {
    var installed = weather
    installed.installedVersion = "1.1.0"; installed.enabled = true; installed.running = true; installed.status = "update-available"
    var off = PluginDetail(id: "whatsapp", name: "WhatsApp", enabled: false, installedVersion: "0.1.2", status: "disabled")
    off.disabled = nil
    return AnyView(VStack(alignment: .leading, spacing: 10) {
      Text("Installed").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink3).padding(.leading, 16)
      VStack(spacing: 0) {
        ForEach([installed, off]) { p in
          HStack {
            PluginRow(plugin: p); Spacer()
            // The renderer can't draw a Toggle: the switch, drawn.
            Capsule().fill(p.enabled ? Theme.accent : Theme.surface3).frame(width: 51, height: 31)
              .overlay(Circle().fill(p.enabled ? Theme.onAccent : Theme.bg).padding(2), alignment: p.enabled ? .trailing : .leading)
          }
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
      }
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      Text("Available").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink3).padding(.leading, 16).padding(.top, 10)
      HStack {
        PluginRow(plugin: optimus); Spacer()
        Text("Install").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
          .padding(.horizontal, 12).padding(.vertical, 6).background(Theme.surface3, in: Capsule())
      }
      .padding(.horizontal, 16).padding(.vertical, 10)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
      Spacer()
    }
    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(Theme.bg))
  }

  public static func screens() -> [(name: String, view: AnyView)] {
    [
      ("12a-plugins-list", rows),
      ("12b-plugin-confirm-optimus", sheet(optimus)),
      ("12c-plugin-confirm-other", sheet(weather)),
      ("12d-plugin-approval", sheet(optimus) { $0.gate.question = .waiting(code: "ABC123"); $0.stage = .working("Installing Optimus…") }),
      ("12e-plugin-installing", sheet(optimus) { $0.stage = .working("Installing Optimus…") }),
      ("12f-plugin-running", sheet(optimus) { $0.stage = .done(.running) }),
      ("12g-plugin-needs-desktop", sheet(optimus) {
        $0.stage = .failed(Plugins.friendlyError("Optimus can't be installed here: not available for android-arm64 (supports darwin-arm64).", plugin: optimus))
      }),
    ]
  }
}
