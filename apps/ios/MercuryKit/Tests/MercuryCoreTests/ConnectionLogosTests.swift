import Testing
import Foundation
@testable import MercuryCore

/// Friendly names and logos: old records migrate, new ones get the next logo, edits persist.
@MainActor
struct ConnectionLogosTests {
  func defaults() -> UserDefaults {
    let name = "connection-logos-tests-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
  }

  /// A record list as version 1 saved it: no logo field at all.
  func saveOld(_ d: UserDefaults, names: [String]) {
    let items = names.enumerated().map { i, n in
      #"{"id":"c\#(i)","name":"\#(n)","baseURL":"http:\/\/192.168.1.\#(i + 2):6175","createdAt":0}"#
    }
    let json = #"{"version":1,"connections":[\#(items.joined(separator: ","))],"activeId":"c1"}"#
    d.set(Data(json.utf8), forKey: ConnectionStore.key)
  }

  @Test func oldRecordsKeepTheirNameAndGetTheRotationsLogos() {
    let d = defaults()
    saveOld(d, names: ["studio.local", "Home", ""])
    let store = ConnectionStore(defaults: d)
    #expect(store.connections.map(\.name) == ["studio.local", "Home", "192.168.1.4"])
    #expect(store.connections.map(\.logo) == ["shades", "party", "headphones"])
    #expect(store.activeId == "c1")
    // Saved once: a second launch reads the same logos back.
    let again = ConnectionStore(defaults: d)
    #expect(again.connections.map(\.logo) == ["shades", "party", "headphones"])
    #expect(again.connections.map(\.name) == ["studio.local", "Home", "192.168.1.4"])
  }

  @Test func newMercurysTakeTheNextLogoNotInUse() {
    let url = URL(string: "http://a.local")!
    #expect(ConnectionLogos.next(after: []) == "shades")
    let one = [Connection(name: "A", baseURL: url, logo: "shades")]
    #expect(ConnectionLogos.next(after: one) == "party")
    // The person switched the first to Party: the next is still a fresh one.
    #expect(ConnectionLogos.next(after: [Connection(name: "A", baseURL: url, logo: "party")]) == "shades")
    let two = one + [Connection(name: "B", baseURL: url, logo: "party")]
    #expect(ConnectionLogos.next(after: two) == "headphones")
    // Every logo taken: the rotation carries on by count.
    let all = ConnectionLogos.ids.map { Connection(name: $0, baseURL: url, logo: $0) }
    #expect(ConnectionLogos.next(after: all) == "shades")
    #expect(ConnectionLogos.next(after: all + [all[0]]) == "party")
  }

  @Test func renameAndLogoPersistAndBlankNamesAreIgnored() {
    let d = defaults()
    saveOld(d, names: ["Home", "Work"])
    let store = ConnectionStore(defaults: d)
    store.update("c0", name: "  Mercury on MacBook  ", logo: "wizard")
    store.update("c1", name: "   ", logo: "not-a-logo")
    let again = ConnectionStore(defaults: d)
    #expect(again.connections.map(\.name) == ["Mercury on MacBook", "Work"])
    #expect(again.connections.map(\.logo) == ["wizard", "party"])
    #expect(again.connections[0].logoId == "wizard")
  }

  @Test func aConnectionWithAnUnknownLogoDrawsTheFirst() {
    var c = Connection(name: "A", baseURL: URL(string: "http://a.local")!)
    #expect(c.logoId == "shades")
    c.logo = "gone"
    #expect(c.logoId == "shades")
  }

  @Test func suggestedNamesComeFromTheComputersNameThenTheAddress() {
    let ip = URL(string: "http://192.168.1.7:6175")!
    #expect(ConnectionLogos.suggestedName(host: "Salmans-MacBook-Pro.local", url: ip) == "Mercury on Salmans MacBook Pro")
    #expect(ConnectionLogos.suggestedName(host: "studio", url: ip) == "Mercury on studio")
    #expect(ConnectionLogos.suggestedName(host: "  ", url: ip) == "Mercury")
    #expect(ConnectionLogos.suggestedName(host: nil, url: ip) == "Mercury")
    #expect(ConnectionLogos.suggestedName(host: nil, url: URL(string: "http://localhost:6174")!) == "Mercury")
    #expect(ConnectionLogos.suggestedName(host: nil, url: URL(string: "http://salmans-mac.local:6175")!) == "Mercury on salmans mac")
    #expect(ConnectionLogos.suggestedName(host: nil, url: URL(string: "https://mercury.tail1234.ts.net")!) == "mercury.tail1234.ts.net")
  }
}
