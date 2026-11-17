package sh.mercuryagent.ui.conversation

import java.time.Duration
import java.time.Instant
import kotlin.math.max
import kotlin.math.roundToLong
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import sh.mercuryagent.core.LiveSnapshot
import sh.mercuryagent.core.StoredTrace
import sh.mercuryagent.core.int
import sh.mercuryagent.core.str

/**
 * A turn as it happens, in order: thinking, tool steps, notes and the answer's text (iOS:
 * ConversationTrace.swift). Immutable; each event returns the next trace. The timeline phase draws
 * it in full; this phase shows its status line and its summary.
 */
data class TurnTrace(
  val items: List<Item> = emptyList(),
  val steps: List<Step> = emptyList(),
  val startedAt: Instant = Instant.now(),
  val endedAt: Instant? = null,
  /** The turn was stopped by you, not finished. */
  val stopped: Boolean = false,
  val lastEventAt: Instant = startedAt,
  /** What the runtime says it's doing between tools ("Checking my work"). */
  val phase: String? = null,
) {
  enum class Status { Running, Done, Error, Stopped }

  /** What a media tool is making: kind image, video, music or speech. */
  data class MediaShape(val kind: String, val aspect: String? = null, val count: Int? = null, val prompt: String? = null) {
    companion object {
      fun from(json: JsonElement?): MediaShape? {
        val o = json as? JsonObject ?: return null
        return MediaShape(o.str("kind") ?: return null, o.str("aspect"), o.int("count"), o.str("prompt"))
      }
    }
  }

  data class Step(
    val key: String,
    val number: Int,
    val tool: String,
    /** "Read src/x.ts", "Run npm test" (the runtime's words), when it sent some. */
    val title: String?,
    val status: Status,
    val startedAt: Instant,
    val endedAt: Instant? = null,
    val summary: String? = null,
    val media: MediaShape? = null,
  ) {
    /** What a row says: the runtime's title, else the tool in words. */
    val label: String get() = title?.trim()?.takeIf { it.isNotEmpty() && it != tool } ?: toolLabel(tool)

    /** How long it took, or has been running (null when it never ended). Seconds. */
    fun duration(now: Instant): Double? = endedAt?.let { Duration.between(startedAt, it).toMillis() / 1000.0 }
      ?: if (status == Status.Running) Duration.between(startedAt, now).toMillis() / 1000.0 else null

    /** A picture or a voice being made: its placeholder stands in for the row while it runs. */
    val isMaking: Boolean
      get() = media != null && (media.kind == "image" || media.kind == "speech") && status != Status.Error && status != Status.Stopped
  }

  sealed interface Item {
    data class Reasoning(val text: String, val startedAt: Instant, val endedAt: Instant?) : Item
    data class StepRef(val key: String) : Item
    data class Text(val text: String) : Item
    data class Note(val text: String) : Item
  }

  private fun capped(list: List<Item>) = if (list.size > MAX_ITEMS) list.takeLast(MAX_ITEMS) else list

  fun touch(now: Instant = Instant.now()) = copy(lastEventAt = now)

  fun addReasoning(text: String, now: Instant = Instant.now()): TurnTrace {
    if (text.isEmpty()) return this
    val last = items.lastOrNull()
    val next = if (last is Item.Reasoning && last.endedAt == null) items.dropLast(1) + last.copy(text = last.text + text)
    else items + Item.Reasoning(text, now, null)
    return copy(items = capped(next), lastEventAt = now, phase = null)
  }

  /** The current thinking block ended (the answer, a tool or a new step began). */
  fun endReasoning(now: Instant = Instant.now()): TurnTrace {
    val last = items.lastOrNull()
    val next = if (last is Item.Reasoning && last.endedAt == null) items.dropLast(1) + last.copy(endedAt = now) else items
    return copy(items = next, lastEventAt = now)
  }

  fun startTool(key: String?, tool: String, title: String?, number: Int?, media: MediaShape?, now: Instant = Instant.now()): TurnTrace {
    val t = endReasoning(now)
    val k = key?.takeIf { it.isNotEmpty() } ?: "$tool:${now.toEpochMilli()}:${steps.size}"
    if (t.steps.any { it.key == k }) return t
    return t.copy(
      steps = t.steps + Step(k, number ?: (t.steps.size + 1), tool, title, Status.Running, now, media = media),
      items = capped(t.items + Item.StepRef(k)), lastEventAt = now, phase = null,
    )
  }

  fun finishTool(key: String?, tool: String, failed: Boolean, summary: String?, durationMs: Double?, now: Instant = Instant.now()): TurnTrace {
    var i = key?.let { k -> steps.indexOfFirst { it.key == k } } ?: -1
    // Older runtimes: no call id, so the latest running step of that tool.
    if (i < 0) i = steps.indexOfLast { it.status == Status.Running && it.tool == tool }
    if (i < 0) return copy(lastEventAt = now)
    val s = steps[i]
    val ms = durationMs?.roundToLong() ?: Duration.between(s.startedAt, now).toMillis()
    val done = s.copy(status = if (failed) Status.Error else Status.Done, summary = summary, endedAt = s.startedAt.plusMillis(ms))
    return copy(steps = steps.toMutableList().also { it[i] = done }, lastEventAt = now)
  }

  /** Answer text as it streams, in order with the tools around it. */
  fun addText(text: String, now: Instant = Instant.now()): TurnTrace {
    if (text.isEmpty()) return this
    val t = endReasoning(now)
    val last = t.items.lastOrNull()
    val next = if (last is Item.Text) t.items.dropLast(1) + Item.Text(last.text + text) else t.items + Item.Text(text)
    return t.copy(items = capped(next), lastEventAt = now, phase = null)
  }

  fun addNote(text: String, now: Instant = Instant.now()): TurnTrace {
    if (text.isBlank()) return this
    val t = endReasoning(now)
    return t.copy(items = capped(t.items + Item.Note(text)), lastEventAt = now)
  }

  fun setPhase(p: String, now: Instant = Instant.now()) = copy(phase = p, lastEventAt = now)

  /** Stop pressed: what was running shows as stopped straight away. */
  fun markStopped(now: Instant = Instant.now()) =
    copy(steps = steps.map { if (it.status == Status.Running) it.copy(status = Status.Stopped, endedAt = now) else it })

  /** The trace kept on the finished reply: no streamed text (the reply has it), every step ended. */
  fun finished(stopped: Boolean = false, now: Instant = Instant.now()): TurnTrace {
    val t = endReasoning(now)
    return t.copy(
      endedAt = now, stopped = stopped, phase = null,
      items = t.items.filter { it !is Item.Text },
      steps = t.steps.map { if (it.status == Status.Running) it.copy(status = if (stopped) Status.Stopped else Status.Done, endedAt = now) else it },
    )
  }

  val runningStep: Step? get() = steps.lastOrNull { it.status == Status.Running }

  fun step(key: String): Step? = steps.firstOrNull { it.key == key }

  /** Hidden-instruction warnings Mercury itself raised in this turn (🛡 notes, ADR-044). */
  val securityNotes: List<String> get() = items.mapNotNull { (it as? Item.Note)?.text?.takeIf(::isSecurity) }

  /** Every picture in the turn is one batch; each voice its own. Failed or stopped calls leave it. */
  val liveMedia: List<MediaBatch>
    get() {
      val making = steps.filter { it.isMaking }
      val out = mutableListOf<MediaBatch>()
      val images = making.filter { it.media?.kind == "image" }
      if (images.isNotEmpty()) {
        fun size(s: Step) = maxOf(s.media?.count ?: 1, 1)
        val total = images.sumOf { size(it) }
        val done = images.filter { it.status == Status.Done }.sumOf { size(it) }
        val prompts = images.mapNotNull { it.media?.prompt?.takeIf { p -> p.isNotEmpty() } }.toSet()
        out += MediaBatch(
          "images", MediaShape("image", images[0].media?.aspect, total, if (prompts.size == 1) prompts.first() else null),
          images.minOf { it.startedAt }, done, total,
        )
      }
      for (s in making) if (s.media?.kind == "speech") out += MediaBatch(s.key, s.media, s.startedAt, if (s.status == Status.Done) 1 else 0, 1)
      return out
    }

  /** Did the turn think or run anything worth keeping above the answer? */
  val hasProcess: Boolean
    get() = steps.isNotEmpty() || items.any { (it is Item.Reasoning && it.text.isNotBlank()) || it is Item.Note }

  /** "Thought for 12s", "Worked for 1m 05s · 6 steps · 1 failed", "Stopped after 9s · 2 steps". */
  val summary: String
    get() {
      val took = duration(Duration.between(startedAt, endedAt ?: lastEventAt).toMillis() / 1000.0)
      val n = steps.size
      val failed = steps.count { it.status == Status.Error }
      val s = if (n > 0) " · $n step${if (n == 1) "" else "s"}" else ""
      if (stopped) return "Stopped after $took$s"
      return "${if (n > 0) "Worked" else "Thought"} for $took$s${if (failed > 0) " · $failed failed" else ""}"
    }

  /** One block of the timeline: consecutive tool calls form one group. */
  sealed interface Block {
    val index: Int
    data class Reasoning(override val index: Int, val text: String, val startedAt: Instant, val endedAt: Instant?) : Block
    data class Steps(override val index: Int, val steps: List<Step>) : Block
    data class Text(override val index: Int, val text: String) : Block
    data class Note(override val index: Int, val text: String) : Block
  }

  /** Items → blocks, in order (ConversationTimeline.swift `blocks`). */
  fun blocks(): List<Block> {
    val out = mutableListOf<Block>()
    items.forEachIndexed { i, item ->
      when (item) {
        is Item.StepRef -> {
          val s = step(item.key) ?: return@forEachIndexed
          val last = out.lastOrNull()
          if (last is Block.Steps) out[out.lastIndex] = last.copy(steps = last.steps + s) else out += Block.Steps(i, listOf(s))
        }
        is Item.Reasoning -> if (item.text.isNotBlank()) out += Block.Reasoning(i, item.text, item.startedAt, item.endedAt)
        is Item.Text -> if (item.text.isNotEmpty()) out += Block.Text(i, item.text)
        is Item.Note -> out += Block.Note(i, item.text)
      }
    }
    return out
  }

  companion object {
    const val MAX_ITEMS = 300

    fun isSecurity(note: String): Boolean = note.startsWith("🛡")

    /** A reply's trace as the runtime keeps it → this shape. `live`: a running reply's snapshot. */
    fun from(stored: StoredTrace, live: Boolean = false, now: Instant = Instant.now()): TurnTrace? {
      val start = stored.startedAt?.let(::date) ?: now
      val items = mutableListOf<Item>()
      val steps = mutableListOf<Step>()
      for (it in stored.items) {
        if (it.kind == "reasoning" && !it.text.isNullOrBlank()) {
          items += Item.Reasoning(it.text!!, it.startedAt?.let(::date) ?: start, it.endedAt?.let(::date) ?: if (live) null else start)
        } else if (it.kind == "tool" && it.id != null) {
          val title = it.title ?: ""
          val at = it.startedAt?.let(::date) ?: start
          val status = when {
            it.status == "error" -> Status.Error
            it.status == "running" && live -> Status.Running
            else -> Status.Done
          }
          val end = it.durationMs?.let { d -> at.plusMillis(d.roundToLong()) } ?: it.endedAt?.let(::date)
          steps += Step(it.id!!, steps.size + 1, title.split(" ").firstOrNull()?.ifEmpty { null } ?: "tool", title, status, at,
            if (status == Status.Running) null else end, it.summary)
          items += Item.StepRef(it.id!!)
        }
      }
      val endedAt = if (live) null else stored.endedAt?.let(::date) ?: start
      if (items.isEmpty() && !live) return null
      return TurnTrace(items, steps, start, endedAt, lastEventAt = if (live) now else endedAt ?: start)
    }

    /** A reply still being worked on (GET /api/chat/threads/:id/live), ready for live events to carry on. */
    fun live(s: LiveSnapshot, now: Instant = Instant.now()): TurnTrace {
      val start = s.startedAt?.let(::date) ?: now
      var t = s.trace?.let { from(it, live = true, now = now) } ?: TurnTrace(startedAt = start)
      t = t.copy(startedAt = start)
      if (!s.text.isNullOrEmpty()) t = t.copy(items = t.items + Item.Text(s.text!!))
      val p = s.activity?.replace(Regex("^[^\\p{L}\\p{N}]+"), "")?.trim()
      return t.copy(phase = p?.ifEmpty { null }, lastEventAt = now)
    }

    fun date(ms: Double): Instant = Instant.ofEpochMilli(ms.roundToLong())

    /** "0.4s", "12s", "1m 05s", "1h 02m". */
    fun duration(seconds: Double): String {
      if (seconds < 1) return "%.1fs".format(java.util.Locale.US, max(0.1, seconds))
      val s = Math.round(seconds)
      if (s < 60) return "${s}s"
      val m = s / 60
      if (m < 60) return "${m}m %02ds".format(s % 60)
      return "${m / 60}h %02dm".format(m % 60)
    }

    /** A friendly name for a tool while it runs. */
    fun toolLabel(tool: String): String = when (tool) {
      "web_search", "search" -> "Searching the web"
      "fetch_url", "web_fetch", "read_url" -> "Reading a page"
      "run_command", "bash", "shell" -> "Running a command"
      "read_file" -> "Reading a file"
      "write_file", "edit_file" -> "Writing a file"
      "generate_image" -> "Creating an image"
      "generate_video" -> "Creating a video"
      "generate_music" -> "Creating music"
      "generate_speech" -> "Creating a voice"
      else -> tool.replace('_', ' ').split(' ').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }
    }
  }
}

/** Pictures (or a voice) a running turn is making, as one group. */
data class MediaBatch(val id: String, val shape: TurnTrace.MediaShape, val startedAt: Instant, val done: Int, val total: Int)

object MediaText {
  /** What it says while working: changes every few seconds so a long wait never reads as stuck. */
  fun phase(kind: String, elapsed: Double): String {
    val list = when (kind) {
      "video" -> listOf("Setting up the shot", "Blocking the scene", "Animating", "Adding sound", "Rendering frames", "Finishing")
      "music" -> listOf("Finding the groove", "Writing the melody", "Arranging", "Mixing", "Mastering")
      "speech" -> listOf("Warming up the voice", "Speaking", "Polishing")
      else -> listOf("Composing", "Sketching shapes", "Adding light and colour", "Adding detail", "Refining")
    }
    val step = if (kind == "video" || kind == "music") 12.0 else 5.0
    return list[minOf((maxOf(0.0, elapsed) / step).toInt(), list.size - 1)]
  }

  /** "Creating 5 images · 4 of 5 ready · Adding detail" for the turn's status line. */
  fun describe(b: MediaBatch, now: Instant): String {
    val what = if (b.shape.kind == "image" && b.total > 1) "Creating ${b.total} images" else "Creating ${word(b.shape.kind)}"
    val ready = if (b.total > 1 && b.done > 0) " · ${b.done} of ${b.total} ready" else ""
    val phase = if (b.done >= b.total) "Almost there" else phase(b.shape.kind, Duration.between(b.startedAt, now).toMillis() / 1000.0)
    return "$what$ready · $phase"
  }

  fun word(kind: String): String = when (kind) { "video" -> "video"; "music" -> "music"; "speech" -> "voice"; else -> "image" }

  /** The shape a placeholder takes, width / height: a batch is square tiles; one picture keeps its shape. */
  fun ratio(s: TurnTrace.MediaShape, tiles: Int = 1): Float {
    if (s.kind == "video") return if (s.aspect == "portrait") 9f / 16 else 16f / 9
    if (tiles > 1) return 1f
    return when (s.aspect) { "landscape" -> 3f / 2; "portrait" -> 2f / 3; else -> 1f }
  }

  /** One large, two or four in pairs, three or five and more in rows of three. */
  fun columns(n: Int): Int = if (n <= 1) 1 else if (n == 2 || n == 4) 2 else 3

  /** The most tiles a batch shows (the rest are counted on the last one). */
  const val MAX_TILES = 9
}
