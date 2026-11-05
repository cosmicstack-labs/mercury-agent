import Testing
import Foundation
@testable import MercuryCore

/// Needs MERCURY_URL and MERCURY_TOKEN (e.g. the attach token on the runtime's computer).
struct LiveStreamTests {
  static let env = ProcessInfo.processInfo.environment
  static var client: MercuryClient? {
    guard let u = env["MERCURY_URL"].flatMap(URL.init(string:)), let t = env["MERCURY_TOKEN"] else { return nil }
    return MercuryClient(baseURL: u, token: t)
  }

  @Test(.enabled(if: client != nil)) func listsThreads() async throws {
    let threads = try await Self.client!.threads()
    #expect(threads.allSatisfy { !$0.id.isEmpty })
  }

  @Test(.enabled(if: client != nil)) func activityStreamOpens() async throws {
    // The stream sends nothing until something happens; opening it without an error is the check.
    let stream = Self.client!.events("/api/chat/activity")
    let t = Task { for await _ in stream { break } }
    try await Task.sleep(for: .seconds(1))
    t.cancel()
  }
}
