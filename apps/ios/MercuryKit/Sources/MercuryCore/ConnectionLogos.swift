import Foundation

/// The playful Mercury logos a connection can wear (drawn by MercuryUI's `MercuryLogo`), and the
/// rules for a new connection's name and logo. Android: ConnectionLogos.kt, the same ids and order.
public enum ConnectionLogos {
  /// In the default rotation's order: the first Mercury gets the first, the next the second, and so on.
  public static let ids = [
    "shades", "party", "headphones", "wizard", "astronaut", "chef",
    "crown", "sleepy", "wink", "hearts", "ninja", "pirate",
  ]

  /// The logo for the next connection: the first in the rotation no saved Mercury wears yet, else the
  /// rotation continued by how many there are.
  public static func next(after connections: [Connection]) -> String {
    let used = Set(connections.compactMap(\.logo))
    return ids.first { !used.contains($0) } ?? ids[connections.count % ids.count]
  }

  /// Records saved before logos: each gets its place in the rotation (the first #1, the second #2…),
  /// a name when it has none (its host), and keeps everything else. Nil when nothing changed.
  public static func migrate(_ connections: [Connection]) -> [Connection]? {
    var changed = false
    let out = connections.enumerated().map { i, c -> Connection in
      var c = c
      if c.logo == nil || !ids.contains(c.logo!) { c.logo = ids[i % ids.count]; changed = true }
      if c.name.trimmingCharacters(in: .whitespaces).isEmpty { c.name = c.baseURL.host() ?? "Mercury"; changed = true }
      return c
    }
    return changed ? out : nil
  }

  /// A first guess at a friendly name: "Mercury on MacBook Pro" from the host name the runtime
  /// reports, else from the address's own name when it's one ("studio.local"), else the address's
  /// host ("mercury.example.com"), and plain "Mercury" for a bare IP or localhost.
  public static func suggestedName(host: String?, url: URL) -> String {
    if let h = host.map(pretty), !h.isEmpty { return "Mercury on \(h)" }
    guard let urlHost = url.host(), !urlHost.isEmpty else { return "Mercury" }
    if urlHost == "localhost" || urlHost.allSatisfy({ $0.isNumber || $0 == "." || $0 == ":" }) || urlHost.contains(":") { return "Mercury" }
    if urlHost.hasSuffix(".local") { return "Mercury on \(pretty(urlHost))" }
    return urlHost
  }

  /// "Salmans-MacBook-Pro.local" → "Salmans MacBook Pro".
  static func pretty(_ host: String) -> String {
    var h = host.trimmingCharacters(in: .whitespaces)
    for suffix in [".local", ".lan", ".home", ".localdomain"] where h.lowercased().hasSuffix(suffix) {
      h = String(h.dropLast(suffix.count))
    }
    return h.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
      .split(separator: " ").joined(separator: " ")
  }
}
