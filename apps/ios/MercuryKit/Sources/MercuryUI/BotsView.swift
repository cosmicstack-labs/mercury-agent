import SwiftUI
import MercuryCore

/// Bots: every bot and fleet on this Mercury, with what each is doing now. A fleet opens to all of
/// its members together; a bot to itself. Each opens on Live (what it's doing as it happens, and a
/// box to talk to it), with its Inbox and History beside it.
///
/// Put it in a NavigationStack, as the other tabs are: `NavigationStack { BotsView(client: client) }`.
public struct BotsView: View {
  @State var model: BotsModel

  public init(client: MercuryClient) { _model = State(initialValue: BotsModel(client: client)) }
  init(model: BotsModel) { _model = State(initialValue: model) }

  public var body: some View {
    ScrollView {
      BotsList(model: model).padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 24)
    }
    .background(Theme.bg)
    .overlay {
      if !model.loaded { ProgressView() }
    }
    .navigationTitle("Bots")
    .refreshable { await model.load() }
    .task { await model.load() }
    .onAppear { model.appeared() }
    .onDisappear { model.disappeared() }
  }
}

/// The roster: the inbox, then fleets (lead with its crew), then bots on their own.
struct BotsList: View {
  var model: BotsModel

  var body: some View {
    let (fleets, solo) = model.layout
    LazyVStack(alignment: .leading, spacing: 0) {
      if let e = model.error, model.bots.isEmpty { ErrorText(text: e).padding(.vertical, 12) }
      if !model.available {
        BotsEmpty(title: "Bots are off on this Mercury", text: "Turn bots on in Mercury's settings on your computer to see them here.")
      } else if model.loaded && model.bots.isEmpty && model.error == nil {
        BotsEmpty(title: "No bots yet", text: "Make a bot in Mercury Desktop. It shows up here, and you can watch it work and talk to it from your phone.")
      } else {
        NavigationLink { BotsInboxScreen(model: model) } label: {
          InboxRow(unread: model.unread, asking: model.approvals.count)
        }
        .buttonStyle(Pressable())
        .padding(.bottom, 8)

        if !fleets.isEmpty { BotsSectionTitle(text: "Fleets") }
        ForEach(fleets) { f in
          NavigationLink { BotDetail(model: model, leadId: f.lead.id) } label: {
            BotRow(bot: f.lead, subtitle: Self.fleetLine(f), subtitleColor: f.lead.needsYou ? Theme.amber : Theme.ink3,
                   needsYou: f.lead.needsYou || f.crew.contains(where: \.needsYou), size: 40, client: model.client)
          }
          .buttonStyle(Pressable())
          VStack(alignment: .leading, spacing: 0) {
            ForEach(f.crew) { b in
              NavigationLink { BotDetail(model: model, leadId: b.id) } label: {
                BotRow(bot: b, subtitle: Self.line(b, model.activity[b.id]), subtitleColor: Self.lineColor(b), needsYou: b.needsYou, size: 30, client: model.client)
              }
              .buttonStyle(Pressable())
            }
          }
          .padding(.leading, 12)
          .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).padding(.vertical, 6) }
          .padding(.leading, 19).padding(.bottom, 10)
        }

        if !solo.isEmpty { BotsSectionTitle(text: fleets.isEmpty ? "Your bots" : "On their own") }
        ForEach(solo) { b in
          NavigationLink { BotDetail(model: model, leadId: b.id) } label: {
            BotRow(bot: b, subtitle: Self.line(b, model.activity[b.id]), subtitleColor: Self.lineColor(b), needsYou: b.needsYou, size: 40, client: model.client)
          }
          .buttonStyle(Pressable())
        }
      }
    }
  }

  static func fleetLine(_ f: BotFleet) -> String {
    var s = "Fleet · \(f.crew.count) crew"
    if f.working > 0 { s += " · \(f.working) working" }
    if f.members.contains(where: \.needsYou) { s += " · waiting for you" }
    if f.lead.stopped == true { s += " · stopped" }
    return s
  }

  /// What a bot is doing, in a few words: its current step when working.
  static func line(_ b: BotStatus, _ activity: String?) -> String {
    if b.needsYou { return "Waiting for you" }
    if b.stopped == true { return "Stopped" }
    if !b.enabled || b.state == "disabled" { return "Off" }
    switch b.state {
    case "running": return activity.map { "Working · \($0)" } ?? b.activity.map { "Working · \($0)" } ?? "Working"
    case "queued": return "Queued"
    case "paused": return "Paused"
    default: return b.description.flatMap { $0.isEmpty ? nil : $0 } ?? "Idle"
    }
  }

  static func lineColor(_ b: BotStatus) -> Color {
    b.needsYou ? Theme.amber : b.isRunning ? Theme.accent : Theme.ink3
  }
}

struct BotRow: View {
  var bot: BotStatus
  var subtitle: String
  var subtitleColor: Color = Theme.ink3
  var needsYou = false
  var size: CGFloat = 40
  var client: MercuryClient?

  var body: some View {
    HStack(spacing: 12) {
      BotAvatar(id: bot.id, name: bot.name, hasAvatar: bot.hasAvatar == true, size: size, dimmed: bot.isOff, client: client)
        .overlay(alignment: .bottomTrailing) {
          if let dot = Self.dot(bot, needsYou: needsYou) {
            Circle().fill(dot).frame(width: 10, height: 10).overlay(Circle().stroke(Theme.bg, lineWidth: 2)).offset(x: 2, y: 2)
          }
        }
      VStack(alignment: .leading, spacing: 2) {
        Text(bot.name).font(.system(size: size > 34 ? 16 : 15, weight: size > 34 ? .semibold : .regular)).foregroundStyle(Theme.ink).lineLimit(1)
        Text(subtitle).font(.system(size: 13)).foregroundStyle(subtitleColor).lineLimit(1)
      }
      Spacer(minLength: 4)
      if let n = bot.unread, n > 0 { CountBadge(n: n) }
      Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink4)
    }
    .padding(.vertical, 8)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  static func dot(_ b: BotStatus, needsYou: Bool) -> Color? {
    if needsYou { return Theme.amber }
    if b.isRunning { return Theme.accent }
    return nil
  }
}

struct InboxRow: View {
  var unread: Int
  var asking: Int
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "tray").font(.system(size: 16)).foregroundStyle(Theme.ink2)
        .frame(width: 40, height: 40).background(Theme.surface2, in: Circle())
      VStack(alignment: .leading, spacing: 2) {
        Text("Inbox").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
        Text(asking > 0 ? "\(asking) question\(asking == 1 ? "" : "s") waiting for you" : "Results, problems and questions")
          .font(.system(size: 13)).foregroundStyle(asking > 0 ? Theme.amber : Theme.ink3).lineLimit(1)
      }
      Spacer(minLength: 4)
      if unread > 0 { CountBadge(n: unread) }
      Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink4)
    }
    .padding(12)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
    .contentShape(Rectangle())
  }
}

// MARK: - One bot or fleet

/// A bot, or a whole fleet when `leadId` is a lead: Live, Inbox and History.
struct BotDetail: View {
  var model: BotsModel
  var leadId: String
  @State var tab: Tab = .live

  enum Tab: String, CaseIterable { case live = "Live", inbox = "Inbox", history = "History" }

  /// The fleet's members (lead first), or just the bot.
  var members: [BotStatus] {
    if let f = model.layout.fleets.first(where: { $0.lead.id == leadId }) { return f.members }
    return model.bot(leadId).map { [$0] } ?? []
  }

  var body: some View {
    let members = members
    let ids = members.map(\.id)
    VStack(spacing: 0) {
      BotsTabs(selection: $tab).padding(.horizontal, 16).padding(.bottom, 6)
      switch tab {
      case .live: LiveFeed(model: model, members: members, leadId: leadId)
      case .inbox: BotsInboxList(model: model, botIds: ids)
      case .history: BotsHistory(model: model, members: members)
      }
    }
    .background(Theme.bg)
    .navigationTitle(model.bot(leadId)?.name ?? "Bot")
    #if os(iOS)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    #endif
    .onAppear { model.appeared() }
    .onDisappear { model.disappeared() }
  }
}

/// Live · Inbox · History.
struct BotsTabs<T: Hashable & RawRepresentable & CaseIterable>: View where T.RawValue == String, T.AllCases: RandomAccessCollection {
  @Binding var selection: T
  var body: some View {
    HStack(spacing: 2) {
      ForEach(Array(T.allCases), id: \.self) { t in
        Button { selection = t } label: {
          Text(t.rawValue).font(.system(size: 14, weight: .medium))
            .foregroundStyle(selection == t ? Theme.ink : Theme.ink3)
            .frame(maxWidth: .infinity, minHeight: 32)
            .background(selection == t ? Theme.surface : .clear, in: RoundedRectangle(cornerRadius: 9))
            .shadow(color: selection == t ? .black.opacity(0.06) : .clear, radius: 2, y: 1)
        }
        .buttonStyle(Pressable())
      }
    }
    .padding(3)
    .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 11))
  }
}

// MARK: - Small pieces

/// A press that only dims: the label keeps its own look.
struct Pressable: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.6 : 1)
  }
}

struct CountBadge: View {
  var n: Int
  var body: some View {
    Text("\(n)").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.onAccent)
      .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 20)
      .background(Theme.accent, in: Capsule())
      .accessibilityLabel("\(n) unread")
  }
}

struct BotsSectionTitle: View {
  var text: String
  var body: some View {
    Text(text.uppercased()).font(.system(size: 12, weight: .semibold)).tracking(0.6).foregroundStyle(Theme.ink4)
      .padding(.top, 14).padding(.bottom, 4)
  }
}

struct BotsEmpty: View {
  var title: String
  var text: String
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "person.2.wave.2").font(.system(size: 30)).foregroundStyle(Theme.ink3)
      Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink)
      Text(text).font(.system(size: 14)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center).frame(maxWidth: 290)
    }
    .frame(maxWidth: .infinity).padding(.vertical, 60)
  }
}

/// A small spinning arc (drawn, so it shows in snapshots too).
struct Spinner: View {
  var size: CGFloat = 12
  var color: Color = Theme.accent
  @State var on = false
  var body: some View {
    Circle().trim(from: 0, to: 0.72)
      .stroke(color, style: StrokeStyle(lineWidth: max(1.5, size / 7), lineCap: .round))
      .frame(width: size, height: size)
      .rotationEffect(.degrees(on ? 360 : 0))
      .animation(.linear(duration: 0.9).repeatForever(autoreverses: false), value: on)
      .onAppear { on = true }
  }
}

/// A state, in words, on a soft tint of its colour.
struct StateBadge: View {
  var text: String
  var color: Color
  var spinning = false
  var body: some View {
    HStack(spacing: 4) {
      if spinning { Spinner(size: 9, color: color) }
      Text(text).font(.system(size: 12, weight: .medium))
    }
    .foregroundStyle(color)
    .padding(.horizontal, 8).padding(.vertical, 3)
    .background(color.opacity(0.13), in: Capsule())
  }
}
