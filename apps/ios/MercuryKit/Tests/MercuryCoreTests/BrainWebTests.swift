import Testing
import Foundation
@testable import MercuryCore

// Ported from Mercury Desktop: NoteWeb.test.ts (toWeb), MindMap.tsx's themeColors and
// NoteHoverCard.test.ts (shortLabel). Expected values come from running the desktop's own code.

let webMap = BrainMap(
  themes: [
    .init(id: "t1", label: "Garden", parent: nil, size: 3),
    .init(id: "t2", label: "Rust", parent: nil, size: 2),
    .init(id: "t2.a", label: "Cargo", parent: "t2", size: 2),
    .init(id: "loose", label: "Loose notes", parent: nil, size: 1),
  ],
  placement: ["a": "t1", "b": "t1", "c": "t1", "r1": "t2.a", "r2": "t2.a", "x": "loose"],
  links: [.init(a: "a", b: "b", w: 0.5), .init(a: "b", b: "c", w: 0.4), .init(a: "r1", b: "r2", w: 0.3), .init(a: "c", b: "r1", w: 0.2)],
  notes: ["a", "b", "c", "r1", "r2", "x"].map { .init(id: $0, text: "note \($0)", kind: "fact", at: 0, confidence: 0.8, archived: false) }
)

@Suite struct ToWebTests {
  @Test func everyNoteIsADotEveryLinkALineSizedByConnections() {
    let w = BrainWeb.toWeb(webMap, WebOptions())
    #expect(w.nodes.count == 6)
    #expect(w.links.count == 4)
    #expect(w.nodes.first { $0.id == "b" }?.degree == 2)
    #expect(w.nodes.first { $0.id == "x" }?.degree == 0)
  }

  @Test func coloursASubThemeNoteWithItsTopTheme() {
    let w = BrainWeb.toWeb(webMap, WebOptions())
    let color = { (id: String) in w.nodes.first { $0.id == id }!.color }
    #expect(color("r1") == color("r2"))
    #expect(color("a") != color("r1"))
  }

  @Test func hidesOrphansHiddenGroupsAndNonMatchingNotes() {
    #expect(!BrainWeb.toWeb(webMap, WebOptions(orphans: false)).nodes.contains { $0.id == "x" })
    let noRust = BrainWeb.toWeb(webMap, WebOptions(hidden: ["t2"]))
    #expect(noRust.nodes.map(\.id).sorted() == ["a", "b", "c", "x"])
    #expect(noRust.links.count == 2)
    #expect(BrainWeb.toWeb(webMap, WebOptions(query: "note r")).nodes.count == 2)
  }

  @Test func localGraphKeepsANoteAndItsNeighboursToTheChosenDepth() {
    #expect(BrainWeb.toWeb(webMap, WebOptions(local: LocalGraph(id: "a", depth: 1))).nodes.map(\.id).sorted() == ["a", "b"])
    #expect(BrainWeb.toWeb(webMap, WebOptions(local: LocalGraph(id: "a", depth: 3))).nodes.map(\.id).sorted() == ["a", "b", "c", "r1"])
  }

  /// The desktop's exact output: order (hubs first, stable), colours, degrees and links.
  @Test func matchesTheDesktopsOutputExactly() {
    let w = BrainWeb.toWeb(webMap, WebOptions())
    #expect(w.nodes.map(\.id) == ["b", "c", "r1", "a", "r2", "x"])
    #expect(w.nodes.map(\.color) == ["#4F9AA8", "#4F9AA8", "#D08A2E", "#4F9AA8", "#D08A2E", "#8A97A3"])
    #expect(w.nodes.map(\.degree) == [2, 2, 2, 1, 1, 0])
    #expect(w.linkIds.map { "\($0.0)-\($0.1)" } == ["a-b", "b-c", "r1-r2", "c-r1"])
  }

  @Test func decodesTheMapEndpoint() throws {
    let json = #"{"themes":[{"id":"t1","label":"Garden","terms":["tomato"],"parent":null,"size":3}],"placement":{"a":"t1"},"links":[{"a":"a","b":"b","w":0.5}],"notes":[{"id":"a","text":"note a","kind":"fact","at":1,"confidence":0.8,"archived":false}],"stats":{"notes":1,"links":1,"themes":1,"ms":1},"available":true}"#
    let m = try JSONDecoder().decode(BrainMap.self, from: Data(json.utf8))
    #expect(m.themes.first?.parent == nil)
    #expect(m.notes.first?.text == "note a")
    #expect(m.links.first?.w == 0.5)
  }
}

@Suite struct ThemeColorTests {
  /// [id, FNV-1a hash, colour] from the desktop's hash/themeColors over the same list.
  static let expected: [(String, UInt32, String)] = [("t1",138734806,"#4F9AA8"),("t2",121957187,"#D08A2E"),("t3",105179568,"#5B8DEF"),("t4",222622901,"#E8894A"),("t5",205845282,"#2BB5C9"),("t6",189067663,"#C9644F"),("t7",172290044,"#7AA33B"),("t8",289733377,"#E0739B"),("t9",272955758,"#3FB37F"),("t10",3934318098,"#B565C9"),("t11",3951095717,"#D4A72C"),("t12",3900762860,"#9B7BD8"),("t13",3917540479,"#C9644F"),("t14",3867207622,"#4F9AA8"),("loose",2377178881,"#8A97A3"),("c0",2267668038,"#2BB5C9"),("c1",2284445657,"#E8894A"),("c2",2234112800,"#7AA33B"),("theme-ünïcode",2560135821,"#B565C9"),("日本",1610399396,"#D08A2E")]

  @Test func hashesLikeTheDesktop() {
    for (id, h, _) in Self.expected { #expect(BrainWeb.hash(id) == h, "\(id)") }
  }

  @Test func coloursLikeTheDesktopSkippingClashesAndWrappingAfterTwelve() {
    let colors = BrainWeb.themeColors(Self.expected.map(\.0))
    for (id, _, c) in Self.expected { #expect(colors[id] == c, "\(id)") }
  }

  @Test func looseIsGrey() { #expect(BrainWeb.themeColors(["loose"])["loose"] == "#8A97A3") }
}

@Suite struct ShortLabelTests {
  @Test func leavesShortNotesAloneAndDropsTheFullStop() { #expect(BrainWeb.shortLabel("Married to Heer.") == "Married to Heer") }
  @Test func endsAtTheFirstClauseWhenShortEnough() {
    #expect(BrainWeb.shortLabel("Lives in Srinagar, works on Mercury at Cosmic Stack every evening") == "Lives in Srinagar…")
  }
  @Test func otherwiseCutsAtAWholeWord() {
    let out = BrainWeb.shortLabel("Prefers Mercury to communicate in Urdu and not switch languages without asking")
    #expect(out == "Prefers Mercury to communicate…")
    #expect((out as NSString).length <= 32)
  }
  @Test func cutsOneVeryLongWordHard() { #expect((BrainWeb.shortLabel(String(repeating: "a", count: 60)) as NSString).length == 32) }
  @Test func doesntEndOnDanglingPunctuation() {
    #expect(BrainWeb.shortLabel("Uses Tauri for the desktop app (Rust shell) — React UI and more after that") == "Uses Tauri for the desktop app…")
  }
  /// More cases, expected values from the desktop's function.
  @Test func matchesTheDesktopOnMoreCases() {
    let cases: [(String, String)] = [
      ("  Multiple   spaces\n\tand newlines in a fairly long note text here.  ", "Multiple spaces and newlines…"),
      ("Short one。。", "Short one"),
      ("Works at Cosmic Stack - a small studio building agents for people", "Works at Cosmic Stack…"),
      ("The quick brown fox jumps over the lazy dog again and again", "The quick brown fox jumps over…"),
      ("Likes: tea, coffee, and long walks in the evening by the river", "Likes: tea, coffee…"),
      ("Abcdefghijklmnopqrstuvwxyzabcdefghij klm", "Abcdefghijklmnopqrstuvwxyzabcde…"),
      ("Has a dog named Sheru 🐕 who loves long walks in the park", "Has a dog named Sheru 🐕 who…"),
      ("Exactly thirty-two characters!!", "Exactly thirty-two characters!!"),
      ("Ends with dash right at the cut — and continues on", "Ends with dash right at the cut…"),
    ]
    for (text, want) in cases { #expect(BrainWeb.shortLabel(text) == want, "\(text)") }
  }
}

@Suite struct WebSettingsTests {
  @Test func defaultsMatchTheDesktop() {
    let d = WebSettings.defaults
    #expect(d.orphans && d.nodeSize == 1 && d.linkWidth == 1 && d.textFade == 1.6)
    #expect(d.center == 0.06 && d.repel == 40 && d.linkForce == 0.5 && d.linkDistance == 34 && d.hidden.isEmpty)
  }
  @Test func storedFieldsOverrideDefaultsAndMissingOnesKeepThem() throws {
    let s = try JSONDecoder().decode(WebSettings.self, from: Data(#"{"repel":80,"hidden":["t2"]}"#.utf8))
    #expect(s.repel == 80 && s.hidden == ["t2"] && s.linkDistance == 34)
  }
  @Test func labelFadeAndLinkAlphaFollowTheDesktop() {
    #expect(BrainWeb.labelAlpha(scale: 1, degree: 0, textFade: 1.6, lit: true) == 1)
    #expect(BrainWeb.labelAlpha(scale: 1, degree: 0, textFade: 1.6, lit: false) == 0)
    #expect(abs(BrainWeb.labelAlpha(scale: 2, degree: 0, textFade: 1.6, lit: false) - 0.5) < 1e-12)
    #expect(BrainWeb.labelAlpha(scale: 3, degree: 8, textFade: 1.6, lit: false) == 1) // fadeAt 0.8
    #expect(BrainWeb.linkAlpha(w: 0.5, hovering: false) == 0.1 + 0.2)
    #expect(BrainWeb.linkAlpha(w: 0.9, hovering: false) == 0.35)
    #expect(BrainWeb.linkAlpha(w: 0.9, hovering: true) == 0.05)
    #expect(BrainWeb.radius(degree: 4, nodeSize: 1) == 2.2 + 2 * 1.15)
  }
}
