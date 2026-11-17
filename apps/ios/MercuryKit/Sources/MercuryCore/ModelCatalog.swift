import Foundation

// The composer's model pill and picker (Mercury Desktop: views/chat/Composer.tsx's model menu;
// Android: core/ModelCatalog.kt). Mercury has no per-chat model: GET /api/chat/models lists what
// every configured provider offers and which one is current; POST /api/chat/models/switch changes
// Mercury's model for every chat (it isn't owner-gated). "Auto" is the default Mercury is
// configured with (GET /api/providers/settings `default`), so picking it goes back to that.

/// One model a provider offers (GET /api/chat/models `providers[]`).
public struct ModelChoice: Decodable, Hashable, Sendable, Identifiable {
  /// The provider's id ("anthropic", "openrouter").
  public var name: String
  public var model: String
  public var label: String?
  /// The family Mercury files it under ("Claude", "GPT"), for the picker's groups.
  public var group: String?
  public var available: Bool
  public var isCurrent: Bool

  public var id: String { "\(name):\(model)" }
  public var title: String { label.flatMap { $0.isEmpty ? nil : $0 } ?? model }
  public func same(_ provider: String, _ model: String) -> Bool { name == provider && self.model == model }

  public init(name: String, model: String, label: String? = nil, group: String? = nil, available: Bool = true, isCurrent: Bool = false) {
    self.name = name; self.model = model; self.label = label; self.group = group; self.available = available; self.isCurrent = isCurrent
  }

  enum Keys: String, CodingKey { case name, model, label, group, available, isCurrent }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: Keys.self)
    name = try c.decode(String.self, forKey: .name)
    model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
    label = try? c.decodeIfPresent(String.self, forKey: .label)
    group = try? c.decodeIfPresent(String.self, forKey: .group)
    available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? true
    isCurrent = (try? c.decodeIfPresent(Bool.self, forKey: .isCurrent)) ?? false
  }
}

/// Every model, the current one, and what Mercury runs by default.
public struct ModelCatalog: Hashable, Sendable {
  public var models: [ModelChoice]
  public var current: ModelChoice?
  /// The configured default (provider, model): "Auto". Nil when this Mercury didn't say.
  public var defaultProvider: String?
  public var defaultModel: String?
  public var notices: [String] = []

  public init(models: [ModelChoice], current: ModelChoice?, defaultProvider: String? = nil, defaultModel: String? = nil, notices: [String] = []) {
    self.models = models; self.current = current; self.defaultProvider = defaultProvider; self.defaultModel = defaultModel; self.notices = notices
  }

  /// Running the configured default: the pill says "Auto".
  public var isAuto: Bool {
    guard let current, let p = defaultProvider, let m = defaultModel else { return false }
    return current.same(p, m)
  }
  /// What the pill says.
  public var pill: String { isAuto || current == nil ? "Auto" : current!.title }
  public var defaultChoice: ModelChoice? {
    guard let p = defaultProvider, let m = defaultModel else { return nil }
    return models.first { $0.same(p, m) } ?? ModelChoice(name: p, model: m)
  }
}

/// The picker's rows: "Auto" first, then the models by group, filtered as you type.
public enum ModelMenu {
  public struct Group: Hashable, Sendable { public var title: String; public var models: [ModelChoice] }

  public static func groups(_ models: [ModelChoice], query: String = "") -> [Group] {
    let q = query.trimmingCharacters(in: .whitespaces)
    let shown = q.isEmpty ? models : models.filter {
      $0.title.localizedCaseInsensitiveContains(q) || $0.model.localizedCaseInsensitiveContains(q)
        || $0.name.localizedCaseInsensitiveContains(q) || ($0.group?.localizedCaseInsensitiveContains(q) ?? false)
    }
    var out: [Group] = []
    for m in shown {
      let key = m.group.flatMap { $0.isEmpty ? nil : $0 } ?? providerName(m.name)
      if let i = out.firstIndex(where: { $0.title == key }) { out[i].models.append(m) } else { out.append(Group(title: key, models: [m])) }
    }
    return out
  }

  /// "openrouter" → "OpenRouter", "mercuryCloud" → "Mercury Cloud".
  public static func providerName(_ id: String) -> String {
    switch id {
    case "openai": return "OpenAI"
    case "openrouter": return "OpenRouter"
    case "anthropic": return "Anthropic"
    case "deepseek": return "DeepSeek"
    case "mercuryCloud": return "Mercury Cloud"
    case "ollama": return "Ollama"
    case "lmstudio": return "LM Studio"
    default:
      let spaced = id.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
      return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
  }

  /// Where a pick goes: Auto (nil) goes back to the configured default.
  public static func target(_ c: ModelCatalog, _ pick: ModelChoice?) -> (provider: String, model: String)? {
    if let pick { return (pick.name, pick.model) }
    guard let p = c.defaultProvider, let m = c.defaultModel else { return nil }
    return (p, m)
  }
}

extension MercuryClient {
  /// What models there are and which runs now; with the configured default when Mercury says.
  public func modelCatalog(sessionId: String? = nil) async throws -> ModelCatalog {
    struct R: Decodable { var providers: [ModelChoice]?; var current: ModelChoice?; var notices: [String]? }
    let path = "/api/chat/models" + (sessionId.map { "?sessionId=\(Self.q($0))" } ?? "")
    let r = try await decode(R.self, request("GET", path, timeout: 30))
    let models = r.providers ?? []
    let current = models.first(where: \.isCurrent) ?? r.current
    let d = try? await providerSettings().default
    let dp = d.flatMap { $0.provider.isEmpty ? nil : $0.provider }
    let dm = d.map { $0.model.isEmpty ? (current?.model ?? "") : $0.model }
    return ModelCatalog(models: models, current: current, defaultProvider: dp, defaultModel: dp == nil ? nil : dm, notices: r.notices ?? [])
  }

  /// Switches Mercury's model (every chat). Throws with Mercury's words when it says no.
  public func switchModel(provider: String, model: String) async throws {
    let j = try await json(request("POST", "/api/chat/models/switch", body: ["provider": provider, "model": model], timeout: 30))
    if (j["ok"] as? Bool) == false || (j["success"] as? Bool) == false {
      throw MercuryError.server(200, (j["message"] as? String) ?? (j["error"] as? String) ?? "Mercury couldn't switch to that model.")
    }
  }
}
