import SwiftUI
import MercuryCore

/// Screen 4: a question Mercury is waiting on. Permission prompts arrive as
/// "Run command: …", "Write to file: …" or "Read file: …" (src/capabilities/permissions.ts);
/// the card names the action, shows exactly what would run, and Mercury waits until you answer.
struct PromptCard: View {
  var prompt: ConversationModel.Prompt
  var answer: (String) -> Void

  var body: some View {
    let ask = Ask(prompt)
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        Image(systemName: ask.icon).font(.system(size: 17)).foregroundStyle(Theme.amber)
          .frame(width: 40, height: 40).background(Theme.amber.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
        VStack(alignment: .leading, spacing: 2) {
          Text(ask.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
          Text("Mercury waits here until you answer").font(.system(size: 13)).foregroundStyle(Theme.ink3)
        }
      }
      if let detail = ask.detail {
        Text(detail).font(.system(size: 14, design: .monospaced)).foregroundStyle(Theme.ink)
          .padding(12).frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10))
          .textSelection(.enabled)
      }
      if let note = ask.note {
        Text(note).font(.system(size: 14)).foregroundStyle(Theme.ink2)
      }
      Buttons(options: prompt.options, answer: answer)
    }
    .padding(16)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
    .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.amber.opacity(0.55), lineWidth: 1.5))
    .accessibilityElement(children: .contain)
  }

  /// Allow once is the main action; Always allow and Deny sit side by side under it.
  struct Buttons: View {
    var options: [ConversationModel.Prompt.Option]
    var answer: (String) -> Void
    var body: some View {
      let main = options.first { $0.value == "yes" } ?? options.first
      let rest = options.filter { $0 != main }
      VStack(spacing: 8) {
        if let main { Button(main.label) { answer(main.value) }.buttonStyle(PrimaryButtonStyle()) }
        if !rest.isEmpty {
          HStack(spacing: 8) {
            ForEach(rest, id: \.self) { o in
              Button(o.label) { answer(o.value) }.buttonStyle(SecondaryButtonStyle(danger: o.value == "no"))
            }
          }
        }
      }
    }
  }
}

/// What a prompt is asking, in words, split from the exact command or path.
struct Ask {
  var title: String
  var detail: String?
  var note: String?
  var icon: String

  init(_ p: ConversationModel.Prompt) {
    let text = p.text
    func after(_ prefix: String) -> String? {
      guard text.hasPrefix(prefix), let colon = text.firstIndex(of: ":") else { return nil }
      return String(text[text.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
    }
    if let cmd = after("Run command") {
      title = "Mercury wants to run a command"; detail = cmd; icon = "terminal"
      note = text.contains("always asks") ? "This changes Mercury's own setup, so it always asks." : nil
    } else if let path = after("Write to file") {
      title = "Mercury wants to change a file"; detail = path; icon = "square.and.pencil"
    } else if let path = after("Read file") {
      title = "Mercury wants to read a file"; detail = path; icon = "doc.text.magnifyingglass"
    } else if p.kind == "permission_continue" {
      title = "Keep going?"; note = text; icon = "arrow.trianglehead.clockwise"
    } else if p.kind == "choice_prompt" {
      title = "Mercury has a question"; note = text; icon = "questionmark.bubble"
    } else {
      title = "Mercury needs your OK"; note = text; icon = "hand.raised"
    }
  }
}

struct SecondaryButtonStyle: ButtonStyle {
  var danger = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15, weight: .medium))
      .frame(maxWidth: .infinity, minHeight: 46)
      .foregroundStyle(danger ? Theme.red : Theme.ink)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
      .opacity(configuration.isPressed ? 0.8 : 1)
  }
}
