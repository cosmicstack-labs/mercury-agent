import SwiftUI
import MercuryCore

/// Voice: the voice engine and its settings, which live in the Optimus plugin
/// (apps/desktop/src/views/settings/Voice.tsx). Real-time phone calls use them too.
struct VoiceSettings: View {
  let client: MercuryClient
  @State var plugin: PluginDetail?
  @State var loaded = false
  @State var error: String?
  @State var gate: OwnerGate

  init(client: MercuryClient) {
    self.client = client
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var body: some View {
    Form {
      SettingsError(text: error)
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
      } else if loaded {
        Section {
          Text("Voice comes with the Optimus plugin. Install it on your computer (Plugins in Mercury Desktop) to talk to Mercury in real time.")
            .foregroundStyle(Theme.ink2)
        }
      } else {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
      }
    }
    .navigationTitle("Voice")
    .task { await load() }
    .refreshable { await load() }
    .ownerGate(gate)
  }

  func load() async {
    do { plugin = try await client.plugin("optimus"); error = nil }
    catch { self.error = error.localizedDescription }
    loaded = true
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
