import Testing
import Foundation
@testable import MercuryCore

/// Runs against a real Mercury when MERCURY_URL is set, e.g. MERCURY_URL=http://127.0.0.1:6174 swift test
struct LiveTests {
  static let url = ProcessInfo.processInfo.environment["MERCURY_URL"].flatMap(URL.init(string:))

  @Test(.enabled(if: url != nil)) func healthFromTheRuntimesOwnComputer() async throws {
    let h = try await MercuryClient(baseURL: Self.url!).health()
    #expect(h.ok)
    #expect(h.apiVersion == 1)
  }

  @Test(.enabled(if: url != nil)) func wrongPasswordSaysSo() async {
    await #expect(throws: MercuryError.badCredentials) {
      try await MercuryClient(baseURL: Self.url!).signIn(username: "nobody", password: "wrong", deviceName: "test")
    }
  }
}
