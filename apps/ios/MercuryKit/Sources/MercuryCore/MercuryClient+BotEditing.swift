import Foundation

// Making, changing and managing bots (src/web/api/bots.ts; desktop api/mercury.ts `bots`). The
// changes that give a bot more power (a level that runs commands or has full access) need the
// owner's go-ahead from a phone: they answer 428 (MercuryError.needsOwner) and are repeated with
// `approval` through an OwnerGate.

/// What Stop / Start / Run now said.
public struct BotControlResult: Sendable, Equatable {
  public var accepted: Bool
  public var message: String?
  public var reasonCode: String?
  public init(accepted: Bool, message: String? = nil, reasonCode: String? = nil) {
    self.accepted = accepted; self.message = message; self.reasonCode = reasonCode
  }
}

extension MercuryClient {
  /// The JSON object of a 2xx answer, with the same errors as `decode` (401, 428 → needsOwner, else the server's words).
  func object(_ r: URLRequest) async throws -> [String: Any] {
    let (data, res) = try await send(r)
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch res.statusCode {
    case 200..<300: return j
    case 401: throw MercuryError.unauthorized
    case 428:
      if let id = j["approvalId"] as? String, let code = j["code"] as? String {
        throw MercuryError.needsOwner(OwnerQuestion(id: id, code: code, where_: j["where"] as? String ?? "this computer", message: j["error"] as? String ?? "Waiting for the owner."))
      }
      throw MercuryError.server(428, j["error"] as? String)
    default: throw MercuryError.server(res.statusCode, j["error"] as? String)
    }
  }

  // MARK: Making a bot

  /// POST /api/bots. Mercury may lowercase the id: the bot it made is returned.
  @discardableResult
  public func createBot(_ bot: NewBot, approval: String? = nil) async throws -> BotManifest {
    let j = try await object(gated("POST", "/api/bots", body: bot.body, approval: approval))
    guard let m = (j["bot"] as? [String: Any]).flatMap(BotManifest.from) else { throw MercuryError.server(200, "Mercury sent something this app can't read.") }
    return m
  }

  /// POST /api/bots/persona-builder: rough words in, structured instructions out. Nothing is saved.
  /// It asks a model, so it can take up to a minute.
  public func buildPersona(_ text: String, name: String) async throws -> String {
    let j = try await object(request("POST", "/api/bots/persona-builder", body: ["text": text, "name": name], timeout: 120))
    guard let p = j["persona"] as? String, !p.trimmed.isEmpty else { throw MercuryError.server(200, "The persona builder sent nothing back.") }
    return p
  }

  /// POST /api/bots/plan: "Let Mercury decide", one bot or a team. Nothing is made.
  public func planBot(name: String, description: String, persona: String, fleet: Bool = false) async throws -> (plan: BotPlan, maxCrew: Int) {
    var body: [String: Any] = ["name": name, "description": description, "persona": persona]
    if fleet { body["fleet"] = true }
    let j = try await object(request("POST", "/api/bots/plan", body: body, timeout: 120))
    return (BotPlan.from(j["plan"] as? [String: Any] ?? [:]), (j["maxCrew"] as? Int) ?? 6)
  }

  // MARK: Reading and changing one

  /// GET /api/bots/:id: its settings.
  public func botManifest(_ id: String) async throws -> BotManifest {
    let j = try await object(request("GET", Self.botPath(id)))
    guard let m = (j["bot"] as? [String: Any]).flatMap(BotManifest.from) else { throw MercuryError.server(404, "That bot is gone.") }
    return m
  }

  /// GET /api/bots/:id/persona: its instructions.
  public func botPersona(_ id: String) async throws -> String {
    try await object(request("GET", Self.botPath(id) + "/persona"))["persona"] as? String ?? ""
  }

  /// PATCH /api/bots/:id with only what changed. Schedules take effect at once.
  @discardableResult
  public func updateBot(_ id: String, _ changes: BotChanges) async throws -> BotManifest? {
    let j = try await object(request("PATCH", Self.botPath(id), body: changes.body))
    return (j["bot"] as? [String: Any]).flatMap(BotManifest.from)
  }

  /// PUT /api/bots/:id/persona.
  public func setBotPersona(_ id: String, _ persona: String) async throws {
    _ = try await object(request("PUT", Self.botPath(id) + "/persona", body: ["persona": persona]))
  }

  /// PUT /api/bots/:id/permissions with a level. Runs commands / Full access need the owner from a phone.
  public func setBotTier(_ id: String, _ tier: String, approval: String? = nil) async throws {
    _ = try await object(gated("PUT", Self.botPath(id) + "/permissions", body: ["tier": tier], approval: approval))
  }

  /// GET /api/bots/tiers: the levels this Mercury offers, least to most.
  public func botTiers() async throws -> [String] {
    let j = try await object(request("GET", "/api/bots/tiers"))
    let ids = (j["tiers"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
    return ids.isEmpty ? BotTiers.ids : ids
  }

  /// PUT /api/bots/:id/avatar: a png, jpeg, webp or gif, 2 MB at most.
  public func setBotAvatar(_ id: String, image: Data) async throws {
    _ = try await object(request("PUT", Self.botPath(id) + "/avatar", body: ["data": image.base64EncodedString()], timeout: 60))
  }

  /// DELETE /api/bots/:id/avatar: back to the face drawn from its id.
  public func removeBotAvatar(_ id: String) async throws {
    _ = try await object(request("DELETE", Self.botPath(id) + "/avatar"))
  }

  // MARK: Managing

  /// POST /api/bots/:id/enable or /disable.
  public func setBotEnabled(_ id: String, _ on: Bool) async throws {
    _ = try await object(request("POST", Self.botPath(id) + (on ? "/enable" : "/disable"), body: [:]))
  }

  /// POST /api/bots/:id/stop: halts the run and holds what's queued until Start.
  public func stopBot(_ id: String) async throws -> BotControlResult {
    let j = try await object(request("POST", Self.botPath(id) + "/stop", body: [:]))
    return BotControlResult(accepted: true, message: j["message"] as? String)
  }

  /// POST /api/bots/:id/start: lifts a stop, re-runs held work, turns paused schedules back on.
  public func startBot(_ id: String) async throws -> BotControlResult {
    let j = try await object(request("POST", Self.botPath(id) + "/start", body: [:]))
    return BotControlResult(accepted: true, message: j["message"] as? String)
  }

  /// POST /api/bots/:id/run: a run now. Refused (off, stopped, busy…) is `accepted: false`, not an error.
  public func runBotNow(_ id: String) async throws -> BotControlResult {
    let (data, res) = try await send(request("POST", Self.botPath(id) + "/run", body: [:]))
    let j = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch res.statusCode {
    case 200..<300: return BotControlResult(accepted: true)
    case 409: return BotControlResult(accepted: false, reasonCode: j["reasonCode"] as? String)
    case 401: throw MercuryError.unauthorized
    default: throw MercuryError.server(res.statusCode, j["error"] as? String)
    }
  }

  /// DELETE /api/bots/:id: the bot and its folder; a lead takes its whole crew with it.
  public func deleteBot(_ id: String) async throws {
    _ = try await object(request("DELETE", Self.botPath(id)))
  }

  /// POST /api/bots-stop-all: every bot halts and holds its queue.
  public func stopAllBots() async throws {
    _ = try await object(request("POST", "/api/bots-stop-all", body: [:]))
  }

  /// POST /api/bots-start-all.
  public func startAllBots() async throws {
    _ = try await object(request("POST", "/api/bots-start-all", body: [:]))
  }

  // MARK: Fleets

  /// POST /api/bots/:id/promote: it becomes a fleet lead.
  public func promoteBot(_ id: String) async throws {
    _ = try await object(request("POST", Self.botPath(id) + "/promote", body: [:]))
  }

  /// POST /api/bots/:id/autocrew: Mercury designs crew for a lead in the background; they arrive on the roster.
  public func autoCrew(_ id: String) async throws {
    _ = try await object(request("POST", Self.botPath(id) + "/autocrew", body: [:]))
  }

  /// POST /api/bots/:id/crew: a crew member for a lead (it gets the lead's level).
  @discardableResult
  public func addCrew(_ leadId: String, _ member: CrewSpec) async throws -> BotManifest? {
    let body: [String: Any] = ["id": member.id, "name": member.name.trimmed, "description": member.description.trimmed, "persona": member.persona.trimmed]
    return (try await object(request("POST", Self.botPath(leadId) + "/crew", body: body))["bot"] as? [String: Any]).flatMap(BotManifest.from)
  }
}

/// Run now, refused, in words.
public enum BotWords {
  public static func refused(_ code: String?) -> String {
    switch code {
    case "target_disabled": "It's off. Turn it on first."
    case "stopped": "It's stopped. Start it first."
    case "target_unknown": "That bot is gone."
    case "duplicate", "busy": "It's already working on that."
    default: "Not started (\((code ?? "refused").replacingOccurrences(of: "_", with: " ")))."
    }
  }
}
