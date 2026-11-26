import Foundation

// The second brain's mind map, ported from Mercury Desktop (apps/desktop/src/views/brain/NoteWeb.tsx,
// MindMap.tsx, NoteHoverCard.tsx). Everything here is pure and matches the desktop's output exactly:
// toWeb (dots and lines), themeColors (FNV-1a hues with collision skipping) and shortLabel. The same
// functions live in Android's core module (BrainWeb.kt); the three test suites share their cases.

/// GET /api/brain/map: themes → sub-themes → notes, with the sparse "related" links (src/memory/knowledge-map.ts).
public struct BrainMap: Decodable, Sendable, Equatable {
  public struct Theme: Decodable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var terms: [String]
    public var parent: String?
    public var size: Int
    public init(id: String, label: String, terms: [String] = [], parent: String? = nil, size: Int) {
      self.id = id; self.label = label; self.terms = terms; self.parent = parent; self.size = size
    }
    enum CodingKeys: String, CodingKey { case id, label, terms, parent, size }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? id
      terms = (try? c.decodeIfPresent([String].self, forKey: .terms)) ?? []
      parent = try c.decodeIfPresent(String.self, forKey: .parent)
      size = Int((try? c.decodeIfPresent(Double.self, forKey: .size)) ?? 0)
    }
  }
  public struct Link: Decodable, Sendable, Equatable {
    public var a: String
    public var b: String
    public var w: Double
    public init(a: String, b: String, w: Double) { self.a = a; self.b = b; self.w = w }
  }
  public struct Note: Decodable, Sendable, Equatable {
    public var id: String
    public var text: String
    public var kind: String
    public var at: Double
    public var confidence: Double
    public var archived: Bool
    public init(id: String, text: String, kind: String, at: Double = 0, confidence: Double = 0.8, archived: Bool = false) {
      self.id = id; self.text = text; self.kind = kind; self.at = at; self.confidence = confidence; self.archived = archived
    }
    enum CodingKeys: String, CodingKey { case id, text, kind, at, confidence, archived }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
      at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? 0
      confidence = (try? c.decodeIfPresent(Double.self, forKey: .confidence)) ?? 0
      archived = (try? c.decodeIfPresent(Bool.self, forKey: .archived)) ?? false
    }
  }
  public var themes: [Theme]
  /// note id → the theme (or sub-theme) it sits in.
  public var placement: [String: String]
  public var links: [Link]
  public var notes: [Note]

  public init(themes: [Theme], placement: [String: String], links: [Link], notes: [Note]) {
    self.themes = themes; self.placement = placement; self.links = links; self.notes = notes
  }
  enum CodingKeys: String, CodingKey { case themes, placement, links, notes }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    themes = try c.decodeIfPresent([Theme].self, forKey: .themes) ?? []
    placement = try c.decodeIfPresent([String: String].self, forKey: .placement) ?? [:]
    links = try c.decodeIfPresent([Link].self, forKey: .links) ?? []
    notes = try c.decodeIfPresent([Note].self, forKey: .notes) ?? []
  }
}

/// GET /api/brain/memory/:id: one note's full record.
public struct BrainMemory: Decodable, Sendable, Equatable {
  public var id: String
  public var type: String
  public var summary: String
  public var detail: String?
  public var evidenceKind: String?
  public var confidence: Double
  public var evidenceCount: Int?
  public var createdAt: Double?
  public var updatedAt: Double?

  public init(id: String, type: String, summary: String, detail: String? = nil, evidenceKind: String? = nil, confidence: Double = 0.8,
              evidenceCount: Int? = nil, createdAt: Double? = nil, updatedAt: Double? = nil) {
    self.id = id; self.type = type; self.summary = summary; self.detail = detail; self.evidenceKind = evidenceKind
    self.confidence = confidence; self.evidenceCount = evidenceCount; self.createdAt = createdAt; self.updatedAt = updatedAt
  }
  enum CodingKeys: String, CodingKey { case id, type, summary, detail, evidenceKind, confidence, evidenceCount, createdAt, updatedAt }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
    summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
    detail = try c.decodeIfPresent(String.self, forKey: .detail)
    evidenceKind = try c.decodeIfPresent(String.self, forKey: .evidenceKind)
    confidence = (try? c.decodeIfPresent(Double.self, forKey: .confidence)) ?? 0
    evidenceCount = (try? c.decodeIfPresent(Double.self, forKey: .evidenceCount)).flatMap { $0 }.map { Int($0) }
    createdAt = Self.time(c, .createdAt)
    updatedAt = Self.time(c, .updatedAt)
  }
  /// Milliseconds since 1970 (the runtime sends numbers; an ISO string is read too).
  static func time(_ c: KeyedDecodingContainer<CodingKeys>, _ k: CodingKeys) -> Double? {
    if let n = try? c.decodeIfPresent(Double.self, forKey: k) { return n }
    if let s = try? c.decodeIfPresent(String.self, forKey: k), let d = ISO8601DateFormatter.withFractions.date(from: s) ?? ISO8601DateFormatter().date(from: s) {
      return d.timeIntervalSince1970 * 1000
    }
    return nil
  }
}

extension MercuryClient {
  /// GET /api/brain/map[?archive=1].
  public func brainMap(archive: Bool = false) async throws -> BrainMap {
    try await decode(BrainMap.self, request("GET", "/api/brain/map\(archive ? "?archive=1" : "")", timeout: 30))
  }

  /// GET /api/brain/memory/:id.
  public func brainMemory(_ id: String) async throws -> BrainMemory {
    let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
    return try await decode(BrainMemory.self, request("GET", "/api/brain/memory/\(enc)"))
  }
}

// MARK: - The web: dots and lines

/// One dot: a note, its top theme's colour, and how many lines it has.
public struct WebNode: Sendable, Equatable, Identifiable {
  public var id: String
  public var label: String
  public var theme: String
  /// "#RRGGBB".
  public var color: String
  public var degree: Int
  public var kind: String
}

/// One line, by node index into `WebGraph.nodes` (desktop: source/target ids).
public struct WebLink: Sendable, Equatable {
  public var source: Int
  public var target: Int
  public var w: Double
}

public struct WebGraph: Sendable, Equatable {
  /// Hubs first: draw order, and label priority.
  public var nodes: [WebNode]
  public var links: [WebLink]
  public init(nodes: [WebNode] = [], links: [WebLink] = []) { self.nodes = nodes; self.links = links }
  /// The link list as ids, for tests and parity checks with the desktop's output.
  public var linkIds: [(String, String, Double)] { links.map { (nodes[$0.source].id, nodes[$0.target].id, $0.w) } }
}

public struct LocalGraph: Sendable, Equatable, Codable {
  public var id: String
  public var depth: Int
  public init(id: String, depth: Int) { self.id = id; self.depth = depth }
}

public struct WebOptions: Sendable, Equatable {
  public var orphans: Bool
  public var hidden: Set<String>
  public var query: String
  public var local: LocalGraph?
  public init(orphans: Bool = true, hidden: Set<String> = [], query: String = "", local: LocalGraph? = nil) {
    self.orphans = orphans; self.hidden = hidden; self.query = query; self.local = local
  }
}

public enum BrainWeb {
  public static let loose = "loose"
  /// Twelve hues that read on light and dark; a theme keeps its hue while its id lives.
  public static let hues = ["#5B8DEF", "#E0739B", "#3FB37F", "#D4A72C", "#9B7BD8", "#E8894A", "#2BB5C9", "#C9644F", "#7AA33B", "#B565C9", "#4F9AA8", "#D08A2E"]
  public static let looseColor = "#8A97A3"
  public static let kindLabel: [String: String] = [
    "fact": "Fact", "preference": "Preference", "trait": "Trait", "situation": "Situation", "relationship": "Relationship", "goal": "Goal", "project": "Project",
    "episode": "Moment", "identity": "Identity", "habit": "Habit", "decision": "Decision", "constraint": "Constraint", "reflection": "Reflection",
  ]

  /// FNV-1a over UTF-16 code units, as the desktop's `hash` (Math.imul, >>> 0).
  public static func hash(_ s: String) -> UInt32 {
    var h: UInt32 = 2166136261
    for u in s.utf16 { h ^= UInt32(u); h = h &* 16777619 }
    return h
  }

  /// Stable colours: each theme hashes to a hue; clashes step to the next free one.
  public static func themeColors(_ ids: [String]) -> [String: String] {
    var out: [String: String] = [:]
    var used = Set<Int>()
    for id in ids {
      if id == loose { out[id] = looseColor; continue }
      var i = Int(hash(id) % UInt32(hues.count))
      var k = 0
      while k < hues.count && used.contains(i) { i = (i + 1) % hues.count; k += 1 }
      used.insert(i)
      if used.count == hues.count { used.removeAll() }
      out[id] = hues[i]
    }
    return out
  }

  /// Top-level themes, biggest first, Loose last (the desktop's order for colours and Groups).
  public static func tops(_ m: BrainMap) -> [BrainMap.Theme] {
    stableSorted(m.themes.filter { $0.parent == nil }) { a, b in a.id == loose ? 1 : b.id == loose ? -1 : b.size - a.size }
  }

  /// JS's Array.prototype.sort is stable: equal elements keep their order. Swift's sort isn't
  /// guaranteed to be, so ties fall back to the original position.
  static func stableSorted<T>(_ xs: [T], _ cmp: (T, T) -> Int) -> [T] {
    xs.enumerated().sorted { l, r in
      let c = cmp(l.element, r.element)
      return c != 0 ? c < 0 : l.offset < r.offset
    }.map(\.element)
  }

  /// Notes and links → dots and lines, with degree and theme colour (the desktop's toWeb).
  public static func toWeb(_ m: BrainMap, _ opts: WebOptions) -> WebGraph {
    var parentOf: [String: String?] = [:]
    for t in m.themes { parentOf[t.id] = t.parent }
    func topOf(_ id: String?) -> String {
      guard let id, !id.isEmpty else { return loose }
      return (parentOf[id] ?? nil) ?? id
    }
    let colors = themeColors(tops(m).map(\.id))
    let q = opts.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    var keep = Set(m.notes.filter { !opts.hidden.contains(topOf(m.placement[$0.id])) && (q.isEmpty || $0.text.lowercased().contains(q)) }.map(\.id))
    var links = m.links.filter { keep.contains($0.a) && keep.contains($0.b) }

    if let local = opts.local, keep.contains(local.id) {
      var adj: [String: [String]] = [:]
      for l in links { adj[l.a, default: []].append(l.b); adj[l.b, default: []].append(l.a) }
      var seen: Set<String> = [local.id]
      var frontier = [local.id]
      for _ in 0..<max(0, local.depth) {
        var next: [String] = []
        for id in frontier { for j in adj[id] ?? [] where !seen.contains(j) { seen.insert(j); next.append(j) } }
        frontier = next
      }
      keep = seen
      links = links.filter { keep.contains($0.a) && keep.contains($0.b) }
    }

    var degree: [String: Int] = [:]
    for l in links { degree[l.a, default: 0] += 1; degree[l.b, default: 0] += 1 }
    let nodes = stableSorted(
      m.notes
        .filter { keep.contains($0.id) && (opts.orphans || (degree[$0.id] ?? 0) > 0) }
        .map { n -> WebNode in
          let theme = topOf(m.placement[n.id])
          return WebNode(id: n.id, label: n.text, theme: theme, color: colors[theme] ?? looseColor, degree: degree[n.id] ?? 0, kind: n.kind)
        }
    ) { a, b in b.degree - a.degree } // Hubs first, so their labels win the space.
    var index: [String: Int] = [:]
    for (i, n) in nodes.enumerated() { index[n.id] = i }
    let out = links.compactMap { l -> WebLink? in
      guard let s = index[l.a], let t = index[l.b] else { return nil }
      return WebLink(source: s, target: t, w: l.w)
    }
    return WebGraph(nodes: nodes, links: out)
  }

  /// A note's label for the canvas: its first clause or first few words, never cut mid-word
  /// (the desktop's shortLabel; lengths in UTF-16 units like JavaScript's).
  public static func shortLabel(_ text: String, max: Int = 32) -> String {
    var s = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    s = s.trimmingCharacters(in: .whitespacesAndNewlines)
    s = s.replacingOccurrences(of: "[.。]+$", with: "", options: .regularExpression)
    let ns = s as NSString
    if ns.length <= max { return s }
    if let m = clauseRegex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) {
      let clause = ns.substring(with: m.range(at: 1))
      if (clause as NSString).length <= max - 1 { return trimEnd(clause) + "…" }
    }
    let cut = ns.substring(to: max - 1) as NSString
    let space = cut.range(of: " ", options: .backwards).location
    let base = space != NSNotFound && Double(space) >= Double(max) * 0.5 ? cut.substring(to: space) : cut as String
    return base.replacingOccurrences(of: "[\\s,;:.(—–-]+$", with: "", options: .regularExpression) + "…"
  }

  nonisolated(unsafe) static let clauseRegex = try! NSRegularExpression(pattern: "^(.{12,}?)(?:[,;:]\\s|\\s[—–-]\\s|\\s\\()")

  static func trimEnd(_ s: String) -> String {
    var t = Substring(s)
    while let c = t.last, c.isWhitespace { t.removeLast() }
    return String(t)
  }

  /// The desktop's node radius: grows with connections, times the Node size setting.
  public static func radius(degree: Int, nodeSize: Double) -> Double {
    (2.2 + Double(degree).squareRoot() * 1.15) * nodeSize
  }

  /// Label fade: hubs fade in a little sooner; lit labels always show.
  public static func labelAlpha(scale: Double, degree: Int, textFade: Double, lit: Bool) -> Double {
    if lit { return 1 }
    let fadeAt = textFade / (1 + min(1.2, Double(degree) / 8))
    return Swift.max(0, Swift.min(1, (scale - fadeAt) / (fadeAt * 0.5)))
  }

  /// Unlit line opacity: faint, a little stronger for close notes; fainter still while a note is lit.
  public static func linkAlpha(w: Double, hovering: Bool) -> Double {
    hovering ? 0.05 : 0.1 + min(0.25, w * 0.4)
  }

  /// Neighbours of every node (both ways), by index.
  public static func adjacency(_ g: WebGraph) -> [Set<Int>] {
    var adj = Array(repeating: Set<Int>(), count: g.nodes.count)
    for l in g.links { adj[l.source].insert(l.target); adj[l.target].insert(l.source) }
    return adj
  }

  /// A note's related notes in the whole map, strongest first (the detail sheet's list).
  public static func related(_ m: BrainMap, id: String) -> [(note: BrainMap.Note, w: Double)] {
    let byId = Dictionary(m.notes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var out: [(BrainMap.Note, Double)] = []
    for l in m.links {
      if l.a == id, let n = byId[l.b] { out.append((n, l.w)) } else if l.b == id, let n = byId[l.a] { out.append((n, l.w)) }
    }
    return stableSorted(out) { a, b in a.1 == b.1 ? 0 : (a.1 > b.1 ? -1 : 1) }.map { (note: $0.0, w: $0.1) }
  }
}

/// The mind map's settings (desktop: localStorage "mercury.brain.web.settings.v1", same field names).
public struct WebSettings: Codable, Sendable, Equatable {
  public var orphans = true
  public var nodeSize = 1.0
  public var linkWidth = 1.0
  /// Zoom level from which labels fade in (Obsidian's "text fade threshold").
  public var textFade = 1.6
  public var center = 0.06
  public var repel = 40.0
  public var linkForce = 0.5
  public var linkDistance = 34.0
  public var hidden: [String] = []

  public init() {}
  public static let defaults = WebSettings()
  public static let storageKey = "mercury.brain.web.settings.v1"

  /// `{ ...DEFAULTS, ...stored }`: missing fields keep their defaults.
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    let z = WebSettings.defaults
    orphans = (try? c.decodeIfPresent(Bool.self, forKey: .orphans)) ?? z.orphans
    nodeSize = (try? c.decodeIfPresent(Double.self, forKey: .nodeSize)) ?? z.nodeSize
    linkWidth = (try? c.decodeIfPresent(Double.self, forKey: .linkWidth)) ?? z.linkWidth
    textFade = (try? c.decodeIfPresent(Double.self, forKey: .textFade)) ?? z.textFade
    center = (try? c.decodeIfPresent(Double.self, forKey: .center)) ?? z.center
    repel = (try? c.decodeIfPresent(Double.self, forKey: .repel)) ?? z.repel
    linkForce = (try? c.decodeIfPresent(Double.self, forKey: .linkForce)) ?? z.linkForce
    linkDistance = (try? c.decodeIfPresent(Double.self, forKey: .linkDistance)) ?? z.linkDistance
    hidden = (try? c.decodeIfPresent([String].self, forKey: .hidden)) ?? z.hidden
  }

  public var forces: ForceParams { ForceParams(center: center, repel: repel, linkForce: linkForce, linkDistance: linkDistance, nodeSize: nodeSize) }

  public static func load(_ defaults: UserDefaults = .standard) -> WebSettings {
    guard let data = defaults.data(forKey: storageKey), let s = try? JSONDecoder().decode(WebSettings.self, from: data) else { return .defaults }
    return s
  }
  public func save(_ defaults: UserDefaults = .standard) {
    if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.storageKey) }
  }
}
