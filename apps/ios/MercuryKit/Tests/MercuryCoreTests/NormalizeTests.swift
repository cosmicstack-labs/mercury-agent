import Testing
import Foundation
@testable import MercuryCore

@Test func addsHttpsAndDropsThePath() {
  #expect(MercuryClient.normalize("mercury.example.com/chat?x=1")?.absoluteString == "https://mercury.example.com")
  #expect(MercuryClient.normalize("  http://192.168.1.20:6174/ ")?.absoluteString == "http://192.168.1.20:6174")
}

@Test func rejectsNonsense() {
  #expect(MercuryClient.normalize("") == nil)
  #expect(MercuryClient.normalize("not an address") == nil)
  #expect(MercuryClient.normalize("ftp://x.com") == nil)
}

@Test func readsMillisecondAndIsoDates() {
  #expect(MercuryClient.date(1_700_000_000_000.0) == Date(timeIntervalSince1970: 1_700_000_000))
  #expect(MercuryClient.date("2026-11-05T10:00:00.000Z") != nil)
}

@Test func aQueryInThePathStaysAQuery() throws {
  let c = MercuryClient(baseURL: URL(string: "http://127.0.0.1:6174")!)
  let r = try c.request("GET", "/api/chat/events?sessionId=abc-123")
  #expect(r.url?.absoluteString == "http://127.0.0.1:6174/api/chat/events?sessionId=abc-123")
  #expect(try c.request("GET", "/api/chat/threads").url?.absoluteString == "http://127.0.0.1:6174/api/chat/threads")
}

@Test func aThreadIsNamedByItsTitleNotItsCode() {
  var t = ChatThread(id: "1", title: "Deploy the landing page", createdAt: .now)
  t.alias = "brave-otter-x1z"
  #expect(t.displayTitle == "Deploy the landing page")
  t.title = "New session"
  #expect(t.displayTitle == "New chat")
  t.title = ""
  #expect(t.displayTitle == "New chat")
}
