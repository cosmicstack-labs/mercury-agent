import Foundation

/// Owner tasks (ADR-048, src/security/owner-tasks.ts): something only the owner can do — type the
/// letters of a CAPTCHA, listen to an audio one, read out a one-time code, finish a step on a page
/// and say "done". Mercury shows them on every app connected to it; the first answer from anywhere
/// wins and the task goes everywhere else.
///
///   GET  /api/owner/tasks              → { pending: OwnerTask[] }
///   GET  /api/owner/tasks/:id/media    → the image or audio (behind the Bearer token)
///   POST /api/owner/tasks/:id          { answer } | { decline: true } → { task }; 409 answered or
///                                      expired elsewhere, 404 gone
///   `owner_task` on /api/chat/activity { change: "new" | "settled", …task }
public struct OwnerTask: Sendable, Equatable, Identifiable {
  public struct Media: Sendable, Equatable {
    public enum Kind: String, Sendable { case image, audio }
    public var kind: Kind
    public var mimeType: String
    /// "/api/owner/tasks/<id>/media", fetched with the Bearer token.
    public var url: String
  }

  public enum AnswerKind: String, Sendable { case text, done }

  public var id: String
  /// The short code the owner can also answer with from a messaging app ("K7Q2M 4fz9q").
  public var code: String
  public var title: String
  public var prompt: String
  /// Who is asking: "Mercury", "plugin captcha", a bot.
  public var who: String
  /// The site or page this is for, so the owner can judge it.
  public var link: URL?
  public var media: Media?
  /// "done": no text back, the owner did something and says so.
  public var answerKind: AnswerKind
  public var expiresAt: Date
  /// "pending", "answered", "declined", "expired" or "cancelled".
  public var status: String

  public init(id: String, code: String, title: String, prompt: String, who: String = "Mercury", link: URL? = nil, media: Media? = nil,
              answerKind: AnswerKind = .text, expiresAt: Date, status: String = "pending") {
    self.id = id; self.code = code; self.title = title; self.prompt = prompt; self.who = who; self.link = link
    self.media = media; self.answerKind = answerKind; self.expiresAt = expiresAt; self.status = status
  }

  public init?(json j: [String: Any]) {
    guard let id = j["id"] as? String, !id.isEmpty else { return nil }
    self.id = id
    code = j["code"] as? String ?? ""
    title = j["title"] as? String ?? "Mercury needs you"
    prompt = j["prompt"] as? String ?? ""
    who = (j["who"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Mercury"
    // Only a web page opens from here (never a custom scheme a task could slip in).
    link = (j["link"] as? String).flatMap(URL.init(string:)).flatMap { ["http", "https"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
    if let m = j["media"] as? [String: Any], let kind = (m["kind"] as? String).flatMap(Media.Kind.init(rawValue:)) {
      media = Media(kind: kind, mimeType: m["mimeType"] as? String ?? "", url: m["url"] as? String ?? "/api/owner/tasks/\(id)/media")
    } else {
      media = nil
    }
    answerKind = (j["answerKind"] as? String).flatMap(AnswerKind.init(rawValue:)) ?? .text
    expiresAt = MercuryClient.date(j["expiresAt"]) ?? .distantFuture
    status = j["status"] as? String ?? "pending"
  }

  public var isPending: Bool { status == "pending" }
}

/// An `owner_task` event from the activity stream.
public struct OwnerTaskEvent: Sendable, Equatable {
  /// "new" or "settled".
  public var change: String
  public var task: OwnerTask

  public init(change: String, task: OwnerTask) { self.change = change; self.task = task }

  /// A task to show (new and still pending); anything else means it goes.
  public var isOpen: Bool { change == "new" && task.isPending }

  /// nil for any other event, or a malformed one.
  public static func parse(name: String, data: String) -> OwnerTaskEvent? {
    guard name == "owner_task", let d = data.data(using: .utf8),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let task = OwnerTask(json: j) else { return nil }
    return OwnerTaskEvent(change: j["change"] as? String ?? "new", task: task)
  }
}

/// What became of an answer.
public enum OwnerTaskReply: Sendable, Equatable {
  /// Mercury took it.
  case sent
  /// Already answered or expired elsewhere (409), or gone (404): nothing more to do.
  case gone
}

extension MercuryClient {
  /// GET /api/owner/tasks: what's waiting now.
  public func ownerTasks() async throws -> [OwnerTask] {
    let (data, res) = try await send(request("GET", "/api/owner/tasks"))
    try Self.reachCheck(data, res)
    let items = ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["pending"] as? [[String: Any]]) ?? []
    return items.compactMap(OwnerTask.init(json:)).filter(\.isPending)
  }

  /// The task's image or audio bytes (an <img> can't send the Bearer token; neither can AVPlayer).
  public func ownerTaskMedia(_ task: OwnerTask) async throws -> Data {
    let path = task.media?.url ?? "/api/owner/tasks/\(task.id)/media"
    var r = try request("GET", path, timeout: 30)
    r.setValue("*/*", forHTTPHeaderField: "Accept")
    let (data, res) = try await send(r)
    try Self.reachCheck(data, res)
    return data
  }

  /// POST /api/owner/tasks/:id { answer }. A "done" task with nothing typed sends "done".
  public func answerOwnerTask(_ id: String, answer: String) async throws -> OwnerTaskReply {
    try await postOwnerTask(id, ["answer": answer])
  }

  /// POST /api/owner/tasks/:id { decline: true }: Skip.
  public func declineOwnerTask(_ id: String) async throws -> OwnerTaskReply {
    try await postOwnerTask(id, ["decline": true])
  }

  private func postOwnerTask(_ id: String, _ body: [String: Any]) async throws -> OwnerTaskReply {
    let (data, res) = try await send(request("POST", "/api/owner/tasks/\(id)", body: body))
    if res.statusCode == 409 || res.statusCode == 404 { return .gone }
    try Self.reachCheck(data, res)
    return .sent
  }
}
