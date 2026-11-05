import SwiftUI
import MercuryCore

/// One conversation: its messages, the reply as it streams, the live steps and plan,
/// and any question Mercury is waiting on (apps/desktop/src/app/events.ts is the reference).
@MainActor @Observable
final class ConversationModel {
  enum Agent: Equatable { case idle, thinking, working, streaming }

  struct Step: Identifiable, Equatable { var id: Int; var tool: String; var label: String; var done = false; var failed = false; var summary: String? }
  struct PlanStep: Equatable { var label: String; var status: String }
  struct Prompt: Identifiable, Equatable {
    struct Option: Equatable, Hashable { var value: String; var label: String }
    var id: String; var kind: String; var text: String; var options: [Option]; var targetId: String?
  }

  var threadId: String?
  var title: String
  var messages: [ChatMessage] = []
  var agent: Agent = .idle
  var streaming = ""
  var steps: [Step] = []
  var plan: [PlanStep] = []
  var prompts: [Prompt] = []
  var pendingArtifacts: [ArtifactRef] = []
  var queued: Int?
  var draft = ""
  var error: String?
  var loaded = false
  let client: MercuryClient
  var listener: Task<Void, Never>?
  var onChange: () -> Void = {}

  init(client: MercuryClient, thread: ChatThread?) {
    self.client = client
    threadId = thread?.id
    title = thread?.displayTitle ?? "New chat"
  }

  var busy: Bool { agent != .idle }
  var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  func load() async {
    guard let id = threadId else { loaded = true; return }
    do {
      let t = try await client.thread(id)
      messages = t.messages.filter(\.isShown)
      title = t.displayTitle
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
    listen()
  }

  func listen() {
    guard let id = threadId else { return }
    listener?.cancel()
    listener = Task {
      for await e in client.events("/api/chat/events?sessionId=\(id)") { handle(e.name, e.data) }
    }
  }

  func send() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draft = ""
    error = nil
    do {
      if threadId == nil {
        let t = try await client.createThread()
        threadId = t.id
        listen()
      }
      messages.append(ChatMessage(role: "user", content: text))
      agent = .thinking
      steps = []
      try await client.send(text, sessionId: threadId!)
      onChange()
    } catch {
      self.error = error.localizedDescription
      agent = .idle
      draft = text
    }
  }

  func stop() async {
    try? await client.stop()
  }

  func answer(_ p: Prompt, _ value: String) async {
    prompts.removeAll { $0.id == p.id }
    do { try await client.answer(promptId: p.id, action: value, targetId: p.targetId) }
    catch { self.error = error.localizedDescription }
  }

  // MARK: Events

  func handle(_ event: String, _ raw: String) {
    let data = (raw.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    if let s = data["sessionId"] as? String, let id = threadId, s != id { return }
    switch event {
    case "queued":
      queued = data["position"] as? Int ?? 1
      agent = .thinking
    case "thinking":
      queued = nil
      if agent == .idle { agent = .thinking }
    case "step_start":
      queued = nil
      let tool = data["tool"] as? String ?? ""
      let n = (data["step"] ?? data["stepNumber"]) as? Int ?? steps.count + 1
      steps.append(Step(id: n, tool: tool, label: data["label"] as? String ?? Self.label(tool)))
      agent = .working
    case "step_done":
      let tool = data["tool"] as? String ?? ""
      if let i = steps.lastIndex(where: { !$0.done && $0.tool == tool }) {
        steps[i].done = true
        steps[i].failed = data["failed"] as? Bool ?? false
        steps[i].summary = (steps[i].failed ? data["reason"] : data["summary"]) as? String
      }
    case "text_delta":
      queued = nil
      agent = .streaming
      streaming += data["text"] as? String ?? ""
    case "text_done":
      let text = (data["fullText"] ?? data["text"]) as? String ?? streaming
      let stopped = text.range(of: #"^\s*⏹\s*Task (stopped|halted)"#, options: .regularExpression) != nil
      if stopped {
        if !streaming.isEmpty { messages.append(ChatMessage(role: "assistant", content: streaming, stopped: true)) }
      } else if !text.isEmpty {
        messages.append(ChatMessage(role: "assistant", content: text, artifacts: pendingArtifacts.isEmpty ? nil : pendingArtifacts))
      }
      finishTurn()
    case "plan":
      plan = (data["steps"] as? [[String: Any]] ?? []).map { PlanStep(label: $0["label"] as? String ?? "", status: $0["status"] as? String ?? "pending") }
    case "artifacts":
      let items = (data["items"] as? [[String: Any]] ?? []).compactMap(Self.artifact)
      if agent == .idle, let i = messages.lastIndex(where: { $0.role == "assistant" }) {
        messages[i].artifacts = (messages[i].artifacts ?? []) + items
      } else {
        pendingArtifacts += items
      }
    case "permission_request", "permission_continue", "choice_prompt":
      let options: [Prompt.Option] = (data["options"] as? [Any] ?? []).map {
        if let v = $0 as? String { return .init(value: v, label: Self.optionLabel(v)) }
        let o = $0 as? [String: Any] ?? [:]
        let v = o["value"] as? String ?? ""
        return .init(value: v, label: o["label"] as? String ?? v)
      }
      let text = (data["prompt"] ?? data["question"]) as? String ?? ""
      let id = data["id"] as? String ?? UUID().uuidString
      prompts.removeAll { $0.id == id }
      prompts.append(Prompt(id: id, kind: event, text: text, options: options, targetId: data["targetId"] as? String))
    case "permission_resolved", "choice_resolved":
      if let id = data["id"] as? String { prompts.removeAll { $0.id == id } }
    case "error":
      messages.append(ChatMessage(role: "system", content: data["message"] as? String ?? "Something went wrong."))
      finishTurn()
    default:
      break
    }
  }

  func finishTurn() {
    streaming = ""
    steps = []
    pendingArtifacts = []
    queued = nil
    agent = .idle
    onChange()
  }

  static func optionLabel(_ v: String) -> String {
    switch v { case "yes": "Allow once"; case "always": "Always allow"; case "no": "Deny"; default: v }
  }

  /// A friendly name for a tool while it runs.
  static func label(_ tool: String) -> String {
    switch tool {
    case "web_search", "search": "Searching the web"
    case "fetch_url", "web_fetch", "read_url": "Reading a page"
    case "run_command", "bash", "shell": "Running a command"
    case "read_file": "Reading a file"
    case "write_file", "edit_file": "Writing a file"
    default: tool.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }

  static func artifact(_ d: [String: Any]) -> ArtifactRef? {
    guard let data = try? JSONSerialization.data(withJSONObject: d) else { return nil }
    return try? JSONDecoder().decode(ArtifactRef.self, from: data)
  }
}
