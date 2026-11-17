import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// A Mercury that answers GET /api/workspace/info and keeps what POST /api/chat/send was sent.
final class CodeMercury: URLProtocol {
  nonisolated(unsafe) static var sent: [[String: Any]] = []
  nonisolated(unsafe) static var workspace = #"{"cwd":"/Users/me/mercury","projectName":"mercury","projectType":"node","isGit":true,"branch":"main","remoteUrl":""}"#
  static let lock = NSLock()
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url?.path ?? ""
    var body = "{}", code = 404
    switch (request.httpMethod ?? "", path) {
    case ("POST", "/api/chat/threads"): body = #"{"id":"t1","createdAt":"2026-11-16T10:00:00Z","messages":[]}"#; code = 200
    case ("GET", "/api/workspace/info"): Self.lock.lock(); body = Self.workspace; Self.lock.unlock(); code = 200
    case ("POST", "/api/chat/send"):
      let data = request.httpBody ?? Self.read(request.httpBodyStream)
      Self.lock.lock()
      Self.sent.append((try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
      Self.lock.unlock()
      body = #"{"ok":true}"#; code = 200
    default: break
    }
    let res = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}

  static func read(_ s: InputStream?) -> Data {
    guard let s else { return Data() }
    s.open(); defer { s.close() }
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 4096)
    while s.hasBytesAvailable {
      let n = s.read(&buf, maxLength: buf.count)
      if n <= 0 { break }
      out.append(buf, count: n)
    }
    return out
  }

  static func client(workspace: String? = nil) -> MercuryClient {
    lock.lock(); sent = []
    workspace.map { self.workspace = $0 }
    lock.unlock()
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [CodeMercury.self]
    return MercuryClient(baseURL: URL(string: "http://127.0.0.1:6175")!, token: "mdt_x_y", session: URLSession(configuration: c))
  }
}

/// Ask | Code: Code sends a coding turn in Mercury's project folder, as Mercury Desktop's Code view
/// does (`programming: "auto"` and `cwd`); Ask sends neither.
@Suite(.serialized) @MainActor
struct CodeModeTests {
  @Test func thePillReadsAskAndCode() {
    #expect(AskCode.label(false) == "Ask")
    #expect(AskCode.label(true) == "Code")
  }

  @Test func codeSendsProgrammingAndTheWorkspaceFolder() async throws {
    let m = ConversationModel(client: CodeMercury.client(), thread: nil)
    m.code = true
    m.draft = "Fix the failing test"
    await m.send()
    let body = try #require(CodeMercury.sent.first)
    #expect(body["programming"] as? String == "auto")
    #expect(body["cwd"] as? String == "/Users/me/mercury")
    #expect(m.workspace?.name == "mercury")
    m.listener?.cancel()
  }

  @Test func askSendsNoCodingFields() async throws {
    let m = ConversationModel(client: CodeMercury.client(), thread: nil)
    m.draft = "What's the weather?"
    await m.send()
    let body = try #require(CodeMercury.sent.first)
    #expect(body["programming"] == nil)
    #expect(body["cwd"] == nil)
    m.listener?.cancel()
  }

  @Test func anOlderMercuryWithoutAWorkspaceStillSendsCode() async throws {
    let m = ConversationModel(client: CodeMercury.client(workspace: "{}"), thread: nil)
    m.code = true
    m.draft = "Refactor it"
    await m.send()
    let body = try #require(CodeMercury.sent.first)
    #expect(body["programming"] as? String == "auto")
    #expect(body["cwd"] == nil)
    m.listener?.cancel()
    _ = CodeMercury.client(workspace: #"{"cwd":"/Users/me/mercury","projectName":"mercury"}"#)
  }
}

/// A new chat with the keyboard up: the mark and greeting go, the chips stay just above the
/// composer as many as fit, and nothing ever overlaps, down to an iPhone SE.
struct NewChatSpaceTests {
  @Test func chipHeights() {
    #expect(QuickActions.height(0) == 0)
    let one: CGFloat = 44 + 12 + 4
    #expect(QuickActions.height(1) == one)
    let five: CGFloat = 268
    #expect(QuickActions.height(5) == five)
  }

  @Test func roomyPhoneKeyboardDownShowsEverything() {
    let l = NewChatSpace.layout(height: 560, chips: 5, typing: false)
    #expect(l == .init(hello: true, chips: 5))
  }

  @Test func typingHidesTheMarkAndKeepsTheChips() {
    let l = NewChatSpace.layout(height: 560, chips: 5, typing: true)
    #expect(l.hello == false)
    #expect(l.chips == 5)
  }

  @Test func neverOverlapsAtAnyHeight() {
    for typing in [false, true] {
      for h in stride(from: 0.0, through: 900.0, by: 1.0) {
        let l = NewChatSpace.layout(height: h, chips: 5, typing: typing)
        let used = QuickActions.height(l.chips) + l.helloHeight
        #expect(used <= h, "height \(h): \(l)")
        if typing { #expect(!l.hello) }
      }
    }
  }

  @Test func iPhoneSEWithTheKeyboardKeepsSomeChips() {
    // 667 − 20 status − 60 bar − 116 composer − 216 keyboard ≈ 255 pt between the bar and the box.
    let l = NewChatSpace.layout(height: 255, chips: 5, typing: true)
    #expect(l.chips == 4)
    #expect(!l.hello)
    // Keyboard down on the same phone: ≈ 471 pt, room for all five and the mark.
    #expect(NewChatSpace.layout(height: 471, chips: 5, typing: false) == .init(hello: true, chips: 5))
    // Shorter still: all the chips and a smaller mark.
    #expect(NewChatSpace.layout(height: 400, chips: 5, typing: false) == .init(hello: true, chips: 5, compact: true))
  }
}
