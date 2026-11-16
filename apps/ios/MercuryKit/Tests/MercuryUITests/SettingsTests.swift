import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// Answers every request with one canned response.
final class Canned: URLProtocol {
  nonisolated(unsafe) static var status = 200
  nonisolated(unsafe) static var body = Data()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let res = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Self.body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@Suite(.serialized)
struct SettingsTests {
  func fields(_ json: String) throws -> [PluginField] {
    try JSONDecoder().decode([PluginField].self, from: Data(json.utf8))
  }

  @Test func pluginFieldsOnlyShowWhenTheyApply() throws {
    let f = try fields(#"""
    [{"key":"voiceEngine","type":"enum","options":["openai","gemini"],"value":"gemini"},
     {"key":"geminiVoice","type":"enum","options":["Kore","Puck"],"when":{"voiceEngine":"gemini"}},
     {"key":"voice","type":"enum","options":["marin"],"when":[{"voiceEngine":["openai","azure"]}]},
     {"key":"bargeIn","type":"boolean","value":false}]
    """#)
    let values: [String: JSONValue] = ["voiceEngine": .string("gemini")]
    #expect(f.filter { $0.applies(values) }.map(\.key) == ["voiceEngine", "geminiVoice", "bargeIn"])
    #expect(f[3].value?.bool == false)
  }

  @Test func settingValuesReadAsText() {
    #expect(JSONValue.number(60).text == "60")
    #expect(JSONValue.number(1.5).text == "1.5")
    #expect(JSONValue.bool(true).text == "true")
  }

  @Test func tokenCountsAreShort() {
    #expect(Tokens.short(2_400_000) == "2.4M")
    #expect(Tokens.short(1_000_000) == "1M")
    #expect(Tokens.short(750_000) == "750k")
    #expect(Tokens.short(1_500) == "1.5k")
    #expect(Tokens.short(42) == "42")
  }

  @Test func aGatedChangeAsksTheOwner() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [Canned.self]
    Canned.status = 428
    Canned.body = Data(#"{"error":"Waiting for the owner to approve: Revoke a device.","approvalRequired":true,"approvalId":"ap1","code":"K7Q2M","where":"Telegram or this computer"}"#.utf8)
    let c = MercuryClient(baseURL: URL(string: "http://mercury.test")!, token: "t", session: URLSession(configuration: config))
    do {
      try await c.revokeDevice("d2")
      Issue.record("expected the owner's question")
    } catch MercuryError.needsOwner(let q) {
      #expect(q.id == "ap1" && q.code == "K7Q2M" && q.where_ == "Telegram or this computer")
    }
  }
}

@MainActor
struct NotifierTests {
  func notifier() -> (Notifier, () -> [String]) {
    let n = Notifier(defaults: UserDefaults(suiteName: "notifier-\(UUID().uuidString)")!)
    var sent: [String] = []
    n.post = { _, title, _ in sent.append(title) }
    return (n, { sent })
  }

  func event(_ kind: String, _ id: String = "s1") -> ActivityEvent {
    try! JSONDecoder().decode(ActivityEvent.self, from: Data(#"{"kind":"\#(kind)","sessionId":"\#(id)","title":"Deploy"}"#.utf8))
  }

  @Test func needsYouIsAnnouncedExceptForTheChatOnScreen() {
    let (n, sent) = notifier()
    n.handle(event("needs_you"))
    n.viewing = "s2"
    n.handle(event("needs_you", "s2"))
    #expect(sent() == ["Mercury needs you"])
  }

  @Test func onlyLongTasksAnnounceTheyFinished() {
    let (n, sent) = notifier()
    let t0 = Date()
    n.handle(event("started"), now: t0)
    n.handle(event("done"), now: t0.addingTimeInterval(5))
    #expect(sent().isEmpty)
    n.handle(event("started"), now: t0)
    n.handle(event("done"), now: t0.addingTimeInterval(45))
    #expect(sent() == ["Done"])
  }

  @Test func turnedOffMeansQuiet() {
    let (n, sent) = notifier()
    n.prefs.failed = false
    n.handle(event("failed"))
    #expect(sent().isEmpty)
  }
}
