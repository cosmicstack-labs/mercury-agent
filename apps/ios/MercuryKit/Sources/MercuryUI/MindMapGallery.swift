import SwiftUI
import MercuryCore

/// Snapshots of Brain → Mind map (13a–13g): a second brain shaped like a real one, laid out by the
/// same simulation with seeded randomness, so every run draws the same picture.
public enum MindMapGallery {
  static let themes: [(id: String, label: String, notes: [String])] = [
    ("c0", "Mercury · agents", [
      "Builds Mercury, a personal AI agent, at Cosmic Stack", "Mercury runs on a Mac mini at home", "Wants Mercury to remember people, not just facts",
      "Ships the desktop app with Tauri, a Rust shell and React UI", "Prefers small commits with clear messages", "Reviews every outside pull request for backdoors",
      "Keeps the iOS and Android apps monochrome, like Grok", "Mercury's voice calls should never interrupt themselves", "Tests wire-format changes against every provider",
      "Wants the mind map on the phone to match the desktop", "Uses SQLite for Mercury's memory", "Plans session recall and auto-skills next",
    ]),
    ("c1", "Family · home", [
      "Married to Heer", "Heer is a doctor at SKIMS", "Lives in Srinagar, near the Dal Lake", "Has a dog named Sheru who loves long walks",
      "Visits his parents every Sunday", "His mother makes noon chai on Fridays", "Brother Faisal studies in Delhi", "Heer's birthday is in March",
      "Wants a bigger garden next spring",
    ]),
    ("c2", "Health · routine", [
      "Runs 5 km three mornings a week", "Sleeps badly after late coffee", "Stopped sugar in tea last year", "Wants to sleep before midnight",
      "Does stretching for a stiff back", "Walks after dinner when it's dry", "Drinks two litres of water a day", "Tracks steps on the watch",
    ]),
    ("c3", "Languages · reading", [
      "Prefers Mercury to answer in Urdu when he writes Urdu", "Reads Iqbal's poetry in the evening", "Learning Kashmiri properly",
      "Likes long-form essays on design", "Keeps a reading list in Notes", "Finished Sapiens and found it shallow", "Wants book notes summarised weekly",
    ]),
    ("c4", "Work style", [
      "Works best late at night", "Hates meetings before noon", "Writes plans before code", "Wants honest reviews, not praise",
      "Keeps a daily log of what shipped", "Turns off notifications while coding", "Prefers one long focus block a day", "Uses a standing desk in summer",
    ]),
    ("c5", "Travel", [
      "Wants to visit Japan in autumn", "Flew to Dubai for a conference", "Prefers trains to planes in India", "Likes quiet hotels near old towns",
      "Keeps his passport in the study drawer", "Went to Gulmarg for skiing in January",
    ]),
    ("c6", "Food", [
      "Loves wazwan, especially rogan josh", "Doesn't eat seafood", "Makes kahwa for guests", "Prefers home food on weekdays", "Allergic to cashews",
    ]),
    ("c7", "Money", [
      "Saves a fixed share of income every month", "Pays the team on the first", "Wants a simple monthly spending summary", "Avoids credit card debt",
    ]),
    (BrainWeb.loose, "Loose notes", ["Likes the colour green", "Bought noise-cancelling headphones", "Watches cricket finals"]),
  ]

  static let kinds = ["fact", "preference", "goal", "habit", "project", "relationship", "decision", "identity"]

  /// The map: themes and notes as above; links mostly inside a theme, some across, weights 0.1–0.7.
  static func map(seed: UInt64 = 7) -> BrainMap {
    var rng = SeededRandom(seed: seed)
    var m = BrainMap(themes: [], placement: [:], links: [], notes: [])
    var members: [[String]] = []
    for (t, theme) in themes.enumerated() {
      m.themes.append(.init(id: theme.id, label: theme.label, parent: nil, size: theme.notes.count))
      var ids: [String] = []
      for (j, text) in theme.notes.enumerated() {
        let id = "\(theme.id)-\(j)"
        m.notes.append(.init(id: id, text: text, kind: kinds[(t * 3 + j) % kinds.count], at: Double(j), confidence: 0.8))
        m.placement[id] = theme.id
        ids.append(id)
      }
      members.append(ids)
    }
    var seen = Set<String>()
    func link(_ a: String, _ b: String) {
      guard a != b, !seen.contains(a + b), !seen.contains(b + a) else { return }
      seen.insert(a + b)
      m.links.append(.init(a: a, b: b, w: 0.1 + rng.next() * 0.6))
    }
    for (t, ids) in members.enumerated() where themes[t].id != BrainWeb.loose {
      // A hub or two per theme, a chain, and a few extra pairs.
      for (j, id) in ids.enumerated() where j > 0 { link(ids[0], id) }
      for j in 2..<ids.count where rng.next() < 0.5 { link(ids[j - 1], ids[j]) }
      for _ in 0..<(ids.count / 3) { link(ids[Int(rng.next() * Double(ids.count))], ids[Int(rng.next() * Double(ids.count))]) }
    }
    for _ in 0..<14 {
      let a = members[Int(rng.next() * 8)], b = members[Int(rng.next() * 8)]
      link(a[Int(rng.next() * Double(a.count))], b[Int(rng.next() * Double(b.count))])
    }
    return m
  }

  /// The owner's real size: 671 notes, 2,119 links, in 54 themes.
  static func realSize() -> BrainMap {
    var rng = SeededRandom(seed: 671)
    var m = BrainMap(themes: (0..<54).map { .init(id: "r\($0)", label: "Theme \($0 + 1)", parent: nil, size: 0) }, placement: [:], links: [], notes: [])
    let texts = themes.flatMap(\.notes)
    var theme: [Int] = []
    for i in 0..<671 {
      let t = Int(pow(rng.next(), 1.6) * 54)
      theme.append(t)
      m.notes.append(.init(id: "n\(i)", text: texts[i % texts.count], kind: kinds[i % kinds.count]))
      m.placement["n\(i)"] = "r\(t)"
      m.themes[t].size += 1
    }
    var seen = Set<Int>()
    while m.links.count < 2119 {
      let a = Int(rng.next() * 671)
      var b = Int(rng.next() * 671)
      if rng.next() < 0.8, let p = (0..<10).map({ _ in Int(rng.next() * 671) }).first(where: { theme[$0] == theme[a] }) { b = p }
      if a == b || seen.contains(a * 671 + b) || seen.contains(b * 671 + a) { continue }
      seen.insert(a * 671 + b)
      m.links.append(.init(a: "n\(a)", b: "n\(b)", w: 0.1 + rng.next() * 0.6))
    }
    return m
  }

  static let size = CGSize(width: 390, height: 763)

  @MainActor static func model(_ m: BrainMap, seed: UInt64 = 3, _ f: (MindMapModel) -> Void = { _ in }) -> MindMapModel {
    let defaults = UserDefaults(suiteName: "mindmap-gallery") ?? .standard
    defaults.removeObject(forKey: WebSettings.storageKey)
    let model = MindMapModel(client: nil, scope: "gallery-\(seed)", defaults: defaults)
    model.show(m, seed: seed, size: size)
    f(model)
    return model
  }

  @MainActor static func screen(_ model: MindMapModel) -> AnyView {
    AnyView(MindMapScreen(model: model, still: true))
  }

  /// The note sheet over the map, as it sits at its medium height.
  @MainActor static func sheet(_ model: MindMapModel, _ id: String) -> AnyView {
    model.detail = BrainMemory(id: id, type: "relationship", summary: model.note(id)?.text ?? "", detail: "Mentioned often, usually with plans for the weekend.",
                               evidenceKind: "owner", confidence: 0.92, evidenceCount: 6, createdAt: 1_757_000_000_000, updatedAt: 1_762_000_000_000)
    return AnyView(ZStack(alignment: .bottom) {
      screen(model)
      MindMapNoteSheet(model: model, id: id, still: true)
        .frame(maxWidth: .infinity, maxHeight: 430, alignment: .top)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 28, topTrailingRadius: 28))
        .shadow(color: .black.opacity(0.12), radius: 20, y: -4)
    })
  }

  @MainActor public static func screens() -> [(name: String, view: AnyView)] {
    let m = map()
    let hub = "c1-0"
    let zoomed = model(m) { md in
      md.engine.pull()
      if let i = md.index["c0-0"] {
        md.view = MapView(k: 2.2, cx: Double(md.engine.front.xs[i]), cy: Double(md.engine.front.ys[i]))
        md.updateZoomPct()
      }
    }
    let selected = model(m) { $0.selected = hub }
    let local = model(m) { md in
      md.selected = hub; md.local = LocalGraph(id: hub, depth: 1)
      md.engine.settleNow(); md.engine.pull(); md.fit(padding: 80, duration: 0)
    }
    return [
      ("13a-mindmap", screen(model(m))),
      ("13b-mindmap-selected", screen(selected)),
      ("13c-mindmap-zoomed-labels", screen(zoomed)),
      ("13d-mindmap-note", sheet(model(m) { $0.selected = hub }, hub)),
      ("13e-mindmap-local", screen(local)),
      ("13f-mindmap-real-size", screen(model(realSize(), seed: 671))),
      ("13g-mindmap-empty", screen(model(BrainMap(themes: [], placement: [:], links: [], notes: [])))),
    ]
  }
}
