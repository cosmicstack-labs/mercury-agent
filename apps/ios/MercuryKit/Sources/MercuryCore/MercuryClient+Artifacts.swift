import Foundation

// Artifact calls added for parity with Mercury Desktop 1.5.2 (delete for real, clean up, batches),
// plus the authenticated loading the shared media viewer needs.
extension MercuryClient {
  /// GET /api/artifacts/:id/file as a full URL, for viewers that take URLs (MediaSlider).
  public func artifactFileURL(_ id: String) -> URL {
    baseURL.appending(path: "/api/artifacts/\(id)/file")
  }

  /// Whether `url` is on this Mercury, so it gets the device token. Other hosts never see it.
  public func owns(_ url: URL) -> Bool {
    url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port
  }

  /// Headers to load `url` with: the Bearer token, only for this Mercury's own URLs.
  public func headers(for url: URL) -> [String: String] {
    guard owns(url), let token else { return [:] }
    return ["Authorization": "Bearer \(token)"]
  }

  /// A file at `url` downloaded (with the token when it is this Mercury's) into the caches folder.
  /// Local file URLs come back as they are.
  public func cachedFile(_ url: URL, name: String? = nil) async throws -> URL {
    if url.isFileURL { return url }
    let key = String(url.absoluteString.hashValueStable, radix: 36)
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "media/\(key)")
    let fallback = url.lastPathComponent == "file" ? "file" : url.lastPathComponent
    let dest = dir.appending(path: (name?.isEmpty == false ? name! : fallback).replacingOccurrences(of: "/", with: "-"))
    if FileManager.default.fileExists(atPath: dest.path) { return dest }
    var r = URLRequest(url: url, timeoutInterval: 120)
    for (k, v) in headers(for: url) { r.setValue(v, forHTTPHeaderField: k) }
    let (tmp, res) = try await session.download(for: r)
    guard (res as? HTTPURLResponse)?.statusCode ?? 200 == 200 else {
      throw MercuryError.server((res as? HTTPURLResponse)?.statusCode ?? 0, "Couldn't download it.")
    }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: dest)
    try FileManager.default.moveItem(at: tmp, to: dest)
    return dest
  }

  /// DELETE /api/artifacts/:id: Mercury's copy, and the original when Mercury owns it. A file that
  /// lives in the person's project stays (only Mercury's copy goes).
  public func deleteArtifact(_ id: String) async throws -> ArtifactRemoved {
    let (data, res) = try await send(request("DELETE", "/api/artifacts/\(id)"))
    guard res.statusCode == 200 else { throw MercuryError.server(res.statusCode, Self.message(data)) }
    return try JSONDecoder().decode(ArtifactRemoved.self, from: data)
  }

  /// GET /api/artifacts/usage: the space artifacts take, as the disk counts it, per kind.
  public func artifactUsage() async throws -> ArtifactUsage {
    try await decode(ArtifactUsage.self, request("GET", "/api/artifacts/usage"))
  }

  /// POST /api/artifacts/delete: many at once, by ids or by a kind / an age, or everything.
  public func deleteArtifacts(_ scope: ArtifactCleanup) async throws -> ArtifactRemoved {
    let (data, res) = try await send(request("POST", "/api/artifacts/delete", body: scope.body, timeout: 60))
    guard res.statusCode == 200 else { throw MercuryError.server(res.statusCode, Self.message(data)) }
    return try JSONDecoder().decode(ArtifactRemoved.self, from: data)
  }
}

extension String {
  /// FNV-1a: `hashValue` changes per launch, a cache key must not.
  var hashValueStable: UInt64 {
    var h: UInt64 = 0xcbf29ce484222325
    for b in utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
    return h
  }
}
