import Testing
import Foundation
@testable import MercuryCore
@testable import MercuryUI

@Suite struct PermissionModeTests {
  func json(_ s: String) -> Data { Data(s.utf8) }

  @Test func readsTheModeOrTheOlderFlag() {
    #expect(PermissionMode.decode(json(#"{"bypassPermissions":true,"permissionMode":"allow-all"}"#)) == .allowAll)
    #expect(PermissionMode.decode(json(#"{"bypassPermissions":false,"permissionMode":"ask-me"}"#)) == .askMe)
    // An older Mercury: only bypassPermissions.
    #expect(PermissionMode.decode(json(#"{"bypassPermissions":true,"restrictUser":false}"#)) == .allowAll)
    #expect(PermissionMode.decode(json(#"{"bypassPermissions":false}"#)) == .askMe)
    #expect(PermissionMode.decode(json(#"{"workspace":"/x"}"#)) == nil)
    #expect(PermissionMode.decode(json("not json")) == nil)
  }

  @Test func readsTheLiveStatus() {
    #expect(PermissionMode.fromStatus(["permission": "allow-all", "model": "x"]) == .allowAll)
    #expect(PermissionMode.fromStatus(["permission": "ask-me"]) == .askMe)
    #expect(PermissionMode.fromStatus(["permission": "other"]) == nil)
    #expect(PermissionMode.fromStatus(["model": "x"]) == nil)
  }

  @Test func wordsTheOptions() {
    #expect(PermissionMode.askMe.title == "Ask Me")
    #expect(PermissionMode.askMe.detail == "Mercury asks before anything risky")
    #expect(PermissionMode.allowAll.title == "Allow All")
    #expect(PermissionMode.allowAll.detail == "Mercury acts without asking")
    #expect(PermissionMode.allCases == [.askMe, .allowAll])
  }
}

@MainActor @Suite struct PermissionModelTests {
  struct Refused: LocalizedError { var errorDescription: String? { "The owner said no." } }

  @Test func refreshReadsMercurysSetting() async {
    let p = PermissionModel(load: { .allowAll }, save: { $0 })
    #expect(p.mode == nil && !p.allowAll)
    await p.refresh()
    #expect(p.mode == .allowAll && p.allowAll)
  }

  @Test func refreshKeepsWhatsKnownWhenMercuryCantBeAsked() async {
    let p = PermissionModel(load: { throw Refused() }, save: { $0 })
    p.show(.askMe)
    await p.refresh()
    #expect(p.mode == .askMe)
    #expect(p.error == nil)
  }

  @Test func switchesAtOnceThenTakesMercurysAnswer() async {
    var sent: [PermissionMode] = []
    let p = PermissionModel(load: { .askMe }, save: { m in sent.append(m); return m })
    p.show(.askMe)
    await p.set(.allowAll)
    #expect(sent == [.allowAll])
    #expect(p.mode == .allowAll && !p.saving && p.error == nil)
    // The same mode again: nothing to send.
    await p.set(.allowAll)
    #expect(sent == [.allowAll])
  }

  @Test func showsTheNewModeWhileSaving() async {
    let gate = AsyncStream<Void>.makeStream()
    let p = PermissionModel(load: { .askMe }, save: { m in for await _ in gate.stream { break }; return m })
    p.show(.askMe)
    let t = Task { await p.set(.allowAll) }
    for _ in 0..<100 where !p.saving { await Task.yield() }
    #expect(p.saving)
    #expect(p.mode == .allowAll)  // optimistic
    gate.continuation.yield()
    await t.value
    #expect(!p.saving && p.mode == .allowAll)
  }

  @Test func revertsAndSaysWhyWhenRefused() async {
    let p = PermissionModel(load: { .askMe }, save: { _ in throw Refused() })
    p.show(.askMe)
    await p.set(.allowAll)
    #expect(p.mode == .askMe)
    #expect(!p.saving)
    #expect(p.error == "Couldn't switch to Allow All: The owner said no.")
    // The next switch clears the line.
    let ok = PermissionModel(load: { .askMe }, save: { $0 })
    ok.show(.allowAll)
    ok.error = "old"
    await ok.set(.askMe)
    #expect(ok.error == nil && ok.mode == .askMe)
  }

  @Test func followsChangesMadeElsewhere() {
    let p = PermissionModel(load: { .askMe }, save: { $0 })
    p.show(.askMe)
    p.apply(status: ["permission": "allow-all", "model": "claude"])
    #expect(p.allowAll)
    p.apply(status: ["model": "claude"])  // no word on permissions: unchanged
    #expect(p.allowAll)
    p.apply(status: ["permission": "ask-me"])
    #expect(p.mode == .askMe)
  }

  @Test func theConversationFollowsTheStatusStream() {
    let c = ConversationModel(client: MercuryClient(baseURL: URL(string: "http://permissions.test")!), thread: nil)
    c.permissions.show(.askMe)
    c.handle("status", #"{"provider":"Anthropic","model":"claude","permission":"allow-all"}"#)
    #expect(c.permissions.allowAll)
    c.handle("status", #"{"permission":"ask-me"}"#)
    #expect(!c.permissions.allowAll)
  }
}

/// PUT /api/chat/settings, as Mercury answers it: at once (current), or 428 for the owner (older).
final class CannedSettings: URLProtocol {
  nonisolated(unsafe) static var status = 200
  nonisolated(unsafe) static var bodies: [String] = []
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "settings.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var body = request.httpBody
    if body == nil, let s = request.httpBodyStream {
      s.open(); var d = Data(); var buf = [UInt8](repeating: 0, count: 1024)
      while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
      s.close(); body = d
    }
    Self.bodies.append(String(decoding: body ?? Data(), as: UTF8.self))
    let approval = request.value(forHTTPHeaderField: "X-Mercury-Approval")
    let (code, json): (Int, String) = switch (request.httpMethod, Self.status, approval) {
    case ("GET", _, _): (200, #"{"bypassPermissions":false,"restrictUser":false,"workspace":"","permissionMode":"ask-me"}"#)
    case (_, 428, nil): (428, #"{"error":"Waiting for the owner.","approvalId":"ap1","code":"482913","where":"Mercury Desktop"}"#)
    case (_, 428, _?): (200, #"{"success":true,"bypassPermissions":true,"restrictUser":false,"workspace":""}"#)
    default: (200, #"{"success":true,"bypassPermissions":true,"restrictUser":false,"workspace":"","permissionMode":"allow-all"}"#)
    }
    let res = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(json.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@Suite(.serialized) struct PermissionClientTests {
  func client() -> MercuryClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CannedSettings.self]
    return MercuryClient(baseURL: URL(string: "http://settings.test")!, token: "t", session: URLSession(configuration: config))
  }

  @Test func readsAndSwitches() async throws {
    CannedSettings.status = 200
    CannedSettings.bodies = []
    let c = client()
    #expect(try await c.permissionMode() == .askMe)
    #expect(try await c.setPermissionMode(.allowAll) == .allowAll)
    #expect(CannedSettings.bodies.last == #"{"bypassPermissions":true}"#)
  }

  @Test func anOlderMercuryAsksTheOwner() async throws {
    CannedSettings.status = 428
    defer { CannedSettings.status = 200 }
    let c = client()
    do {
      _ = try await c.setPermissionMode(.allowAll)
      Issue.record("should ask the owner")
    } catch MercuryError.needsOwner(let q) {
      #expect(q.id == "ap1" && q.code == "482913" && q.where_ == "Mercury Desktop")
    }
    // Repeated with the approval, it goes through (an older Mercury sends no permissionMode).
    #expect(try await c.setPermissionMode(.allowAll, approval: "ap1") == .allowAll)
  }
}
