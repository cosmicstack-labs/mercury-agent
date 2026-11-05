import Testing
import SwiftUI
@testable import MercuryUI

struct MarkdownTests {
  func plain(_ t: AttributedString) -> String { String(t.characters) }

  @Test func headingsParagraphsAndRules() {
    let b = MarkdownParser.parse("# Title\n\nSome **bold** text.\n\n---\n\n### Small")
    guard b.count == 4, case .heading(1, let h) = b[0], case .paragraph(let p) = b[1], case .rule = b[2], case .heading(3, _) = b[3] else {
      Issue.record("got \(b)"); return
    }
    #expect(plain(h) == "Title")
    #expect(plain(p) == "Some bold text.")
  }

  @Test func nestedListsKeepTheirShape() {
    let b = MarkdownParser.parse("3. one\n4. two\n   - inner a\n   - inner b\n5. three")
    guard case .list(true, 3, let items)? = b.first else { Issue.record("got \(b)"); return }
    #expect(items.count == 3)
    guard items.count == 3, items[1].blocks.count == 2, case .list(false, _, let inner) = items[1].blocks[1] else { Issue.record("got \(items)"); return }
    #expect(inner.count == 2)
  }

  @Test func taskItemsBecomeBoxes() {
    let b = MarkdownParser.parse("- [x] ship it\n- [ ] tell people\n- plain")
    guard case .list(false, _, let items)? = b.first else { Issue.record("got \(b)"); return }
    #expect(items.map(\.done) == [true, false, nil])
    if case .paragraph(let t)? = items.first?.blocks.first { #expect(plain(t) == "ship it") }
  }

  @Test func codeBlocksKeepTheirLanguageAndLines() {
    let b = MarkdownParser.parse("```swift\nlet a = 1\nlet b = 2\n```")
    #expect(b == [.code(language: "swift", text: "let a = 1\nlet b = 2")])
  }

  @Test func tablesHaveAHeaderAndRows() {
    let b = MarkdownParser.parse("| Plan | Price |\n|---|---|\n| Free | $0 |\n| Pro | **$20** |")
    guard case .table(let header, let rows)? = b.first else { Issue.record("got \(b)"); return }
    #expect(header.map(plain) == ["Plan", "Price"])
    #expect(rows.map { $0.map(plain) } == [["Free", "$0"], ["Pro", "$20"]])
  }

  @Test func alertsAndQuotes() {
    let b = MarkdownParser.parse("> [!WARNING]\n> This deletes files.\n\n> Just a quote.")
    guard b.count == 2, case .alert(.warning, let inner) = b[0], case .quote = b[1] else { Issue.record("got \(b)"); return }
    if case .paragraph(let t)? = inner.first { #expect(plain(t) == "This deletes files.") }
  }

  @Test func linesOfOneParagraphDontRunTogether() {
    guard case .paragraph(let t)? = MarkdownParser.parse("first line\nsecond line").first else { Issue.record(); return }
    #expect(plain(t).contains("line second") || plain(t).contains("line\nsecond"), "\(plain(t).debugDescription)")
  }

  @Test func inlineCodeAndLinksAreStyled() {
    guard case .paragraph(let t)? = MarkdownParser.parse("Run `npm test` or see [docs](https://example.com).").first else { Issue.record(); return }
    let code = t.runs.first { $0.inlinePresentationIntent?.contains(.code) == true }
    #expect(code?.backgroundColor != nil)
    let link = t.runs.first { $0.link != nil }
    #expect(link?.underlineStyle == .single)
  }
}
