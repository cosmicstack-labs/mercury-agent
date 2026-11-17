import SwiftUI
import MercuryCore

/// Screen 7: the Mercury this phone is connected to, its settings, the others it knows, and about.
struct MoreView: View {
  var store: ConnectionStore
  var connection: Connection
  @State var health: Health?
  @State var healthError: String?
  @State var adding = false
  @State var confirmDisconnect = false
  @State var editing: Connection?

  var body: some View {
    List {
      Section {
        Button { editing = connection } label: {
          HStack(spacing: 12) {
            LogoBadge(id: connection.logoId, size: 44)
            VStack(alignment: .leading, spacing: 2) {
              Text(connection.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
              Text(statusLine).font(.system(size: 13)).foregroundStyle(healthError == nil ? Theme.ink2 : Theme.red).lineLimit(2)
            }
            Spacer(minLength: 0)
            Circle().fill(healthError == nil && health != nil ? Theme.green : Theme.ink4).frame(width: 9, height: 9)
            Image(systemName: "pencil").font(.system(size: 14)).foregroundStyle(Theme.ink3)
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Rename it or pick its logo")
        LabeledContent("Address", value: connection.baseURL.absoluteString)
        Button("Disconnect this phone", role: .destructive) { confirmDisconnect = true }
      } header: { Text("Connected to") }

      Section("Settings") {
        let client = store.client(for: connection)
        NavigationLink { ModelsSettings(client: client) } label: { Label("Models", systemImage: "cpu") }
        NavigationLink { VoiceSettings(client: client, computer: connection.name) } label: { Label("Voice", systemImage: "waveform") }
        NavigationLink { PluginsSettings(client: client, computer: connection.name) } label: { Label("Plugins", systemImage: "puzzlepiece.extension") }
        NavigationLink { ChannelsSettings(client: client) } label: { Label("Channels", systemImage: "bubble.left.and.bubble.right") }
        NavigationLink { AppearanceSettings() } label: { Label("Appearance", systemImage: "paintpalette") }
        NavigationLink { NotificationsSettings() } label: { Label("Notifications", systemImage: "bell") }
        NavigationLink { BudgetsSettings(client: client) } label: { Label("Budgets", systemImage: "gauge.with.dots.needle.33percent") }
        NavigationLink { ActivitySettings(client: client) } label: { Label("Activity", systemImage: "chart.bar") }
        NavigationLink { DevicesSettings(client: client) } label: { Label("Paired devices", systemImage: "iphone.and.arrow.forward") }
      }

      Section("Your Mercurys") {
        ForEach(store.connections) { c in
          Button { store.activate(c.id) } label: {
            HStack(spacing: 12) {
              LogoBadge(id: c.logoId, size: 32)
              Text(c.name).foregroundStyle(Theme.ink).lineLimit(1)
              Spacer()
              if c.id == connection.id { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
            }
          }
        }
        Button { adding = true } label: { Label("Add another Mercury", systemImage: "plus") }
      }

      Section("About") {
        LabeledContent("Mercury for iOS", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0")
        if let v = health?.version { LabeledContent("Mercury", value: v) }
        Link("Mercury website", destination: URL(string: "https://mercuryagent.sh")!)
        Link("Source on GitHub", destination: URL(string: "https://github.com/cosmicstack-labs/mercury-agent")!)
      }
    }
    .navigationTitle("Settings")
    .task(id: connection.id) {
      do { health = try await store.client(for: connection).health(); healthError = nil }
      catch { healthError = error.localizedDescription }
    }
    .sheet(isPresented: $adding) { ConnectView(store: store) }
    .sheet(item: $editing) { c in EditMercury(store: store, connection: c) }
    .onChange(of: store.connections.count) { adding = false }
    .confirmationDialog("Disconnect from \(connection.name)?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
      Button("Disconnect", role: .destructive) { Task { await store.remove(connection.id) } }
    } message: {
      Text("This phone's device token is revoked on that Mercury. You can connect again any time.")
    }
  }

  var statusLine: String {
    if let healthError { return healthError }
    guard let h = health else { return "Checking…" }
    return "Online · Mercury \(h.version ?? "")"
  }
}
