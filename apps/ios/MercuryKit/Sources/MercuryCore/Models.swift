import Foundation

/// A Mercury this phone can reach. The token is never stored here: it lives in the Keychain under `connection:<id>`.
public struct Connection: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  /// An origin with no trailing slash, e.g. https://mercury.tail1234.ts.net
  public var baseURL: URL
  public var deviceId: String?
  public var createdAt: Date
  public var lastUsedAt: Date?
  /// Which of the Mercury logos this one wears (`ConnectionLogos.ids`); nil in records saved before
  /// logos, until the store gives them one.
  public var logo: String?

  public init(id: String = Connection.newId(), name: String, baseURL: URL, deviceId: String? = nil, createdAt: Date = .now, logo: String? = nil) {
    self.id = id; self.name = name; self.baseURL = baseURL; self.deviceId = deviceId; self.createdAt = createdAt; self.logo = logo
  }

  /// The logo to draw: the saved one, else the first.
  public var logoId: String { logo.flatMap { ConnectionLogos.ids.contains($0) ? $0 : nil } ?? ConnectionLogos.ids[0] }

  /// 12 random hex characters, like Mercury Desktop's connection ids.
  public static func newId() -> String {
    (0..<6).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
  }
}

/// GET /api/health
public struct Health: Decodable, Sendable {
  public var ok: Bool
  public var version: String?
  public var apiVersion: Int?
  public var features: [String]?
  public var setupRequired: Bool?
  /// The computer's host name (newer runtimes, only to a signed-in device): the friendly name's first guess.
  public var host: String?
}

public struct Device: Decodable, Sendable, Hashable {
  public var id: String
  public var name: String
  public var platform: String?
}

public enum MercuryError: LocalizedError, Equatable {
  case badAddress
  case unreachable(String)
  /// A pasted device token that Mercury doesn't know (GET /api/health said 401 or 404).
  case badToken
  /// POST /api/auth/pair said 401: a wrong, used or expired pairing code.
  case badPairCode
  case tooManyAttempts(retryAfter: Int?)
  case unauthorized
  case server(Int, String?)
  /// The owner must allow this change first (approve the code, then it's repeated).
  case needsOwner(OwnerQuestion)

  public var errorDescription: String? {
    switch self {
    case .badAddress: "That doesn't look like a web address. Try something like https://mercury.example.com"
    case .unreachable(let why): "Couldn't reach that Mercury. \(why)"
    case .badToken: "That Mercury doesn't know this token. Check the address, or make a new token with /server token on the computer it runs on."
    case .badPairCode: "This pairing code isn't valid. Make a new one on the computer Mercury runs on."
    case .tooManyAttempts(let s): s.map { "Too many tries. Wait \($0) seconds and try again." } ?? "Too many tries. Try again in a minute."
    case .unauthorized: "This phone isn't signed in to that Mercury any more. Connect again."
    case .server(let code, let msg): msg ?? "Mercury answered with an error (\(code))."
    case .needsOwner(let q): q.message
    }
  }
}
