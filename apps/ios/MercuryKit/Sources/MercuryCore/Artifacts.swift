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
  /// Made together, in one turn by one media tool (five images for one ask): shown as one card.
  public var batch: String?
  /// What the media model was asked for.
  public var prompt: String?
  /// The tool that made or sent it.
  public var tool: String?
  /// Deleting it deletes the file itself (Mercury's own output). When false and `originalExists`,
  /// the file lives in the person's project: only Mercury's copy goes.
  public var owned: Bool?
  public var originalExists: Bool?

  public init(id: String, threadTitle: String?, name: String, kind: String, mime: String? = nil, size: Int? = nil,
              createdAt: Double? = nil, batch: String? = nil, prompt: String? = nil, owned: Bool? = nil, originalExists: Bool? = nil) {
    self.id = id; self.threadTitle = threadTitle; self.name = name; self.kind = kind; self.mime = mime; self.size = size
    self.createdAt = createdAt; self.batch = batch; self.prompt = prompt; self.owned = owned; self.originalExists = originalExists
  }

  /// The file sits in the person's project: deleting keeps it and removes only Mercury's copy
  /// (Mercury Desktop's `owned === false`).
  public var keepsOriginal: Bool { owned == false }
}

public struct ArtifactPage: Decodable, Sendable {
  public var items: [ArtifactItem]
  public var nextCursor: String?
  public var counts: [String: Int]?
}

/// One card in the artifacts list: a single artifact, or a batch made together (shown as a mosaic).
public struct ArtifactGroup: Identifiable, Hashable, Sendable {
  public var items: [ArtifactItem]
  public var id: String { items.count > 1 ? "batch:\(items[0].batch ?? items[0].id)" : items[0].id }
  public var lead: ArtifactItem { items[0] }
  public var isBatch: Bool { items.count > 1 }
  public var ids: [String] { items.map(\.id) }
  public var size: Int { items.reduce(0) { $0 + ($1.size ?? 0) } }

  public init(items: [ArtifactItem]) { self.items = items }

  /// Batches gathered into one card, at the place of their newest member (the list is newest
  /// first); the rest stay one card each. Same as Mercury Desktop's `groupBatches`.
  public static func group(_ items: [ArtifactItem]) -> [ArtifactGroup] {
    var out: [ArtifactGroup] = []
    var at: [String: Int] = [:]
    for a in items {
      if let b = a.batch, !b.isEmpty {
        if let i = at[b] { out[i].items.append(a); continue }
        at[b] = out.count
      }
      out.append(ArtifactGroup(items: [a]))
    }
    return out
  }
}

/// GET /api/artifacts/usage: space taken, counted the way the disk does.
public struct ArtifactUsage: Decodable, Hashable, Sendable {
  public struct Kind: Decodable, Hashable, Sendable {
    public var count: Int
    public var bytes: Int
    public init(count: Int, bytes: Int) { self.count = count; self.bytes = bytes }
  }
  public var count: Int
  public var bytes: Int
  public var byKind: [String: Kind]
  /// What deleting every artifact would give back.
  public var freeable: Int
  /// Artifacts whose file lives in a project: deleting keeps that file.
  public var outside: Int

  public init(count: Int, bytes: Int, byKind: [String: Kind], freeable: Int, outside: Int) {
    self.count = count; self.bytes = bytes; self.byKind = byKind; self.freeable = freeable; self.outside = outside
  }

  /// Kinds with something in them, biggest first, each with its share of the largest (0…1) for a bar.
  public var kinds: [(kind: String, usage: Kind, share: Double)] {
    let rows = byKind.filter { $0.value.count > 0 }.sorted { $0.value.bytes != $1.value.bytes ? $0.value.bytes > $1.value.bytes : $0.key < $1.key }
    let top = Double(max(rows.first?.value.bytes ?? 0, 1))
    return rows.map { ($0.key, $0.value, Double($0.value.bytes) / top) }
  }
}

/// What to delete in one go (POST /api/artifacts/delete).
public enum ArtifactCleanup: Hashable, Sendable {
  case ids([String])
  case kind(String)
  case olderThan(days: Int)
  case all

  var body: [String: Any] {
    switch self {
    case .ids(let ids): ["ids": ids]
    case .kind(let k): ["kind": k]
    case .olderThan(let d): ["olderThanDays": d]
    case .all: ["all": true]
    }
  }
}

/// What deleting did: records gone, bytes the disk got back, originals left in place.
public struct ArtifactRemoved: Decodable, Hashable, Sendable {
  public var removed: Int
  public var freed: Int
  public var keptOriginals: Int
  public init(removed: Int, freed: Int, keptOriginals: Int) { self.removed = removed; self.freed = freed; self.keptOriginals = keptOriginals }

  /// "3 deleted, 4.2 MB freed." (and the project files that stayed), as Mercury Desktop says it.
  public var summary: String {
    let space = freed > 0 ? ", \(ArtifactFormat.bytes(freed)) freed" : ""
    let kept = keptOriginals > 0 ? ". \(keptOriginals) file\(keptOriginals == 1 ? "" : "s") in your projects stayed where they are" : ""
    return "\(removed) deleted\(space)\(kept)."
  }
}

public enum ArtifactFormat {
  /// 512 B, 38 KB, 4.2 MB, 1.25 GB: the same numbers Mercury Desktop shows.
  public static func bytes(_ n: Int) -> String {
    let d = Double(max(n, 0))
    if d < 1024 { return "\(max(n, 0)) B" }
    if d < 1024 * 1024 { return "\(Int((d / 1024).rounded())) KB" }
    if d < 1024 * 1024 * 1024 { return String(format: "%.1f MB", d / (1024 * 1024)) }
    return String(format: "%.2f GB", d / (1024 * 1024 * 1024))
  }

  /// When it was made: the time today, else "Nov 3" (with the year when it isn't this year).
  public static func when(_ ms: Double?, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
    guard let ms else { return "" }
    let d = Date(timeIntervalSince1970: ms / 1000)
    let f = DateFormatter()
    f.locale = locale; f.calendar = calendar; f.timeZone = calendar.timeZone
    if calendar.isDate(d, inSameDayAs: now) { f.setLocalizedDateFormatFromTemplate("jmm") }
    else if calendar.component(.year, from: d) == calendar.component(.year, from: now) { f.setLocalizedDateFormatFromTemplate("MMMd") }
    else { f.setLocalizedDateFormatFromTemplate("yMMMd") }
    return f.string(from: d)
  }

  /// "4 images", "1 video": what a batch holds.
  public static func batchLabel(_ items: [ArtifactItem]) -> String {
    let kinds = Set(items.map(\.kind))
    let n = items.count
    switch kinds.count == 1 ? kinds.first! : "" {
    case "image": return "\(n) image\(n == 1 ? "" : "s")"
    case "video": return "\(n) video\(n == 1 ? "" : "s")"
    case "audio": return "\(n) sound\(n == 1 ? "" : "s")"
    default: return "\(n) file\(n == 1 ? "" : "s")"
    }
  }

  /// Plural label for a kind, as the filters and clean-up rows show it.
  public static func kindLabel(_ kind: String) -> String {
    switch kind {
    case "image": "Images"
    case "video": "Videos"
    case "audio": "Audio"
    case "pdf": "PDFs"
    case "document": "Documents"
    case "text": "Notes"
    default: "Other files"
    }
  }

  /// Confirming one delete, as Mercury Desktop words it: a project file stays, Mercury's own goes.
  public static func deleteTitle(_ a: ArtifactItem) -> String {
    a.keepsOriginal ? "Remove from Mercury? (your file stays)" : "Delete this file?"
  }

  public static func deleteDetail(_ a: ArtifactItem) -> String {
    a.keepsOriginal ? "Removes it from Mercury. The file in your project stays." : "Deletes the file."
  }

  /// Confirming several: how many, and what happens to files in projects.
  public static func deleteDetail(_ items: [ArtifactItem]) -> String {
    let kept = items.filter(\.keepsOriginal).count
    if items.count == 1, let a = items.first { return deleteDetail(a) }
    if kept == 0 { return "Deletes the files." }
    if kept == items.count { return "Removes them from Mercury. The files in your projects stay." }
    return "Deletes the files. \(kept) in your projects stay; only Mercury's copies go."
  }

  /// Under the clean-up actions: what deleting does to files in projects (`outside` from usage).
  public static func outsideNote(_ outside: Int) -> String {
    outside > 0
      ? "\(outside) artifact\(outside == 1 ? " is a file" : "s are files") in your projects: deleting removes \(outside == 1 ? "it" : "them") from Mercury, \(outside == 1 ? "the file stays" : "the files stay")."
      : "Deleting removes the files from your output folder too."
  }
}

extension MercuryClient {
  public func artifacts(kind: String? = nil, query: String? = nil, cursor: String? = nil, limit: Int = 40) async throws -> ArtifactPage {
    var c = URLComponents()
    c.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
    if let kind, kind != "all" { c.queryItems!.append(.init(name: "kind", value: kind)) }
    if let query, !query.isEmpty { c.queryItems!.append(.init(name: "q", value: query)) }
    if let cursor { c.queryItems!.append(.init(name: "cursor", value: cursor)) }
    return try await decode(ArtifactPage.self, request("GET", "/api/artifacts?" + (c.percentEncodedQuery ?? "")))
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
