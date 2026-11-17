package sh.mercuryagent.core

import java.text.NumberFormat
import java.time.Instant
import java.util.Base64
import java.util.Locale
import java.util.UUID
import kotlin.math.roundToInt
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Mercury's chat shapes (src/web/api/chat.ts, apps/desktop/src/api/types.ts; iOS: ChatModels.swift).
// Everything the runtime may leave out is optional, and the pieces riding on a stored message
// decode tolerantly: an odd value never stops a whole conversation from loading.

/** A conversation (GET /api/chat/threads lists them without messages). */
@Serializable
data class ChatThread(
  val id: String,
  val title: String? = null,
  val alias: String? = null,
  @Serializable(with = InstantIso::class) val createdAt: Instant,
  @Serializable(with = InstantIso::class) val updatedAt: Instant? = null,
  @Serializable(with = InstantIso::class) val savedAt: Instant? = null,
  val voiceCall: Boolean? = null,
  /** The list's one line of the last user or assistant message (runtimes from 1.6 on). */
  val preview: String? = null,
  /** Who wrote that line: "user" or "assistant". */
  val lastRole: String? = null,
  @Serializable(with = ChatMessageList::class) val messages: List<ChatMessage> = emptyList(),
) {
  /**
   * What the list shows: its title, as Mercury Desktop does. The alias is a code Mercury makes up
   * ("brave-otter-x1z"), never shown; until the first message names it, the title is "New session".
   */
  val displayTitle: String
    get() {
      val t = title?.trim().orEmpty()
      return if (t.isEmpty() || t == "New session") "New chat" else t
    }

  val lastActivity: Instant get() = updatedAt ?: createdAt

  /** The row's second line when nothing is happening: the last message, "You: " first when it was the person's. */
  val previewLine: String?
    get() {
      val p = preview?.trim()
      if (p.isNullOrEmpty()) return null
      return if (lastRole == "user") "You: $p" else p
    }
}

@Serializable
data class ChatMessage(
  val id: String = UUID.randomUUID().toString(),
  val role: String,
  val kind: String? = null,
  val content: String = "",
  @Serializable(with = InstantIso::class) val timestamp: Instant = Instant.now(),
  @Serializable(with = ArtifactRefList::class) val artifacts: List<ArtifactRef> = emptyList(),
  /** This turn was stopped; content is whatever was written before that. */
  val stopped: Boolean? = null,
  /** A reply's tokens, steps and time, raw (see [usage]). */
  @kotlinx.serialization.SerialName("usage") val usageJson: JsonElement? = null,
  /** A reply's thought process as the runtime keeps it (ADR-041), raw (see [storedTrace]). */
  @kotlinx.serialization.SerialName("trace") val traceJson: JsonElement? = null,
  /** Files the person sent with this message. */
  @Serializable(with = SentAttachmentList::class) val attachments: List<SentAttachment> = emptyList(),
  /** Set on replies built on the phone (a finished stream): parsed once instead of from JSON. */
  @kotlinx.serialization.Transient val localUsage: ReplyUsage? = null,
) {
  val usage: ReplyUsage? get() = localUsage ?: ReplyUsage.from(usageJson)
  val storedTrace: StoredTrace? get() = StoredTrace.from(traceJson)

  /** A message a person reads (user, assistant or a system note), not a stored tool call. */
  val isShown: Boolean
    get() = (role == "user" || role == "assistant" || role == "system") && (kind == null || kind == "message") && content.isNotEmpty()
}

/** A file a turn made (image, PDF, report…). The file is at GET /api/artifacts/:id/file. */
@Serializable
data class ArtifactRef(
  val id: String,
  val name: String,
  val kind: String? = null,
  val mime: String? = null,
  val size: Long? = null,
  /** The tool that made it ("generate_image"…): media models' work is shown large and playable. */
  val tool: String? = null,
  val prompt: String? = null,
  val batch: String? = null,
)

/** A file the person sent with a message (`/api/chat/uploads/…`). */
@Serializable
data class SentAttachment(val name: String, val kind: String? = null, val mime: String? = null, val url: String? = null) {
  val isImage: Boolean get() = kind == "image" || mime?.startsWith("image/") == true
}

object ChatMessageList : KSerializer<List<ChatMessage>> by LossyList(ChatMessage.serializer())
object ArtifactRefList : KSerializer<List<ArtifactRef>> by LossyList(ArtifactRef.serializer())
object SentAttachmentList : KSerializer<List<SentAttachment>> by LossyList(SentAttachment.serializer())

/** One line of GET /api/chat/activity: what a conversation is doing now (Desktop's notify.ts ActivityEvent). */
@Serializable
data class ActivityEvent(
  /** started, needs_you, resolved, done, stopped, failed or research */
  val kind: String,
  val sessionId: String,
  val title: String? = null,
  /** The question's id (needs_you, resolved). */
  val id: String? = null,
  val prompt: String? = null,
  /** How long the turn ran (done, failed). */
  val ms: Double? = null,
  /** The reply's first words (done). */
  val preview: String? = null,
  val message: String? = null,
  /** kind "research": how a research run ended (done, partial, stopped, failed), and what it found. */
  val state: String? = null,
  val topic: String? = null,
  val read: Int? = null,
  val cited: Int? = null,
  val failed: Int? = null,
)

/** One server-sent event: its name and its raw JSON data. */
data class ServerEvent(val name: String, val data: String, val id: String? = null)

/** One reply's tokens, steps, time and model (text_done's `usage`, and stored replies). */
data class ReplyUsage(
  val inputTokens: Int,
  val cachedInputTokens: Int = 0,
  val outputTokens: Int,
  val steps: Int? = null,
  val elapsedMs: Double? = null,
  val provider: String? = null,
  val model: String? = null,
) {
  /** "14k tokens · 82% cached · 6 steps · 12s", as Mercury Desktop writes it under a reply. */
  val short: String
    get() {
      val parts = mutableListOf("${compact(inputTokens + outputTokens)} tokens")
      if (cachedInputTokens > 0 && inputTokens > 0) parts += "${(cachedInputTokens.toDouble() / inputTokens * 100).roundToInt()}% cached"
      if (steps != null && steps > 1) parts += "$steps steps"
      if (elapsedMs != null && elapsedMs >= 1000) parts += "${(elapsedMs / 1000).roundToInt()}s"
      return parts.joinToString(" · ")
    }

  /** "20,765 in (18,649 from cache) · 16 out" and the model, for the details. */
  val detail: List<String>
    get() {
      val f = NumberFormat.getIntegerInstance(Locale.US)
      val lines = mutableListOf("${f.format(inputTokens)} in (${f.format(cachedInputTokens)} from cache) · ${f.format(outputTokens)} out")
      if (model != null) lines += (provider?.let { "$it · " } ?: "") + model
      return lines
    }

  companion object {
    fun from(json: JsonElement?): ReplyUsage? {
      val o = json as? JsonObject ?: return null
      fun n(k: String) = o.double(k)?.takeIf { it.isFinite() && it >= 0 }
      val i = n("inputTokens") ?: return null
      val out = n("outputTokens") ?: return null
      return ReplyUsage(
        inputTokens = i.toInt(), cachedInputTokens = (n("cachedInputTokens") ?: 0.0).toInt(), outputTokens = out.toInt(),
        steps = n("steps")?.toInt(), elapsedMs = n("elapsedMs"), provider = o.str("provider"), model = o.str("model"),
      )
    }

    /** 950 → "950", 14_200 → "14k", 1_250_000 → "1.3M". */
    fun compact(n: Int): String = when {
      n < 1000 -> n.toString()
      n < 10_000 -> String.format(Locale.US, "%.1fk", n / 1000.0).replace(".0k", "k")
      n < 1_000_000 -> "${(n / 1000.0).roundToInt()}k"
      else -> String.format(Locale.US, "%.1fM", n / 1_000_000.0).replace(".0M", "M")
    }
  }
}

/**
 * A reply's thought process as the runtime keeps it: `{ startedAt, endedAt, items }`, where an item
 * is thinking (`reasoning`) or a tool call (`tool`). Times are milliseconds since 1970.
 */
data class StoredTrace(val startedAt: Double?, val endedAt: Double?, val items: List<Item>) {
  data class Item(
    val kind: String,
    val text: String? = null,
    val id: String? = null,
    val title: String? = null,
    val status: String? = null,
    val startedAt: Double? = null,
    val endedAt: Double? = null,
    val durationMs: Double? = null,
    val summary: String? = null,
  )

  companion object {
    fun from(json: JsonElement?): StoredTrace? {
      val o = json as? JsonObject ?: return null
      val items = o.arr("items").orEmpty().mapNotNull { e ->
        val i = e as? JsonObject ?: return@mapNotNull null
        Item(
          kind = i.str("kind") ?: "", text = i.str("text"), id = i.str("id"), title = i.str("title"), status = i.str("status"),
          startedAt = i.double("startedAt"), endedAt = i.double("endedAt"), durationMs = i.double("durationMs"), summary = i.str("summary"),
        )
      }
      return StoredTrace(o.double("startedAt"), o.double("endedAt"), items)
    }
  }
}

/** Which chats are working now and which wait (GET /api/chat/running, ADR-037). */
@Serializable
data class TurnsInfo(val running: List<Running> = emptyList(), val waiting: List<Waiting> = emptyList()) {
  @Serializable data class Running(val sessionId: String? = null, val channelId: String? = null, val activity: String? = null)
  @Serializable data class Waiting(val sessionId: String? = null, val channelId: String? = null, val position: Int? = null)
}

/** The reply a chat is working on now (GET /api/chat/threads/:id/live). */
data class LiveSnapshot(
  val running: Boolean,
  val startedAt: Double? = null,
  val activity: String? = null,
  val trace: StoredTrace? = null,
  val text: String? = null,
)

/** A video or song being made in the background for a chat (arrives with media_ready). */
@Serializable
data class PendingMedia(
  val jobId: String,
  /** video or music */
  val kind: String,
  val aspect: String? = null,
  val prompt: String? = null,
  val startedAt: Double? = null,
)

@Serializable
data class PlanStep(val label: String = "", /** pending, active or done */ val status: String = "pending")

/** The plan Mercury works through in a chat; `state` is paused or stopped when its turn ended unfinished. */
@Serializable
data class ChatPlan(val steps: List<PlanStep> = emptyList(), val updatedAt: Double? = null, val state: String? = null)

