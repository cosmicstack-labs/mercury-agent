import Testing
import Foundation
@testable import MercuryCore

private let code = "7K3MQ9ABCD2EFGH4JKMN5PQRS"

@Test func codesNormalizeAsTheRuntimeReadsThem() {
  #expect(PairCode.normalize("7k3mq-9abcd 2efgh-4jkmn-5pqrs") == code)
  #expect(PairCode.normalize("o0-iI-lL") == "00" + "1111")
  #expect(PairCode.normalize("  ab–c·d\n") == "ABCD")
  #expect(PairCode.normalize("ÄB") == "B")
}

@Test func onlyFullCodesFromTheAlphabetAreValid() {
  #expect(PairCode.isValid(code))
  #expect(!PairCode.isValid(String(code.dropLast())))
  #expect(!PairCode.isValid(code + "A"))
  #expect(!PairCode.isValid("U" + code.dropFirst()))
  #expect(PairCode.isValid(PairCode.normalize("7K3MQ-9ABCD-2EFGH-4JKMN-5PQRS")))
}

@Test func codesShowInGroupsOfFive() {
  #expect(PairCode.display(code) == "7K3MQ-9ABCD-2EFGH-4JKMN-5PQRS")
  #expect(PairCode.display("ABCDEFG") == "ABCDE-FG")
  #expect(PairCode.display("") == "")
}

@Test func readsTheComputersLink() throws {
  let l = try PairLink.parse("mercury://pair?u=https://mac.tail1234.ts.net&c=\(code)")
  #expect(l.address.absoluteString == "https://mac.tail1234.ts.net")
  #expect(l.code == code)
  #expect(l.host == "mac.tail1234.ts.net")
}

@Test func readsAPercentEncodedAddress() throws {
  let once = try PairLink.parse("mercury://pair?u=https%3A%2F%2Fmac.tail1234.ts.net%3A8443%2F&c=\(code)")
  #expect(once.address.absoluteString == "https://mac.tail1234.ts.net:8443")
  #expect(once.host == "mac.tail1234.ts.net:8443")
  let twice = try PairLink.parse("mercury://pair?u=https%253A%252F%252Fmac.tail1234.ts.net&c=\(code)")
  #expect(twice.address.absoluteString == "https://mac.tail1234.ts.net")
}

@Test func linksAreForgivingAboutCaseAndGrouping() throws {
  let l = try PairLink.parse(URL(string: "MERCURY://PAIR?c=7k3mq-9abcd-2efgh-4jkmn-5pqrs&u=mac.tail1234.ts.net")!)
  #expect(l.code == code)
  #expect(l.address.absoluteString == "https://mac.tail1234.ts.net")
}

@Test func localHttpIsAllowedPublicHttpIsNot() throws {
  #expect(try PairLink.parse("mercury://pair?u=http://192.168.1.7:6174&c=\(code)").address.absoluteString == "http://192.168.1.7:6174")
  #expect(try PairLink.parse("mercury://pair?u=http://studio.local:6174&c=\(code)").address.absoluteString == "http://studio.local:6174")
  #expect(try PairLink.parse("mercury://pair?u=http://100.101.102.103:6174&c=\(code)").host == "100.101.102.103:6174")
  #expect(throws: PairLink.Problem.insecureAddress) { try PairLink.parse("mercury://pair?u=http://mercury.example.com&c=\(code)") }
  #expect(throws: PairLink.Problem.insecureAddress) { try PairLink.parse("mercury://pair?u=http://8.8.8.8&c=\(code)") }
}

@Test func otherCodesAreNotPairLinks() {
  #expect(throws: PairLink.Problem.notAPairLink) { try PairLink.parse("https://mercuryagent.sh") }
  #expect(throws: PairLink.Problem.notAPairLink) { try PairLink.parse("mercury://chat?u=https://a.com&c=\(code)") }
  #expect(throws: PairLink.Problem.notAPairLink) { try PairLink.parse("WIFI:S:home;T:WPA;P:secret;;") }
  #expect(PairLink.isPairLink(URL(string: "mercury://pair?u=x&c=y")!))
  #expect(!PairLink.isPairLink(URL(string: "mercury://call")!))
}

@Test func brokenLinksSayWhy() {
  #expect(throws: PairLink.Problem.badCode) { try PairLink.parse("mercury://pair?u=https://mac.ts.net&c=ABC") }
  #expect(throws: PairLink.Problem.badCode) { try PairLink.parse("mercury://pair?u=https://mac.ts.net") }
  #expect(throws: PairLink.Problem.badAddress) { try PairLink.parse("mercury://pair?c=\(code)") }
  #expect(throws: PairLink.Problem.badAddress) { try PairLink.parse("mercury://pair?u=ftp://mac.ts.net&c=\(code)") }
}

@Test func typedAddressAndCode() throws {
  let l = try PairLink.make(address: " mac.tail1234.ts.net/ ", code: "7k3mq 9abcd 2efgh 4jkmn 5pqrs")
  #expect(l == PairLink(address: URL(string: "https://mac.tail1234.ts.net")!, code: code))
}

@Test func cleartextOnlyOnTheLocalNetwork() {
  for h in ["127.0.0.1", "localhost", "192.168.1.7", "10.0.0.2", "172.20.1.1", "169.254.3.3", "100.101.102.103",
            "mymac.local", "mymac", "::1", "fd7a:115c::1", "fe80::1", "[::1]"] {
    #expect(LocalNetwork.allowsCleartext(h), "\(h)")
  }
  for h in ["8.8.8.8", "172.32.0.1", "mercury.example.com", "2001:db8::1", "192.169.0.1", "100.128.0.1", ""] {
    #expect(!LocalNetwork.allowsCleartext(h), "\(h)")
  }
}

// MARK: "Enter a code or token"

private let token = "mdt_0a1b2c3d_" + String(repeating: "0123456789abcdef", count: 4)

@Test func aTokenIsToldFromACode() throws {
  #expect(try ConnectSecret.read(token) == .token(token))
  #expect(try ConnectSecret.read("  \(token)\n") == .token(token))
  // Pasted across two lines.
  #expect(try ConnectSecret.read(String(token.prefix(40)) + "\n " + String(token.dropFirst(40))) == .token(token))
  #expect(try ConnectSecret.read("7K3MQ-9ABCD-2EFGH-4JKMN-5PQRS") == .pairCode(code))
  #expect(try ConnectSecret.read("7k3mq 9abcd 2efgh 4jkmn 5pqrs") == .pairCode(code))
  #expect(try ConnectSecret.read("7K3MQ9ABCD2EFGH4JKMN5PQRS") == .pairCode(code))
  // O read as 0, I and L as 1, as the runtime does.
  #expect(try ConnectSecret.read("o1234-56789-abcde-fghjk-mnpqi") == .pairCode("0123456789ABCDEFGHJKMNPQ1"))
}

@Test func whatIsNeitherSaysWhy() {
  #expect(throws: ConnectSecret.Problem.empty) { try ConnectSecret.read("  ") }
  #expect(throws: ConnectSecret.Problem.neither) { try ConnectSecret.read("7K3MQ-9ABCD") }
  #expect(throws: ConnectSecret.Problem.neither) { try ConnectSecret.read(code + "A") }
  #expect(throws: ConnectSecret.Problem.neither) { try ConnectSecret.read("my password") }
  #expect(throws: ConnectSecret.Problem.neither) { try ConnectSecret.read("U" + code.dropFirst()) }
  #expect(throws: ConnectSecret.Problem.badToken) { try ConnectSecret.read("mdt_") }
  #expect(throws: ConnectSecret.Problem.badToken) { try ConnectSecret.read(String(token.dropLast())) }
  #expect(throws: ConnectSecret.Problem.badToken) { try ConnectSecret.read(token.uppercased()) }
  #expect(ConnectSecret.isToken(" MDT_abc"))
  #expect(!ConnectSecret.isToken(code))
}
