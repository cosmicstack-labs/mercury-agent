import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// The chat list's day sections, read marks, saved filter and second line; the conversation's day lines.
@MainActor
struct ChatListTests {
  var cal: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "Asia/Kolkata")!
    return c
  }()
  /// Mon 16 Nov 2026, 1:00 am in Srinagar: an hour into the day, so "yesterday" is close by.
  var now: Date { cal.date(from: DateComponents(year: 2026, month: 11, day: 16, hour: 1))! }
  func ago(days: Int = 0, hours: Int = 0) -> Date { now.addingTimeInterval(-Double(days) * 86_400 - Double(hours) * 3_600) }
  func thread(_ id: String, _ at: Date, saved: Date? = nil, preview: String? = nil, role: String? = nil) -> ChatThread {
    ChatThread(id: id, title: id, createdAt: at, savedAt: saved, preview: preview, lastRole: role)
  }
  func defaults() -> UserDefaults {
    let name = "chat-list-tests-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
  }

  // MARK: Sections

  @Test func daysAreCalendarDaysNotHours() {
    #expect(ChatSections.title(ago(hours: 0), now: now, calendar: cal) == "Today")
    // Two hours ago is 11 pm the day before.
    #expect(ChatSections.title(ago(hours: 2), now: now, calendar: cal) == "Yesterday")
    #expect(ChatSections.title(ago(days: 2), now: now, calendar: cal) == "Previous 7 days")
    #expect(ChatSections.title(ago(days: 6), now: now, calendar: cal) == "Previous 7 days")
    #expect(ChatSections.title(ago(days: 7), now: now, calendar: cal) == "Previous 30 days")
    #expect(ChatSections.title(ago(days: 29), now: now, calendar: cal) == "Previous 30 days")
    #expect(ChatSections.title(ago(days: 30), now: now, calendar: cal) == "Older")
    // A clock running ahead is still today.
    #expect(ChatSections.title(now.addingTimeInterval(120), now: now, calendar: cal) == "Today")
  }

  @Test func sectionsKeepTheListsOrderAndSkipEmptyDays() {
    let list = [thread("a", ago()), thread("b", ago(hours: 3)), thread("c", ago(days: 40)), thread("d", ago(days: 50))]
    let s = ChatSections.byDay(list, now: now, calendar: cal)
    #expect(s.map(\.title) == ["Today", "Yesterday", "Older"])
    #expect(s.map { $0.threads.map(\.id) } == [["a"], ["b"], ["c", "d"]])
  }

  // MARK: Unread

  @Test func aFirstLaunchShowsNothingAsNew() {
    let marks = ReadMarks(scope: "m1", defaults: defaults(), now: now)
    #expect(!marks.isUnread(thread("a", ago(days: 3))))
    #expect(marks.isUnread(thread("b", now.addingTimeInterval(60))))
  }

  @Test func aChatIsUnreadWhenItMovedAfterThePhoneLookedUnlessItsOpen() {
    let d = defaults()
    let marks = ReadMarks(scope: "m1", defaults: d, now: ago(days: 1))
    let t = thread("a", now)
    #expect(marks.isUnread(t))
    #expect(!marks.isUnread(t, open: "a"))
    marks.markSeen("a", at: now)
    #expect(!marks.isUnread(t))
    // Within a second's clock slack is not new.
    #expect(!marks.isUnread(thread("a", now.addingTimeInterval(0.5))))
    #expect(marks.isUnread(thread("a", now.addingTimeInterval(30))))
    // Marks never go back in time.
    marks.markSeen("a", at: ago(days: 1))
    #expect(marks.seen["a"] == now)
  }

  @Test func marksAreKeptPerMercuryAndSurviveARelaunch() {
    let d = defaults()
    let one = ReadMarks(scope: "m1", defaults: d, now: ago(days: 1))
    one.markSeen("a", at: now)
    #expect(ReadMarks(scope: "m1", defaults: d).seen["a"] == now)
    #expect(ReadMarks(scope: "m1", defaults: d).since == ago(days: 1))
    #expect(ReadMarks(scope: "m2", defaults: d).seen["a"] == nil)
  }

  @Test func markAllReadAndPruning() {
    let marks = ReadMarks(scope: "m1", defaults: defaults(), now: ago(days: 2))
    let list = [thread("a", ago(hours: 1)), thread("b", now.addingTimeInterval(5))]
    #expect(list.allSatisfy { marks.isUnread($0) })
    marks.markAllSeen(list, now: now)
    #expect(!list.contains { marks.isUnread($0) })
    // A fresh mark stays though its chat isn't listed (it may be newer than the list)…
    marks.markSeen("new", at: now)
    marks.prune(keeping: ["a"], now: now)
    #expect(Set(marks.seen.keys) == ["a", "b", "new"])
    // …and goes once it's old and the chat is still gone.
    marks.prune(keeping: ["a"], now: now.addingTimeInterval(3_600))
    #expect(Set(marks.seen.keys) == ["a"])
  }

  @Test func theModelsListHidesTheOpenChatsDotAndMarksOnLeaving() {
    let m = ChatsModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), scope: "m1", defaults: defaults())
    let t = thread("a", Date.now.addingTimeInterval(60))
    m.threads = [t]
    #expect(m.isUnread(t) && m.anyUnread)
    m.viewing("a", open: true)
    #expect(m.open == "a" && !m.isUnread(t))
    m.viewing("a", open: false)
    #expect(m.open == nil)
    // Marked as of its last activity, which ran ahead of the phone's clock.
    #expect(!m.isUnread(t) && !m.anyUnread)
    // Another chat leaving doesn't close this one.
    m.viewing("a", open: true)
    m.viewing("b", open: false)
    m.viewing("b", open: nil)
    #expect(m.open == "a")
  }

  // MARK: Saved and search

  @Test func savedOnlyIsNewestSaveFirstAndSearchReadsPreviews() {
    let m = ChatsModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), scope: "m1", defaults: defaults())
    m.threads = [
      thread("old-save", ago(), saved: ago(days: 3), preview: "Gondola tickets"),
      thread("new-save", ago(days: 5), saved: ago(hours: 1)),
      thread("plain", ago(hours: 2), preview: "The deploy is ready"),
    ]
    #expect(m.hasSaved)
    #expect(m.visible.map(\.id) == ["old-save", "plain", "new-save"])
    m.savedOnly = true
    #expect(m.visible.map(\.id) == ["new-save", "old-save"])
    #expect(m.sections.map(\.title) == ["Saved"])
    m.savedOnly = false
    m.query = "DEPLOY"
    #expect(m.visible.map(\.id) == ["plain"])
    m.query = "gondola"
    #expect(m.visible.map(\.id) == ["old-save"])
  }

  // MARK: The second line

  @Test func previewSaysYouWhenThePersonWroteLast() {
    #expect(thread("a", now, preview: "Deploy it", role: "user").previewLine == "You: Deploy it")
    #expect(thread("a", now, preview: "It's live.", role: "assistant").previewLine == "It's live.")
    #expect(thread("a", now, preview: "  ", role: "assistant").previewLine == nil)
    #expect(thread("a", now).previewLine == nil)
  }

  @Test func statusBeatsThePreview() {
    let t = thread("a", now, preview: "Deploy it", role: "user")
    #expect(ThreadRow(thread: t, status: .working).subtitle?.text == "Working…")
    #expect(ThreadRow(thread: t, status: nil).subtitle?.text == "You: Deploy it")
    #expect(ThreadRow(thread: t, status: nil).subtitle?.lines == 2)
    var call = thread("c", now)
    call.voiceCall = true
    #expect(ThreadRow(thread: call, status: nil).subtitle?.text == "Voice call")
    #expect(ThreadRow(thread: thread("b", now), status: nil).subtitle == nil)
  }

  @Test func theListDecodesPreviewsAndOlderListsWithoutThem() throws {
    let json = #"{"threads":[{"id":"a","title":"T","createdAt":"2026-11-16T01:00:00.000Z","updatedAt":"2026-11-16T02:00:00.000Z","savedAt":"2026-11-15T01:00:00.000Z","preview":"Hi","lastRole":"user","messages":[]},{"id":"b","createdAt":"2026-11-16T01:00:00.000Z"}]}"#
    struct L: Decodable { var threads: [ChatThread] }
    let l = try JSONDecoder.mercury.decode(L.self, from: Data(json.utf8))
    #expect(l.threads[0].previewLine == "You: Hi")
    #expect(l.threads[0].savedAt != nil)
    #expect(l.threads[1].preview == nil && l.threads[1].messages.isEmpty)
  }

  // MARK: Day lines in a conversation

  @Test func dayLinesGoBetweenDaysAndNotAboveToday() {
    func msg(_ id: String, _ at: Date) -> ChatMessage { ChatMessage(id: id, role: "user", content: id, timestamp: at) }
    let today = [msg("a", ago()), msg("b", now.addingTimeInterval(60))]
    #expect(DaySeparators.make(today, now: now, calendar: cal).isEmpty)
    let mixed = [msg("a", ago(days: 3)), msg("b", ago(days: 3)), msg("c", ago(hours: 2)), msg("d", ago())]
    let lines = DaySeparators.make(mixed, now: now, calendar: cal)
    #expect(Set(lines.keys) == ["a", "c", "d"])
    #expect(lines["c"] == "Yesterday")
    #expect(lines["d"] == "Today")
    #expect(lines["a"]?.contains("13") == true)
  }

  @Test func olderDaysNameTheYearWhenItIsntThisOne() {
    let lastYear = cal.date(from: DateComponents(year: 2025, month: 11, day: 3, hour: 12))!
    #expect(DaySeparators.label(lastYear, now: now, calendar: cal).contains("2025"))
    #expect(!DaySeparators.label(ago(days: 5), now: now, calendar: cal).contains("2026"))
  }
}
