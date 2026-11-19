import Foundation

// Plugins from the phone: the list, install, on/off, update and remove, over the API Mercury
// Desktop uses (src/web/api/plugins.ts, apps/desktop/src/views/plugins). Every change runs code on
// the computer, so from a phone it needs the owner's approval (428 → OwnerGate).

/// GET /api/plugins: installed plugins and the catalog, merged into one list.
public struct PluginList: Decodable, Sendable {
  public var items: [PluginDetail]
  public var catalogError: String?
  public var stale: Bool?
  public var safeMode: Bool?
  public init(items: [PluginDetail], catalogError: String? = nil, safeMode: Bool? = nil) {
    self.items = items; self.catalogError = catalogError; self.safeMode = safeMode
  }
}

/// POST /api/plugins/install's answer.
public struct PluginInstalled: Decodable, Sendable, Equatable {
  public var id: String
  public var name: String?
  public var version: String?
  public var unchanged: Bool?
}

/// The decisions behind the Plugins screens, kept apart from the views so tests can check them.
public enum Plugins {
  /// A Mercury can take plugin changes from a phone when it has the plugins API and the owner's
  /// approval for remote changes (before `security.remote`, remote plugin changes were refused).
  public static let manageFeatures = ["plugins", "security.remote"]

  public static func canManage(_ features: [String]?) -> Bool {
    guard let features else { return false }
    return manageFeatures.allSatisfy(features.contains)
  }

  /// Installed means an installed version. GET /api/plugins/:id also answers for a plugin that's only
  /// in the catalog (no installedVersion, no settings): that isn't installed.
  public static func isInstalled(_ p: PluginDetail?) -> Bool { p?.installedVersion != nil }

  /// Plugins that use the screen, mouse and keyboard. The installed manifest says so
  /// (`permissions.desktop`); the catalog doesn't carry it, so known ones are named here.
  public static let desktopPlugins: Set<String> = ["optimus"]

  public static func controlsComputer(_ p: PluginDetail) -> Bool {
    p.permissions?.desktop == true || desktopPlugins.contains(p.id)
  }

  public static func updateAvailable(_ p: PluginDetail) -> Bool {
    isInstalled(p) && p.status == "update-available"
  }

  public static func installed(_ items: [PluginDetail]) -> [PluginDetail] { items.filter { isInstalled($0) } }
  public static func available(_ items: [PluginDetail]) -> [PluginDetail] { items.filter { !isInstalled($0) } }

  /// The line under a plugin's name.
  public enum Tone: Equatable { case good, off, warn }
  public static func statusLine(_ p: PluginDetail) -> (text: String, tone: Tone) {
    guard isInstalled(p) else {
      if p.status == "incompatible" { return (needsComputerLine(p) ?? "Can't be installed on this computer", .off) }
      return (p.description ?? "", .off)
    }
    if p.status == "error" || (p.enabled && p.lastError != nil && !p.running) {
      return (p.lastError.map { friendlyError($0, plugin: p) } ?? "Isn't running", .warn)
    }
    if !p.enabled { return (p.disabled?.code == "user" || p.disabled == nil ? "Off" : (p.disabled?.message ?? "Off"), .off) }
    if let m = p.missing, !m.isEmpty { return ("Needs setting up", .warn) }
    return ("On", .good)
  }

  // MARK: Asking first

  /// What's shown before a plugin is installed or turned on.
  public enum Consent: Equatable {
    /// It controls the computer: one clear sentence.
    case controlsComputer(title: String, body: String)
    /// Anything else: what it can reach.
    case access(title: String, lines: [String])

    public var title: String {
      switch self { case .controlsComputer(let t, _), .access(let t, _): t }
    }
  }

  public static func consent(for p: PluginDetail, computer: String, enabling: Bool = false) -> Consent {
    let verb = enabling ? "Turn on" : "Install"
    if controlsComputer(p) {
      return .controlsComputer(
        title: "\(verb) \(p.name)?",
        body: "\(p.name) lets Mercury see the screen and use the mouse and keyboard on \(computer). It asks before anything that submits, sends or deletes.")
    }
    return .access(title: "\(verb) \(p.name)?", lines: accessLines(p, computer: computer))
  }

  /// What a plugin can reach, one line each.
  public static func accessLines(_ p: PluginDetail, computer: String) -> [String] {
    var lines: [String] = []
    if controlsComputer(p) { lines.append("Sees the screen and uses the mouse and keyboard on \(computer)") }
    let hosts = p.permissions?.network ?? []
    if hosts.count > 3 { lines.append("Connects to \(hosts.count) services, like \(hosts.prefix(2).joined(separator: " and "))") }
    else if !hosts.isEmpty { lines.append("Connects to \(hosts.joined(separator: ", "))") }
    let secrets = p.permissions?.secrets ?? []
    if !secrets.isEmpty { lines.append("Can read \(secrets.count == 1 ? "the key" : "\(secrets.count) keys") it needs: \(secrets.prefix(3).joined(separator: ", "))\(secrets.count > 3 ? "…" : "")") }
    for (id, need) in (p.permissions?.providers ?? [:]).sorted(by: { $0.key < $1.key }) {
      lines.append("Uses your \(providerName(id)) key\(need.unlocks.map { " for \($0.prefix(1).lowercased() + $0.dropFirst())" } ?? "")")
    }
    if let tools = p.tools, !tools.isEmpty { lines.append("Gives Mercury \(tools.count) tool\(tools.count == 1 ? "" : "s")") }
    lines.append(p.kind == "in-process" ? "Runs inside Mercury on \(computer)" : "Runs in its own process on \(computer)")
    if hosts.isEmpty && secrets.isEmpty && !controlsComputer(p) { lines.append("Doesn't reach the internet or read any keys") }
    return lines
  }

  static func providerName(_ id: String) -> String {
    switch id {
    case "openai": "OpenAI"
    case "grok", "xai": "Grok"
    case "gemini", "google": "Gemini"
    case "anthropic": "Anthropic"
    default: id.prefix(1).uppercased() + id.dropFirst()
    }
  }

  // MARK: Errors

  /// "Optimus needs a desktop computer…" when the computer can't run a desktop plugin.
  static func needsComputerLine(_ p: PluginDetail) -> String? {
    guard controlsComputer(p) else { return nil }
    return "\(p.name) needs a desktop computer (a Mac, Windows or Linux with a screen)"
  }

  /// The server's error in plain words. Install refuses a platform it has no build for
  /// ("Optimus can't be installed here: not available for android-arm64 …"); on a server with no
  /// screen it installs but can't start (the error then mentions the display).
  public static func friendlyError(_ message: String, plugin p: PluginDetail) -> String {
    let m = message.lowercased()
    let platform = m.contains("can't be installed here") || m.contains("not available for")
    let noScreen = m.contains("display") || m.contains("x11") || m.contains("xcb") || m.contains("wayland") || m.contains("no screen")
    if let line = needsComputerLine(p), platform || noScreen {
      return "\(line). This Mercury runs where there isn't one."
    }
    if m.contains("safe mode") { return "Mercury is in safe mode, so plugins are off. Restart Mercury normally to use them." }
    return message
  }

  // MARK: After installing

  /// Where a plugin stands once an install or turn-on went through.
  public enum After: Equatable {
    /// Installed and running.
    case running
    /// Installed and on, but it wants something set first (a key, a choice).
    case needsSetup
    /// Installed, still starting (the screen keeps checking).
    case starting
    /// Installed, but it didn't start: why.
    case failed(String)
    /// Not there at all (the list didn't pick it up).
    case missing
  }

  public static func after(_ p: PluginDetail?) -> After {
    guard let p, isInstalled(p) else { return .missing }
    if let why = p.lastError ?? (p.status == "error" ? "It didn't start." : nil) { return .failed(friendlyError(why, plugin: p)) }
    if !p.enabled, let d = p.disabled, d.code != "user" { return .failed(d.message ?? "It was turned off.") }
    if !(p.missing ?? []).isEmpty { return .needsSetup }
    if p.running || (p.enabled && p.kind == "in-process") { return .running }
    return .starting
  }
}

extension MercuryClient {
  public func pluginList(refresh: Bool = false) async throws -> PluginList {
    try await decode(PluginList.self, request("GET", refresh ? "/api/plugins?refresh=1" : "/api/plugins", timeout: 30))
  }

  /// Installs a catalog plugin and turns it on. Downloads it on the computer, so it can take a while.
  public func installPlugin(_ id: String, approval: String? = nil) async throws -> PluginInstalled {
    var r = try gated("POST", "/api/plugins/install", body: ["source": id, "enable": true], approval: approval)
    r.timeoutInterval = 600
    return try await decode(PluginInstalled.self, r)
  }

  public func setPluginEnabled(_ id: String, _ on: Bool, approval: String? = nil) async throws {
    struct R: Decodable { var ok: Bool? }
    var r = try gated("POST", "/api/plugins/\(id)/\(on ? "enable" : "disable")", approval: approval)
    r.timeoutInterval = 120
    _ = try await decode(R.self, r)
  }

  /// Updates one plugin to the catalog's version.
  public func updatePlugin(_ id: String, approval: String? = nil) async throws {
    struct R: Decodable { var changed: [Changed]?; struct Changed: Decodable { var id: String } }
    var r = try gated("POST", "/api/plugins/\(id)/update", approval: approval)
    r.timeoutInterval = 600
    _ = try await decode(R.self, r)
  }

  /// Removes a plugin (its settings stay unless `purge`).
  public func uninstallPlugin(_ id: String, purge: Bool = false, approval: String? = nil) async throws {
    struct R: Decodable { var ok: Bool? }
    var r = try gated("DELETE", "/api/plugins/\(id)\(purge ? "?purge=1" : "")", approval: approval)
    r.timeoutInterval = 120
    _ = try await decode(R.self, r)
  }
}
