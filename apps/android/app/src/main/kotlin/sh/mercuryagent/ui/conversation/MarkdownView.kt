package sh.mercuryagent.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.CheckBoxOutlineBlank
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import sh.mercuryagent.ui.theme.Mercury

/** Draws a reply's Markdown with Material type. Parsed once per text (a streaming reply only grows). */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurface) {
  val blocks = remember(markdown) { Markdown.parse(markdown) }
  Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
    blocks.forEach { MdBlock(it, color) }
  }
}

@Composable
private fun MdBlock(b: Markdown.Block, color: Color) {
  val type = MaterialTheme.typography
  when (b) {
    is Markdown.Block.Paragraph -> Text(annotated(b.text), style = type.bodyLarge, color = color)
    is Markdown.Block.Heading -> Text(
      annotated(b.text), color = color, modifier = Modifier.padding(top = 4.dp),
      style = when (b.level) { 1 -> type.headlineSmall; 2 -> type.titleLarge; 3 -> type.titleMedium; else -> type.titleSmall }
        .copy(fontWeight = FontWeight.SemiBold),
    )
    is Markdown.Block.Code -> CodeBlock(b)
    is Markdown.Block.Quote -> {
      val accent = when (b.alert) {
        "warning", "caution" -> Mercury.colors.amber
        "important" -> MaterialTheme.colorScheme.tertiary
        null -> MaterialTheme.colorScheme.outlineVariant
        else -> MaterialTheme.colorScheme.primary
      }
      Row(Modifier.height(IntrinsicSize.Min)) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(accent, RoundedCornerShape(2.dp)))
        Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          b.alert?.let { Text(it.replaceFirstChar(Char::uppercase), style = type.labelLarge, color = accent) }
          b.blocks.forEach { MdBlock(it, MaterialTheme.colorScheme.onSurfaceVariant) }
        }
      }
    }
    is Markdown.Block.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      b.items.forEachIndexed { n, item ->
        Row {
          Box(Modifier.widthIn(min = 24.dp).padding(end = 6.dp), contentAlignment = Alignment.TopEnd) {
            when {
              item.done != null -> Icon(
                if (item.done) Icons.Outlined.CheckBox else Icons.Outlined.CheckBoxOutlineBlank, if (item.done) "Done" else "Not done",
                Modifier.size(20.dp).padding(top = 2.dp), tint = if (item.done) MaterialTheme.colorScheme.primary else Mercury.colors.ink3,
              )
              b.ordered -> Text("${b.start + n}.", style = type.bodyLarge, color = Mercury.colors.ink3)
              else -> Text("•", style = type.bodyLarge, color = Mercury.colors.ink3)
            }
          }
          Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { item.blocks.forEach { MdBlock(it, color) } }
        }
      }
    }
    is Markdown.Block.Table -> Table(b, color)
    Markdown.Block.Rule -> HorizontalDivider(Modifier.padding(vertical = 4.dp))
  }
}

@Composable
private fun CodeBlock(b: Markdown.Block.Code) {
  val clipboard = LocalClipboardManager.current
  Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
    Column {
      Row(Modifier.fillMaxWidth().padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(b.language ?: "code", style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3, modifier = Modifier.weight(1f))
        IconButton(onClick = { clipboard.setText(AnnotatedString(b.text)) }) {
          Icon(Icons.Outlined.ContentCopy, "Copy code", Modifier.size(18.dp), tint = Mercury.colors.ink3)
        }
      }
      Text(
        b.text, softWrap = false,
        style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = MaterialTheme.typography.bodyMedium.fontSize, lineHeight = 1.45.em),
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 14.dp, end = 14.dp, bottom = 14.dp),
      )
    }
  }
}

@Composable
private fun Table(b: Markdown.Block.Table, color: Color) {
  val columns = maxOf(b.header.size, b.rows.maxOfOrNull { it.size } ?: 0)
  val line = MaterialTheme.colorScheme.outlineVariant
  Box(Modifier.horizontalScroll(rememberScrollState()).border(1.dp, line, MaterialTheme.shapes.small)) {
    // Column by column, single-line cells, so every row lines up whatever its text.
    Row {
      for (c in 0 until columns) {
        Column(Modifier.width(IntrinsicSize.Max)) {
          val align = when (b.align.getOrNull(c)) { Markdown.Align.Center -> TextAlign.Center; Markdown.Align.End -> TextAlign.End; else -> TextAlign.Start }
          Text(
            annotated(b.header.getOrNull(c) ?: Markdown.Inline("")), maxLines = 1, softWrap = false, textAlign = align,
            style = MaterialTheme.typography.labelLarge, color = color,
            modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 8.dp),
          )
          b.rows.forEach { row ->
            HorizontalDivider(color = line)
            Text(
              annotated(row.getOrNull(c) ?: Markdown.Inline("")), maxLines = 1, softWrap = false, textAlign = align,
              style = MaterialTheme.typography.bodyMedium, color = color,
              modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            )
          }
        }
      }
    }
  }
}

/** Inline spans → an AnnotatedString; links open in the browser (LinkAnnotation). */
@Composable
fun annotated(inline: Markdown.Inline): AnnotatedString {
  val accent = MaterialTheme.colorScheme.primary
  val codeBg = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f)
  return remember(inline, accent, codeBg) {
    buildAnnotatedString {
      append(inline.text)
      for (s in inline.spans) {
        if (s.start >= s.end) continue
        when (s.style) {
          Markdown.Style.Bold -> addStyle(SpanStyle(fontWeight = FontWeight.SemiBold), s.start, s.end)
          Markdown.Style.Italic -> addStyle(SpanStyle(fontStyle = FontStyle.Italic), s.start, s.end)
          Markdown.Style.Strike -> addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), s.start, s.end)
          Markdown.Style.Code -> addStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, fontSize = 0.92.em), s.start, s.end)
          Markdown.Style.Link -> {
            val url = s.url.orEmpty()
            if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
              addLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))), s.start, s.end)
            } else addStyle(SpanStyle(color = accent), s.start, s.end)
          }
        }
      }
    }
  }
}
