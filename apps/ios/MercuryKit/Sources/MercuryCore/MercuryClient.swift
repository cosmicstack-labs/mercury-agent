import Foundation

/// Talks to one Mercury runtime over its HTTP API (src/web/api-contract.ts, API_VERSION 1).
/// The only credential is `Authorization: Bearer <device token>`.
public struct MercuryClient: Sendable {
  public var baseURL: URL
  public var token: String?
  var session: URLSession

  public init(baseURL: URL, token: String? = nil, session: URLSession = .shared) {
    self.baseURL = baseURL; self.token = token; self.session = session
  }

  /// Turns what the person typed into an origin: adds https:// when missing, drops paths and trailing slashes.
  public static func normalize(_ typed: String) -> URL? {
    var s = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty, !s.contains(" ") else { return nil }
    if !s.contains("://") { s = "https://" + s }
    guard var c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), ["http", "https"].contains(scheme),
          let host = c.host, !host.isEmpty else { return nil }
    c.scheme = scheme; c.path = ""; c.query = nil; c.fragment = nil; c.user = nil; c.password = nil
    return c.url
  }

  // MARK: Requests

  /// `path` may end in an already-encoded query ("/api/chat/events?sessionId=…"). It's split off
  /// first: `appending(path:)` would encode the "?" and ask for a path that doesn't exist.
  func request(_ method: String, _ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 15) throws -> URLRequest {
    let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    var url = baseURL.appending(path: String(parts[0]))
    if parts.count == 2, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) {
      c.percentEncodedQuery = String(parts[1])
      url = c.url ?? url
    }
    var r = URLRequest(url: url, timeoutInterval: timeout)
    r.httpMethod = method
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    return r
  }

  func send(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
    do {
      let (data, res) = try await session.data(for: r)
      guard let http = res as? HTTPURLResponse else { throw MercuryError.unreachable("No answer.") }
      return (data, http)
    } catch let e as MercuryError {
      throw e
    } catch let e as URLError {
      throw MercuryError.unreachable(Self.describe(e))
    }
  }

  static func describe(_ e: URLError) -> String {
    switch e.code {
    case .timedOut: "It didn't answer in time."
    case .cannotFindHost, .dnsLookupFailed: "That address doesn't exist."
    case .cannotConnectToHost: "Nothing is answering there. Is Mercury running?"
    case .notConnectedToInternet: "This phone is offline."
    case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate: "Its HTTPS certificate isn't trusted."
    case .appTransportSecurityRequiresSecureConnection: "Plain http:// works only on your own network. Use https:// for anything else."
    default: e.localizedDescription
    }
  }

  static func message(_ data: Data) -> String? {
    (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
  }

  // MARK: Health

  /// GET /api/health. Remote callers need a valid token: without one Mercury answers 404 so scanners can't find it.
  public func health() async throws -> Health {
    let (data, res) = try await send(request("GET", "/api/health", timeout: 5))
    switch res.statusCode {
    case 200: return try JSONDecoder().decode(Health.self, from: data)
    case 401, 404: throw MercuryError.unauthorized
    default: throw MercuryError.server(res.statusCode, Self.message(data))
    }
  }

  // MARK: Connecting a phone (QR pairing code or device token; no password sign-in)

  /// Checks a pasted device token (mdt_…) by asking for GET /api/health with it.
  public func checkToken() async throws -> Health {
    do { return try await health() } catch MercuryError.unauthorized { throw MercuryError.badToken }
  }

  /// POST /api/auth/pair: trades a one-time code from the computer's QR code (or typed) for a
  /// device token. Runtimes that can say `auth.pairCode`.
  public func pair(code: String, deviceName: String, platform: String = "ios") async throws -> (token: String, device: Device?) {
    let body: [String: Any] = ["code": PairCode.normalize(code), "deviceName": deviceName, "platform": platform]
    let (data, res) = try await send(request("POST", "/api/auth/pair", body: body))
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch res.statusCode {
    case 200:
      guard let token = json["token"] as? String else { throw MercuryError.server(200, "Mercury didn't send a token.") }
      return (token, Self.device(json["device"]))
    case 401: throw MercuryError.badPairCode
    case 404: throw MercuryError.unreachable("That Mercury is too old to pair with a code. Update it, or connect with a device token.")
    case 429: throw MercuryError.tooManyAttempts(retryAfter: (res.value(forHTTPHeaderField: "Retry-After")).flatMap { Int($0) })
    // Remote access is off (`remoteOff`) or this address isn't allowed (`addressBlocked`); Mercury words both.
    case 403:
      throw MercuryError.server(403, json["error"] as? String
        ?? (json["remoteOff"] != nil ? "Remote access is turned off on this Mercury. Turn it on with /server on the computer it runs on."
          : json["addressBlocked"] != nil ? "This address is not allowed to connect to this Mercury." : nil))
    default: throw MercuryError.server(res.statusCode, json["error"] as? String)
    }
  }

  /// POST /api/auth/token/revoke: forget this phone on the runtime.
  public func revoke() async {
    _ = try? await send(request("POST", "/api/auth/token/revoke", body: [:]))
  }

  static func device(_ any: Any?) -> Device? {
    guard let d = any as? [String: Any], let id = d["id"] as? String else { return nil }
    return Device(id: id, name: d["name"] as? String ?? "", platform: d["platform"] as? String)
  }

  static func date(_ any: Any?) -> Date? {
    if let s = any as? String { return ISO8601DateFormatter.withFractions.date(from: s) ?? ISO8601DateFormatter().date(from: s) }
    if let n = any as? Double { return Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n) }
    return nil
  }
}

extension ISO8601DateFormatter {
  nonisolated(unsafe) static let withFractions: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
  }()
}
