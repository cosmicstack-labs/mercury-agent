import Foundation

/// A one-time pairing code from the computer Mercury runs on (`/server pair`, or Mercury Desktop's
/// Pair a phone): 25 characters from 0-9 and A-Z without I, L, O and U, shown in groups of five.
public enum PairCode {
  public static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
  public static let length = 25

  /// What the person typed, as the runtime reads it: upper case, only letters and digits,
  /// O as 0 and I or L as 1 (the same as the runtime's `normalizePairCode`).
  public static func normalize(_ typed: String) -> String {
    String(typed.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
      .map { c -> Character in
        switch c {
        case "O": "0"
        case "I", "L": "1"
        default: c
        }
      })
  }

  /// A normalized code that could be one: the right length, every character from the alphabet.
  public static func isValid(_ code: String) -> Bool {
    code.count == length && code.allSatisfy(alphabet.contains)
  }

  /// "7K3MQ-…": groups of five, as the computer shows it.
  public static func display(_ code: String) -> String {
    stride(from: 0, to: code.count, by: 5).map { i in
      let start = code.index(code.startIndex, offsetBy: i)
      return String(code[start..<(code.index(start, offsetBy: 5, limitedBy: code.endIndex) ?? code.endIndex)])
    }.joined(separator: "-")
  }
}

/// `mercury://pair?u=<address>&c=<code>`: what the computer's QR code holds. The address is the
/// Mercury to pair with; the code is good once, for a few minutes.
public struct PairLink: Equatable, Hashable, Sendable, Identifiable {
  public var address: URL
  public var code: String
  public var id: String { "\(address.absoluteString)#\(code)" }

  public init(address: URL, code: String) { self.address = address; self.code = code }

  public enum Problem: LocalizedError, Equatable {
    case notAPairLink
    case badAddress
    case insecureAddress
    case badCode

    public var errorDescription: String? {
      switch self {
      case .notAPairLink: "That isn't a Mercury pairing code."
      case .badAddress: MercuryError.badAddress.errorDescription
      case .insecureAddress: "Plain http:// works only on your own network. Use an https:// address."
      case .badCode: "That code isn't complete. It has 25 letters and numbers."
      }
    }
  }

  /// Whether `url` is a pairing link at all (the scheme and the `pair` host), valid or not.
  public static func isPairLink(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "mercury" else { return false }
    let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
    return c?.host?.lowercased() == "pair" || c?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased() == "pair"
  }

  /// Reads a scanned or opened pairing link.
  public static func parse(_ url: URL) throws -> PairLink {
    guard isPairLink(url), let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw Problem.notAPairLink }
    let items = c.queryItems ?? []
    let u = items.first { $0.name == "u" }?.value ?? ""
    let code = items.first { $0.name == "c" }?.value ?? ""
    // `u` arrives decoded once; a second layer of encoding ("https%3A%2F%2F…") is undone too.
    let address = u.contains("://") ? u : (u.removingPercentEncoding ?? u)
    return try make(address: address, code: code)
  }

  /// Reads what a QR code held (text, not yet a URL).
  public static func parse(_ text: String) throws -> PairLink {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw Problem.notAPairLink }
    return try parse(url)
  }

  /// A typed address and code: the address as the other connect screens read it, http:// only on
  /// this phone's own network, and the code normalized.
  public static func make(address typed: String, code typedCode: String) throws -> PairLink {
    let url = try checkedAddress(typed)
    let code = PairCode.normalize(typedCode)
    guard PairCode.isValid(code) else { throw Problem.badCode }
    return PairLink(address: url, code: code)
  }

  public static func checkedAddress(_ typed: String) throws -> URL {
    guard let url = MercuryClient.normalize(typed) else { throw Problem.badAddress }
    guard LocalNetwork.allows(url) else { throw Problem.insecureAddress }
    return url
  }

  /// "mac.tail1234.ts.net" (with the port when it has one): what the confirm question names.
  public var host: String {
    let h = address.host() ?? address.absoluteString
    return address.port.map { "\(h):\($0)" } ?? h
  }
}

/// What the person typed in "Enter a code or token": a pairing code (`/server pair`, any grouping
/// or case) or a device token (`/server token <name>`, `mdt_<8 hex>_<64 hex>`). Nothing else connects.
public enum ConnectSecret: Equatable, Sendable {
  case pairCode(String)
  case token(String)

  public enum Problem: LocalizedError, Equatable {
    case empty
    case badToken
    case neither

    public var errorDescription: String? {
      switch self {
      case .empty: "Enter the pairing code or the device token from your computer."
      case .badToken: "That token isn't complete. Copy the whole line that starts with mdt_."
      case .neither: "That isn't a pairing code or a device token. A code has 25 letters and numbers; a token starts with mdt_."
      }
    }
  }

  /// `mdt_<8 hex>_<64 hex>`, lower case, as the runtime makes it.
  static func isWholeToken(_ s: String) -> Bool {
    let parts = s.split(separator: "_", omittingEmptySubsequences: false)
    let hex = Set("0123456789abcdef")
    return parts.count == 3 && parts[0] == "mdt" && parts[1].count == 8 && parts[2].count == 64
      && parts[1].allSatisfy(hex.contains) && parts[2].allSatisfy(hex.contains)
  }

  /// Anything starting with `mdt_` is a token (spaces and line breaks from pasting dropped);
  /// anything else must normalize to a full pairing code.
  public static func read(_ typed: String) throws -> ConnectSecret {
    let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw Problem.empty }
    if isToken(trimmed) {
      let token = trimmed.filter { !$0.isWhitespace }
      guard isWholeToken(token) else { throw Problem.badToken }
      return .token(token)
    }
    let code = PairCode.normalize(trimmed)
    guard PairCode.isValid(code) else { throw Problem.neither }
    return .pairCode(code)
  }

  /// Whether it's meant as a token (it starts with `mdt_`), complete or not.
  public static func isToken(_ typed: String) -> Bool {
    typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("mdt_")
  }
}
