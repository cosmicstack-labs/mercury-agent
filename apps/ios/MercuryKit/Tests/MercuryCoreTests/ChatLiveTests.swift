import Testing
import Foundation
@testable import MercuryCore

/// The 1.5.2 chat routes against a real Mercury, read-only. Needs MERCURY_URL and MERCURY_TOKEN
/// (e.g. the attach token on the runtime's computer).
struct ChatLiveTests {
  static let client: MercuryClient? = {
    let env = ProcessInfo.processInfo.environment
    guard let u = env["MERCURY_URL"].flatMap(URL.init(string:)), let t = env["MERCURY_TOKEN"] else { return nil }
    return MercuryClient(baseURL: u, token: t)
  }()

  @Test(.enabled(if: client != nil)) func readsTheChatRoutes() async throws {
    let c = Self.client!
    let threads = try await c.threads()
    #expect(!threads.isEmpty)
    let id = threads[0].id
    let t = try await c.thread(id)
    #expect(t.id == id)
    #expect(await c.runningTurns() != nil)
    _ = await c.queuePosition(id)
    _ = await c.pendingPrompts(id)
    _ = await c.plan(id)
    _ = await c.mediaJobs(id)
    let live = await c.liveTurn(id)
    #expect(live != nil)
    let model = try await c.chatModel(sessionId: id)
    #expect(!model.model.isEmpty)
    _ = try await c.mediaAvailability()
  }

  @Test(.enabled(if: client != nil)) func everyStoredMessageLoads() async throws {
    let c = Self.client!
    // Replies with usage, traces and generated media all decode.
    for t in try await c.threads().prefix(15) { _ = try await c.thread(t.id) }
  }

  @Test(.enabled(if: client != nil)) func suggestionsForANewChat() async throws {
    let p = try await Self.client!.suggestions(4)
    #expect(p.greeting != nil)
  }
}
