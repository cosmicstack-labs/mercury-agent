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

  func request(_ method: String, _ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 15) throws -> URLRequest {
    var r = URLRequest(url: baseURL.appending(path: path), timeoutInterval: timeout)
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

  // MARK: Pairing (ADR-035)

  /// POST /api/auth/token. Off the runtime's own computer this starts a pairing the owner must approve.
  public func signIn(username: String, password: String, deviceName: String, platform: String = "ios") async throws -> SignInResult {
    let body: [String: Any] = ["username": username, "password": password, "deviceName": deviceName, "platform": platform]
    let (data, res) = try await send(request("POST", "/api/auth/token", body: body))
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    switch res.statusCode {
    case 200:
      guard let token = json["token"] as? String else { throw MercuryError.server(200, "Mercury didn't send a token.") }
      return .signedIn(token: token, device: Self.device(json["device"]))
    case 202:
      guard let id = json["pairingId"] as? String, let poll = json["pollToken"] as? String, let code = json["code"] as? String else {
        throw MercuryError.server(202, "Mercury started a pairing but left out its code.")
      }
      return .pending(Pairing(pairingId: id, pollToken: poll, code: code, message: json["message"] as? String, expiresAt: Self.date(json["expiresAt"])))
    case 401: throw MercuryError.badCredentials
    case 404: throw MercuryError.unreachable("That address answers, but it isn't a Mercury (or it's too old to pair a phone).")
    case 409: throw MercuryError.deviceLimit
    case 429: throw MercuryError.tooManyAttempts(retryAfter: (res.value(forHTTPHeaderField: "Retry-After")).flatMap { Int($0) })
    default: throw MercuryError.server(res.statusCode, json["error"] as? String)
    }
  }

  /// POST /api/auth/token/pending: holds for up to about 25 s, then answers with the pairing's status.
  public func pairingStatus(_ p: Pairing) async throws -> PairingStatus {
    let body: [String: Any] = ["pairingId": p.pairingId, "pollToken": p.pollToken, "waitMs": 25_000]
    let (data, res) = try await send(request("POST", "/api/auth/token/pending", body: body, timeout: 40))
    let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    let error = json["error"] as? String
    switch json["status"] as? String {
    case "pending": return .pending
    case "approved":
      guard let token = json["token"] as? String else { throw MercuryError.server(res.statusCode, "Approved, but Mercury didn't send a token.") }
      return .approved(token: token, device: Self.device(json["device"]))
    case "denied": return .denied(error ?? "The owner said no.")
    case "expired": return .expired(error ?? "The code expired.")
    default:
      if res.statusCode == 410 || res.statusCode == 404 { return .expired(error ?? "The code expired.") }
      throw MercuryError.server(res.statusCode, error)
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
