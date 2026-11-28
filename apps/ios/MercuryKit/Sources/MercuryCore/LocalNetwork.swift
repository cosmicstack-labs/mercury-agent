import Foundation

/// Plain http:// is allowed only to this phone's own network, as the app's App Transport Security
/// setting (`NSAllowsLocalNetworking` in project.yml) and Android's `LocalNetwork` allow it:
/// loopback, private and link-local addresses (10/8, 172.16/12, 192.168/16, 169.254/16, Tailscale's
/// 100.64/10, IPv6 ULA and link-local), `.local` names (Bonjour) and single-label names. Anything
/// else must be https://.
public enum LocalNetwork {
  public static func allowsCleartext(_ host: String) -> Bool {
    var h = host.trimmingCharacters(in: .whitespaces).lowercased()
    if h.hasPrefix("[") { h.removeFirst() }
    if h.hasSuffix("]") { h.removeLast() }
    while h.hasSuffix(".") { h.removeLast() }
    if h.isEmpty { return false }
    if h == "localhost" || h.hasSuffix(".localhost") || h.hasSuffix(".local") { return true }
    if let b = ipv4(h) { return isPrivate4(b) }
    if h.contains(":") { return isPrivate6(h) }
    // A single-label name ("mymac") only resolves on the local network.
    return !h.contains(".")
  }

  /// Whether this phone may talk to `url`: https:// anywhere, http:// only on the local network.
  public static func allows(_ url: URL) -> Bool {
    switch url.scheme?.lowercased() {
    case "https": return true
    case "http": return allowsCleartext(url.host() ?? "")
    default: return false
    }
  }

  static func ipv4(_ h: String) -> [Int]? {
    let parts = h.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var out: [Int] = []
    for p in parts {
      guard !p.isEmpty, p.count <= 3, p.allSatisfy(\.isASCII), p.allSatisfy(\.isNumber), let n = Int(p), n <= 255 else { return nil }
      out.append(n)
    }
    return out
  }

  static func isPrivate4(_ b: [Int]) -> Bool {
    switch (b[0], b[1]) {
    case (127, _), (10, _): true
    case (172, 16...31): true
    case (192, 168): true
    case (169, 254): true
    case (100, 64...127): true
    default: false
    }
  }

  static func isPrivate6(_ h: String) -> Bool {
    if h == "::1" { return true }
    let firstGroup = h.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    guard !firstGroup.isEmpty, let first = Int(firstGroup, radix: 16) else { return false }
    // fc00::/7 (unique local) and fe80::/10 (link-local)
    return (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
  }
}
