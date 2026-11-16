import SwiftUI
import MercuryCore

/// Channels: the places people talk to Mercury besides this app, and who may
/// (apps/desktop/src/views/settings/Channels.tsx).
struct ChannelsSettings: View {
  let client: MercuryClient
  @State var channels: [ChannelInfo] = []
  @State var loaded = false
  @State var error: String?
  @State var gate: OwnerGate

  init(client: MercuryClient) {
    self.client = client
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var waiting: Int { channels.reduce(0) { $0 + $1.access.pending.count } }

  var body: some View {
    List {
      SettingsError(text: error)
      if waiting > 0 {
        Label("\(waiting) \(waiting == 1 ? "person is" : "people are") waiting for your approval", systemImage: "person.badge.clock")
          .foregroundStyle(Theme.amber)
      }
      Section {
        ForEach(channels) { c in
          NavigationLink { ChannelDetail(client: client, channel: c, gate: gate) { await load() } } label: { ChannelRow(channel: c) }
        }
      } footer: {
        Text("WhatsApp is a plugin: set it up in Plugins on your computer.")
      }
    }
    .overlay { if !loaded { ProgressView() } }
    .navigationTitle("Channels")
    .task {
      // Requests arrive while you look: keep the lists fresh.
      while !Task.isCancelled {
        await load()
        try? await Task.sleep(for: .seconds(6))
      }
    }
    .refreshable { await load() }
    .ownerGate(gate)
  }

  func load() async {
    do { channels = try await client.channels(); error = nil }
    catch { self.error = error.localizedDescription }
    loaded = true
  }
}

struct ChannelRow: View {
  var channel: ChannelInfo
  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 3) {
        Text(channel.label).font(.system(size: 16))
        if channel.running { StatusText(text: "Running", tone: .good) }
        else if !channel.configured { StatusText(text: "Not set up", tone: .off) }
        else if channel.enabled { StatusText(text: "Not connected", tone: .warn) }
        else { StatusText(text: "Off", tone: .off) }
      }
      Spacer()
      if !channel.access.pending.isEmpty {
        Text("\(channel.access.pending.count)").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
          .padding(.horizontal, 8).padding(.vertical, 3).background(Theme.amber, in: Capsule())
          .accessibilityLabel("\(channel.access.pending.count) waiting")
      }
    }
  }
}

/// What a channel needs to connect (the same fields Mercury Desktop asks for).
struct ChannelField {
  var key: String
  var label: String
  var secret = false
  var optional = false
  var placeholder: String
  var hint: String

  static let all: [String: [ChannelField]] = [
    "telegram": [.init(key: "botToken", label: "Bot token", secret: true, placeholder: "123456789:AAE…", hint: "In Telegram, message @BotFather: /newbot (or /token for an existing bot), then paste the token.")],
    "discord": [
      .init(key: "botToken", label: "Bot token", secret: true, placeholder: "MTIz…", hint: "Developer Portal → your application → Bot → Reset Token. Turn on Message Content Intent there too."),
      .init(key: "guildId", label: "Server ID", optional: true, placeholder: "123456789012345678", hint: "Only answer in this server."),
      .init(key: "channelId", label: "Channel ID", optional: true, placeholder: "123456789012345678", hint: "Only answer in this channel. Leave empty for any channel the bot can see."),
      .init(key: "adminRoleName", label: "Admin role", optional: true, placeholder: "Mercury Admin", hint: "Members with this role (or server admins) can approve people from Discord."),
    ],
    "slack": [
      .init(key: "botToken", label: "Bot token", secret: true, placeholder: "xoxb-…", hint: "Your Slack app → OAuth & Permissions → Bot User OAuth Token."),
      .init(key: "appToken", label: "App-level token", secret: true, placeholder: "xapp-…", hint: "Basic Information → App-Level Tokens, with connections:write. Turn on Socket Mode."),
      .init(key: "channelId", label: "Channel ID", optional: true, placeholder: "C0123456789", hint: "Only answer mentions in this channel."),
    ],
    "signal": [
      .init(key: "phoneNumber", label: "Phone number", placeholder: "+923001234567", hint: "The Signal account Mercury uses, with country code. Link it on your computer."),
      .init(key: "groupName", label: "Group name", optional: true, placeholder: "Mercury", hint: "Group mode: Mercury answers in the Signal group with this name."),
    ],
  ]

  static let howToJoin: [String: String] = [
    "telegram": "People open your bot in Telegram and send /start. Their request shows up here.",
    "discord": "People talk to Mercury in the channel you set, or DM the bot /start; requests show up here.",
    "slack": "People DM the Mercury app /start (the first person becomes the admin). Later requests show up here.",
    "signal": "In group mode, people send /pair in the group. In private mode, only you can talk to it.",
  ]
}

struct ChannelDetail: View {
  let client: MercuryClient
  @State var channel: ChannelInfo
  var gate: OwnerGate
  var changed: () async -> Void
  @State var draft: [String: String] = [:]
  @State var busy = false
  @State var note: (text: String, ok: Bool)?
  @State var error: String?

  init(client: MercuryClient, channel: ChannelInfo, gate: OwnerGate, changed: @escaping () async -> Void) {
    self.client = client; self.gate = gate; self.changed = changed
    _channel = State(initialValue: channel)
  }

  var fields: [ChannelField] { ChannelField.all[channel.type] ?? [] }

  func saved(_ f: ChannelField) -> String {
    channel.settings[f.key]?.text ?? ""
  }

  var body: some View {
    Form {
      Section {
        Toggle("On", isOn: Binding(get: { channel.enabled }, set: { v in Task { await save(["enabled": v]) } }))
          .disabled(!channel.configured || busy)
      } footer: { Text(ChannelField.howToJoin[channel.type] ?? "") }

      Section("Connection") {
        ForEach(fields, id: \.key) { f in
          VStack(alignment: .leading, spacing: 4) {
            Text(f.label + (f.optional ? " (optional)" : "")).font(.system(size: 13)).foregroundStyle(Theme.ink2)
            Group {
              if f.secret {
                SecureField(saved(f).isEmpty ? f.placeholder : saved(f), text: binding(f))
              } else {
                TextField(f.placeholder, text: binding(f))
              }
            }
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            Text(f.hint).font(.system(size: 12)).foregroundStyle(Theme.ink3)
          }
        }
        Button(busy ? "Checking…" : "Check and save") { Task { await checkAndSave() } }
          .disabled(busy || draft.values.allSatisfy(\.isEmpty))
        if let note { StatusText(text: note.text, tone: note.ok ? .good : .warn) }
      }

      if !channel.access.pending.isEmpty {
        Section("Waiting for you") {
          ForEach(channel.access.pending) { p in
            VStack(alignment: .leading, spacing: 8) {
              PersonLine(person: p)
              HStack {
                Button("Let in") { Task { await access("approve", p) } }.buttonStyle(.borderedProminent).tint(Theme.accent)
                Button("Decline", role: .destructive) { Task { await access("reject", p) } }.buttonStyle(.bordered)
              }
            }
          }
        }
      }
      people("Admins", channel.access.admins, swap: ("Make member", "demote"))
      people("Members", channel.access.members, swap: ("Make admin", "promote"))
      SettingsError(text: error)
    }
    .navigationTitle(channel.label)
  }

  @ViewBuilder func people(_ title: String, _ list: [ChannelPerson], swap: (label: String, action: String)) -> some View {
    if !list.isEmpty {
      Section(title) {
        ForEach(list) { p in
          PersonLine(person: p)
            .swipeActions {
              Button("Remove", role: .destructive) { Task { await access("remove", p) } }
              Button(swap.label) { Task { await access(swap.action, p) } }.tint(Theme.ink3)
            }
        }
      }
    }
  }

  func binding(_ f: ChannelField) -> Binding<String> {
    Binding(get: { draft[f.key] ?? (f.secret ? "" : saved(f)) }, set: { draft[f.key] = $0 })
  }

  func checkAndSave() async {
    busy = true; defer { busy = false }
    let patch = draft.filter { !$0.value.isEmpty }
    do {
      let c = try await client.checkChannel(channel.type, draft: patch)
      guard c.ok else { note = (c.message, false); return }
      await save(patch.mapValues { $0 as Any })
      note = (c.identity.map { "Connected as \($0)" } ?? c.message, true)
      draft = [:]
    } catch { self.error = error.localizedDescription }
  }

  func save(_ patch: [String: Any]) async {
    do { channel = try await gate.run { try await client.saveChannel(channel.type, patch: patch, approval: $0) }; error = nil; await changed() }
    catch { self.error = error.localizedDescription }
  }

  func access(_ action: String, _ p: ChannelPerson) async {
    do { channel = try await gate.run { try await client.channelAccess(channel.type, action: action, id: p.id, approval: $0) }; error = nil; await changed() }
    catch { self.error = error.localizedDescription }
  }
}

struct PersonLine: View {
  var person: ChannelPerson
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(person.name).font(.system(size: 15))
      if let d = person.detail ?? person.code { Text(d).font(.system(size: 12)).foregroundStyle(Theme.ink3) }
    }
  }
}
