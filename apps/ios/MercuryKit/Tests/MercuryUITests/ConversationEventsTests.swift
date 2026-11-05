import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

@MainActor
struct ConversationEventsTests {
  func model() -> ConversationModel {
    let m = ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: ChatThread(id: "s1", title: "Test", createdAt: .now))
    m.agent = .thinking
    return m
  }

  @Test func aReplyStreamsThenLands() {
    let m = model()
    m.handle("step_start", #"{"tool":"web_search","step":1,"totalSteps":2}"#)
    #expect(m.agent == .working)
    #expect(m.steps.first?.label == "Searching the web")
    m.handle("step_done", #"{"tool":"web_search","summary":"4 results","stepNumber":1}"#)
    #expect(m.steps.first?.done == true)
    m.handle("text_delta", #"{"text":"Hello "}"#)
    m.handle("text_delta", #"{"text":"there"}"#)
    #expect(m.streaming == "Hello there")
    m.handle("text_done", #"{"fullText":"Hello there."}"#)
    #expect(m.agent == .idle)
    #expect(m.messages.last?.content == "Hello there.")
    #expect(m.streaming.isEmpty && m.steps.isEmpty)
  }

  @Test func otherSessionsAreIgnored() {
    let m = model()
    m.handle("text_delta", #"{"text":"not mine","sessionId":"other"}"#)
    #expect(m.streaming.isEmpty)
  }

  @Test func anApprovalWaitsThenClears() {
    let m = model()
    m.handle("permission_request", #"{"id":"perm_1","prompt":"Run npm run deploy?","options":["yes","always","no"],"targetId":"s1"}"#)
    #expect(m.prompts.count == 1)
    #expect(m.prompts[0].options.map(\.label) == ["Allow once", "Always allow", "Deny"])
    #expect(m.prompts[0].targetId == "s1")
    m.handle("permission_resolved", #"{"id":"perm_1"}"#)
    #expect(m.prompts.isEmpty)
  }

  @Test func aStoppedTurnKeepsWhatWasWritten() {
    let m = model()
    m.handle("text_delta", #"{"text":"Half an ans"}"#)
    m.handle("text_done", #"{"fullText":"⏹ Task stopped."}"#)
    #expect(m.messages.last?.content == "Half an ans")
    #expect(m.messages.last?.stopped == true)
  }

  @Test func filesMadeDuringTheTurnAttachToTheReply() {
    let m = model()
    m.handle("artifacts", #"{"items":[{"id":"a1","name":"report.pdf","kind":"pdf","size":2048}]}"#)
    m.handle("text_done", #"{"fullText":"Done."}"#)
    #expect(m.messages.last?.artifacts?.first?.name == "report.pdf")
  }

  @Test func theErrorEventEndsTheTurn() {
    let m = model()
    m.handle("error", #"{"message":"The model is unavailable"}"#)
    #expect(m.agent == .idle)
    #expect(m.messages.last?.role == "system")
  }
}
