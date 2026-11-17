import Foundation
import MercuryCore

/// The call's chat thread as the call brain sees it: questions go in with the app's chat API
/// (/api/chat/send with `voiceCall` = the call's id, so a new thread is named "Voice call · <time>"),
/// and the reply, the activity and the approvals come from the thread's events (ConversationModel).
@MainActor
final class ConversationCallChat: CallChat {
  let conversation: ConversationModel
  /// Long enough for a turn that waits on the owner's approval (voice.rs ASK_TIMEOUT).
  var timeout: Duration = .seconds(300)

  private var waiting: [UUID: CheckedContinuation<CallAnswer, Never>] = [:]
  private var order: [UUID] = []
  /// Turns already running when a question was sent: their ends aren't its reply.
  private var foreignTurns = 0

  init(conversation: ConversationModel, callId: String) {
    self.conversation = conversation
    conversation.callId = callId
    conversation.onTurnEnd = { [weak self] reply in self?.turnEnded(reply) }
  }

  /// The call is over: the chat goes back to being a chat; anyone still waiting gets no answer.
  func detach() {
    conversation.callId = nil
    conversation.onTurnEnd = { _ in }
    for id in order { waiting.removeValue(forKey: id)?.resume(returning: .stopped) }
    order = []
  }

  func ask(_ question: String) async -> CallAnswer {
    let id = UUID()
    if conversation.busy && order.isEmpty { foreignTurns += 1 }
    // Waiting before sending: a quick reply can't arrive before anyone listens for it.
    return await withCheckedContinuation { (c: CheckedContinuation<CallAnswer, Never>) in
      waiting[id] = c
      order.append(id)
      let limit = timeout
      Task { [weak self] in
        guard let self else { return }
        let m = self.conversation
        m.draft = question
        m.attachments = []
        m.media = nil
        await m.send()
        if let e = m.error {
          m.error = nil
          m.draft = ""
          self.resolve(id, .failed(e))
        }
      }
      Task { [weak self] in
        try? await Task.sleep(for: limit)
        self?.resolve(id, .timedOut)
      }
    }
  }

  private func resolve(_ id: UUID, _ answer: CallAnswer) {
    guard let c = waiting.removeValue(forKey: id) else { return }
    order.removeAll { $0 == id }
    c.resume(returning: answer)
  }

  /// A turn ended in the thread: the oldest question waiting gets it.
  func turnEnded(_ reply: ChatMessage?) {
    if foreignTurns > 0 { foreignTurns -= 1; return }
    guard let id = order.first else { return }
    resolve(id, Self.answer(reply, conversation: conversation))
  }

  static func answer(_ reply: ChatMessage?, conversation: ConversationModel) -> CallAnswer {
    if let reply, !reply.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let failed = conversation.traces[reply.id]?.steps.filter { $0.status == .error || $0.status == .stopped }.map(\.label) ?? []
      return .reply(reply.content, failedSteps: failed)
    }
    // An error ends the turn with a line of its own.
    if let last = conversation.messages.last, last.role == "system", !last.content.isEmpty { return .failed(last.content) }
    return .stopped
  }

  var activity: String? {
    let c = conversation
    guard c.busy else { return nil }
    if c.queued != nil { return "Waiting for another chat to finish" }
    if let s = c.live?.runningStep { return s.label }
    if !c.streaming.isEmpty { return "Writing the answer" }
    return "Thinking"
  }

  var working: Bool { conversation.busy }

  var approvals: [CallApproval] {
    conversation.prompts.filter { $0.kind == "permission_request" || $0.kind == "permission_continue" }
      .map { CallApproval(id: $0.id, text: $0.text, targetId: $0.targetId) }
  }

  func answer(_ approval: CallApproval, approved: Bool) async throws {
    // Only yes or no from a call: never "always".
    try await conversation.client.answer(promptId: approval.id, action: approved ? "yes" : "no", targetId: approval.targetId)
    conversation.prompts.removeAll { $0.id == approval.id }
  }

  func stopWork() async { await conversation.stop() }
}
