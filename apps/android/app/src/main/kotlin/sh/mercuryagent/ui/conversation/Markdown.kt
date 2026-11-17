package sh.mercuryagent.ui.conversation

/**
 * A reply's Markdown as blocks the phone draws (apps/desktop/src/components/Markdown.tsx is the
 * reference; iOS: MarkdownParser.swift). A small, forgiving CommonMark/GFM subset: headings,
 * paragraphs, fenced code, quotes (and GitHub alerts), lists (nested, ordered, tasks), tables, rules;
 * inline bold, italic, strikethrough, code, links and bare URLs. A streaming reply is always valid
 * input: an unclosed fence runs to the end. Pure, so tested.
 */
object Markdown {
  sealed interface Block {
    data class Paragraph(val text: Inline) : Block
    data class Heading(val level: Int, val text: Inline) : Block
    data class Code(val language: String?, val text: String) : Block
    data class Quote(val blocks: List<Block>, val alert: String? = null) : Block
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<Item>) : Block
    data class Table(val header: List<Inline>, val rows: List<List<Inline>>, val align: List<Align>) : Block
    data object Rule : Block
  }

  enum class Align { Start, Center, End }

  /** One list item; [done] is null for a plain item, else whether its task box is ticked. */
  data class Item(val done: Boolean?, val blocks: List<Block>)

  enum class Style { Bold, Italic, Code, Strike, Link }
  data class Span(val start: Int, val end: Int, val style: Style, val url: String? = null)
  data class Inline(val text: String, val spans: List<Span> = emptyList())

  private val fence = Regex("^ {0,3}(`{3,}|~{3,})\\s*([^`\\s]*).*$")
  private val heading = Regex("^ {0,3}(#{1,6})(?:\\s+(.*?))?\\s*#*\\s*$")
  private val rule = Regex("^ {0,3}([-*_])(\\s*\\1){2,}\\s*$")
  private val bullet = Regex("^(\\s*)([-*+]|\\d{1,9}[.)])(\\s+)(.*)$")
  private val tableSep = Regex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")
  private val alert = Regex("^\\s*\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)]\\s*", RegexOption.IGNORE_CASE)

  fun parse(markdown: String): List<Block> = blocks(markdown.replace("\r\n", "\n").replace('\t', ' ').split("\n"))

  private fun blocks(lines: List<String>): List<Block> {
    val out = mutableListOf<Block>()
    var i = 0
    while (i < lines.size) {
      val line = lines[i]
      if (line.isBlank()) { i++; continue }
      fence.matchEntire(line)?.let { m ->
        val marker = m.groupValues[1]
        val lang = m.groupValues[2].ifEmpty { null }
        val body = mutableListOf<String>()
        i++
        while (i < lines.size && !lines[i].trimStart().let { it.startsWith(marker) && it.trim().all { c -> c == marker[0] } }) { body += lines[i]; i++ }
        i++ // the closing fence (or past the end)
        out += Block.Code(lang, body.joinToString("\n").trimEnd('\n'))
        return@let
      } ?: run {
        val h = heading.matchEntire(line)
        when {
          h != null -> { out += Block.Heading(h.groupValues[1].length, inline(h.groupValues[2])); i++ }
          rule.matches(line) -> { out += Block.Rule; i++ }
          line.trimStart().startsWith(">") -> {
            val inner = mutableListOf<String>()
            while (i < lines.size && lines[i].trimStart().startsWith(">")) {
              inner += lines[i].trimStart().removePrefix(">").removePrefix(" "); i++
            }
            val first = inner.firstOrNull().orEmpty()
            val a = alert.find(first)
            if (a != null) {
              inner[0] = first.substring(a.range.last + 1)
              out += Block.Quote(blocks(inner), a.groupValues[1].lowercase())
            } else out += Block.Quote(blocks(inner))
          }
          line.contains('|') && i + 1 < lines.size && tableSep.matches(lines[i + 1]) && lines[i + 1].contains('-') -> {
            val header = cells(line)
            val align = cells(lines[i + 1]).map {
              val l = it.startsWith(":"); val r = it.endsWith(":")
              if (l && r) Align.Center else if (r) Align.End else Align.Start
            }
            i += 2
            val rows = mutableListOf<List<Inline>>()
            while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
              rows += cells(lines[i]).map(::inline); i++
            }
            out += Block.Table(header.map(::inline), rows, align)
          }
          bullet.matches(line) -> {
            val (block, next) = list(lines, i)
            out += block; i = next
          }
          else -> {
            val para = mutableListOf<String>()
            while (i < lines.size && lines[i].isNotBlank() && (para.isEmpty() || !startsBlock(lines, i))) { para += lines[i].trim(); i++ }
            out += Block.Paragraph(inline(para.joinToString("\n")))
          }
        }
      }
    }
    return out
  }

  private fun startsBlock(lines: List<String>, i: Int): Boolean {
    val l = lines[i]
    return fence.matches(l) || heading.matches(l) || rule.matches(l) || l.trimStart().startsWith(">") ||
      bullet.matches(l) && bullet.matchEntire(l)!!.groupValues[4].isNotEmpty()
  }

  private fun list(lines: List<String>, from: Int): Pair<Block, Int> {
    val first = bullet.matchEntire(lines[from])!!
    val indent = first.groupValues[1].length
    val ordered = first.groupValues[2].first().isDigit()
    val start = if (ordered) first.groupValues[2].dropLast(1).toIntOrNull() ?: 1 else 1
    val items = mutableListOf<Item>()
    var i = from
    while (i < lines.size) {
      val m = bullet.matchEntire(lines[i]) ?: break
      if (m.groupValues[1].length != indent || m.groupValues[2].first().isDigit() != ordered) break
      val contentIndent = indent + m.groupValues[2].length + m.groupValues[3].length.coerceAtMost(4)
      val body = mutableListOf(m.groupValues[4])
      i++
      while (i < lines.size) {
        val l = lines[i]
        if (l.isBlank()) {
          // A blank line continues the item only when indented content follows.
          val next = lines.getOrNull(i + 1)
          if (next != null && next.isNotBlank() && leading(next) >= contentIndent.coerceAtMost(indent + 2)) { body += ""; i++; continue }
          break
        }
        val lm = bullet.matchEntire(l)
        if (lm != null && lm.groupValues[1].length <= indent) break
        if (lm == null && leading(l) <= indent && startsBlock(lines, i)) break
        body += if (leading(l) >= contentIndent) l.substring(contentIndent) else l.trimStart()
        i++
      }
      var blocks = blocks(body)
      var done: Boolean? = null
      val p = blocks.firstOrNull() as? Block.Paragraph
      if (p != null && p.text.text.length >= 3 && p.text.text.substring(0, 3).lowercase() in setOf("[ ]", "[x]") &&
        (p.text.text.length == 3 || p.text.text[3] == ' ')) {
        done = p.text.text[1] != ' '
        blocks = listOf(Block.Paragraph(inline(raw(body.first()).drop(3).trimStart()))) + blocks.drop(1)
      }
      items += Item(done, blocks)
    }
    return Block.ListBlock(ordered, start, items) to i
  }

  private fun raw(s: String) = s
  private fun leading(s: String) = s.length - s.trimStart().length

  private fun cells(line: String): List<String> {
    var s = line.trim()
    if (s.startsWith("|")) s = s.drop(1)
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.dropLast(1)
    val out = mutableListOf<String>()
    val cur = StringBuilder()
    var code = false
    var k = 0
    while (k < s.length) {
      val c = s[k]
      when {
        c == '\\' && k + 1 < s.length && s[k + 1] == '|' -> { cur.append('|'); k++ }
        c == '`' -> { code = !code; cur.append(c) }
        c == '|' && !code -> { out += cur.toString().trim(); cur.setLength(0) }
        else -> cur.append(c)
      }
      k++
    }
    out += cur.toString().trim()
    return out
  }

  // MARK: Inline

  private const val PUNCT = "\\`*_{}[]()#+-.!|~<>\"'"

  fun inline(src: String): Inline {
    val out = StringBuilder()
    val spans = mutableListOf<Span>()
    inline(src, out, spans)
    return Inline(out.toString(), spans.sortedBy { it.start })
  }

  private fun inline(s: String, out: StringBuilder, spans: MutableList<Span>) {
    var i = 0
    while (i < s.length) {
      val c = s[i]
      when {
        c == '\\' && i + 1 < s.length && s[i + 1] in PUNCT -> { out.append(s[i + 1]); i += 2 }
        c == '`' -> {
          var n = 0
          while (i + n < s.length && s[i + n] == '`') n++
          val close = findRun(s, '`', n, i + n)
          if (close < 0) { out.append(s, i, i + n); i += n } else {
            var code = s.substring(i + n, close)
            if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.substring(1, code.length - 1)
            val st = out.length
            out.append(code)
            spans += Span(st, out.length, Style.Code)
            i = close + n
          }
        }
        (s.startsWith("**", i) || s.startsWith("__", i)) && emphasisOpens(s, i, 2) -> {
          val d = s.substring(i, i + 2)
          val close = closing(s, d, i + 2)
          if (close < 0) { out.append(d); i += 2 } else { styled(s.substring(i + 2, close), Style.Bold, out, spans); i = close + 2 }
        }
        s.startsWith("~~", i) -> {
          val close = s.indexOf("~~", i + 2)
          if (close <= i + 2) { out.append("~~"); i += 2 } else { styled(s.substring(i + 2, close), Style.Strike, out, spans); i = close + 2 }
        }
        (c == '*' || c == '_') && emphasisOpens(s, i, 1) -> {
          val close = closing(s, c.toString(), i + 1)
          if (close < 0) { out.append(c); i++ } else { styled(s.substring(i + 1, close), Style.Italic, out, spans); i = close + 1 }
        }
        c == '[' -> {
          val end = matchingBracket(s, i)
          if (end > 0 && end + 1 < s.length && s[end + 1] == '(') {
            val close = s.indexOf(')', end + 2)
            if (close > 0) {
              val url = s.substring(end + 2, close).trim().substringBefore(' ').removePrefix("<").removeSuffix(">")
              val st = out.length
              inline(s.substring(i + 1, end), out, spans)
              spans += Span(st, out.length, Style.Link, url)
              i = close + 1
              continue
            }
          }
          out.append(c); i++
        }
        c == '<' && Regex("^<(https?://[^>\\s]+)>").find(s.substring(i)) != null -> {
          val m = Regex("^<(https?://[^>\\s]+)>").find(s.substring(i))!!
          val url = m.groupValues[1]
          val st = out.length
          out.append(url); spans += Span(st, out.length, Style.Link, url)
          i += m.value.length
        }
        (s.startsWith("https://", i) || s.startsWith("http://", i)) && (i == 0 || s[i - 1].isWhitespace() || s[i - 1] == '(') -> {
          var e = i
          while (e < s.length && !s[e].isWhitespace() && s[e] != '<') e++
          while (e > i && s[e - 1] in ".,;:!?)'\"") e--
          val url = s.substring(i, e)
          val st = out.length
          out.append(url); spans += Span(st, out.length, Style.Link, url)
          i = e
        }
        else -> { out.append(c); i++ }
      }
    }
  }

  private fun styled(inner: String, style: Style, out: StringBuilder, spans: MutableList<Span>) {
    val st = out.length
    inline(inner, out, spans)
    spans += Span(st, out.length, style)
  }

  /** A delimiter opens emphasis when text follows it, and `_` only at a word's start. */
  private fun emphasisOpens(s: String, i: Int, n: Int): Boolean {
    val next = s.getOrNull(i + n) ?: return false
    if (next.isWhitespace()) return false
    if (s[i] == '_' && i > 0 && s[i - 1].isLetterOrDigit()) return false
    return true
  }

  private fun closing(s: String, d: String, from: Int): Int {
    var k = from
    while (true) {
      val at = s.indexOf(d, k)
      if (at < 0) return -1
      val valid = at > from && !s[at - 1].isWhitespace() &&
        (d.length == 2 || s.getOrNull(at + 1) != d[0]) &&
        (d[0] != '_' || s.getOrNull(at + d.length)?.isLetterOrDigit() != true)
      if (valid) return at
      // Skip a code span in between.
      k = at + d.length
    }
  }

  private fun findRun(s: String, c: Char, n: Int, from: Int): Int {
    var k = from
    while (k < s.length) {
      if (s[k] == c) {
        var m = 0
        while (k + m < s.length && s[k + m] == c) m++
        if (m == n) return k
        k += m
      } else k++
    }
    return -1
  }

  private fun matchingBracket(s: String, open: Int): Int {
    var depth = 0
    for (k in open until s.length) {
      when (s[k]) {
        '\\' -> {}
        '[' -> depth++
        ']' -> { depth--; if (depth == 0) return k }
      }
    }
    return -1
  }
}
