import Testing
@testable import MercuryUI

@MainActor
struct AskTests {
  func ask(_ text: String, kind: String = "permission_request") -> Ask {
    Ask(.init(id: "1", kind: kind, text: text, options: [], targetId: nil))
  }

  @Test func aCommandShowsExactlyWhatRuns() {
    let a = ask("Run command: git push origin main")
    #expect(a.title == "Mercury wants to run a command")
    #expect(a.detail == "git push origin main")
  }

  @Test func aConfigCommandSaysWhyItAlwaysAsks() {
    let a = ask("Run command (changes Mercury's MCP servers or config, so it always asks): mercury mcp add x")
    #expect(a.detail == "mercury mcp add x")
    #expect(a.note != nil)
  }

  @Test func filesAndOtherQuestions() {
    #expect(ask("Write to file: /tmp/a.txt").detail == "/tmp/a.txt")
    #expect(ask("Read file: /etc/hosts").title == "Mercury wants to read a file")
    #expect(ask("Still working after 40 steps. Continue?", kind: "permission_continue").title == "Keep going?")
  }
}
