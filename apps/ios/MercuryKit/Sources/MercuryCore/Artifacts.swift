import Foundation

/// Something Mercury made, listed in GET /api/artifacts.
public struct ArtifactItem: Decodable, Identifiable, Hashable, Sendable {
  public var id: String
  public var threadId: String?
  public var threadTitle: String?
  public var name: String
  /// image, video, audio, pdf, document, text or file
  public var kind: String
  public var mime: String?
  public var size: Int?
  /// Milliseconds since 1970.
  public var createdAt: Double?

  public init(id: String, threadTitle: String?, name: String, kind: String, mime: String? = nil, size: Int? = nil) {
    self.id = id; self.threadTitle = threadTitle; self.name = name; self.kind = kind; self.mime = mime; self.size = size
  }
}

public struct ArtifactPage: Decodable, Sendable {
  public var items: [ArtifactItem]
  public var nextCursor: String?
  public var counts: [String: Int]?
}

extension MercuryClient {
  public func artifacts(kind: String? = nil, query: String? = nil, cursor: String? = nil, limit: Int = 40) async throws -> ArtifactPage {
    var c = URLComponents()
    c.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
    if let kind, kind != "all" { c.queryItems!.append(.init(name: "kind", value: kind)) }
    if let query, !query.isEmpty { c.queryItems!.append(.init(name: "q", value: query)) }
    if let cursor { c.queryItems!.append(.init(name: "cursor", value: cursor)) }
    var r = try request("GET", "/api/artifacts")
    r.url = URL(string: r.url!.absoluteString + "?" + (c.percentEncodedQuery ?? ""))
    return try await decode(ArtifactPage.self, r)
  }

  /// Downloads an artifact's file (it needs the Bearer token, so no plain URL loading) into the caches folder.
  public func download(_ id: String, name: String) async throws -> URL {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "artifacts/\(id)")
    let dest = dir.appending(path: name.isEmpty ? "file" : name)
    if FileManager.default.fileExists(atPath: dest.path) { return dest }
    let r = try request("GET", "/api/artifacts/\(id)/file", timeout: 120)
    let (tmp, res) = try await session.download(for: r)
    guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw MercuryError.server((res as? HTTPURLResponse)?.statusCode ?? 0, "Couldn't download it.") }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: dest)
    try FileManager.default.moveItem(at: tmp, to: dest)
    return dest
  }

  /// An image's bytes, for thumbnails.
  public func data(_ path: String) async throws -> Data {
    let (data, res) = try await send(request("GET", path, timeout: 60))
    guard res.statusCode == 200 else { throw MercuryError.server(res.statusCode, nil) }
    return data
  }
}
