import SwiftUI
import MercuryCore

// MARK: - A question, in words (apps/desktop/src/components/needs-you/describe.ts)

/// A question from the runtime, in words: a short title, the exact thing it would run or touch
/// (one code block), and any note or warning. The runtime sends plain text in a handful of
/// shapes (src/capabilities/permissions.ts, src/security/tool-guard.ts); anything else is shown
/// as it came.
struct Described: Equatable {
  var title: String
  /// The command, path, URL or arguments, verbatim.
  var code: String?
  /// Context in a quiet line ("It read: weather.html, notes.txt").
  var note: String?
  /// Something to look at twice (data leaving, hidden instructions).
  var warning: String?
  /// Free text when the prompt isn't one of the known shapes (a question, a pick).
  var body: String?

  /// `kind` is the event that asked: permission_request, permission_continue or choice_prompt.
  init(kind: String, text raw: String) {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    self.title = "Allow this?"
    if kind == "permission_continue" || kind == "continue" { self = .init(title: "Keep going?", body: text); return }
    if kind == "choice_prompt" || kind == "choice" { self = .init(title: "Your pick", body: text); return }

    if let m = Rx.match(#"^Run command(?: \(([^)]*)\))?:\s*([\s\S]+)$"#, text) {
      self = .init(title: "Run a command", code: m[2]!.trimmed, note: m[1].map(Self.cap)); return
    }
    if let m = Rx.match(#"^(Write to file|Read file):\s*(.+)$"#, text) {
      self = .init(title: m[1] == "Read file" ? "Read a file" : "Write a file", code: m[2]!.trimmed); return
    }
    if let m = Rx.match(#"^Mercury needs (read|write) access to:\s*\n(.+?)\n"#, text, dotAll: true) {
      let write = m[1] == "write"
      self = .init(title: "Allow \(m[1]!) access", code: m[2]!.trimmed, note: write ? "Mercury may create and change files there." : "Mercury may read files there."); return
    }
    if let m = Rx.match(#"^MCP tool call\nServer:\s*(.+)\nTool:\s*(.+)\nArguments:\n([\s\S]*)$"#, text) {
      let args = m[3]!.trimmed
      self = .init(title: "Use \(m[2]!.trimmed)", code: args.isEmpty ? nil : args, note: "\(m[1]!.trimmed) (MCP server)"); return
    }
    if text.hasPrefix("⚠ Possible prompt injection") || text.hasPrefix("Mercury read content from outside this chat") {
      let injection = text.hasPrefix("⚠")
      let wants = Rx.match(#"It now wants to run (\S+) with:\n([\s\S]*?)(?:\n\n|$)"#, text)
      let sources = Rx.all(#"^- (.+?)(?: — contains instructions to an AI: .*)?$"#, text, lines: true)
        .compactMap { $0[1] }
        .map { $0.replacingOccurrences(of: #"\s*\((\w+)\)$"#, with: "", options: .regularExpression) }
        .filter { !$0.hasPrefix("…") }
      let leak = Rx.match(#"⚠ This could send data out: (.+?)\.?$"#, text, lines: true)
      var d = Described(title: "After reading outside content")
      if let wants {
        d.title = "\(injection ? "Suspicious request" : "After reading outside content"): \(Self.toolWords(wants[1]!))"
        d.code = wants[2]!.trimmed
      }
      let read = sources.prefix(3).map(Self.shortSource).joined(separator: ", ") + (sources.count > 3 ? " and \(sources.count - 3) more" : "")
      d.note = sources.isEmpty ? "Approve only if you asked for this." : "It read: \(read). Approve only if you asked for this."
      if injection { d.warning = "What it read contains instructions written to an AI." }
      if let leak { d.warning = "\(injection ? "Hidden instructions, and this " : "This ")could send data out: \(leak[1]!)." }
      self = d; return
    }
    if let m = Rx.match(#"^Open (\S+) in this chat.s isolated read-only browser\?\s*([\s\S]*)$"#, text) {
      let note = Self.cap(m[2]!.trimmed)
      self = .init(title: "Open a page", code: m[1], note: note.isEmpty ? nil : note); return
    }
    self = .init(title: "Allow this?", body: text)
  }

  init(title: String, code: String? = nil, note: String? = nil, warning: String? = nil, body: String? = nil) {
    self.title = title; self.code = code; self.note = note; self.warning = warning; self.body = body
  }

  /// "run_command" → "run a command"; other tool names as they are, spaced.
  static func toolWords(_ name: String) -> String {
    let words = [
      "run_command": "run a command", "write_file": "write a file", "edit_file": "edit a file", "create_file": "create a file", "delete_file": "delete a file",
      "fetch_url": "open a web address", "web_search": "search the web", "schedule_task": "schedule a task", "send_message": "send a message", "send_file": "send a file",
      "save_memory": "save to memory", "git_push": "push to git", "create_pr": "open a pull request", "create_issue": "open an issue", "delegate_task": "hand off a task",
    ]
    return words[name] ?? name.replacingOccurrences(of: "_", with: " ")
  }

  /// A path to its file name, a long address cut short.
  static func shortSource(_ s: String) -> String {
    let t = s.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
    let path = t.components(separatedBy: "/")
    if path.count > 2, Rx.match(#"^[\w.-]+\.\w+$"#, path[0]) == nil { return path[path.count - 1] }
    return t.count > 48 ? String(t.prefix(47)) + "…" : t
  }

  static func cap(_ s: String) -> String { s.isEmpty ? s : s.prefix(1).uppercased() + s.dropFirst() }
}

/// The answers to a question, each with its place: the main one, another yes, or no (quiet, on the right).
struct NeedsYouOption: Equatable, Hashable {
  enum Role { case primary, secondary, quiet }
  var value: String
  var label: String
  var role: Role

  /// The first is the main answer, a deny-like one is quiet, the rest secondary.
  static func roles(_ options: [ConversationModel.Prompt.Option]) -> [NeedsYouOption] {
    let deny = options.count >= 2
      ? options.firstIndex { Rx.match(#"^(deny|no|don'?t|stop|reject|decline|never|cancel)\b"#, $0.label, caseless: true) != nil }
      : nil
    return options.enumerated().map { i, o in
      NeedsYouOption(value: o.value, label: o.label, role: i == deny ? .quiet : i == 0 ? .primary : .secondary)
    }
  }
}

/// "Pick a model — the fast one" → name and detail, for a list row.
func splitChoiceLabel(_ label: String) -> (name: String, detail: String?) {
  guard let m = Rx.match(#"^(.{1,60}?)\s+[—–-]{1,2}\s+([\s\S]+)$"#, label) else { return (label, nil) }
  return (m[1]!.trimmed, m[2]!.trimmed)
}

/// Small regex helpers over NSRegularExpression (groups as optional strings, 0 = whole match).
enum Rx {
  nonisolated(unsafe) static var cache: [String: NSRegularExpression] = [:]
  static let lock = NSLock()

  static func regex(_ pattern: String, _ options: NSRegularExpression.Options) -> NSRegularExpression? {
    let key = "\(options.rawValue)|\(pattern)"
    lock.lock(); defer { lock.unlock() }
    if let r = cache[key] { return r }
    let r = try? NSRegularExpression(pattern: pattern, options: options)
    cache[key] = r
    return r
  }

  static func options(dotAll: Bool, lines: Bool, caseless: Bool) -> NSRegularExpression.Options {
    var o: NSRegularExpression.Options = []
    if dotAll { o.insert(.dotMatchesLineSeparators) }
    if lines { o.insert(.anchorsMatchLines) }
    if caseless { o.insert(.caseInsensitive) }
    return o
  }

  static func groups(_ m: NSTextCheckingResult, in s: String) -> [String?] {
    (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } }
  }

  static func match(_ pattern: String, _ s: String, dotAll: Bool = false, lines: Bool = false, caseless: Bool = false) -> [String?]? {
    guard let r = regex(pattern, options(dotAll: dotAll, lines: lines, caseless: caseless)),
          let m = r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
    return groups(m, in: s)
  }

  static func all(_ pattern: String, _ s: String, dotAll: Bool = false, lines: Bool = false) -> [[String?]] {
    guard let r = regex(pattern, options(dotAll: dotAll, lines: lines, caseless: false)) else { return [] }
    return r.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { groups($0, in: s) }
  }
}

extension String {
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

// MARK: - The card

/// "Needs you": everything this chat is waiting on you for, one at a time, in a card pinned above
/// the message box (the plan's style). Several are a carousel: "1 of 3", ‹ ›, or swipe. Answering
/// one shows the next; the card goes when none are left. Plain words on top, the exact command or
/// path underneath (folded when long), the main answer as the button, Deny quietly on the right.
struct NeedsYouCard: View {
  var prompts: [ConversationModel.Prompt]
  var answer: (ConversationModel.Prompt, String) async -> Void

  @State private var index = 0
  @State private var lastIds: [String] = []
  @State private var busy: String?
  @State private var open = false
  @State private var drag: CGFloat = 0

  static let codeFold = 6

  private var current: ConversationModel.Prompt? { prompts.isEmpty ? nil : prompts[min(index, prompts.count - 1)] }

  var body: some View {
    if let p = current {
      VStack(alignment: .leading, spacing: 0) {
        header
        Divider().overlay(Theme.line)
        page(p)
          .id(p.id)
          .offset(x: drag)
          .transition(.opacity)
          .contentShape(Rectangle())
          .gesture(prompts.count > 1 ? swipe : nil)
      }
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
      .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line))
      .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
      .onChange(of: prompts.map(\.id), initial: true) { _, ids in keepPlace(ids) }
      .onChange(of: index) { open = false }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Needs you")
    }
  }

  private var header: some View {
    HStack(spacing: 10) {
      Circle().fill(Theme.amber).frame(width: 8, height: 8)
        .overlay(Circle().stroke(Theme.amber.opacity(0.35), lineWidth: 4))
        .accessibilityHidden(true)
      Text("Needs you").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
      if prompts.count > 1 {
        Text("\(min(index, prompts.count - 1) + 1) of \(prompts.count)")
          .font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink3)
      }
      Spacer(minLength: 4)
      if prompts.count > 1 {
        HStack(spacing: 4) {
          ForEach(Array(prompts.prefix(6).enumerated()), id: \.element.id) { i, _ in
            Capsule().fill(i == index ? Theme.ink.opacity(0.55) : Theme.ink.opacity(0.15))
              .frame(width: i == index ? 14 : 6, height: 6)
          }
        }
        .accessibilityHidden(true)
        Button { go(-1) } label: { Image(systemName: "chevron.left").frame(width: 30, height: 30) }
          .buttonStyle(IconButtonStyle()).accessibilityLabel("Previous question")
        Button { go(1) } label: { Image(systemName: "chevron.right").frame(width: 30, height: 30) }
          .buttonStyle(IconButtonStyle()).accessibilityLabel("Next question")
      }
    }
    .padding(.leading, 14).padding(.trailing, prompts.count > 1 ? 6 : 14).frame(minHeight: 44)
  }

  @ViewBuilder
  private func page(_ p: ConversationModel.Prompt) -> some View {
    let d = Described(kind: p.kind, text: p.text)
    let options = NeedsYouOption.roles(p.options)
    let list = p.kind == "choice_prompt" || p.options.contains { $0.label.count > 32 }
    VStack(alignment: .leading, spacing: 8) {
      Text(d.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
        .fixedSize(horizontal: false, vertical: true)
      if let w = d.warning {
        Label { Text(w) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
          .font(.system(size: 13)).foregroundStyle(Theme.amber)
      }
      if let code = d.code { codeBlock(code) }
      if let b = d.body {
        Text(b).font(.system(size: 15)).foregroundStyle(Theme.ink2).textSelection(.enabled)
          .lineLimit(open ? nil : 8).fixedSize(horizontal: false, vertical: true)
      }
      if let n = d.note { Text(n).font(.system(size: 13)).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true) }
      if list { choices(p, options) } else { buttons(p, options) }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func codeBlock(_ code: String) -> some View {
    let lines = code.components(separatedBy: "\n").count
    let long = lines > Self.codeFold || code.count > 320
    return VStack(alignment: .leading, spacing: 4) {
      Text(code).font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.ink)
        .lineLimit(open || !long ? nil : Self.codeFold)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
      if long {
        Button(open ? "Show less" : lines > Self.codeFold ? "Show all \(lines) lines" : "Show all") { withAnimation(.snappy) { open.toggle() } }
          .buttonStyle(LinkButtonStyle())
      }
    }
  }

  private func buttons(_ p: ConversationModel.Prompt, _ options: [NeedsYouOption]) -> some View {
    HStack(spacing: 8) {
      ForEach(options.filter { $0.role != .quiet }, id: \.self) { o in
        Button { reply(p, o.value) } label: { label(o) }
          .buttonStyle(AnswerButtonStyle(primary: o.role == .primary))
      }
      Spacer(minLength: 0)
      ForEach(options.filter { $0.role == .quiet }, id: \.self) { o in
        Button { reply(p, o.value) } label: { label(o) }.buttonStyle(AnswerButtonStyle(quiet: true))
      }
    }
    .disabled(busy != nil)
    .padding(.top, 4)
  }

  private func choices(_ p: ConversationModel.Prompt, _ options: [NeedsYouOption]) -> some View {
    VStack(spacing: 6) {
      ForEach(Array(options.enumerated()), id: \.element) { i, o in
        let split = splitChoiceLabel(o.label)
        Button { reply(p, o.value) } label: {
          HStack(alignment: .top, spacing: 10) {
            Text(i < 9 ? "\(i + 1)" : "·").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink3)
              .frame(width: 22, height: 22).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 2) {
              Text(split.name).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
              if let d = split.detail { Text(d).font(.system(size: 13)).foregroundStyle(Theme.ink3).lineLimit(2) }
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 10).padding(.vertical, 9)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
          .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
          .opacity(busy == o.value ? 0.6 : 1)
        }
        .buttonStyle(PressButtonStyle())
      }
      if p.kind == "choice_prompt" {
        HStack { Button("Cancel") { reply(p, "") }.buttonStyle(AnswerButtonStyle(quiet: true)); Spacer() }
      }
    }
    .disabled(busy != nil)
    .padding(.top, 2)
  }

  private func label(_ o: NeedsYouOption) -> some View {
    Text(o.label).opacity(busy == o.value ? 0.5 : 1)
  }

  private func reply(_ p: ConversationModel.Prompt, _ value: String) {
    guard busy == nil else { return }
    busy = value
    Task { await answer(p, value); busy = nil }
  }

  private var swipe: some Gesture {
    DragGesture(minimumDistance: 20)
      .onChanged { v in if abs(v.translation.width) > abs(v.translation.height) { drag = v.translation.width * 0.4 } }
      .onEnded { v in
        let dx = v.translation.width
        withAnimation(.snappy) {
          drag = 0
          if abs(dx) > 60, abs(dx) > abs(v.translation.height) { go(dx < 0 ? 1 : -1) }
        }
      }
  }

  private func go(_ d: Int) {
    guard prompts.count > 1 else { return }
    withAnimation(.snappy) { index = (min(index, prompts.count - 1) + d + prompts.count) % prompts.count }
  }

  /// Keep showing the same question when others arrive or leave; else stay at the same place.
  private func keepPlace(_ ids: [String]) {
    let current = lastIds.indices.contains(index) ? lastIds[index] : nil
    if let current, let at = ids.firstIndex(of: current) { index = at } else { index = min(index, max(0, ids.count - 1)) }
    lastIds = ids
  }
}

/// One question on its own (a voice call shows the first one waiting).
struct PromptCard: View {
  var prompt: ConversationModel.Prompt
  var answer: (String) -> Void
  var body: some View {
    NeedsYouCard(prompts: [prompt]) { _, v in answer(v) }
  }
}

// MARK: - Buttons

/// The card's answers: the main one filled, another yes outlined, no as quiet text.
struct AnswerButtonStyle: ButtonStyle {
  var primary = false
  var quiet = false
  @Environment(\.isEnabled) var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15, weight: primary ? .semibold : .medium))
      .lineLimit(1)
      .padding(.horizontal, quiet ? 10 : 16)
      .frame(minHeight: 40)
      .foregroundStyle(primary ? Theme.onAccent : quiet ? Theme.ink2 : Theme.ink)
      .background {
        if primary { RoundedRectangle(cornerRadius: 11).fill(Theme.accent) }
        else if !quiet { RoundedRectangle(cornerRadius: 11).stroke(Theme.ink.opacity(0.16)) }
      }
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.7 : enabled ? 1 : 0.6)
  }
}

/// A small tappable glyph (chevrons, close).
struct IconButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink3)
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.5 : 1)
  }
}

/// Small text that acts ("Show all 12 lines", "More ideas").
struct LinkButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.system(size: 13)).foregroundStyle(Theme.ink3)
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.5 : 1)
  }
}

/// A whole row or card that dims while pressed.
struct PressButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.contentShape(Rectangle()).opacity(configuration.isPressed ? 0.7 : 1)
  }
}
