import SwiftUI
import MercuryCore

/// A new chat: a greeting, a line about what the owner is up to, and four things they might want
/// next, made by the runtime from what it knows about them (GET /api/suggestions), different on
/// each new chat (apps/desktop/src/views/chat/Welcome.tsx). Tapping one puts it in the message box
/// to send or edit; nothing runs by itself. It never breaks a new chat: when suggestions can't load
/// (an older runtime, a fresh install, offline) it shows the greeting alone.
@MainActor @Observable
final class WelcomeModel {
  var pick: SuggestionPick?
  var round = 0
  let client: MercuryClient

  init(client: MercuryClient, pick: SuggestionPick? = nil) { self.client = client; self.pick = pick }

  func load() async {
    guard let p = try? await client.suggestions(4) else { return }
    pick = p
    round += 1
  }

  func used(_ s: Suggestion) { Task { await client.suggestionUsed(s.id) } }

  nonisolated static let plain = "Ask, delegate, or think out loud. I'll remember what matters."

  /// "Good morning" and the like, for when the runtime has no greeting.
  nonisolated static func greeting(_ now: Date = .now) -> String {
    switch Calendar.current.component(.hour, from: now) {
    case 5..<12: "Good morning"
    case 12..<17: "Good afternoon"
    case 17..<22: "Good evening"
    default: "Hello"
    }
  }

  nonisolated static func icon(_ kind: String?) -> String {
    switch kind {
    case "continue": "clock.arrow.circlepath"
    case "plan": "calendar.badge.checkmark"
    case "check": "checklist"
    case "learn": "book"
    case "explore": "binoculars"
    default: "sparkles"
    }
  }
}

/// The middle of an empty chat, as in Grok (and on Android): a large, faint mark and one quiet line.
struct WelcomeHello: View {
  var pick: SuggestionPick?
  /// A short screen: a smaller mark.
  var compact = false
  /// The least room it needs: the mark, the gap, the line, and a margin.
  static let minHeight: CGFloat = 190
  static let compactMinHeight: CGFloat = 104
  var body: some View {
    VStack(spacing: compact ? 10 : 18) {
      MercuryMark(color: Theme.ink4.opacity(0.55)).frame(width: compact ? 64 : 120, height: compact ? 64 : 120)
      Text(pick?.greeting ?? WelcomeModel.greeting())
        .font(.system(size: 16)).foregroundStyle(Theme.ink3).lineLimit(1)
    }
    .padding(.horizontal, 32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
  }
}

/// A new chat's room between the bar and the composer, as in the ChatGPT and Grok apps: the mark
/// and greeting in the middle, the quick-action chips just above the composer. It's keyboard-aware:
/// the composer is a safe-area bar, so this room shrinks as the keyboard comes up. While you type
/// (the box focused) the mark and greeting shrink and fade away; the chips stay just above the
/// composer, as many as fit (none when there's no room), so nothing ever overlaps. They come back
/// when the keyboard goes.
struct NewChatSpace: View {
  var pick: SuggestionPick?
  var ideas: [Suggestion]
  var media: MediaAvailability?
  /// The message box has focus (the keyboard is up).
  var typing: Bool
  var onMedia: (MediaIntent) -> Void
  var onPick: (Suggestion) -> Void

  var body: some View {
    GeometryReader { g in
      let all = QuickActions.items(ideas: ideas, media: media).count
      let lay = Self.layout(height: g.size.height, chips: all, typing: typing)
      VStack(spacing: 0) {
        ZStack {
          if lay.hello {
            WelcomeHello(pick: pick, compact: lay.compact).transition(.opacity.combined(with: .scale(scale: 0.8)))
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        if lay.chips > 0 {
          QuickActions(ideas: ideas, media: media, limit: lay.chips, onMedia: onMedia, onPick: onPick)
            .padding(.bottom, QuickActions.bottomGap)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
      }
      .animation(.snappy(duration: 0.28), value: lay)
    }
  }

  struct Layout: Equatable {
    var hello: Bool
    var chips: Int
    var compact = false
    /// The room the mark and greeting take as laid out (0 when hidden).
    var helloHeight: CGFloat { !hello ? 0 : compact ? WelcomeHello.compactMinHeight : WelcomeHello.minHeight }
  }

  /// What fits in `height` points: as many chips as fit (from the first), then the mark and
  /// greeting only when not typing and there's room left for them (a smaller mark on a short one).
  static func layout(height: CGFloat, chips: Int, typing: Bool) -> Layout {
    var n = chips
    while n > 0 && QuickActions.height(n) > height - 8 { n -= 1 }
    let left = height - QuickActions.height(n)
    if typing { return Layout(hello: false, chips: n) }
    if left >= WelcomeHello.minHeight { return Layout(hello: true, chips: n) }
    if left >= WelcomeHello.compactMinHeight { return Layout(hello: true, chips: n, compact: true) }
    return Layout(hello: false, chips: n)
  }
}

/// Above the composer in a new chat, stacked on the left as in Grok: Make an image, Create a
/// video, Make music (each sets the next message, as the + menu does), then up to two of the
/// runtime's ideas in the same style (a tap puts it in the box; nothing runs by itself).
struct QuickActions: View {
  var ideas: [Suggestion]
  var media: MediaAvailability?
  /// At most this many (the first ones), where the screen is short.
  var limit = Int.max
  var onMedia: (MediaIntent) -> Void
  var onPick: (Suggestion) -> Void

  static let chipHeight: CGFloat = 44
  static let spacing: CGFloat = 8
  static let verticalPadding: CGFloat = 6
  static let bottomGap: CGFloat = 4

  /// The height `n` chips take, padding and the gap above the composer included (0 for none).
  static func height(_ n: Int) -> CGFloat {
    n <= 0 ? 0 : CGFloat(n) * chipHeight + CGFloat(n - 1) * spacing + 2 * verticalPadding + bottomGap
  }

  enum Item: Identifiable {
    case media(MediaIntent, String, String)
    case idea(Suggestion)
    var id: String {
      switch self {
      case .media(_, _, let label): "media:" + label
      case .idea(let s): "idea:" + s.id
      }
    }
  }

  static func items(ideas: [Suggestion], media: MediaAvailability?) -> [Item] {
    let a = media ?? .unknown
    var out: [Item] = []
    if a.image { out.append(.media(MediaIntent(kind: .image, aspect: .square), "photo", "Make an image")) }
    if a.video { out.append(.media(MediaIntent(kind: .video, aspect: .landscape), "film", "Create a video")) }
    if a.music { out.append(.media(MediaIntent(kind: .music), "music.note", "Make music")) }
    out += ideas.map { .idea($0) }
    return out
  }

  var body: some View {
    GlassGroup(spacing: Self.spacing) {
      VStack(alignment: .leading, spacing: Self.spacing) {
        ForEach(Self.items(ideas: ideas, media: media).prefix(limit)) { item in
          switch item {
          case .media(let intent, let icon, let label): QuickChip(icon: icon, label: label) { onMedia(intent) }
          case .idea(let s): QuickChip(icon: WelcomeModel.icon(s.kind), label: s.title) { onPick(s) }
          }
        }
      }
    }
    .padding(.horizontal, 14).padding(.vertical, Self.verticalPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct QuickChip: View {
  var icon: String
  var label: String
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: icon).font(.system(size: 15)).foregroundStyle(Theme.ink)
        Text(label).font(.system(size: 16)).foregroundStyle(Theme.ink).lineLimit(1)
      }
      .padding(.horizontal, 16).frame(height: QuickActions.chipHeight)
      .contentShape(Capsule())
    }
    .buttonStyle(PressButtonStyle())
    .glassSurface(in: Capsule(), interactive: true)
    .frame(maxWidth: 320, alignment: .leading)
  }
}
