import Testing
import SwiftUI
@testable import MercuryUI
@testable import MercuryCore

@Suite(.serialized) struct AppearanceStoreTests {
  func defaults() -> UserDefaults {
    let d = UserDefaults(suiteName: "appearance-tests")!
    d.removePersistentDomain(forName: "appearance-tests")
    return d
  }

  @Test func remembersTheThemeOnThisDevice() {
    let d = defaults()
    let a = Appearance(defaults: d)
    #expect(a.mode == .system && a.mode.scheme == nil)
    a.mode = .dark
    let b = Appearance(defaults: d)
    #expect(b.mode == .dark && b.mode.scheme == .dark)
  }

  @Test func anOldTintIsForgotten() {
    let d = defaults()
    d.set("#6D4CCC", forKey: "appearance.tint")
    _ = Appearance(defaults: d)
    #expect(d.string(forKey: "appearance.tint") == nil)
  }

  /// Monochrome, like Android: ink for actions, Mercury's green only for status.
  @Test func theThemeIsMonochrome() {
    func grey(_ v: UInt32) -> Bool { (v >> 16) & 0xFF == (v >> 8) & 0xFF && (v >> 8) & 0xFF == v & 0xFF }
    for p in Palette.monochrome { #expect(grey(p.light) && grey(p.dark)) }
    #expect(Palette.bg.light == 0xFFFFFF && Palette.bg.dark == 0x000000)
    #expect(!grey(Palette.green.light) && !grey(Palette.amber.dark) && !grey(Palette.red.light))
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
