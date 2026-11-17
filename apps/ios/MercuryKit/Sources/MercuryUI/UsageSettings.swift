import SwiftUI
import MercuryCore

/// Budgets: how many tokens Mercury may use a day, when Token Saver steps in, and the
/// caps for bots. Saves apply at once (apps/desktop/src/views/settings/Budgets.tsx).
struct BudgetsSettings: View {
  let client: MercuryClient
  @State var state: BudgetState?
  @State var error: String?
  @State var gate: OwnerGate

  static let daily = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000]
  static let perBot = [50_000, 100_000, 250_000, 500_000, 1_000_000]
  static let fleet = [250_000, 500_000, 1_000_000, 2_000_000, 5_000_000]

  init(client: MercuryClient) {
    self.client = client
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var body: some View {
    Form {
      SettingsError(text: error)
      if let s = state {
        Section {
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text("Today").font(.system(size: 15, weight: .semibold))
              Spacer()
              Text("\(Tokens.short(s.daily.used)) of \(Tokens.short(s.daily.budget))").monospacedDigit().foregroundStyle(Theme.ink2)
            }
            ProgressView(value: min(Double(s.daily.used), Double(s.daily.budget)), total: Double(max(s.daily.budget, 1)))
              .tint(s.daily.percentage >= 90 ? Theme.red : s.daily.percentage >= 75 ? Theme.amber : Theme.accent)
          }
          .accessibilityElement(children: .combine)
          tokenPicker("Daily budget", s.daily.budget, Self.daily) { ["dailyBudget": $0] }
        } footer: { Text("Mercury slows down rather than stops when it runs low.") }

        Section {
          Toggle("On now", isOn: Binding(get: { s.saver.state == "on" }, set: { v in save(["saver": ["manual": v]]) }))
          Toggle("Turn on by itself", isOn: Binding(get: { s.saver.autoEnabled }, set: { v in save(["saver": ["autoEnabled": v]]) }))
          if s.saver.autoEnabled {
            Picker("When the day's budget is", selection: Binding(get: { s.saver.autoThreshold }, set: { v in save(["saver": ["autoThreshold": v]]) })) {
              ForEach([50, 75, 90], id: \.self) { Text("\($0)% used").tag($0) }
            }
          }
          LabeledContent("Saved today", value: Tokens.short(s.saver.savedToday))
        } header: { Text("Token Saver") } footer: {
          Text("Shorter context and lighter models for routine work. \(Tokens.short(s.saver.savedLifetime)) saved so far.")
        }

        Section("Bots") {
          tokenPicker("Each bot, a day", s.bots.perBot, Self.perBot) { ["bots": ["perBot": $0]] }
          tokenPicker("All bots, a day", s.bots.fleet, Self.fleet) { ["bots": ["fleet": $0]] }
        }
      } else if error == nil {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
      }
    }
    .navigationTitle("Budgets")
    .task { await load() }
    .refreshable { await load() }
    .ownerGate(gate)
  }

  func tokenPicker(_ title: String, _ value: Int, _ presets: [Int], patch: @escaping (Int) -> [String: Any]) -> some View {
    Picker(title, selection: Binding(get: { value }, set: { save(patch($0)) })) {
      ForEach(Array(Set(presets + [value])).sorted(), id: \.self) { Text(Tokens.short($0)).tag($0) }
    }
  }

  func save(_ patch: [String: Any]) {
    Task {
      do { state = try await gate.run { try await client.setBudget(patch, approval: $0) }; error = nil }
      catch { self.error = error.localizedDescription }
    }
  }

  func load() async {
    do { state = try await client.budget(); error = nil }
    catch { self.error = error.localizedDescription }
  }
}

/// Activity: half a year of token use, one square a day (darker = more), with totals
/// (apps/desktop/src/views/settings/Analytics.tsx).
struct ActivitySettings: View {
  let client: MercuryClient
  @State var days: [UsageDay]?
  @State var error: String?
  @State var picked: UsageDay?

  static let weeks = 26

  var body: some View {
    List {
      SettingsError(text: error)
      if let days {
        Section {
          HStack(spacing: 0) {
            total("Today", days.suffix(1))
            total("7 days", days.suffix(7))
            total("30 days", days.suffix(30))
          }
          .listRowInsets(EdgeInsets(top: 12, leading: 8, bottom: 12, trailing: 8))
        }
        Section {
          UsageGrid(days: days, picked: $picked)
          if let p = picked {
            Text("\(Self.dayLabel(p.date)): \(Tokens.short(p.tokens)) tokens, \(p.requests) requests")
              .font(.system(size: 13)).foregroundStyle(Theme.ink2)
          }
        } header: { Text("Last \(Self.weeks) weeks") } footer: { Text("Tap a day for its numbers.") }
      } else if error == nil {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
      }
    }
    .navigationTitle("Activity")
    .task { await load() }
    .refreshable { await load() }
  }

  func total(_ label: String, _ slice: ArraySlice<UsageDay>) -> some View {
    VStack(spacing: 4) {
      Text(Tokens.short(slice.reduce(0) { $0 + $1.tokens })).font(.system(size: 22, weight: .semibold)).monospacedDigit()
      Text(label).font(.system(size: 12)).foregroundStyle(Theme.ink3)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  func load() async {
    do { days = try await client.usageHistory(days: Self.weeks * 7); error = nil }
    catch { self.error = error.localizedDescription }
  }

  static func dayLabel(_ iso: String) -> String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
    guard let d = f.date(from: iso) else { return iso }
    return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
  }
}

/// One column per week, Monday at the top, like GitHub's contribution graph.
struct UsageGrid: View {
  var days: [UsageDay]
  @Binding var picked: UsageDay?

  var body: some View {
    let peak = max(days.map(\.tokens).max() ?? 1, 1)
    let columns = stride(from: 0, to: days.count, by: 7).map { Array(days[$0..<min($0 + 7, days.count)]) }
    HStack(alignment: .top, spacing: 3) {
      ForEach(columns.indices, id: \.self) { c in
        VStack(spacing: 3) {
          ForEach(columns[c]) { d in
            RoundedRectangle(cornerRadius: 2.5)
              .fill(d.tokens == 0 ? Theme.ink.opacity(0.07) : Theme.accent.opacity(0.25 + 0.75 * Double(d.tokens) / Double(peak)))
              .frame(width: 10, height: 10)
              .overlay(RoundedRectangle(cornerRadius: 2.5).stroke(picked == d ? Theme.ink : .clear, lineWidth: 1.5))
              .onTapGesture { picked = d }
          }
        }
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 6)
    .accessibilityElement()
    .accessibilityLabel("Token use for the last \(days.count) days")
  }
}

/// Paired devices: every phone and computer with a token for this Mercury.
struct DevicesSettings: View {
  let client: MercuryClient
  @State var devices: [PairedDevice] = []
  @State var current: String?
  @State var loaded = false
  @State var error: String?
  @State var revoking: PairedDevice?
  @State var gate: OwnerGate

  init(client: MercuryClient) {
    self.client = client
    _gate = State(initialValue: OwnerGate(client: client))
  }

  var body: some View {
    List {
      SettingsError(text: error)
      Section {
        ForEach(devices) { d in
          HStack(spacing: 12) {
            Image(systemName: Self.icon(d.platform)).foregroundStyle(Theme.ink2).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 6) {
                Text(d.name).font(.system(size: 16))
                if d.id == current { Text("This phone").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.accent) }
              }
              Text(d.lastSeenAt.map { "Last seen \(RelativeTime.short($0))" } ?? "Never used").font(.system(size: 13)).foregroundStyle(Theme.ink3)
            }
          }
          .swipeActions {
            if d.id != current { Button("Revoke", role: .destructive) { revoking = d } }
          }
        }
      } footer: {
        Text("Revoking signs a device out of this Mercury at once. To disconnect this phone, use More.")
      }
    }
    .overlay { if !loaded { ProgressView() } }
    .navigationTitle("Paired devices")
    .task { await load() }
    .refreshable { await load() }
    .confirmationDialog("Revoke \(revoking?.name ?? "")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
      Button("Revoke", role: .destructive) {
        guard let d = revoking else { return }
        Task {
          do { try await gate.run { try await client.revokeDevice(d.id, approval: $0) }; await load() }
          catch { self.error = error.localizedDescription }
        }
      }
    }
    .ownerGate(gate)
  }

  func load() async {
    do { (devices, current) = try await client.pairedDevices(); error = nil }
    catch { self.error = error.localizedDescription }
    loaded = true
  }

  static func icon(_ platform: String) -> String {
    switch platform.lowercased() {
    case "ios", "iphone": "iphone"
    case "android": "candybarphone"
    case "darwin", "macos", "mac": "laptopcomputer"
    case "windows", "win32", "linux": "desktopcomputer"
    default: "rectangle.connected.to.line.below"
    }
  }
}
