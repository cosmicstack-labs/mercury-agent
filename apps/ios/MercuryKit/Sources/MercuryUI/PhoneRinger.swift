import SwiftUI
import UserNotifications
import MercuryCore

/// Mercury rings and notifies this iPhone (ADR-046), over the live activity stream only:
///   - `ring` → a real incoming call on the system's call screen (CallKit), even with the app open.
///     Answer → Mercury's live voice call, which starts by saying why it called. Decline, or no
///     answer before the ring expires → reported back, so Mercury retries or falls back.
///   - `ring_end` → the ring stopped elsewhere (another phone answered, or it timed out).
///   - `notify` → a local notification (silent in the owner's quiet hours).
/// Coming back to the foreground fetches whatever was missed meanwhile and shows it.
///
/// Without PushKit, iOS can't wake Mercury: it rings while the app is open or still running in the
/// background. When it can't, Mercury tries WhatsApp (when linked) and leaves a missed call here.
@MainActor @Observable
final class PhoneRinger {
  static let shared = PhoneRinger()

  struct Prefs: Equatable {
    /// Ring this iPhone for calls from Mercury.
    var ring = true
    /// Show Mercury's notifications on this iPhone.
    var notify = true
  }

  struct Ringing: Equatable {
    var invite: RingInvite
    var uuid: UUID
  }

  var prefs: Prefs { didSet { if prefs != oldValue { save(); Task { await register() } } } }
  private(set) var ringing: Ringing?
  /// Answered: the call MainView starts (then sets back to nil).
  var answered: RingInvite?
  /// Why registering failed (shown in Settings → Calls from Mercury), or nil.
  private(set) var problem: String?

  @ObservationIgnored var presenter: IncomingCallPresenter
  /// Posts a local notification: id, title, body, chat to open, silent. Replaced in tests.
  @ObservationIgnored var post: (_ id: String, _ title: String, _ body: String, _ threadId: String?, _ silent: Bool) -> Void = PhoneRinger.deliver
  /// Tells Mercury what happened to a ring. Replaced in tests.
  @ObservationIgnored var reportOutcome: (_ id: String, _ outcome: RingOutcome) async -> Void
  @ObservationIgnored var now: () -> Date = { .now }
  @ObservationIgnored private(set) var client: MercuryClient?
  /// Rings and notifications already handled (the app has more than one activity stream open).
  @ObservationIgnored private var seen: [String] = []
  @ObservationIgnored private var expiry: Task<Void, Never>?
  @ObservationIgnored private let defaults: UserDefaults

  init(presenter: IncomingCallPresenter? = nil, defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.presenter = presenter ?? CallKitCall.shared
    var p = Prefs()
    if defaults.object(forKey: "reach.ring") != nil {
      p.ring = defaults.bool(forKey: "reach.ring")
      p.notify = defaults.bool(forKey: "reach.notify")
    }
    prefs = p
    reportOutcome = { _, _ in }
    reportOutcome = { [weak self] id, outcome in
      guard let client = self?.client else { return }
      try? await client.reportRing(id, outcome)
    }
    wirePresenter()
  }

  private func wirePresenter() {
    presenter.onIncomingAnswer = { [weak self] uuid in self?.answeredHere(uuid) }
    presenter.onIncomingDecline = { [weak self] uuid in self?.declinedHere(uuid) }
  }

  private func save() {
    defaults.set(prefs.ring, forKey: "reach.ring")
    defaults.set(prefs.notify, forKey: "reach.notify")
  }

  // MARK: The connection

  /// The Mercury this phone talks to: tells it how to reach this phone, and catches up on what was missed.
  func connect(_ client: MercuryClient) async {
    self.client = client
    await register()
    await catchUp()
  }

  func register() async {
    guard let client else { return }
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    do {
      try await client.registerReach(ring: prefs.ring, notify: prefs.notify, appVersion: build.map { "\(version) (\($0))" } ?? version, capabilities: ["callkit"])
      problem = nil
    } catch MercuryError.server(404, _) {
      problem = "Your Mercury is too old to call this phone. Update Mercury on your computer."
    } catch MercuryError.server(403, _) {
      // Signed in without a device token: nothing to register.
      problem = "This phone isn't paired with a device token, so Mercury can't call it. Pair it again from Mercury Desktop."
    } catch {
      problem = error.localizedDescription
    }
  }

  /// What came while no phone was connected: shown as notifications, then acknowledged.
  func catchUp() async {
    guard let client, let items = try? await client.missed(), !items.isEmpty else { return }
    for item in items where !seen.contains(item.id) {
      remember(item.id)
      post(item.id, item.title, item.body, item.threadId, false)
    }
    try? await client.ackMissed(items.map(\.id))
  }

  // MARK: Events

  func handle(_ event: ReachEvent) {
    switch event {
    case .ring(let invite): ring(invite)
    case .ringEnd(let id, let outcome): ended(id, outcome)
    case .notify(let n):
      guard !seen.contains(n.id) else { return }
      remember(n.id)
      if prefs.notify { post(n.id, n.title, n.body, n.threadId, n.silent) }
    }
  }

  func ring(_ invite: RingInvite) {
    guard !seen.contains(invite.id) else { return }
    remember(invite.id)
    if let exp = invite.expiresAt, exp <= now() { return }
    // Off on this phone, or already on a call (or ringing): this phone doesn't take it.
    guard prefs.ring, ringing == nil, !presenter.inCall else {
      Task { await reportOutcome(invite.id, .missed) }
      return
    }
    let r = Ringing(invite: invite, uuid: UUID())
    ringing = r
    Task {
      do {
        try await presenter.reportIncoming(r.uuid, caller: invite.caller.isEmpty ? "Mercury" : invite.caller)
      } catch {
        // iOS wouldn't show it (Focus, another call): a missed call, and Mercury moves on.
        if ringing?.uuid == r.uuid { ringing = nil }
        post("missed-\(invite.id)", "Missed call from Mercury", invite.reason, nil, false)
        await reportOutcome(invite.id, .missed)
        return
      }
      expire(r)
    }
  }

  /// Stops ringing when the invite runs out, if nothing else stopped it first.
  private func expire(_ r: Ringing) {
    expiry?.cancel()
    let wait = max(1, (r.invite.expiresAt ?? now().addingTimeInterval(45)).timeIntervalSince(now()))
    expiry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(wait))
      guard !Task.isCancelled else { return }
      self?.timedOut(r)
    }
  }

  func timedOut(_ r: Ringing) {
    guard ringing?.uuid == r.uuid else { return }
    ringing = nil
    presenter.endIncoming(r.uuid, .unanswered)
    post("missed-\(r.invite.id)", "Missed call from Mercury", r.invite.reason, nil, false)
    Task { await reportOutcome(r.invite.id, .missed) }
  }

  private func ended(_ id: String, _ outcome: String) {
    guard let r = ringing, r.invite.id == id else { return }
    ringing = nil
    expiry?.cancel()
    presenter.endIncoming(r.uuid, outcome == "answered_elsewhere" ? .answeredElsewhere : outcome == "declined" ? .declinedElsewhere : .unanswered)
  }

  private func answeredHere(_ uuid: UUID) {
    guard let r = ringing, r.uuid == uuid else { return }
    ringing = nil
    expiry?.cancel()
    answered = r.invite
    Task { await reportOutcome(r.invite.id, .answered) }
  }

  private func declinedHere(_ uuid: UUID) {
    guard let r = ringing, r.uuid == uuid else { return }
    ringing = nil
    expiry?.cancel()
    Task { await reportOutcome(r.invite.id, .declined) }
  }

  private func remember(_ id: String) {
    seen.append(id)
    if seen.count > 200 { seen.removeFirst(seen.count - 200) }
  }

  // MARK: The system

  static func deliver(_ id: String, _ title: String, _ body: String, _ threadId: String?, _ silent: Bool) {
    guard Notifier.available else { return }
    let c = UNMutableNotificationContent()
    c.title = title
    c.body = body
    c.sound = silent ? nil : .default
    c.threadIdentifier = threadId ?? "mercury-reach"
    if let threadId { c.userInfo = ["sessionId": threadId] }
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
}

/// Settings → Calls from Mercury: whether Mercury may ring this iPhone, quiet hours, a test ring.
struct CallsSettings: View {
  var client: MercuryClient
  @State var ringer = PhoneRinger.shared
  @State var settings: ReachSettings?
  @State var error: String?
  @State var testing = false
  @State var tested: String?

  var body: some View {
    Form {
      Section {
        Toggle("Ring this iPhone", isOn: $ringer.prefs.ring)
        Toggle("Show Mercury's notifications", isOn: $ringer.prefs.notify)
        Button {
          Task { await test() }
        } label: {
          HStack { Text("Test ring"); Spacer(); if testing { ProgressView() } }
        }
        .disabled(testing || !ringer.prefs.ring)
        if let tested { Text(tested).font(.footnote).foregroundStyle(Theme.ink2) }
        if let problem = ringer.problem { Text(problem).font(.footnote).foregroundStyle(Theme.red) }
      } footer: {
        Text("Mercury rings this iPhone while the app is open or still running in the background. When it can't, it tries WhatsApp (if linked), then leaves a missed call you'll see when you open Mercury.")
      }
      if let s = settings {
        Section {
          Toggle("Calls from Mercury", isOn: bind(\.calls, s))
          Toggle("Quiet hours", isOn: bind(\.quietHours, s))
          if s.quietHours {
            DatePicker("From", selection: time(\.quietStart, s), displayedComponents: .hourAndMinute)
            DatePicker("Until", selection: time(\.quietEnd, s), displayedComponents: .hourAndMinute)
          }
        } header: { Text("All your phones") } footer: {
          Text("In quiet hours only urgent calls ring; notifications arrive silently. At most \(s.maxCallsPerHour) calls an hour.")
        }
      }
      if let error { Section { Text(error).foregroundStyle(Theme.red) } }
    }
    .navigationTitle("Calls from Mercury")
    .task { await load() }
  }

  func load() async {
    do { settings = try await client.reachSettings(); error = nil } catch { self.error = error.localizedDescription }
  }

  func test() async {
    testing = true
    defer { testing = false }
    do { try await client.testRing(); tested = "Ringing…" } catch { tested = error.localizedDescription }
  }

  func save(_ s: ReachSettings) {
    settings = s
    Task {
      do { settings = try await client.updateReachSettings(s); error = nil } catch { self.error = error.localizedDescription }
    }
  }

  func bind(_ key: WritableKeyPath<ReachSettings, Bool>, _ s: ReachSettings) -> Binding<Bool> {
    Binding(get: { settings?[keyPath: key] ?? s[keyPath: key] }, set: { v in var n = settings ?? s; n[keyPath: key] = v; save(n) })
  }

  /// "HH:MM" as a time of day for the picker (today's date; only hour and minute count).
  func time(_ key: WritableKeyPath<ReachSettings, String>, _ s: ReachSettings) -> Binding<Date> {
    Binding(
      get: { Self.date(settings?[keyPath: key] ?? s[keyPath: key]) },
      set: { d in var n = settings ?? s; n[keyPath: key] = Self.hhmm(d); save(n) }
    )
  }

  static func date(_ hhmm: String) -> Date {
    let p = hhmm.split(separator: ":").compactMap { Int($0) }
    return Calendar.current.date(bySettingHour: p.first ?? 0, minute: p.count > 1 ? p[1] : 0, second: 0, of: .now) ?? .now
  }

  static func hhmm(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
  }
}
