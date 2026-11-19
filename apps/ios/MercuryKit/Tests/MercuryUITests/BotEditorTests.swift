import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// A small Mercury for bot changes: powerful levels wait for the owner (428) as src/web/api/bots.ts does.
final class BotMercury: URLProtocol {
  nonisolated(unsafe) static var log: [(method: String, path: String, approval: String?, body: [String: Any])] = []
  nonisolated(unsafe) static var approval = "allowed"
  static func reset() { log = []; approval = "allowed" }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let method = request.httpMethod ?? "GET", path = request.url!.path
    let approval = request.value(forHTTPHeaderField: "X-Mercury-Approval")
    let body = (try? JSONSerialization.jsonObject(with: PluginsTests.body(request))) as? [String: Any] ?? [:]
    Self.log.append((method, path, approval, body))
    var status = 200
    var out: Any = ["ok": true]
    let powerful = ["operator", "full"].contains(body["tier"] as? String ?? "")
    switch (method, path) {
    case ("POST", "/api/bots"):
      if powerful && approval == nil {
        status = 428; out = ["error": "Waiting for the owner.", "approvalRequired": true, "approvalId": "ap1", "code": "123456", "where": "this computer"]
      } else {
        status = 201; out = ["bot": ["id": (body["id"] as? String ?? "").lowercased(), "name": body["name"] ?? "", "enabled": true]]
      }
    case ("PUT", "/api/bots/scout/permissions"):
      if powerful && approval == nil {
        status = 428; out = ["error": "Waiting for the owner.", "approvalRequired": true, "approvalId": "ap1", "code": "123456", "where": "this computer"]
      } else { out = ["permissions": [:] as [String: Any]] }
    case ("GET", "/api/security/approvals/ap1/status"): out = ["status": Self.approval]
    case ("GET", "/api/bots/scout"):
      out = ["bot": ["id": "scout", "name": "Scout", "enabled": true, "schedules": [], "autonomy": ["dailyTokenBudget": 500000, "maxSteps": 25]]]
    case ("GET", "/api/bots/scout/persona"): out = ["persona": "You scout."]
    case ("PATCH", "/api/bots/scout"), ("PATCH", "/api/bots/rust-watch"):
      out = ["bot": ["id": path.split(separator: "/").last.map(String.init)!, "name": body["name"] ?? "Scout", "enabled": true,
                     "schedules": body["schedules"] ?? [], "autonomy": ["dailyTokenBudget": 500000, "maxSteps": 25]]]
    case ("POST", "/api/bots/rust-watch/run"): status = 409; out = ["accepted": false, "reasonCode": "target_disabled"]
    case ("GET", "/api/bots"): out = ["bots": [], "available": true]
    case ("GET", "/api/bots/approvals"): out = ["approvals": []]
    default: break
    }
    let data = try! JSONSerialization.data(withJSONObject: out)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor @Suite(.serialized)
struct BotEditorTests {
  func client() -> MercuryClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [BotMercury.self]
    return MercuryClient(baseURL: URL(string: "http://mercury.test")!, token: "t", session: URLSession(configuration: config))
  }

  @Test func aNewBotIsMadeThenItsSchedulesAreRegistered() async {
    BotMercury.reset()
    let f = NewBotModel(client: client(), existingIds: ["rust-watch"])
    f.fields = BotFields(name: "Rust Watch", description: "HN", persona: "You watch HN.", tier: "readonly",
                         schedules: [BotSchedule(name: "routine", cron: "0 9 * * *", prompt: " Check ")])
    let id = await f.create(gate: OwnerGate(client: f.client))
    #expect(id == "rust-watch-2")
    #expect(f.error == nil)
    #expect(BotMercury.log.map { "\($0.method) \($0.path)" } == ["POST /api/bots", "PATCH /api/bots/rust-watch-2"])
    #expect(BotMercury.log[0].body["tier"] as? String == "readonly")
    #expect((BotMercury.log[1].body["schedules"] as? [[String: Any]])?.first?["prompt"] as? String == "Check")
  }

  @Test func aLevelThatRunsCommandsWaitsForTheOwnerThenRepeatsWithTheApproval() async {
    BotMercury.reset()
    let f = NewBotModel(client: client(), existingIds: [])
    f.fields = BotFields(name: "Deployer", persona: "You deploy.", tier: "operator")
    let gate = OwnerGate(client: f.client)
    let id = await f.create(gate: gate)
    #expect(id == "deployer")
    let creates = BotMercury.log.filter { $0.path == "/api/bots" }
    #expect(creates.map(\.approval) == [nil, "ap1"])
    #expect(gate.question == nil)
  }

  @Test func theOwnerSayingNoMakesNothingAndSaysSo() async {
    BotMercury.reset()
    BotMercury.approval = "denied"
    let f = NewBotModel(client: client(), existingIds: [])
    f.fields = BotFields(name: "Deployer", persona: "You deploy.", tier: "full")
    #expect(await f.create(gate: OwnerGate(client: f.client)) == nil)
    #expect(f.error == "The owner said no.")
    #expect(f.createdId == nil)
  }

  @Test func theFormRefusesBeforeAnyRequest() async {
    BotMercury.reset()
    let f = NewBotModel(client: client(), existingIds: [])
    f.fields = BotFields(name: "X", persona: "")
    #expect(await f.create(gate: OwnerGate(client: f.client)) == nil)
    #expect(f.error == "Say how it should work (its instructions).")
    #expect(BotMercury.log.isEmpty)
  }

  @Test func editSendsOnlyWhatChangedAndGatesTheLevel() async {
    BotMercury.reset()
    let e = EditBotModel(client: client(), id: "scout", tier: "readonly")
    await e.load()
    #expect(e.fields.name == "Scout" && e.fields.persona == "You scout." && e.fields.budget == "500000")
    #expect(!e.dirty)
    e.fields.name = "Scout Two"
    e.fields.persona = "You scout carefully."
    e.fields.tier = "operator"
    #expect(await e.save(gate: OwnerGate(client: e.client)))
    let writes = BotMercury.log.filter { $0.method != "GET" }
    #expect(writes.map { "\($0.method) \($0.path)" } == ["PATCH /api/bots/scout", "PUT /api/bots/scout/persona", "PUT /api/bots/scout/permissions", "PUT /api/bots/scout/permissions"])
    #expect(writes[0].body.keys.sorted() == ["name"])
    #expect(writes.map(\.approval) == [nil, nil, nil, "ap1"])
    #expect(!e.dirty)
  }

  @Test func runNowRefusedIsSaidPlainly() async {
    BotMercury.reset()
    let m = BotsModel(client: client())
    #expect(await m.control(.runNow, "rust-watch") == "It's off. Turn it on first.")
  }
}
