import Testing
import Foundation
@testable import MercuryCore

/// The phone's bot requests against a real Mercury, when MERCURY_URL and MERCURY_TOKEN_FILE are set:
///   MERCURY_URL=http://127.0.0.1:6174 MERCURY_TOKEN_FILE=~/.mercury/attach-token swift test --filter BotEditingLiveTests
/// Makes "phone-test-bot", reads it back, edits it, turns it off, deletes it, and checks it's gone.
struct BotEditingLiveTests {
  static let env = ProcessInfo.processInfo.environment
  static let url = env["MERCURY_URL"].flatMap(URL.init(string:))
  static let token = env["MERCURY_TOKEN_FILE"].flatMap { try? String(contentsOfFile: ($0 as NSString).expandingTildeInPath, encoding: .utf8) }?
    .trimmingCharacters(in: .whitespacesAndNewlines)

  @Test(.enabled(if: url != nil && token != nil)) func createReadEditDisableDelete() async throws {
    let c = MercuryClient(baseURL: Self.url!, token: Self.token!)
    let name = "phone-test-bot"
    let id = BotForms.uniqueId(BotForms.slugify(name), taken: try await c.bots().bots.map(\.id))
    #expect(id == "phone-test-bot")
    defer { Task { try? await c.deleteBot(id) } }

    let made = try await c.createBot(NewBot(id: id, name: name, description: "Made by the phone's live test",
                                            persona: "You are a harmless test bot. Do nothing; if asked, call bot_no_update.", tier: "readonly"))
    print("LIVE create → id=\(made.id) name=\(made.name) enabled=\(made.enabled)")
    #expect(made.id == id && made.name == name)

    let read = try await c.botManifest(id)
    let persona = try await c.botPersona(id)
    print("LIVE read → name=\(read.name) schedules=\(read.schedules.count) budget=\(read.dailyTokenBudget.map(String.init) ?? "-") persona=\(persona.prefix(40))…")
    #expect(read.schedules.isEmpty && read.dailyTokenBudget == BotForms.defaultBudget && persona.contains("harmless test bot"))
    #expect(try await c.bots().bots.first { $0.id == id }?.tier == "readonly")

    let changes = BotChanges.between(read, name: "Phone Test Bot (edited)", description: read.description, model: read.model, schedules: [], budget: "1000000")
    let edited = try await c.updateBot(id, changes)
    try await c.setBotPersona(id, "You are an edited harmless test bot. Do nothing.")
    let after = try await c.botManifest(id)
    print("LIVE edit → patch=\(changes.body) name=\(after.name) persona=\(try await c.botPersona(id).prefix(40))…")
    #expect(edited?.name == "Phone Test Bot (edited)" && after.name == "Phone Test Bot (edited)")
    #expect(try await c.botPersona(id).contains("edited harmless"))

    try await c.setBotEnabled(id, false)
    let off = try await c.botManifest(id)
    let run = try await c.runBotNow(id)
    print("LIVE disable → enabled=\(off.enabled); run now → accepted=\(run.accepted) reason=\(run.reasonCode ?? "-")")
    #expect(!off.enabled && !run.accepted)

    try await c.deleteBot(id)
    let gone = try await c.bots().bots.contains { $0.id == id }
    var status = 0
    do { _ = try await c.botManifest(id) } catch MercuryError.server(let code, _) { status = code }
    print("LIVE delete → still listed=\(gone) GET status=\(status)")
    #expect(!gone && status == 404)
  }
}
