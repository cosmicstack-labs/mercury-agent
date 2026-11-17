import Foundation

// Chat calls added for parity with Mercury Desktop 1.5.2 (apps/desktop/src/api/mercury.ts).
// None of these routes is owner-gated: a paired phone may call them all (src/web/api/chat.ts,
// suggestions.ts, media.ts). Calls a screen can live without return nil on an older runtime.
extension MercuryClient {
  func json(_ r: URLRequest) async throws -> [String: Any] {
    let (data, res) = try await send(r)
    switch res.statusCode {
    case 200..<300: return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(res.statusCode, Self.message(data))
    }
  }

  static func q(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_.~"))) ?? s }

  // MARK: Sending and stopping

  /// POST /api/chat/send with files and the Create switch. The reply streams on /api/chat/events.
  /// `programming`: Mercury's coding mode for this turn only ("auto", "plan", "execute"), the Code switch.
  /// `cwd`: the project folder the coding turn works in, as Mercury Desktop's Code view sends it
  /// (the server checks it's a folder, points the turn there and lets it write there). Sent only
  /// with `programming`: the server ignores it otherwise.
  public func sendMessage(_ content: String, sessionId: String, attachments: [OutgoingAttachment] = [], media: MediaIntent? = nil, voiceCall: String? = nil, programming: String? = nil, cwd: String? = nil) async throws {
    var body: [String: Any] = ["content": content, "sessionId": sessionId]
    if let programming {
      body["programming"] = programming
      if let cwd, !cwd.isEmpty { body["cwd"] = cwd }
    }
    if !attachments.isEmpty { body["attachments"] = attachments.map(\.json) }
    if let media { body["media"] = media.json }
    if let voiceCall { body["voiceCall"] = voiceCall }
    _ = try await json(request("POST", "/api/chat/send", body: body, timeout: attachments.isEmpty ? 15 : 90))
  }

  /// GET /api/workspace/info: Mercury's project folder (the workspace set in Settings, else the
  /// folder Mercury runs in) and its name. Code mode works there.
  public func workspaceInfo() async throws -> WorkspaceInfo {
    let j = try await json(request("GET", "/api/workspace/info"))
    guard let cwd = j["cwd"] as? String, !cwd.isEmpty else { throw MercuryError.server(200, "No workspace folder") }
    let name = (j["projectName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (cwd as NSString).lastPathComponent
    return WorkspaceInfo(cwd: cwd, name: name)
  }

  /// Stops this chat's turn only (other chats keep running, ADR-037), and drops its waiting
  /// messages (ADR-038). Returns the runtime's note, if any.
  @discardableResult
  public func stop(threadId: String) async throws -> String? {
    try await json(request("POST", "/api/chat/stop", body: ["threadId": threadId]))["note"] as? String
  }

  // MARK: Threads

  /// PUT /api/chat/threads/:id/title. The owner's name survives automatic naming. Returns the saved title.
  public func renameThread(_ id: String, title: String) async throws -> String {
    let j = try await json(request("PUT", "/api/chat/threads/\(Self.q(id))/title", body: ["title": title]))
    return j["title"] as? String ?? title
  }

  /// Which chats are working and which wait (nil on runtimes before ADR-037).
  public func runningTurns() async -> TurnsInfo? {
    try? await decode(TurnsInfo.self, request("GET", "/api/chat/running"))
  }

  /// Is this chat's message waiting in line behind another chat? The position when it is.
  public func queuePosition(_ threadId: String) async -> Int? {
    guard let j = try? await json(request("GET", "/api/chat/threads/\(Self.q(threadId))/queue")), j["state"] as? String == "queued" else { return nil }
    return (j["position"] as? Int) ?? 1
  }

  /// The reply this chat is working on now, as far as it got (nil on older runtimes).
  public func liveTurn(_ threadId: String) async -> LiveSnapshot? {
    guard let j = try? await json(request("GET", "/api/chat/threads/\(Self.q(threadId))/live")) else { return nil }
    return LiveSnapshot(running: j["running"] as? Bool ?? false, startedAt: j["startedAt"] as? Double,
                        activity: j["activity"] as? String, trace: StoredTrace(json: j["trace"]), text: j["text"] as? String)
  }

  /// Questions still waiting in this chat, as the events that asked them (name, JSON data).
  public func pendingPrompts(_ sessionId: String) async -> [ServerEvent] {
    guard let j = try? await json(request("GET", "/api/chat/pending?sessionId=\(Self.q(sessionId))")) else { return [] }
    return (j["prompts"] as? [[String: Any]] ?? []).compactMap { p in
      guard let type = p["type"] as? String, let data = try? JSONSerialization.data(withJSONObject: p),
            let s = String(data: data, encoding: .utf8) else { return nil }
      return ServerEvent(name: type, data: s)
    }
  }

  /// The plan Mercury was working through in this chat, if any.
  public func plan(_ sessionId: String) async -> ChatPlan? {
    struct R: Decodable { var plan: ChatPlan? }
    return (try? await decode(R.self, request("GET", "/api/chat/plan?sessionId=\(Self.q(sessionId))")))?.plan
  }

  /// Videos or songs still being made for this chat.
  public func mediaJobs(_ sessionId: String) async -> [PendingMedia] {
    struct R: Decodable { var jobs: [PendingMedia]? }
    return (try? await decode(R.self, request("GET", "/api/media/jobs?sessionId=\(Self.q(sessionId))")))?.jobs ?? []
  }

  // MARK: New chat

  /// GET /api/suggestions: a greeting, a line, and a few things to ask. Throws on older runtimes (503/404).
  public func suggestions(_ n: Int = 4) async throws -> SuggestionPick {
    try await decode(SuggestionPick.self, request("GET", "/api/suggestions?n=\(n)", timeout: 8))
  }

  /// The owner picked one: it leaves the pool.
  public func suggestionUsed(_ id: String) async {
    _ = try? await send(request("POST", "/api/suggestions/\(Self.q(id))/used", body: [:]))
  }

  // MARK: Model, effort and media

  /// The model this chat uses and its effort (GET /api/chat/models `current`).
  public func chatModel(sessionId: String?) async throws -> ChatModelInfo {
    struct R: Decodable { var current: ChatModelInfo }
    let path = "/api/chat/models" + (sessionId.map { "?sessionId=\(Self.q($0))" } ?? "")
    return try await decode(R.self, request("GET", path, timeout: 20)).current
  }

  /// This chat's effort: a level the model takes, "auto", or nil for the model's default.
  @discardableResult
  public func setEffort(sessionId: String, level: String?) async throws -> ChatEffort? {
    let j = try await json(request("POST", "/api/chat/effort", body: ["sessionId": sessionId, "level": level ?? NSNull()]))
    guard let e = j["effort"], let data = try? JSONSerialization.data(withJSONObject: e) else { return nil }
    return try? JSONDecoder().decode(ChatEffort.self, from: data)
  }

  /// Which media this Mercury can make (GET /api/media/models).
  public func mediaAvailability() async throws -> MediaAvailability {
    let j = try await json(request("GET", "/api/media/models", timeout: 20))
    return Self.mediaAvailability(j)
  }

  static func mediaAvailability(_ j: [String: Any]) -> MediaAvailability {
    var using: [MediaIntent.Kind: String] = [:]
    func has(_ k: MediaIntent.Kind) -> Bool {
      guard let info = j[k.rawValue] as? [String: Any] else { return false }
      let models = info["models"] as? [[String: Any]] ?? []
      if let d = info["default"] as? [String: Any], d["available"] as? Bool == true,
         let m = models.first(where: { $0["ref"] as? String == d["ref"] as? String }), let l = m["label"] as? String { using[k] = l }
      else if let a = info["auto"] as? [String: Any], let l = a["label"] as? String { using[k] = l }
      return !models.isEmpty
    }
    return MediaAvailability(image: has(.image), video: has(.video), music: has(.music), using: using)
  }

  /// A file the person sent (`/api/chat/uploads/…`), as a URL the media views load with the token.
  public func uploadURL(_ path: String) -> URL? {
    guard path.hasPrefix("/api/") else { return nil }
    return URL(string: path, relativeTo: baseURL)?.absoluteURL
  }
}

/// The folder a Code turn works in (GET /api/workspace/info).
public struct WorkspaceInfo: Sendable, Equatable {
  public var cwd: String
  public var name: String
  public init(cwd: String, name: String) { self.cwd = cwd; self.name = name }
}
