import Testing
import SwiftUI
@testable import MercuryUI
@testable import MercuryCore

@Suite struct TintTests {
  @Test func hexRoundTrips() {
    #expect(Tint.rgb("#1A9E6E") == 0x1A9E6E)
    #expect(Tint.rgb("1a9e6e") == 0x1A9E6E)
    #expect(Tint.rgb(" #19e ") == 0x1199EE)
    #expect(Tint.rgb("#12345") == nil)
    #expect(Tint.rgb("zzzzzz") == nil)
    #expect(Tint.hex(0x0E7C8C) == "#0E7C8C")
    for p in Tint.presets { #expect(Tint.rgb(p.hex) == p.light) }
  }

  @Test func colourToHex() {
    #expect(Tint.hex(Color(hex: 0x6D4CCC)) == "#6D4CCC")
    #expect(Tint.hex(Color(.sRGB, red: 1, green: 1, blue: 1)) == "#FFFFFF")
    #expect(Tint.hex(Color(.sRGB, red: 0, green: 0, blue: 0)) == "#000000")
  }

  @Test func contrast() {
    #expect(abs(Tint.contrast(0xFFFFFF, 0x000000) - 21) < 0.01)
    #expect(Tint.contrast(0x777777, 0x777777) == 1)
  }

  @Test func textOnATintStaysReadable() {
    // Mercury's green and the deep shades carry white text, as on Desktop.
    #expect(Tint.on(0x1A9E6E) == 0xFFFFFF)
    #expect(Tint.on(0x6D4CCC) == 0xFFFFFF)
    #expect(Tint.on(0x0E7C8C) == 0xFFFFFF)
    // Light tints (the dark-mode shades, yellow) carry dark text.
    #expect(Tint.on(0x34E1A1) == Tint.darkText)
    #expect(Tint.on(0xF5C451) == Tint.darkText)
    #expect(Tint.on(0xFFE14D) == Tint.darkText)
    #expect(Tint.on(0xFFFFFF) == Tint.darkText)
    #expect(Tint.on(0x000000) == 0xFFFFFF)
  }

  @Test func everyPresetReadsOnItsGround() {
    for p in Tint.presets {
      #expect(Tint.contrast(p.light, Tint.lightGround) >= 3, "\(p.name) light")
      #expect(Tint.contrast(p.dark, Tint.darkGround) >= 3, "\(p.name) dark")
      #expect(Tint.contrast(p.light, p.pair.onLight) >= 3, "\(p.name) text on light")
      #expect(Tint.contrast(p.dark, p.pair.onDark) >= 3, "\(p.name) text on dark")
    }
    #expect(Tint.presets.first == Tint.mercury)
    #expect(Set(Tint.presets.map(\.id)).count == Tint.presets.count)
  }

  @Test func aCustomColourIsMadeLegible() {
    // Pale yellow is darkened for the light ground, kept for the dark one.
    let p = Tint.pair(for: "#FFE14D")
    #expect(p.light != 0xFFE14D && Tint.contrast(p.light, Tint.lightGround) >= 3)
    #expect(p.dark == 0xFFE14D)
    // Navy is lightened for the dark ground.
    let n = Tint.pair(for: "#14213D")
    #expect(n.light == 0x14213D)
    #expect(Tint.contrast(n.dark, Tint.darkGround) >= 3)
    // A preset's hex gives the preset, both shades.
    #expect(Tint.pair(for: "#6d4ccc") == Tint.presets.first { $0.id == "violet" }!.pair)
    #expect(Tint.pair(for: nil) == Tint.mercury.pair)
    #expect(Tint.pair(for: "nonsense") == Tint.mercury.pair)
  }
}

@Suite(.serialized) struct AppearanceStoreTests {
  func defaults() -> UserDefaults {
    let d = UserDefaults(suiteName: "appearance-tests")!
    d.removePersistentDomain(forName: "appearance-tests")
    return d
  }

  @Test func remembersTintAndThemeOnThisDevice() {
    let d = defaults()
    let a = Appearance(defaults: d)
    #expect(a.tintHex == nil && a.mode == .system && a.preset == Tint.mercury)
    a.setTint("#0e7c8c")
    a.mode = .dark
    #expect(d.string(forKey: "appearance.tint") == "#0E7C8C")
    let b = Appearance(defaults: d)
    #expect(b.tintHex == "#0E7C8C" && b.mode == .dark && b.preset?.id == "teal")
    #expect(b.mode.scheme == .dark)
  }

  @Test func resetGoesBackToMercury() {
    let d = defaults()
    let a = Appearance(defaults: d)
    a.setTint("#FFE14D")
    #expect(a.preset == nil)
    a.setTint(nil)
    #expect(a.tintHex == nil && a.pair == Tint.mercury.pair)
    #expect(d.string(forKey: "appearance.tint") == nil)
    // Picking Mercury's own green is the default, not a custom colour.
    a.setTint(Tint.mercury.hex)
    #expect(a.tintHex == nil)
  }

  @Test @MainActor func previewingDoesNotRemember() {
    let d = defaults()
    let a = Appearance(defaults: d)
    let seen = a.previewing("#6D4CCC") { a.preset?.id }
    #expect(seen == "violet")
    #expect(a.tintHex == nil)
    #expect(d.string(forKey: "appearance.tint") == nil)
  }
}

@Suite struct MediaGeneratingTests {
  typealias Shape = TurnTrace.MediaShape

  @Test func placeholderKeepsTheShapeOfWhatIsComing() {
    #expect(MediaText.ratio(Shape(kind: "image")) == 1)
    #expect(MediaText.ratio(Shape(kind: "image", aspect: "landscape")) == 1.5)
    #expect(abs(MediaText.ratio(Shape(kind: "image", aspect: "portrait")) - 2.0 / 3) < 0.0001)
    #expect(abs(MediaText.ratio(Shape(kind: "video")) - 16.0 / 9) < 0.0001)
    #expect(abs(MediaText.ratio(Shape(kind: "video", aspect: "portrait")) - 9.0 / 16) < 0.0001)
    // A batch is square tiles, whatever the pictures' shape (the finished grid is square too).
    #expect(MediaText.ratio(Shape(kind: "image", aspect: "landscape"), tiles: 4) == 1)
    #expect(MediaText.columns(1) == 1 && MediaText.columns(4) == 2 && MediaText.columns(5) == 3)
  }

  @Test func statusLineSaysWhatAndHowFar() {
    let start = Date(timeIntervalSince1970: 0)
    func line(_ kind: String, total: Int = 1, done: Int = 0, at s: TimeInterval) -> String {
      MediaText.describe(MediaBatch(id: "", shape: Shape(kind: kind, count: total), startedAt: start, done: done, total: total), now: start.addingTimeInterval(s))
    }
    #expect(line("image", total: 5, done: 4, at: 16) == "Creating 5 images · 4 of 5 ready · Adding detail")
    #expect(line("image", total: 4, at: 1) == "Creating 4 images · Composing")
    #expect(line("image", at: 0) == "Creating image · Composing")
    #expect(line("image", total: 2, done: 2, at: 30) == "Creating 2 images · 2 of 2 ready · Almost there")
    #expect(line("video", at: 41) == "Creating video · Adding sound")
    #expect(line("music", at: 5) == "Creating music · Finding the groove")
    #expect(line("speech", at: 6) == "Creating voice · Speaking")
  }

  @Test func motionFollowsDesktopTiming() {
    // The sweep crosses every 2.2 s; the drift goes there and back over 14 s.
    let a = MediaMotion(t: 0.5, index: 0), b = MediaMotion(t: 2.7, index: 0)
    #expect(abs(a.sweep - b.sweep) < 0.0001)
    #expect(MediaMotion(t: 0, index: 0).drift == 0)
    #expect(abs(MediaMotion(t: 7, index: 0).drift - 1) < 0.0001)
    #expect(abs(MediaMotion(t: 3.5, index: 0).drift - MediaMotion(t: 10.5, index: 0).drift) < 0.0001)
    // Tiles are staggered.
    #expect(MediaMotion(t: 1, index: 0).drift != MediaMotion(t: 1, index: 1).drift)
    // Bars stay between .35 and 1.
    for i in 0..<16 { for t in stride(from: 0.0, through: 3, by: 0.13) {
      let s = SoundBars.scale(t: t, i: i)
      #expect(s >= 0.35 && s <= 1.0001)
    } }
    // Still: nothing depends on time.
    #expect(MediaMotion(t: 3, index: 2, still: true).drift == MediaMotion(t: 9, index: 0, still: true).drift)
  }

  @Test func onlyJustMadeMediaIsRevealed() {
    let now = Date()
    #expect(MediaReveal.isFresh(ChatMessage(role: "assistant", content: "x", timestamp: now.addingTimeInterval(-5)), now: now))
    #expect(!MediaReveal.isFresh(ChatMessage(role: "assistant", content: "x", timestamp: now.addingTimeInterval(-600)), now: now))
  }
}
