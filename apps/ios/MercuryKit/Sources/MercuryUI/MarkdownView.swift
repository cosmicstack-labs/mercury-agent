import SwiftUI

/// Mercury's replies, rendered for reading, as Mercury Desktop does: headings, lists and task
/// lists, code blocks with their language, Copy and line wrapping, tables that scroll sideways,
/// quotes and callouts. Inline bold, italic, strikethrough, code and links render natively.
struct Markdown: View {
  var text: String
  var body: some View {
    MarkdownBlocks(blocks: MarkdownParser.cached(text))
      .foregroundStyle(Theme.ink)
      .tint(Theme.accent)
      .frame(maxWidth: .infinity, alignment: .leading)
      .textSelection(.enabled)
  }
}

struct MarkdownBlocks: View {
  var blocks: [MDBlock]
  var spacing: CGFloat = 12
  var depth = 0
  var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(blocks.indices, id: \.self) { MarkdownBlock(block: blocks[$0], depth: depth) }
    }
  }
}

struct MarkdownBlock: View {
  var block: MDBlock
  var depth: Int

  var body: some View {
    switch block {
    case .paragraph(let t):
      Text(t).font(.system(size: 16)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
    case .heading(let level, let t):
      Text(t).font(.system(size: [21.5, 19, 17.5, 16][min(max(level, 1), 4) - 1], weight: .semibold))
        .fixedSize(horizontal: false, vertical: true).padding(.top, level <= 2 ? 6 : 2)
        .accessibilityAddTraits(.isHeader)
    case .code(let language, let text):
      CodeBlock(language: language, code: text)
    case .quote(let inner):
      HStack(alignment: .top, spacing: 12) {
        Rectangle().fill(Theme.ink.opacity(0.18)).frame(width: 2)
        MarkdownBlocks(blocks: inner, spacing: 8, depth: depth).foregroundStyle(Theme.ink2)
      }
      .fixedSize(horizontal: false, vertical: true)
    case .alert(let kind, let inner):
      Callout(kind: kind, blocks: inner, depth: depth)
    case .list(let ordered, let start, let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(items.indices, id: \.self) { i in
          ListItem(item: items[i], marker: ordered ? "\(start + i)." : ["•", "◦", "▪"][min(depth, 2)], ordered: ordered, depth: depth)
        }
      }
    case .table(let header, let rows):
      MarkdownTable(header: header, rows: rows)
    case .rule:
      Rectangle().fill(Theme.ink.opacity(0.12)).frame(height: 1).padding(.vertical, 4)
    }
  }
}

struct ListItem: View {
  var item: MDItem
  var marker: String
  var ordered: Bool
  var depth: Int

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if let done = item.done {
        Image(systemName: done ? "checkmark.square.fill" : "square")
          .font(.system(size: 16)).foregroundStyle(done ? Theme.accent : Theme.ink3)
          .accessibilityLabel(done ? "Done" : "To do")
      } else {
        Text(marker).font(.system(size: 16, weight: ordered ? .medium : .regular)).monospacedDigit()
          .foregroundStyle(Theme.ink3).frame(minWidth: ordered ? 20 : 12, alignment: .leading)
          .accessibilityHidden(!ordered)
      }
      MarkdownBlocks(blocks: item.blocks, spacing: 6, depth: depth + 1)
        .foregroundStyle(item.done == true ? Theme.ink3 : Theme.ink)
        .strikethrough(item.done == true, color: Theme.ink.opacity(0.3))
    }
  }
}

/// A fenced code block: its language, Copy, and a wrap toggle; long lines scroll sideways.
struct CodeBlock: View {
  var language: String?
  var code: String
  @State var wrap = false
  @State var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 2) {
        Text((language ?? "text").lowercased()).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink3)
        Spacer(minLength: 0)
        Button { wrap.toggle() } label: {
          Image(systemName: "text.word.spacing").font(.system(size: 13)).foregroundStyle(wrap ? Theme.accent : Theme.ink3)
            .frame(width: 36, height: 34).contentShape(Rectangle())
        }
        .accessibilityLabel(wrap ? "Don't wrap lines" : "Wrap lines")
        Button(action: copy) {
          Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.system(size: 12))
            .foregroundStyle(copied ? Theme.accent : Theme.ink3).padding(.horizontal, 8).frame(height: 34).contentShape(Rectangle())
        }
      }
      .buttonStyle(.plain)
      .padding(.leading, 12).padding(.trailing, 4)
      Rectangle().fill(Theme.ink.opacity(0.08)).frame(height: 1)
      if wrap {
        source.fixedSize(horizontal: false, vertical: true)
      } else {
        ScrollView(.horizontal, showsIndicators: false) { source.fixedSize() }.fixedSize(horizontal: false, vertical: true)
      }
    }
    .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.ink.opacity(0.1)))
  }

  var source: some View {
    Text(code).font(.system(size: 13.5, design: .monospaced)).lineSpacing(4).foregroundStyle(Theme.ink)
      .padding(.vertical, 14).padding(.horizontal, 16)
  }

  func copy() {
    #if canImport(UIKit)
    UIPasteboard.general.string = code
    #else
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string)
    #endif
    copied = true
    Task { try? await Task.sleep(for: .seconds(1.2)); copied = false }
  }
}

/// A table in a rounded box: a tinted header, striped rows, sideways scrolling when wide.
struct MarkdownTable: View {
  var header: [AttributedString]
  var rows: [[AttributedString]]

  var columns: Int { max(header.count, rows.map(\.count).max() ?? 0) }

  var body: some View {
    // A table that fits spans the width, as on desktop; a wider one scrolls sideways.
    ViewThatFits(in: .horizontal) {
      grid
      ScrollView(.horizontal, showsIndicators: false) { grid }
    }
    .fixedSize(horizontal: false, vertical: true)
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.ink.opacity(0.12)))
  }

  var grid: some View {
      Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
        if !header.isEmpty {
          GridRow { ForEach(0..<columns, id: \.self) { c in cell(c < header.count ? header[c] : "", bold: true).background(Theme.ink.opacity(0.04)) } }
        }
        ForEach(rows.indices, id: \.self) { r in
          Rectangle().fill(Theme.ink.opacity(0.08)).frame(height: 1).gridCellUnsizedAxes(.horizontal)
          GridRow {
            ForEach(0..<columns, id: \.self) { c in
              cell(c < rows[r].count ? rows[r][c] : "", bold: false).background(r % 2 == 1 ? Theme.ink.opacity(0.025) : .clear)
            }
          }
        }
      }
  }

  func cell(_ t: AttributedString, bold: Bool) -> some View {
    Text(t).font(.system(size: 14, weight: bold ? .semibold : .regular))
      .frame(maxWidth: 240, alignment: .leading).fixedSize(horizontal: false, vertical: true)
      .padding(.vertical, 7).padding(.horizontal, 10)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

/// `> [!NOTE]` and friends: a tinted box with a bar, an icon and the kind's name.
struct Callout: View {
  var kind: MDAlert
  var blocks: [MDBlock]
  var depth: Int

  var tone: Color {
    switch kind {
    case .note: Theme.cyan
    case .tip: Theme.accent
    case .important: Color(hex: 0x8B5CF6)
    case .warning: Theme.amber
    case .caution: Theme.red
    }
  }

  var icon: String {
    switch kind {
    case .note: "info.circle"
    case .tip: "lightbulb"
    case .important: "exclamationmark.circle"
    case .warning: "exclamationmark.triangle"
    case .caution: "exclamationmark.octagon"
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Label(kind.rawValue.capitalized, systemImage: icon).font(.system(size: 14, weight: .semibold)).foregroundStyle(tone)
      MarkdownBlocks(blocks: blocks, spacing: 8, depth: depth)
    }
    .padding(.vertical, 10).padding(.horizontal, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(tone.opacity(0.08))
    .overlay(alignment: .leading) { Rectangle().fill(tone).frame(width: 3) }
    .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 10, topTrailingRadius: 10))
    .accessibilityElement(children: .combine)
  }
}
