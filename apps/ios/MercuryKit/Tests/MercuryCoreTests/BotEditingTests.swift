import Testing
import Foundation
@testable import MercuryCore

/// Ported from apps/desktop/src/views/bots/BotForms.test.ts, plus the phone's own pieces: the
/// schedule picker's round trip, the first draft from plain words, and the request bodies.
struct BotFormsTests {
  @Test func makesAnIdTheRuntimeAcceptsFromAnyName() {
    #expect(BotForms.slugify("Rust Watcher") == "rust-watcher")
    #expect(BotForms.slugify("  Café Daily Brief!! ") == "cafe-daily-brief")
    #expect(BotForms.slugify("42 news") == "bot-42-news")
    #expect(BotForms.slugify("") == "bot-new")
    #expect(BotForms.slugify(String(repeating: "x", count: 80)).count == 30)
    for id in [BotForms.slugify("Rust Watcher"), BotForms.slugify("42 news"), BotForms.slugify("Ünïcode"), BotForms.slugify("Phone Test Bot")] {
      #expect(id.range(of: "^[a-z][a-z0-9-]*$", options: .regularExpression) != nil, "\(id)")
    }
  }

  @Test func saysCommonSchedulesInWordsAndLeavesTheRestAsCron() {
    #expect(BotForms.describeCron("0 9 * * 1-5") == "Weekdays at 9")
    #expect(BotForms.describeCron("0 * * * *") == "Every hour")
    #expect(BotForms.describeCron("30 7 * * *") == "30 7 * * *")
  }

  @Test func warnsWhenAScheduleAsksForMoreThanOneRunEvery15Minutes() {
    #expect(BotForms.tooFrequent("*/5 * * * *"))
    #expect(BotForms.tooFrequent("* * * * *"))
    #expect(!BotForms.tooFrequent("*/15 * * * *"))
    #expect(!BotForms.tooFrequent("0 9 * * *"))
  }

  @Test func uniqueIdsAndRoutineNames() {
    #expect(BotForms.uniqueId("scout", taken: ["a"]) == "scout")
    #expect(BotForms.uniqueId("scout", taken: ["scout", "scout-2"]) == "scout-3")
    #expect(BotForms.nextRoutineName([]) == "routine")
    #expect(BotForms.nextRoutineName([BotSchedule(name: "routine", cron: "0 9 * * *", prompt: "x")]) == "routine-2")
  }

  @Test func theFormSaysWhatIsMissingInOrder() {
    let ok = BotSchedule(name: "routine", cron: "0 9 * * *", prompt: "Brief me")
    #expect(BotForms.problem(name: " ", persona: "x", budget: "1000000", schedules: []) == "Give it a name.")
    #expect(BotForms.problem(name: "A", persona: "  ", budget: "1000000", schedules: []) == "Say how it should work (its instructions).")
    #expect(BotForms.problem(name: "A", persona: "x", budget: "9,999", schedules: []) == "The daily budget must be at least 10,000 tokens.")
    #expect(BotForms.problem(name: "A", persona: "x", budget: "lots", schedules: []) == "The daily budget must be at least 10,000 tokens.")
    #expect(BotForms.problem(name: "A", persona: "x", budget: "1 000 000", schedules: [ok, BotSchedule(name: "b", cron: "0 * * * *", prompt: " ")]) == "Every schedule needs instructions.")
    #expect(BotForms.problem(name: "A", persona: "x", budget: "1_000_000", schedules: [ok], manualFleet: true, crew: [CrewSpec()]) == "Add at least one crew member, or pick another option.")
    #expect(BotForms.problem(name: "A", persona: "x", budget: "1,000,000", schedules: [ok]) == nil)
    #expect(BotForms.crewProblem([CrewSpec(name: "Checker", persona: "")]) == "Every crew member needs a name and instructions.")
    #expect(BotForms.crewProblem([CrewSpec(name: "Checker", persona: "Check facts")]) == nil)
  }

  @Test func theEditFormAllowsTheFleetDefaultBudgetButNotABrokenSchedule() {
    #expect(BotForms.editProblem(name: "A", persona: "x", budget: "", schedules: []) == nil)
    #expect(BotForms.editProblem(name: "A", persona: "x", budget: "5", schedules: []) == "The daily budget must be at least 10,000 tokens.")
    #expect(BotForms.editProblem(name: "A", persona: "x", budget: "", schedules: [BotSchedule(name: "r", cron: "every day", prompt: "x")])?.contains("isn't a schedule") == true)
  }

  @Test func tiersInPlainWords() {
    #expect(BotTiers.words("readonly")?.title == "Read only")
    #expect(BotTiers.title("custom") == "Custom (edited by hand)")
    #expect(BotTiers.needsOwner("operator") && BotTiers.needsOwner("full"))
    #expect(!BotTiers.needsOwner("builder") && !BotTiers.needsOwner("readonly"))
  }
}

struct ScheduleRuleTests {
  @Test func everyPickerChoiceRoundTripsThroughCron() {
    let rules: [ScheduleRule] = [.everyMinutes(15), .everyMinutes(30), .everyHours(1), .everyHours(4), .daily(hour: 9, minute: 0),
                                 .daily(hour: 18, minute: 30), .weekdays(hour: 7, minute: 30), .weekly(day: 1, hour: 9, minute: 0),
                                 .weekly(day: 0, hour: 20, minute: 5)]
    for r in rules { #expect(ScheduleRule.from(cron: r.cron) == r, "\(r.cron)") }
  }

  @Test func serverCronsReadAsWords() {
    #expect(ScheduleRule.from(cron: "0 * * * *") == .everyHours(1))
    #expect(ScheduleRule.from(cron: "0 */4 * * *").words == "Every 4 hours")
    #expect(ScheduleRule.from(cron: "0 9 * * 1-5").words == "Weekdays at 9:00")
    #expect(ScheduleRule.from(cron: "30 7 * * *").words == "Every day at 7:30")
    #expect(ScheduleRule.from(cron: "0 9 * * 7") == .weekly(day: 0, hour: 9, minute: 0))
    #expect(ScheduleRule.from(cron: "0 9 * * 1").words == "Mondays at 9:00")
    #expect(ScheduleRule.from(cron: "*/30 * * * *").words == "Every 30 minutes")
  }

  @Test func whatThePickerCantSayStaysCronUnchanged() {
    for c in ["0 9 1 * *", "0 9 * * 1,3", "15 */2 * * *", "@daily", "0 9 * *"] {
      #expect(ScheduleRule.from(cron: c) == .custom(c))
      #expect(ScheduleRule.from(cron: c).cron == c)
    }
  }

  @Test func switchingKindKeepsTheTimeOfDay() {
    let r = ScheduleRule.daily(hour: 7, minute: 30)
    #expect(r.with(kind: .weekdays) == .weekdays(hour: 7, minute: 30))
    #expect(r.with(kind: .weekly) == .weekly(day: 1, hour: 7, minute: 30))
    #expect(r.with(kind: .custom) == .custom("30 7 * * *"))
    #expect(r.with(kind: .minutes) == .everyMinutes(30))
  }

  @Test func validCrons() {
    #expect(ScheduleRule.isValid("0 9 * * 1-5"))
    #expect(ScheduleRule.isValid("*/15 * * * *"))
    #expect(!ScheduleRule.isValid("every day"))
    #expect(!ScheduleRule.isValid("0 9 * *"))
  }
}

struct BotDraftTests {
  @Test func aNameFromTheFirstWords() {
    #expect(BotDraft.name(from: "Watch Hacker News for Rust posts every morning") == "Watch Hacker News")
    #expect(BotDraft.name(from: "I want a bot that summarises my inbox every evening") == "Summarises My Inbox")
    #expect(BotDraft.name(from: "track prices on amazon and tell me when they drop") == "Track Prices")
    #expect(BotDraft.name(from: "") == "")
  }

  @Test func theFirstSentenceIsTheLine() {
    #expect(BotDraft.description(from: "Watch HN for Rust posts. Report only new ones.") == "Watch HN for Rust posts")
    #expect(BotDraft.description(from: String(repeating: "a", count: 200)).count == 118)
  }

  @Test func aScheduleOnlyWhenTheWordsAskForOne() {
    #expect(BotDraft.schedule(from: "Watch HN for Rust posts every morning")?.cron == "0 9 * * *")
    #expect(BotDraft.schedule(from: "Brief me every morning at 7:30")?.cron == "30 7 * * *")
    #expect(BotDraft.schedule(from: "Summarise my inbox every evening")?.cron == "0 18 * * *")
    #expect(BotDraft.schedule(from: "Check the status page hourly")?.cron == "0 * * * *")
    #expect(BotDraft.schedule(from: "Check prices every 2 hours")?.cron == "0 */2 * * *")
    #expect(BotDraft.schedule(from: "Poll the API every 5 minutes")?.cron == "*/15 * * * *")
    #expect(BotDraft.schedule(from: "Send the standup on weekdays at 9am")?.cron == "0 9 * * 1-5")
    #expect(BotDraft.schedule(from: "Every Friday at 5 pm, list what shipped")?.cron == "0 17 * * 5")
    #expect(BotDraft.schedule(from: "Research a topic when I ask") == nil)
    let s = BotDraft.schedule(from: "Watch HN for Rust posts every morning. Report only new ones.")
    #expect(s?.name == "routine" && s?.prompt == "Watch HN for Rust posts every morning")
  }

  @Test func readOnlyUnlessTheJobMakesFiles() {
    #expect(BotDraft.tier(from: "Watch HN for Rust posts and tell me") == "readonly")
    #expect(BotDraft.tier(from: "Draft a weekly newsletter") == "builder")
    #expect(BotDraft.tier(from: "Save the prices to a CSV file") == "builder")
    #expect(BotDraft.tier(from: "Run my deploy script and delete old builds") == "readonly")
  }
}

struct BotRequestTests {
  func json(_ any: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: any, options: [.sortedKeys]), encoding: .utf8)!
  }

  @Test func theCreateBodyIsWhatDesktopSends() {
    let b = NewBot(id: "rust-watch", name: " Rust Watch ", description: " ", persona: "You watch HN.\n", tier: "readonly",
                   model: BotModelRef(provider: "anthropic", model: "claude-x"), dailyTokenBudget: 250_000)
    #expect(json(b.body) == #"{"id":"rust-watch","manifest":{"autonomy":{"dailyTokenBudget":250000},"model":{"model":"claude-x","provider":"anthropic"}},"name":"Rust Watch","persona":"You watch HN.","tier":"readonly"}"#)
    let plain = NewBot(id: "x", name: "X", description: "Line", persona: "p")
    #expect(json(plain.body) == #"{"description":"Line","id":"x","manifest":{"autonomy":{"dailyTokenBudget":1000000}},"name":"X","persona":"p","tier":"readonly"}"#)
  }

  @Test func readsTheManifestTheRuntimeSends() throws {
    let raw = #"{"id":"scout","name":"Scout","enabled":false,"description":"Finds things","model":{"provider":"openai","model":"gpt-x"},"schedules":[{"name":"routine","cron":"0 9 * * *","prompt":"Go"}],"autonomy":{"dailyTokenBudget":500000,"maxSteps":25},"memory":{"learn":true},"fleetRole":"lead","createdAt":"2026-11-01"}"#
    let m = try #require(BotManifest.from(JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]))
    #expect(m.id == "scout" && m.name == "Scout" && !m.enabled && m.description == "Finds things")
    #expect(m.model == BotModelRef(provider: "openai", model: "gpt-x"))
    #expect(m.schedules == [BotSchedule(name: "routine", cron: "0 9 * * *", prompt: "Go")])
    #expect(m.dailyTokenBudget == 500_000 && m.autonomy["maxSteps"] == 25)
    #expect(m.fleetRole == "lead")
    #expect(BotManifest.from(["name": "no id"]) == nil)
    #expect(BotManifest.from(["id": "bare"])?.name == "bare")
  }

  @Test func aPatchCarriesOnlyWhatChanged() {
    let bot = BotManifest(id: "scout", name: "Scout", description: "Finds", model: BotModelRef(provider: "openai", model: "gpt-x"),
                          schedules: [BotSchedule(name: "routine", cron: "0 9 * * *", prompt: "Go")],
                          autonomy: ["dailyTokenBudget": 500_000, "maxSteps": 25])
    let same = BotChanges.between(bot, name: "Scout ", description: "Finds", model: bot.model, schedules: bot.schedules, budget: "500,000")
    #expect(same.isEmpty)

    let renamed = BotChanges.between(bot, name: "Scout Two", description: "Finds", model: bot.model, schedules: bot.schedules, budget: "500000")
    #expect(json(renamed.body) == #"{"name":"Scout Two"}"#)

    // Clearing the model sends null (Mercury's default); the budget keeps the other limits.
    let c = BotChanges.between(bot, name: "Scout", description: "Finds", model: nil,
                               schedules: [BotSchedule(name: "routine", cron: " 0 18 * * * ", prompt: " Evening ")], budget: "")
    #expect(json(c.body) == #"{"autonomy":{"maxSteps":25},"model":null,"schedules":[{"cron":"0 18 * * *","name":"routine","prompt":"Evening"}]}"#)

    let budget = BotChanges.between(bot, name: "Scout", description: "Finds", model: bot.model, schedules: bot.schedules, budget: "2,000,000")
    #expect(json(budget.body) == #"{"autonomy":{"dailyTokenBudget":2000000,"maxSteps":25}}"#)
  }

  @Test func readsMercurysPlan() {
    let p = BotPlan.from(["shape": "fleet", "reason": "Three parts", "crew": [["id": "fact-checker", "name": "Fact Checker", "description": "Checks", "persona": "You check."]]])
    #expect(p.isFleet && p.reason == "Three parts" && p.crew.first?.name == "Fact Checker")
    #expect(!BotPlan.from([:]).isFleet)
  }
}
