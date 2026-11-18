import SwiftUI
import UserNotifications
import MercuryCore

/// Tells you when Mercury needs an answer, finishes a long task, or fails, from the live
/// activity stream (as Mercury Desktop's notifications do). This phone's own choice; it
/// works while the app is open or was just in use, since iOS pauses apps in the background.
@MainActor @Observable
final class Notifier {
  struct Prefs: Equatable {
    var needsYou = true
    var finished = true
    var failed = true
    /// A finished task only counts when it ran at least this long.
    var after: Double = 30
  }

  static let shared = Notifier()

  var prefs: Prefs { didSet { save() } }
  /// The chat on screen: nothing is announced for it.
  var viewing: String?
  /// A notification was tapped: the chat to open.
  var open: String?
  private var startedAt: [String: Date] = [:]
  private var listener: Task<Void, Never>?
  private let defaults: UserDefaults
  /// How a notification goes out; replaced in tests.
  var post: (_ id: String, _ title: String, _ body: String) -> Void = Notifier.deliver

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    var p = Prefs()
    if defaults.object(forKey: "notify.needsYou") != nil {
      p.needsYou = defaults.bool(forKey: "notify.needsYou")
      p.finished = defaults.bool(forKey: "notify.finished")
      p.failed = defaults.bool(forKey: "notify.failed")
      p.after = defaults.double(forKey: "notify.after")
    }
    prefs = p
  }

  private func save() {
    defaults.set(prefs.needsYou, forKey: "notify.needsYou")
    defaults.set(prefs.finished, forKey: "notify.finished")
    defaults.set(prefs.failed, forKey: "notify.failed")
    defaults.set(prefs.after, forKey: "notify.after")
  }

  /// Follows one Mercury's activity until `stop` (or the next `start`).
  func start(_ client: MercuryClient) {
    listener?.cancel()
    Self.installDelegate()
    listener = Task {
      for await e in client.events("/api/chat/activity") {
        // Mercury ringing or notifying this phone (ADR-046) comes on the same stream.
        if e.name != "activity" {
          if let r = ReachEvent.parse(name: e.name, data: e.data) { PhoneRinger.shared.handle(r) }
          continue
        }
        guard let data = e.data.data(using: .utf8), let a = try? JSONDecoder().decode(ActivityEvent.self, from: data) else { continue }
        handle(a)
      }
    }
  }

  func stop() { listener?.cancel(); listener = nil }

  func handle(_ a: ActivityEvent, now: Date = .now) {
    let title = a.title?.isEmpty == false ? a.title! : "Mercury"
    switch a.kind {
    case .started, .research:
      if startedAt[a.sessionId] == nil { startedAt[a.sessionId] = now }
    case .needs_you:
      if prefs.needsYou && viewing != a.sessionId { post(a.sessionId, "Mercury needs you", "\(title): \(a.prompt ?? "waiting for your answer")") }
    case .done:
      let ran = startedAt.removeValue(forKey: a.sessionId).map { now.timeIntervalSince($0) } ?? 0
      if prefs.finished && ran >= prefs.after && viewing != a.sessionId { post(a.sessionId, "Done", "\(title)\(a.message.map { ": \($0)" } ?? "")") }
    case .failed:
      startedAt[a.sessionId] = nil
      if prefs.failed && viewing != a.sessionId { post(a.sessionId, "Something went wrong", "\(title)\(a.message.map { ": \($0)" } ?? "")") }
    case .resolved: break
    case .stopped: startedAt[a.sessionId] = nil
    }
  }

  // MARK: The system

  /// Only inside the app: a test or tool process has no bundle to post from.
  static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }

  static func deliver(_ id: String, _ title: String, _ body: String) {
    guard available else { return }
    let c = UNMutableNotificationContent()
    c.title = title
    c.body = body
    c.sound = .default
    c.threadIdentifier = id
    c.userInfo = ["sessionId": id]
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
  }

  static func authorization() async -> UNAuthorizationStatus {
    guard available else { return .notDetermined }
    return await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
  }

  static func ask() async -> Bool {
    guard available else { return false }
    return (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
  }

  private static let delegate = Delegate()
  static func installDelegate() {
    guard available else { return }
    UNUserNotificationCenter.current().delegate = delegate
  }

  final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    /// Show it even with the app open (the chat on screen was already skipped).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
      [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
      let id = response.notification.request.content.userInfo["sessionId"] as? String
      await MainActor.run { Notifier.shared.open = id }
    }
  }
}

/// Notifications: what this phone tells you about, and whether iOS lets it.
struct NotificationsSettings: View {
  @State var notifier = Notifier.shared
  @State var status: UNAuthorizationStatus = .notDetermined
  @Environment(\.openURL) var openURL

  static let after: [(Double, String)] = [(10, "10 s"), (30, "30 s"), (60, "1 min"), (120, "2 min"), (300, "5 min")]

  var body: some View {
    Form {
      Section {
        switch status {
        case .authorized, .provisional, .ephemeral:
          Label("On", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.accent)
        case .denied:
          VStack(alignment: .leading, spacing: 8) {
            Text("Notifications are off for Mercury in iOS Settings.").foregroundStyle(Theme.ink2)
            #if os(iOS)
            Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) } }
            #endif
          }
        default:
          Button("Turn on notifications") { Task { _ = await Notifier.ask(); status = await Notifier.authorization() } }
        }
      } footer: {
        Text("They arrive while Mercury is open or was just in use.")
      }
      Section("Tell me when") {
        Toggle("Mercury needs an answer", isOn: $notifier.prefs.needsYou)
        Toggle("A long task finishes", isOn: $notifier.prefs.finished)
        if notifier.prefs.finished {
          Picker("Long means over", selection: $notifier.prefs.after) {
            ForEach(Self.after, id: \.0) { Text($0.1).tag($0.0) }
          }
        }
        Toggle("Something fails", isOn: $notifier.prefs.failed)
      }
    }
    .navigationTitle("Notifications")
    .task { status = await Notifier.authorization() }
  }
}
