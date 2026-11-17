import SwiftUI
import MercuryCore

/// Media being made (09a–09e) and Settings → Appearance with a few tints (10a–10f), for the
/// Snapshots tool. The renderer can't draw forms or scroll views, so screens are laid out directly.
@MainActor
public enum AppearanceGallery {
  static var client: MercuryClient { ChatGallery.client }
  static let fox = "A red fox in fresh snow at dawn, soft light"

  // MARK: Media on its way

  static func making(_ title: String, ask: String, steps: [(count: Int, done: Bool)], aspect: String, startedAgo: TimeInterval) -> AnyView {
    let m = ChatGallery.model(title)
    let start = Date(timeIntervalSinceNow: -startedAgo)
    var t = TurnTrace(startedAt: start)
    t.addReasoning("One call per picture, landscape.", now: start.addingTimeInterval(1))
    t.endReasoning(start.addingTimeInterval(3))
    for (i, s) in steps.enumerated() {
      t.startTool(key: "g\(i)", tool: "generate_image", title: nil, number: i + 1,
                  media: .init(kind: "image", aspect: aspect, count: s.count, prompt: fox), now: start.addingTimeInterval(4 + Double(i)))
      if s.done { t.finishTool(key: "g\(i)", tool: "generate_image", failed: false, summary: nil, durationMs: 20_000) }
    }
    t.lastEventAt = .now
    m.live = t
    m.agent = .working
    let user = ChatMessage(role: "user", content: ask)
    return ChatGallery.screen { ChatGallery.bottom(m) { MessageView(message: user, client: client); LiveTurn(model: m, trace: t) } }
  }

  static func background(_ kind: String, aspect: String?, prompt: String, ask: String, reply: String) -> AnyView {
    let m = ChatGallery.model("Made in the background")
    m.messages = [ChatMessage(role: "user", content: ask), ChatMessage(role: "assistant", content: reply)]
    let job = PendingMedia(jobId: "j1", kind: kind, aspect: aspect, prompt: prompt, startedAt: Date(timeIntervalSinceNow: -38).timeIntervalSince1970 * 1000)
    return ChatGallery.screen {
      ChatGallery.bottom(m) {
        ForEach(m.messages) { MessageView(message: $0, client: client) }
        PendingMediaList(jobs: [job])
      }
    }
  }

  /// One tile as it settles: field, then tick, side by side (the 300 ms change, frozen).
  static var tiles: AnyView {
    ChatGallery.screen {
      VStack(alignment: .leading, spacing: 16) {
        Text("Tiles: waiting, ready").font(.system(size: 13)).foregroundStyle(Theme.ink3)
        HStack(spacing: 8) {
          GeneratingTile(kind: "image", index: 0).aspectRatio(1, contentMode: .fit)
          GeneratingTile(kind: "image", index: 1, ready: true).aspectRatio(1, contentMode: .fit)
          GeneratingTile(kind: "video", index: 2).aspectRatio(1, contentMode: .fit)
        }
        Text("Reduce Motion: held still").font(.system(size: 13)).foregroundStyle(Theme.ink3)
        HStack(spacing: 8) {
          GeneratingTile(kind: "image", index: 0).aspectRatio(1, contentMode: .fit)
          GeneratingTile(kind: "image", index: 1, ready: true).aspectRatio(1, contentMode: .fit)
          GeneratingTile(kind: "video", index: 2).aspectRatio(1, contentMode: .fit)
        }
        .environment(\.stillMedia, true)
        MediaPlaceholder(shape: .init(kind: "speech", prompt: "Read the summary aloud"), startedAt: Date(timeIntervalSinceNow: -4), now: .now)
        MediaPlaceholder(shape: .init(kind: "image", aspect: "portrait", prompt: fox), startedAt: Date(timeIntervalSinceNow: -12), now: .now)
      }
      .padding(16)
    }
  }

  // MARK: Appearance

  /// Settings → Appearance as the form lays it out.
  static var settings: AnyView {
    let look = Appearance.shared
    func section<V: View>(_ title: String?, footer: String? = nil, @ViewBuilder _ v: () -> V) -> some View {
      VStack(alignment: .leading, spacing: 6) {
        if let title { Text(title.uppercased()).font(.system(size: 12)).foregroundStyle(Theme.ink3).padding(.leading, 16) }
        VStack(alignment: .leading, spacing: 0) { v() }
          .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        if let footer { Text(footer).font(.system(size: 12)).foregroundStyle(Theme.ink3).padding(.horizontal, 16) }
      }
    }
    return ChatGallery.screen {
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 4) {
          Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.accent)
          Text("Settings").font(.system(size: 17)).foregroundStyle(Theme.accent)
          Spacer()
        }
        .overlay { Text("Appearance").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink) }
        section(nil) { AppearancePreview().padding(12) }
        section("Theme", footer: "Black and white, like the Android app. Mercury's green only marks a chat that's working; amber needs you, red failed. Kept on this phone only.") { ThemeModePicker(look: look).padding(12) }
      }
      .padding(16)
    }
  }

  /// A picture being made, a reply's link and the composer, to see a tint in a chat.
  static var chat: AnyView {
    let m = ChatGallery.model("Fox images")
    let start = Date(timeIntervalSinceNow: -30)
    var t = TurnTrace(startedAt: start)
    t.startTool(key: "a", tool: "web_search", title: "Search “red fox winter coat”", number: 1, media: nil, now: start)
    t.finishTool(key: "a", tool: "web_search", failed: false, summary: "8 results", durationMs: 2100)
    t.startTool(key: "b", tool: "generate_image", title: nil, number: 2, media: .init(kind: "image", aspect: "landscape", count: 2, prompt: fox), now: start.addingTimeInterval(4))
    t.finishTool(key: "b", tool: "generate_image", failed: false, summary: nil, durationMs: 20_000)
    t.startTool(key: "c", tool: "generate_image", title: nil, number: 3, media: .init(kind: "image", aspect: "landscape", count: 2, prompt: fox), now: start.addingTimeInterval(25))
    t.lastEventAt = .now
    m.live = t
    m.agent = .working
    m.draft = "Make the third one warmer"
    let earlier = ChatMessage(role: "assistant", content: "I used the [reference you sent](https://example.com) for the fur colour. Want four more?")
    return ChatGallery.screen {
      ChatGallery.bottom(m) {
        MessageView(message: earlier, client: client)
        MessageView(message: ChatMessage(role: "user", content: "Yes, four, landscape"), client: client)
        LiveTurn(model: m, trace: t)
      }
    }
  }

  public static func screens() -> [(name: String, view: AnyView)] {
    [
      ("09a-media-image-single", making("A fox", ask: "Make an image of a red fox in snow, landscape", steps: [(1, false)], aspect: "landscape", startedAgo: 17)),
      ("09b-media-batch-4", making("Fox images", ask: "Make 4 images of a red fox in snow", steps: [(1, true), (1, true), (1, false), (1, false)], aspect: "landscape", startedAgo: 26)),
      ("09c-media-video", background("video", aspect: "landscape", prompt: "A drone shot over a snowy forest at dawn", ask: "Make a short video of a snowy forest from above", reply: "I've started the video. It takes a minute or two.")),
      ("09d-media-music", background("music", aspect: nil, prompt: "A calm winter theme, piano and strings", ask: "Make a calm winter theme", reply: "Writing it now. It will play here when it's done.")),
      ("09e-media-tiles", tiles),
    ]
  }

  /// Settings → Appearance and a chat in the monochrome theme.
  public static func themed() -> [(name: String, view: AnyView)] {
    [("10a-appearance", settings), ("10d-chat-monochrome", chat)]
  }
}
