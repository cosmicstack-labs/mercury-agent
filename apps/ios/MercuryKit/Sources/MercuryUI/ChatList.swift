import Foundation
import MercuryCore

/// The chat list's sections, as Mercury Desktop groups them (ThreadList.tsx `groupByDay`):
/// Today, Yesterday, Previous 7 days, Previous 30 days, Older. Counted in calendar days, so a
/// chat from 11 pm is "Yesterday" at 1 am.
enum ChatSections {
  struct Section: Equatable { var title: String; var threads: [ChatThread] }

  static func title(_ d: Date, now: Date = .now, calendar: Calendar = .current) -> String {
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: d), to: calendar.startOfDay(for: now)).day ?? 0
    switch days {
    case ...0: return "Today"
    case 1: return "Yesterday"
    case 2..<7: return "Previous 7 days"
    case 7..<30: return "Previous 30 days"
    default: return "Older"
    }
  }

  /// Threads in the order given, cut into day sections (in order of first appearance).
  static func byDay(_ threads: [ChatThread], now: Date = .now, calendar: Calendar = .current) -> [Section] {
    var out: [Section] = []
    for t in threads {
      let key = title(t.lastActivity, now: now, calendar: calendar)
      if let i = out.firstIndex(where: { $0.title == key }) { out[i].threads.append(t) }
      else { out.append(Section(title: key, threads: [t])) }
    }
    return out
  }
}

/// Which chats have something this phone hasn't seen. Mercury keeps no read state, so the phone
/// keeps its own: when it last looked at each chat, per Mercury it connects to (two Mercurys can
/// have chats with the same id). A chat is unread when it moved after that. Chats with no mark
/// compare against when marks started, so a first launch doesn't show everything as new.
@MainActor @Observable
final class ReadMarks {
  private(set) var seen: [String: Date] = [:]
  private(set) var since: Date
  @ObservationIgnored let defaults: UserDefaults
  @ObservationIgnored let key: String

  init(scope: String, defaults: UserDefaults = .standard, now: Date = .now) {
    self.defaults = defaults
    key = "chats.seen." + (scope.isEmpty ? "default" : scope)
    let stored = defaults.dictionary(forKey: key) as? [String: Double] ?? [:]
    seen = stored.filter { $0.key != Self.sinceKey }.mapValues { Date(timeIntervalSince1970: $0) }
    if let s = stored[Self.sinceKey] { since = Date(timeIntervalSince1970: s) } else { since = now }
    if stored[Self.sinceKey] == nil { save() }
  }

  private static let sinceKey = "_since"

  /// A second's slack: the phone's clock and Mercury's aren't quite the same.
  static let slack: TimeInterval = 1

  func isUnread(_ t: ChatThread, open: String? = nil) -> Bool {
    guard t.id != open else { return false }
    return t.lastActivity.timeIntervalSince(seen[t.id] ?? since) > Self.slack
  }

  /// Seen now, or as of the chat's last activity when Mercury's clock runs ahead of the phone's.
  func markSeen(_ id: String, at date: Date = .now) {
    if let old = seen[id], old >= date { return }
    seen[id] = date
    save()
  }

  func markAllSeen(_ threads: [ChatThread], now: Date = .now) {
    for t in threads { seen[t.id] = max(now, t.lastActivity, seen[t.id] ?? .distantPast) }
    save()
  }

  /// Marks for chats that are gone are dropped, so the stored list never grows past the list.
  /// A fresh mark stays: its chat may be newer than the list that was just fetched.
  func prune(keeping ids: Set<String>, now: Date = .now) {
    let before = seen.count
    seen = seen.filter { ids.contains($0.key) || now.timeIntervalSince($0.value) < 600 }
    if seen.count != before { save() }
  }

  private func save() {
    var d = seen.mapValues(\.timeIntervalSince1970)
    d[Self.sinceKey] = since.timeIntervalSince1970
    defaults.set(d, forKey: key)
  }
}

extension ChatThread {
  /// The row's second line when nothing is happening: the last message, "You: " first when it
  /// was the person's. Nil on runtimes that don't send a preview.
  var previewLine: String? {
    guard let p = preview?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty else { return nil }
    return lastRole == "user" ? "You: \(p)" : p
  }
}

/// Labels between a conversation's messages from different days: "Today", "Yesterday",
/// "Mon 3 Nov" (with the year when it isn't this one). None before the first message when it's from today.
enum DaySeparators {
  static func label(_ d: Date, now: Date = .now, calendar: Calendar = .current) -> String {
    if calendar.isDate(d, inSameDayAs: now) { return "Today" }
    if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(d, inSameDayAs: y) { return "Yesterday" }
    var f = Date.FormatStyle.dateTime.weekday(.abbreviated).day().month(.abbreviated)
    if calendar.component(.year, from: d) != calendar.component(.year, from: now) { f = f.year() }
    f.calendar = calendar
    f.timeZone = calendar.timeZone
    return d.formatted(f)
  }

  /// Message id → the label to show above it.
  static func make(_ messages: [ChatMessage], now: Date = .now, calendar: Calendar = .current) -> [String: String] {
    var out: [String: String] = [:]
    var last: Date?
    for m in messages {
      if let l = last, calendar.isDate(l, inSameDayAs: m.timestamp) { last = m.timestamp; continue }
      if last != nil || !calendar.isDate(m.timestamp, inSameDayAs: now) { out[m.id] = label(m.timestamp, now: now, calendar: calendar) }
      last = m.timestamp
    }
    return out
  }
}

/// The side panel's history, as in Grok's: one flat list, newest first, rows the title alone.
/// "Saved" shows only saved chats, newest save first. A search filters live, on titles and
/// previews; the label above the list says which it is. The same rules as Android's `ChatHistory`.
struct ChatHistory: Equatable {
  var threads: [ChatThread] = []
  var query = ""
  var savedOnly = false

  var isEmpty: Bool { threads.isEmpty }
  /// "Conversations", "Saved" or "Results".
  var label: String { !query.isEmpty ? "Results" : savedOnly ? "Saved" : "Conversations" }

  static func build(_ threads: [ChatThread], query: String, savedOnly: Bool) -> ChatHistory {
    let q = query.trimmingCharacters(in: .whitespaces)
    let base = savedOnly
      ? threads.filter { $0.savedAt != nil }.sorted { $0.savedAt! > $1.savedAt! }
      : threads.sorted { $0.lastActivity > $1.lastActivity }
    return ChatHistory(threads: q.isEmpty ? base : base.filter { ChatSearch.matches($0, q) }, query: q, savedOnly: savedOnly)
  }
}

/// Live search over the history: case-insensitive, on the title and the last message.
enum ChatSearch {
  static func matches(_ t: ChatThread, _ query: String) -> Bool {
    let q = query.trimmingCharacters(in: .whitespaces)
    if q.isEmpty { return true }
    return t.displayTitle.localizedCaseInsensitiveContains(q) || (t.preview?.localizedCaseInsensitiveContains(q) ?? false)
  }

  /// Where `query` occurs in `text` (every occurrence, never overlapping), as character offsets.
  static func ranges(_ text: String, _ query: String) -> [Range<Int>] {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else { return [] }
    var out: [Range<Int>] = []
    var from = text.startIndex
    while let r = text.range(of: q, options: .caseInsensitive, range: from..<text.endIndex) {
      let a = text.distance(from: text.startIndex, to: r.lowerBound)
      out.append(a..<(a + text.distance(from: r.lowerBound, to: r.upperBound)))
      from = r.upperBound
    }
    return out
  }

  /// The text with the matches in semibold ink.
  static func emphasised(_ text: String, _ query: String) -> AttributedString {
    var s = AttributedString(text)
    let chars = Array(s.characters.indices)
    for r in ranges(text, query) where r.upperBound <= chars.count {
      let range = chars[r.lowerBound]..<(r.upperBound < chars.count ? chars[r.upperBound] : s.endIndex)
      s[range].inlinePresentationIntent = .stronglyEmphasized
    }
    return s
  }
}

/// How a history row looks: the title alone, on one line. A dot before it only when the chat
/// works, waits, needs you or failed; unread: a semibold title and a dot at the end.
struct RowLook: Equatable {
  enum Marker: Equatable { case working, waiting, needsYou, failed }
  var marker: Marker?
  var unread: Bool

  static func of(status: ChatsModel.Status?, unread: Bool) -> RowLook {
    let marker: Marker? = switch status {
    case .working: .working
    case .waiting: .waiting
    case .needsYou: .needsYou
    case .failed: .failed
    case nil: nil
    }
    return RowLook(marker: marker, unread: unread)
  }
}
