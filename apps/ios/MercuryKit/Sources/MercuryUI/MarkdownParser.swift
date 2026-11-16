import SwiftUI

/// A reply's Markdown as the blocks the phone draws (apps/desktop/src/components/Markdown.tsx is the reference).
indirect enum MDBlock: Equatable {
  case paragraph(AttributedString)
  case heading(Int, AttributedString)
  case code(language: String?, text: String)
  case quote([MDBlock])
  case alert(MDAlert, [MDBlock])
  case list(ordered: Bool, start: Int, items: [MDItem])
  case table(header: [AttributedString], rows: [[AttributedString]])
  case rule
}

struct MDItem: Equatable {
  /// nil for a plain item; for a task (`- [ ]` / `- [x]`), whether it's done.
  var done: Bool?
  var blocks: [MDBlock]
}

/// GitHub alerts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`.
enum MDAlert: String, CaseIterable {
  case note, tip, important, warning, caution
}

/// Foundation parses the Markdown (GitHub flavour: tables, strikethrough) and tags every run of
/// text with the blocks it sits in. This rebuilds the block tree from those tags, then reads it
/// as `MDBlock`s; task-list boxes and alerts, which Foundation leaves as text, are recognised here.
enum MarkdownParser {
  final class Node {
    let kind: PresentationIntent.Kind?
    let identity: Int
    var children: [Node] = []
    var text = AttributedString()
    init(kind: PresentationIntent.Kind?, identity: Int) { self.kind = kind; self.identity = identity }
  }

  final class Parsed { let blocks: [MDBlock]; init(_ b: [MDBlock]) { blocks = b } }
  nonisolated(unsafe) static let cache: NSCache<NSString, Parsed> = { let c = NSCache<NSString, Parsed>(); c.countLimit = 200; return c }()

  /// Parsed once per text (and tint, which links are drawn in): a list of replies redraws often,
  /// and a streaming reply only grows.
  static func cached(_ markdown: String) -> [MDBlock] {
    let key = "\(Appearance.shared.pair.light)\u{1}\(markdown)" as NSString
    if let hit = cache.object(forKey: key) { return hit.blocks }
    let blocks = parse(markdown)
    cache.setObject(Parsed(blocks), forKey: key)
    return blocks
  }

  static func parse(_ markdown: String) -> [MDBlock] {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
    guard let parsed = try? AttributedString(markdown: markdown, options: options) else { return [.paragraph(AttributedString(markdown))] }
    let root = Node(kind: nil, identity: -1)
    for run in parsed.runs {
      // components run innermost first; walk the tree from the outside in.
      var node = root
      for c in (run.presentationIntent?.components ?? []).reversed() {
        if let last = node.children.last, last.identity == c.identity { node = last }
        else { let n = Node(kind: c.kind, identity: c.identity); node.children.append(n); node = n }
      }
      var piece = AttributedString(parsed[run.range])
      piece.presentationIntent = nil
      node.text += piece
    }
    return blocks(root.children)
  }

  static func blocks(_ nodes: [Node]) -> [MDBlock] { nodes.compactMap(block) }

  static func block(_ n: Node) -> MDBlock? {
    switch n.kind {
    case .paragraph?:
      return .paragraph(inline(n.text))
    case .header(let level)?:
      return .heading(level, inline(n.text))
    case .codeBlock(let language)?:
      var code = String(n.text.characters)
      while code.hasSuffix("\n") { code.removeLast() }
      return .code(language: language?.isEmpty == false ? language : nil, text: code)
    case .thematicBreak?:
      return .rule
    case .blockQuote?:
      let inner = blocks(n.children)
      return alert(inner) ?? .quote(inner)
    case .orderedList?, .unorderedList?:
      let ordered = if case .orderedList? = n.kind { true } else { false }
      var start = 1
      if case .listItem(let ordinal)? = n.children.first?.kind { start = ordinal }
      return .list(ordered: ordered, start: start, items: n.children.map { item(blocks($0.children)) })
    case .table?:
      let header = n.children.first { if case .tableHeaderRow? = $0.kind { true } else { false } }
      let rows = n.children.filter { if case .tableRow? = $0.kind { true } else { false } }
      return .table(header: header?.children.map(cell) ?? [], rows: rows.map { $0.children.map(cell) })
    default:
      if !n.children.isEmpty { return blocks(n.children).first }
      return n.text.characters.isEmpty ? nil : .paragraph(inline(n.text))
    }
  }

  static func cell(_ n: Node) -> AttributedString {
    inline(n.children.reduce(n.text) { $0 + $1.text })
  }

  /// `[ ] ` or `[x] ` at the start of an item makes it a task.
  static func item(_ blocks: [MDBlock]) -> MDItem {
    guard case .paragraph(var text)? = blocks.first else { return MDItem(done: nil, blocks: blocks) }
    let head = String(text.characters.prefix(4))
    guard ["[ ] ", "[x] ", "[X] "].contains(head) else { return MDItem(done: nil, blocks: blocks) }
    text.removeSubrange(text.startIndex..<text.index(text.startIndex, offsetByCharacters: 4))
    return MDItem(done: head != "[ ] ", blocks: [.paragraph(text)] + blocks.dropFirst())
  }

  /// A quote that opens with `[!NOTE]` (or another kind) is a callout.
  static func alert(_ blocks: [MDBlock]) -> MDBlock? {
    guard case .paragraph(var text)? = blocks.first else { return nil }
    let s = String(text.characters)
    guard let m = s.range(of: #"^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*"#, options: [.regularExpression, .caseInsensitive]),
          let kind = MDAlert(rawValue: s[m].trimmingCharacters(in: .whitespacesAndNewlines).dropFirst(2).dropLast().lowercased()) else { return nil }
    text.removeSubrange(text.startIndex..<text.index(text.startIndex, offsetByCharacters: s.distance(from: s.startIndex, to: m.upperBound)))
    let rest = Array(blocks.dropFirst())
    return .alert(kind, text.characters.isEmpty ? rest : [.paragraph(text)] + rest)
  }

  /// Inline code gets a tinted mono face, links the accent with an underline (as on desktop).
  static func inline(_ text: AttributedString) -> AttributedString {
    var t = text
    for run in t.runs {
      if run.inlinePresentationIntent?.contains(.code) == true {
        t[run.range].font = .system(size: 14.5, design: .monospaced)
        t[run.range].backgroundColor = Theme.ink.opacity(0.07)
      }
      if run.link != nil {
        t[run.range].foregroundColor = Theme.accent
        t[run.range].underlineStyle = .single
      }
    }
    return t
  }
}
