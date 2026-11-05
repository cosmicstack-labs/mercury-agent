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
