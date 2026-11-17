package sh.mercuryagent.ui.conversation

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlinx.coroutines.launch
import sh.mercuryagent.ui.theme.Mercury

// MARK: A question, in words (Desktop's needs-you/describe.ts, iOS NeedsYou.swift)

/**
 * A question from the runtime, in words: a short title, the exact thing it would run or touch (one
 * code block), and any note or warning. The runtime sends plain text in a handful of shapes
 * (src/capabilities/permissions.ts, src/security/tool-guard.ts); anything else is shown as it came.
 */
data class Described(
  val title: String,
  /** The command, path, URL or arguments, verbatim. */
  val code: String? = null,
  /** Context in a quiet line ("It read: weather.html, notes.txt"). */
  val note: String? = null,
  /** Something to look at twice (data leaving, hidden instructions). */
  val warning: String? = null,
  /** Free text when the prompt isn't one of the known shapes (a question, a pick). */
  val body: String? = null,
) {
  companion object {
    /** [kind] is the event that asked: permission_request, permission_continue or choice_prompt. */
    fun of(kind: String, raw: String): Described {
      val text = raw.trim()
      if (kind == "permission_continue" || kind == "continue") return Described("Keep going?", body = text)
      if (kind == "choice_prompt" || kind == "choice") return Described("Your pick", body = text)

      Rx.match("^Run command(?: \\(([^)]*)\\))?:\\s*([\\s\\S]+)$", text)?.let { m ->
        return Described("Run a command", code = m[2]!!.trim(), note = m[1]?.let(::cap))
      }
      Rx.match("^(Write to file|Read file):\\s*(.+)$", text)?.let { m ->
        return Described(if (m[1] == "Read file") "Read a file" else "Write a file", code = m[2]!!.trim())
      }
      Rx.match("^Mercury needs (read|write) access to:\\s*\\n(.+?)\\n", text, dotAll = true)?.let { m ->
        val write = m[1] == "write"
        return Described("Allow ${m[1]} access", code = m[2]!!.trim(), note = if (write) "Mercury may create and change files there." else "Mercury may read files there.")
      }
      Rx.match("^MCP tool call\\nServer:\\s*(.+)\\nTool:\\s*(.+)\\nArguments:\\n([\\s\\S]*)$", text)?.let { m ->
        val args = m[3]!!.trim()
        return Described("Use ${m[2]!!.trim()}", code = args.ifEmpty { null }, note = "${m[1]!!.trim()} (MCP server)")
      }
      if (text.startsWith("⚠ Possible prompt injection") || text.startsWith("Mercury read content from outside this chat")) {
        val injection = text.startsWith("⚠")
        val wants = Rx.match("It now wants to run (\\S+) with:\\n([\\s\\S]*?)(?:\\n\\n|$)", text)
        val sources = Rx.all("^- (.+?)(?: — contains instructions to an AI: .*)?$", text, lines = true)
          .mapNotNull { it[1] }
          .map { it.replace(Regex("\\s*\\((\\w+)\\)$"), "") }
          .filter { !it.startsWith("…") }
        val leak = Rx.match("⚠ This could send data out: (.+?)\\.?$", text, lines = true)
        var title = "After reading outside content"
        var code: String? = null
        if (wants != null) {
          title = "${if (injection) "Suspicious request" else "After reading outside content"}: ${toolWords(wants[1]!!)}"
          code = wants[2]!!.trim()
        }
        val read = sources.take(3).joinToString(", ", transform = ::shortSource) + if (sources.size > 3) " and ${sources.size - 3} more" else ""
        val note = if (sources.isEmpty()) "Approve only if you asked for this." else "It read: $read. Approve only if you asked for this."
        var warning: String? = if (injection) "What it read contains instructions written to an AI." else null
        if (leak != null) warning = "${if (injection) "Hidden instructions, and this " else "This "}could send data out: ${leak[1]}."
        return Described(title, code, note, warning)
      }
      Rx.match("^Open (\\S+) in this chat.s isolated read-only browser\\?\\s*([\\s\\S]*)$", text)?.let { m ->
        val note = cap(m[2]!!.trim())
        return Described("Open a page", code = m[1], note = note.ifEmpty { null })
      }
      return Described("Allow this?", body = text)
    }

    /** "run_command" → "run a command"; other tool names as they are, spaced. */
    fun toolWords(name: String): String = mapOf(
      "run_command" to "run a command", "write_file" to "write a file", "edit_file" to "edit a file", "create_file" to "create a file",
      "delete_file" to "delete a file", "fetch_url" to "open a web address", "web_search" to "search the web", "schedule_task" to "schedule a task",
      "send_message" to "send a message", "send_file" to "send a file", "save_memory" to "save to memory", "git_push" to "push to git",
      "create_pr" to "open a pull request", "create_issue" to "open an issue", "delegate_task" to "hand off a task",
    )[name] ?: name.replace('_', ' ')

    /** A path to its file name, a long address cut short. */
    fun shortSource(s: String): String {
      val t = s.replace(Regex("^https?://"), "")
      val path = t.split("/")
      if (path.size > 2 && Rx.match("^[\\w.-]+\\.\\w+$", path[0]) == null) return path.last()
      return if (t.length > 48) t.take(47) + "…" else t
    }

    fun cap(s: String): String = s.replaceFirstChar { it.uppercase() }
  }
}

/** The answers to a question, each with its place: the main one, another yes, or no (quiet, on the right). */
data class NeedsYouOption(val value: String, val label: String, val role: Role) {
  enum class Role { Primary, Secondary, Quiet }

  companion object {
    /** The first is the main answer, a deny-like one is quiet, the rest secondary. */
    fun roles(options: List<Prompt.Option>): List<NeedsYouOption> {
      val deny = if (options.size >= 2) options.indexOfFirst { Rx.match("^(deny|no|don'?t|stop|reject|decline|never|cancel)\\b", it.label, caseless = true) != null } else -1
      return options.mapIndexed { i, o -> NeedsYouOption(o.value, o.label, if (i == deny) Role.Quiet else if (i == 0) Role.Primary else Role.Secondary) }
    }
  }
}

/** "Pick a model — the fast one" → name and detail, for a list row. */
fun splitChoiceLabel(label: String): Pair<String, String?> {
  val m = Rx.match("^(.{1,60}?)\\s+[—–-]{1,2}\\s+([\\s\\S]+)$", label) ?: return label to null
  return m[1]!!.trim() to m[2]!!.trim()
}

/** Small regex helpers (groups as nullable strings, 0 = the whole match), like iOS's Rx. */
object Rx {
  private val cache = java.util.concurrent.ConcurrentHashMap<String, java.util.regex.Pattern>()

  private fun pattern(p: String, dotAll: Boolean, lines: Boolean, caseless: Boolean): java.util.regex.Pattern {
    var f = 0
    if (dotAll) f = f or java.util.regex.Pattern.DOTALL
    if (lines) f = f or java.util.regex.Pattern.MULTILINE
    if (caseless) f = f or java.util.regex.Pattern.CASE_INSENSITIVE or java.util.regex.Pattern.UNICODE_CASE
    // No UNICODE_CHARACTER_CLASS: Android's regex engine (ICU) refuses the flag and throws, and its
    // \\w, \\s and \\b are already Unicode-aware there. (The JVM tests accepted it; phones crashed.)
    return cache.getOrPut("$f|$p") { java.util.regex.Pattern.compile(p, f) }
  }

  fun match(p: String, s: String, dotAll: Boolean = false, lines: Boolean = false, caseless: Boolean = false): List<String?>? {
    val m = pattern(p, dotAll, lines, caseless).matcher(s)
    if (!m.find()) return null
    return (0..m.groupCount()).map { m.group(it) }
  }

  fun all(p: String, s: String, dotAll: Boolean = false, lines: Boolean = false): List<List<String?>> {
    val m = pattern(p, dotAll, lines, false).matcher(s)
    val out = mutableListOf<List<String?>>()
    while (m.find()) out += (0..m.groupCount()).map { m.group(it) }
    return out
  }
}

/** Keep showing the same question when others arrive or leave; else stay at the same place. */
fun keepPlace(index: Int, lastIds: List<String>, ids: List<String>): Int {
  val current = lastIds.getOrNull(index)
  val at = current?.let { ids.indexOf(it) } ?: -1
  return if (at >= 0) at else index.coerceAtMost(maxOf(0, ids.size - 1))
}

// MARK: The card

/**
 * "Needs you": everything this chat is waiting on you for, one at a time, in a card pinned above
 * the message box. Several are a carousel: "1 of 3", ‹ ›, or swipe. Answering one shows the next;
 * the card goes when none are left. Plain words on top, the exact command or path underneath
 * (folded when long), the main answer as the button, Deny quietly on the right.
 */
@Composable
fun NeedsYouCard(prompts: List<Prompt>, answer: suspend (Prompt, String) -> Unit, modifier: Modifier = Modifier) {
  if (prompts.isEmpty()) return
  var index by remember { mutableIntStateOf(0) }
  var lastIds by remember { mutableStateOf(emptyList<String>()) }
  var busy by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  val ids = prompts.map { it.id }
  LaunchedEffect(ids) { index = keepPlace(index, lastIds, ids); lastIds = ids }
  val i = index.coerceIn(0, prompts.size - 1)
  val p = prompts[i]
  fun go(d: Int) { if (prompts.size > 1) index = (i + d + prompts.size) % prompts.size }
  fun reply(value: String) {
    if (busy != null) return
    busy = value
    scope.launch { try { answer(p, value) } finally { busy = null } }
  }
  val c = Mercury.colors
  Surface(
    shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(1.dp, c.line), shadowElevation = 1.dp,
    modifier = modifier.fillMaxWidth().animateContentSize().semantics { contentDescription = "Needs you" },
  ) {
    Column {
      Row(Modifier.heightIn(min = 48.dp).padding(start = 14.dp, end = if (prompts.size > 1) 4.dp else 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(c.amber))
        Spacer(Modifier.width(10.dp))
        Text("Needs you", style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
        if (prompts.size > 1) Text("  ${i + 1} of ${prompts.size}", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = c.ink3)
        Spacer(Modifier.weight(1f))
        if (prompts.size > 1) {
          Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            prompts.take(6).forEachIndexed { n, _ ->
              Box(Modifier.size(width = if (n == i) 14.dp else 6.dp, height = 6.dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = if (n == i) 0.55f else 0.15f)))
            }
          }
          IconButton(onClick = { go(-1) }) { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, "Previous question") }
          IconButton(onClick = { go(1) }) { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, "Next question") }
        }
      }
      HorizontalDivider(color = c.line)
      AnimatedContent(p.id, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "question") { _ ->
        Box(
          if (prompts.size > 1) Modifier.pointerInput(prompts.size) {
            var dx = 0f
            detectHorizontalDragGestures(onDragStart = { dx = 0f }, onDragEnd = { if (abs(dx) > 60) go(if (dx < 0) 1 else -1) }) { _, d -> dx += d }
          } else Modifier,
        ) { Page(p, busy, ::reply) }
      }
    }
  }
}

@Composable
private fun Page(p: Prompt, busy: String?, reply: (String) -> Unit) {
  val d = remember(p.kind, p.text) { Described.of(p.kind, p.text) }
  val options = remember(p.options) { NeedsYouOption.roles(p.options.ifEmpty { listOf(Prompt.Option("yes", "Allow once"), Prompt.Option("no", "Deny")) }) }
  val list = p.kind == "choice_prompt" || p.options.any { it.label.length > 32 }
  var open by remember(p.id) { mutableStateOf(false) }
  val c = Mercury.colors
  Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(d.title, style = MaterialTheme.typography.titleMedium)
    d.warning?.let {
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Icons.Outlined.WarningAmber, null, Modifier.size(16.dp), tint = c.amber)
        Text(it, style = MaterialTheme.typography.bodySmall, color = c.amber)
      }
    }
    d.code?.let { code ->
      val lines = code.lines().size
      val long = lines > CODE_FOLD || code.length > 320
      SelectionContainer {
        Text(
          code, fontFamily = FontFamily.Monospace, fontSize = 13.sp, softWrap = true,
          maxLines = if (open || !long) Int.MAX_VALUE else CODE_FOLD, overflow = TextOverflow.Ellipsis,
          modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .border(1.dp, c.line, RoundedCornerShape(10.dp)).padding(horizontal = 11.dp, vertical = 9.dp),
        )
      }
      if (long) TextButton(onClick = { open = !open }) {
        Text(if (open) "Show less" else if (lines > CODE_FOLD) "Show all $lines lines" else "Show all", color = c.ink3)
      }
    }
    d.body?.let {
      SelectionContainer {
        Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = if (open) Int.MAX_VALUE else 8, overflow = TextOverflow.Ellipsis)
      }
    }
    d.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.ink3) }
    if (list) Choices(p, options, busy, reply) else Buttons(options, busy, reply)
  }
}

private const val CODE_FOLD = 6

@Composable
private fun Buttons(options: List<NeedsYouOption>, busy: String?, reply: (String) -> Unit) {
  Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
    Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      options.filter { it.role != NeedsYouOption.Role.Quiet }.forEach { o ->
        if (o.role == NeedsYouOption.Role.Primary) Button(onClick = { reply(o.value) }, enabled = busy == null) { Text(o.label, maxLines = 1) }
        else OutlinedButton(onClick = { reply(o.value) }, enabled = busy == null) { Text(o.label, maxLines = 1) }
      }
    }
    options.filter { it.role == NeedsYouOption.Role.Quiet }.forEach { o ->
      TextButton(onClick = { reply(o.value) }, enabled = busy == null) { Text(o.label, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
    }
  }
}

@Composable
private fun Choices(p: Prompt, options: List<NeedsYouOption>, busy: String?, reply: (String) -> Unit) {
  val c = Mercury.colors
  Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 2.dp)) {
    options.forEachIndexed { n, o ->
      val (name, detail) = splitChoiceLabel(o.label)
      Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(10.dp)).border(1.dp, c.line, RoundedCornerShape(10.dp))
          .clickable(enabled = busy == null) { reply(o.value) }.padding(horizontal = 10.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top,
      ) {
        Box(Modifier.size(22.dp).clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), Alignment.Center) {
          Text(if (n < 9) "${n + 1}" else "·", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = c.ink3)
        }
        Column(Modifier.weight(1f)) {
          Text(name, style = MaterialTheme.typography.titleSmall)
          detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.ink3, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
      }
    }
    if (p.kind == "choice_prompt") TextButton(onClick = { reply("") }, enabled = busy == null) { Text("Cancel", color = MaterialTheme.colorScheme.onSurfaceVariant) }
  }
}
