import Foundation
import Observation

/// The phone's Mercurys and which one is active. Records go in UserDefaults; tokens in the Keychain.
@MainActor @Observable
public final class ConnectionStore {
  public private(set) var connections: [Connection] = []
  public private(set) var activeId: String?
  let defaults: UserDefaults
  static let key = "mercury-connections"

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    if let data = defaults.data(forKey: Self.key), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
      connections = saved.connections; activeId = saved.activeId
      // Saved before friendly names and logos: each gets its logo once, kept from then on.
      if let migrated = ConnectionLogos.migrate(connections) { connections = migrated; save() }
    }
  }

  public var active: Connection? { connections.first { $0.id == activeId } }

  public func client(for c: Connection) -> MercuryClient {
    MercuryClient(baseURL: c.baseURL, token: Keychain.get("connection:\(c.id)"))
  }

  /// The logo a Mercury added now would get by default.
  public var nextLogo: String { ConnectionLogos.next(after: connections) }

  /// Saves a newly paired Mercury and makes it active (with the next logo when it has none).
  public func add(_ c: Connection, token: String) {
    Keychain.set(token, for: "connection:\(c.id)")
    connections.removeAll { $0.id == c.id }
    var c = c
    if c.logo == nil { c.logo = nextLogo }
    connections.append(c)
    activeId = c.id
    save()
  }

  public func activate(_ id: String) {
    guard let i = connections.firstIndex(where: { $0.id == id }) else { return }
    connections[i].lastUsedAt = .now
    activeId = id
    save()
  }

  /// A new friendly name (ignored when blank) and logo for a saved Mercury.
  public func update(_ id: String, name: String, logo: String) {
    guard let i = connections.firstIndex(where: { $0.id == id }) else { return }
    let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if !n.isEmpty { connections[i].name = String(n.prefix(60)) }
    if ConnectionLogos.ids.contains(logo) { connections[i].logo = logo }
    save()
  }

  /// Forgets a Mercury: tells it to revoke this phone's token, then deletes the token and the record.
  public func remove(_ id: String) async {
    guard let c = connections.first(where: { $0.id == id }) else { return }
    await client(for: c).revoke()
    Keychain.remove("connection:\(id)")
    connections.removeAll { $0.id == id }
    if activeId == id { activeId = connections.first?.id }
    save()
  }

  struct Saved: Codable { var version = 2; var connections: [Connection]; var activeId: String? }

  func save() {
    if let data = try? JSONEncoder().encode(Saved(connections: connections, activeId: activeId)) { defaults.set(data, forKey: Self.key) }
  }
}
