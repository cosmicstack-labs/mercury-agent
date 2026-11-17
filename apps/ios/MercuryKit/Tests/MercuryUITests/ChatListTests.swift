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
    #expect(ChatSections.title(ago(days: 2), now: now, calendar: cal) == "2 days ago")
    #expect(ChatSections.title(ago(days: 3), now: now, calendar: cal) == "3 days ago")
    #expect(ChatSections.title(ago(days: 6), now: now, calendar: cal) == "6 days ago")
    #expect(ChatSections.title(ago(days: 7), now: now, calendar: cal) == "Previous 30 days")
    #expect(ChatSections.title(ago(days: 29), now: now, calendar: cal) == "Previous 30 days")
    // A clock running ahead is still today.
    #expect(ChatSections.title(now.addingTimeInterval(120), now: now, calendar: cal) == "Today")
  }

  @Test func olderChatsAreLabelledByMonthWithTheYearWhenItIsAnother() {
    #expect(ChatSections.title(ago(days: 30), now: now, calendar: cal) == "October")
    #expect(ChatSections.title(ago(days: 60), now: now, calendar: cal) == "September")
    #expect(ChatSections.title(cal.date(from: DateComponents(year: 2026, month: 1, day: 2))!, now: now, calendar: cal) == "January")
    #expect(ChatSections.title(cal.date(from: DateComponents(year: 2025, month: 9, day: 20))!, now: now, calendar: cal) == "September 2025")
    #expect(ChatSections.title(cal.date(from: DateComponents(year: 2025, month: 12, day: 31, hour: 23))!, now: now, calendar: cal) == "December 2025")
  }

  @Test func midnightIsTheBoundary() {
    let midnight = cal.date(from: DateComponents(year: 2026, month: 11, day: 16))!
    #expect(ChatSections.title(midnight, now: now, calendar: cal) == "Today")
    #expect(ChatSections.title(midnight.addingTimeInterval(-1), now: now, calendar: cal) == "Yesterday")
    let twoDays = cal.date(from: DateComponents(year: 2026, month: 11, day: 15))!
    #expect(ChatSections.title(twoDays.addingTimeInterval(-1), now: now, calendar: cal) == "2 days ago")
    // One second before midnight, "now" is still the 15th: a chat from 10 pm on the 15th is today.
    let late = midnight.addingTimeInterval(-1)
    #expect(ChatSections.title(midnight.addingTimeInterval(-7_200), now: late, calendar: cal) == "Today")
  }

  @Test func theSameMomentIsLabelledInThePhonesTimeZone() {
    // 20:00 UTC on 15 Nov is 1:30 am on the 16th in Srinagar but noon on the 15th in Los Angeles.
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
    let chat = utc.date(from: DateComponents(year: 2026, month: 11, day: 15, hour: 20))!
    let later = utc.date(from: DateComponents(year: 2026, month: 11, day: 16, hour: 0, minute: 30))!
    var la = Calendar(identifier: .gregorian); la.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    #expect(ChatSections.title(chat, now: later, calendar: cal) == "Today")
    #expect(ChatSections.title(chat, now: later, calendar: utc) == "Yesterday")
    #expect(ChatSections.title(chat, now: later, calendar: la) == "Today")
    // Months too: 1 Oct 02:00 in Srinagar is still 30 Sep in Los Angeles.
    let oct = cal.date(from: DateComponents(year: 2026, month: 10, day: 1, hour: 2))!
    #expect(ChatSections.title(oct, now: now, calendar: cal) == "October")
    #expect(ChatSections.title(oct, now: now, calendar: la) == "September")
  }

  @Test func sectionsKeepTheListsOrderAndSkipEmptyDays() {
    let list = [thread("a", ago()), thread("b", ago(hours: 3)), thread("c", ago(days: 40)), thread("d", ago(days: 45)), thread("e", ago(days: 400))]
    let s = ChatSections.byDay(list, now: now, calendar: cal)
    #expect(s.map(\.title) == ["Today", "Yesterday", "October", "October 2025"])
    #expect(s.map { $0.threads.map(\.id) } == [["a"], ["b"], ["c", "d"], ["e"]])
  }

  @Test func searchResultsKeepTheirDayLabelsAndSavedHasNone() {
    let list = [thread("a", ago(), preview: "carousel"), thread("b", ago(days: 3), preview: "carousel ride"),
                thread("c", ago(days: 3)), thread("s", ago(days: 40), saved: ago(days: 1))]
    let found = ChatHistory.build(list, query: "carousel", savedOnly: false, now: now, calendar: cal)
    #expect(found.sections.map(\.title) == ["Today", "3 days ago"])
    #expect(found.sections.flatMap(\.threads).map(\.id) == found.threads.map(\.id))
    let all = ChatHistory.build(list, query: "", savedOnly: false, now: now, calendar: cal)
    #expect(all.sections.map(\.title) == ["Today", "3 days ago", "October"])
    let saved = ChatHistory.build(list, query: "", savedOnly: true, now: now, calendar: cal)
    #expect(saved.sections.map(\.title) == [nil])
    #expect(ChatHistory.build(list, query: "zzz", savedOnly: true, now: now, calendar: cal).sections.isEmpty)
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

  @Test func oneFlatListNewestFirstAndSavedNewestSaveFirst() {
    let list = [
      thread("a", ago()), thread("b", ago(hours: 2)), thread("c", ago(days: 3)),
      thread("s1", ago(days: 9), saved: ago(days: 4)), thread("s2", ago(hours: 1), saved: ago(days: 1)),
    ]
    let h = ChatHistory.build(list, query: "", savedOnly: false)
    #expect(h.threads.map(\.id) == ["a", "s2", "b", "c", "s1"])
    #expect(h.label == "Conversations")
    let saved = ChatHistory.build(list, query: "", savedOnly: true)
    #expect(saved.threads.map(\.id) == ["s2", "s1"] && saved.label == "Saved")
  }

  @Test func searchFiltersTitlesAndPreviewsLive() {
    let m = ChatsModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), scope: "m1", defaults: defaults())
    m.threads = [
      thread("old-save", ago(), saved: ago(days: 3), preview: "Gondola tickets"),
      thread("new-save", ago(days: 5), saved: ago(hours: 1)),
      thread("plain", ago(hours: 2), preview: "The deploy is ready"),
    ]
    #expect(m.hasSaved)
    #expect(m.history.threads.map(\.id) == ["old-save", "plain", "new-save"])
    m.query = "DEPLOY"
    #expect(m.history.threads.map(\.id) == ["plain"] && m.history.label == "Results")
    m.query = "gondola"
    #expect(m.history.threads.map(\.id) == ["old-save"])
    m.query = "zzz"
    #expect(m.history.isEmpty)
    // The memo follows the list and the Saved filter.
    m.query = ""
    m.savedOnly = true
    #expect(m.history.threads.map(\.id) == ["new-save", "old-save"])
    m.savedOnly = false
    m.threads.append(thread("new", ago().addingTimeInterval(60)))
    #expect(m.history.threads.first?.id == "new")
  }

  @Test func matchesAreEmphasisedCaseInsensitively() {
    #expect(ChatSearch.ranges("Car and car", "CAR") == [0..<3, 8..<11])
    #expect(ChatSearch.ranges("anything", " ").isEmpty)
    let e = ChatSearch.emphasised("Trip to Gulmarg", "gul")
    #expect(e.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized && String(e[$0.range].characters) == "Gul" })
  }

  @Test func deleteWaitsForUndo() {
    let m = ChatsModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), scope: "m1", defaults: defaults())
    let t = thread("a", ago())
    m.threads = [t, thread("b", ago())]
    m.delete(t)
    #expect(m.threads.map(\.id) == ["b"] && m.deleted.map(\.id) == ["a"])
    m.undoDelete(t)
    #expect(Set(m.threads.map(\.id)) == ["a", "b"] && m.deleted.isEmpty)
  }

  // MARK: The second line

  @Test func previewSaysYouWhenThePersonWroteLast() {
    #expect(thread("a", now, preview: "Deploy it", role: "user").previewLine == "You: Deploy it")
    #expect(thread("a", now, preview: "It's live.", role: "assistant").previewLine == "It's live.")
    #expect(thread("a", now, preview: "  ", role: "assistant").previewLine == nil)
    #expect(thread("a", now).previewLine == nil)
  }

  @Test func rowsAreOneLineWithMarkersOnlyWhenRelevant() {
    #expect(RowLook.of(status: nil, unread: false) == RowLook(marker: nil, unread: false))
    #expect(RowLook.of(status: nil, unread: true) == RowLook(marker: nil, unread: true))
    #expect(RowLook.of(status: .working, unread: false).marker == .working)
    #expect(RowLook.of(status: .failed, unread: false).marker == .failed)
    #expect(RowLook.of(status: .waiting, unread: false).marker == .waiting)
    #expect(RowLook.of(status: .needsYou("Run command: npm run deploy"), unread: true) == RowLook(marker: .needsYou, unread: true))
  }

  // MARK: The model picker

  let models = [
    ModelChoice(name: "anthropic", model: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", group: "Claude", isCurrent: true),
    ModelChoice(name: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Claude"),
    ModelChoice(name: "openrouter", model: "openai/gpt-5", label: "GPT-5", group: "GPT"),
    ModelChoice(name: "ollama", model: "llama3"),
  ]

  @Test func modelsGroupInOrderAndFilterAsYouType() {
    #expect(ModelMenu.groups(models).map(\.title) == ["Claude", "GPT", "Ollama"])
    #expect(ModelMenu.groups(models).last?.models.map(\.title) == ["llama3"])
    #expect(ModelMenu.groups(models, query: "gpt").flatMap(\.models).map(\.title) == ["GPT-5"])
    #expect(ModelMenu.groups(models, query: "anthropic").first?.models.count == 2)
    #expect(ModelMenu.groups(models, query: "zzz").isEmpty)
    #expect(ModelMenu.providerName("mercuryCloud") == "Mercury Cloud")
    #expect(ModelMenu.providerName("lmstudio") == "LM Studio")
  }

  @Test func thePillSaysAutoOnTheConfiguredDefault() throws {
    let auto = ModelCatalog(models: models, current: models[0], defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5")
    #expect(auto.isAuto && auto.pill == "Auto")
    var other = auto
    other.current = models[2]
    #expect(other.pill == "GPT-5")
    #expect(ModelMenu.target(other, nil).map { "\($0.provider)/\($0.model)" } == "anthropic/claude-sonnet-4-5")
    #expect(ModelMenu.target(auto, models[2]).map { "\($0.provider)/\($0.model)" } == "openrouter/openai/gpt-5")
    #expect(ModelCatalog(models: models, current: models[0]).pill == "Claude Sonnet 4.5")
    // The list as Mercury sends it.
    let json = #"{"name":"openrouter","model":"openai/gpt-5","available":true,"isCurrent":false,"label":"GPT-5","group":"GPT","reasoning":"auto"}"#
    let m = try JSONDecoder().decode(ModelChoice.self, from: Data(json.utf8))
    #expect(m.title == "GPT-5" && m.group == "GPT" && !m.isCurrent)
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
