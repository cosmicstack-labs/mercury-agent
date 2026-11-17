import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// A slow Mercury: POST /api/chat/threads answers after a pause; every request is counted.
final class SlowMercury: URLProtocol {
  nonisolated(unsafe) static var creates = 0
  nonisolated(unsafe) static var sends = 0
  static let lock = NSLock()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url?.path ?? ""
    var body = "{}"
    var code = 404
    var wait = 0.0
    Self.lock.lock()
    if request.httpMethod == "POST" && path == "/api/chat/threads" {
      Self.creates += 1
      body = #"{"id":"t\#(Self.creates)","createdAt":"2026-11-16T10:00:00Z","messages":[]}"#
      code = 200
      wait = 0.4
    } else if request.httpMethod == "POST" && path == "/api/chat/send" {
      Self.sends += 1
      body = #"{"ok":true}"#
      code = 200
    }
    Self.lock.unlock()
    DispatchQueue.global().asyncAfter(deadline: .now() + wait) { [self] in
      let res = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
  }
  override func stopLoading() {}

  static func client() -> MercuryClient {
    lock.lock(); creates = 0; sends = 0; lock.unlock()
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [SlowMercury.self]
    return MercuryClient(baseURL: URL(string: "http://127.0.0.1:6175")!, token: "mdt_x_y", session: URLSession(configuration: c))
  }
}

/// The vivo's double chat, on iOS: a welcome idea sent, a slow new chat, the idea sent again. One
/// tap = one message = one chat.
@Suite(.serialized) @MainActor
struct DuplicateSendTests {
  @Test func aSecondSendWhileTheChatIsCreatedMakesNoSecondChat() async throws {
    let m = ConversationModel(client: SlowMercury.client(), thread: nil)
    let idea = "Create an Instagram carousel post"
    m.draft = idea
    let first = Task { await m.send() }
    try await Task.sleep(for: .milliseconds(100))
    // Shown at once, before Mercury answers: the welcome is gone.
    #expect(m.messages.filter { $0.role == "user" }.map(\.content) == [idea])
    m.draft = idea
    let second = Task { await m.send() }
    await first.value; await second.value
    #expect(SlowMercury.creates == 1)
    #expect(SlowMercury.sends == 1)
    #expect(m.threadId == "t1")
    #expect(m.messages.filter { $0.role == "user" }.count == 1)
    m.listener?.cancel()
  }

  @Test func twoDifferentMessagesRacingShareOneChat() async throws {
    let m = ConversationModel(client: SlowMercury.client(), thread: nil)
    m.draft = "first"
    let a = Task { await m.send() }
    try await Task.sleep(for: .milliseconds(100))
    m.draft = "second"
    let b = Task { await m.send() }
    await a.value; await b.value
    #expect(SlowMercury.creates == 1)
    #expect(SlowMercury.sends == 2)
    #expect(m.messages.filter { $0.role == "user" }.map(\.content) == ["first", "second"])
    m.listener?.cancel()
  }
}
