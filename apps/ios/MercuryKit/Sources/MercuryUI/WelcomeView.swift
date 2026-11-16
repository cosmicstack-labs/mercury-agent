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

struct WelcomeView: View {
  @State var model: WelcomeModel
  var onPick: (String) -> Void

  var body: some View {
    VStack(spacing: 16) {
      MarkTile(size: 52)
      VStack(spacing: 6) {
        Text(model.pick?.greeting ?? WelcomeModel.greeting())
          .font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
        Text(model.pick?.subtitle ?? WelcomeModel.plain)
          .font(.system(size: 15)).foregroundStyle(Theme.ink3).multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: 320)
      }
      if let items = model.pick?.items, !items.isEmpty {
        VStack(spacing: 8) {
          ForEach(items) { s in
            Button { model.used(s); onPick(s.prompt) } label: { SuggestionRow(suggestion: s) }
              .buttonStyle(PressButtonStyle())
              .accessibilityHint("Puts it in the message box")
          }
        }
        .id(model.round)
        .transition(.opacity)
        .padding(.top, 4)
        Button { Task { await model.load() } } label: {
          Label("More ideas", systemImage: "arrow.clockwise").font(.system(size: 13))
        }
        .buttonStyle(LinkButtonStyle())
        .padding(.top, 2)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 24)
    .task { if model.pick == nil { await model.load() } }
    .animation(.easeOut(duration: 0.2), value: model.round)
  }
}

struct SuggestionRow: View {
  var suggestion: Suggestion
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: WelcomeModel.icon(suggestion.kind)).font(.system(size: 13)).foregroundStyle(Theme.accent)
        .frame(width: 30, height: 30).background(Theme.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
      VStack(alignment: .leading, spacing: 2) {
        Text(suggestion.title).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
        if let why = suggestion.why, !why.isEmpty {
          Text(why).font(.system(size: 13)).foregroundStyle(Theme.ink3).lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: "arrow.up.left").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink4).padding(.top, 4)
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
    .accessibilityElement(children: .combine)
  }
}
