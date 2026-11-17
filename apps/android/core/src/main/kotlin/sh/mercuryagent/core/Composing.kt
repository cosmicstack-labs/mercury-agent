package sh.mercuryagent.core

import java.util.Base64
import java.util.Locale
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// What the composer needs beyond sending (iOS: ChatModels.swift, MercuryClient+Chat.swift): files,
// the Create switch (ADR-042), the chat's thinking effort (ADR-041) and new-chat suggestions.

/** The composer's Create switch (ADR-042): the next message asks for an image, a video or music. */
data class MediaIntent(val kind: String, val aspect: String? = null) {
  fun toJson(): JsonObject = buildJsonObject { put("kind", kind); aspect?.let { put("aspect", it) } }

  /** "Image 3:2", "Video 9:16", "Music": short, so the chip stays on one line. */
  val label: String
    get() {
      val k = kind.replaceFirstChar { it.uppercase() }
      if (aspect == null || kind == MUSIC) return k
      return when {
        aspect == SQUARE -> "$k 1:1"
        kind == VIDEO && aspect == LANDSCAPE -> "$k 16:9"
        kind == VIDEO && aspect == PORTRAIT -> "$k 9:16"
        aspect == LANDSCAPE -> "$k 3:2"
        aspect == PORTRAIT -> "$k 2:3"
        else -> k
      }
    }

  companion object {
    const val IMAGE = "image"
    const val VIDEO = "video"
    const val MUSIC = "music"
    const val SQUARE = "square"
    const val LANDSCAPE = "landscape"
    const val PORTRAIT = "portrait"
    val kinds = listOf(IMAGE, VIDEO, MUSIC)
    val aspects = listOf(SQUARE, LANDSCAPE, PORTRAIT)
  }
}

/** A file to send with a message, as base64 (POST /api/chat/send `attachments`). */
class OutgoingAttachment(val name: String, val mime: String, val data: ByteArray, val id: String = UUID.randomUUID().toString()) {
  val isImage: Boolean get() = mime.startsWith("image/")
  val isText: Boolean get() = mime.startsWith("text/")

  /** "PDF", "MD", "TXT", "IMG": the short tag a chip shows. */
  val tag: String
    get() = when {
      isImage -> "IMG"
      mime == "application/pdf" -> "PDF"
      mime == "text/markdown" -> "MD"
      else -> "TXT"
    }

  fun toJson(): JsonObject = buildJsonObject {
    put("name", name); put("data", Base64.getEncoder().encodeToString(data)); put("mime", mime)
  }

  companion object {
    /** The most a message carries, and each kind's limit (the server's, src/web/api/uploads.ts). */
    const val MAX_FILES = 4
    const val MAX_IMAGE_BYTES = 8 * 1024 * 1024
    const val MAX_PDF_BYTES = 15 * 1024 * 1024
    const val MAX_TEXT_BYTES = 256 * 1024

    /** What a file is, from its name and bytes, or why it can't be sent. */
    fun make(name: String, data: ByteArray): Result<OutgoingAttachment> {
      val ext = name.substringAfterLast('.', "").lowercase()
      val sniffed = sniffImage(data)
      val mime = when {
        sniffed != null -> sniffed
        data.startsWith(byteArrayOf(0x25, 0x50, 0x44, 0x46)) -> "application/pdf"
        ext == "txt" -> "text/plain"
        ext == "md" || ext == "markdown" -> "text/markdown"
        else -> return Result.failure(AttachmentProblem.Unsupported(name))
      }
      val limit = if (mime.startsWith("text/")) MAX_TEXT_BYTES else if (mime.startsWith("image/")) MAX_IMAGE_BYTES else MAX_PDF_BYTES
      if (data.size > limit) return Result.failure(AttachmentProblem.TooLarge(name, limit))
      if (mime.startsWith("text/") && !isUtf8(data)) return Result.failure(AttachmentProblem.NotText(name))
      return Result.success(OutgoingAttachment(name, mime, data))
    }

    /** png, jpeg, gif or webp (what the server takes); null for anything else. */
    fun sniffImage(d: ByteArray): String? {
      fun at(i: Int) = if (i < d.size) d[i].toInt() and 0xFF else -1
      return when {
        at(0) == 0x89 && at(1) == 0x50 && at(2) == 0x4E && at(3) == 0x47 -> "image/png"
        at(0) == 0xFF && at(1) == 0xD8 && at(2) == 0xFF -> "image/jpeg"
        at(0) == 0x47 && at(1) == 0x49 && at(2) == 0x46 && at(3) == 0x38 -> "image/gif"
        d.size >= 12 && at(0) == 0x52 && at(1) == 0x49 && at(2) == 0x46 && at(3) == 0x46 &&
          at(8) == 0x57 && at(9) == 0x45 && at(10) == 0x42 && at(11) == 0x50 -> "image/webp"
        else -> null
      }
    }

    private fun ByteArray.startsWith(p: ByteArray) = size >= p.size && p.indices.all { this[it] == p[it] }

    private fun isUtf8(d: ByteArray): Boolean = runCatching {
      Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(d)); true
    }.getOrDefault(false)
  }
}

/** Why a file can't go with a message, in words. */
sealed class AttachmentProblem(message: String) : Exception(message) {
  class Unsupported(name: String) : AttachmentProblem("$name: attach an image, PDF, TXT or Markdown file.")
  class TooLarge(name: String, limit: Int) : AttachmentProblem("$name is too large (the limit is ${fileSize(limit.toLong())}).")
  class NotText(name: String) : AttachmentProblem("$name isn't UTF-8 text.")
  class TooMany : AttachmentProblem("Up to ${OutgoingAttachment.MAX_FILES} files per message.")
}

/** 512 bytes, 38 KB, 4.2 MB, as iOS's ByteCountFormatter (.file) writes them, in decimal units. */
fun fileSize(n: Long): String {
  val d = n.coerceAtLeast(0).toDouble()
  return when {
    d < 1000 -> "${n.coerceAtLeast(0)} bytes"
    d < 1_000_000 -> "${Math.round(d / 1000)} KB"
    d < 1_000_000_000 -> String.format(Locale.US, "%.1f MB", d / 1_000_000)
    else -> String.format(Locale.US, "%.2f GB", d / 1_000_000_000)
  }
}

// MARK: New chat suggestions

/** What the owner might want next, for a new chat (GET /api/suggestions). */
@Serializable
data class Suggestion(
  val id: String,
  val title: String = "",
  val prompt: String = "",
  val why: String? = null,
  /** continue, create, plan, check, learn or explore */
  val kind: String? = null,
)

data class SuggestionPick(val greeting: String?, val subtitle: String?, val items: List<Suggestion>) {
  companion object {
    fun from(j: JsonObject): SuggestionPick {
      val items = j.arr("items").orEmpty().mapNotNull {
        runCatching { MercuryJson.decodeFromJsonElement(Suggestion.serializer(), it) }.getOrNull()
      }.filter { it.title.isNotEmpty() && it.prompt.isNotEmpty() }
      return SuggestionPick(j.str("greeting")?.ifEmpty { null }, j.str("subtitle")?.ifEmpty { null }, items)
    }
  }
}

// MARK: Thinking effort (ADR-041, #188)

/** The effort a chat's requests carry, and where it comes from. */
@Serializable
data class ChatEffort(
  /** auto, off, low, medium, high, xhigh or max */
  val effective: String = "auto",
  /** chat, model or auto */
  val source: String = "auto",
  val modelDefault: String = "auto",
  /** This chat's own pick, if any. */
  val chat: String? = null,
  val chatUnsupported: Boolean? = null,
) {
  companion object {
    fun label(level: String): String = when (level) {
      "auto" -> "Auto"
      "off" -> "Off"
      "low" -> "Low"
      "medium" -> "Medium"
      "high" -> "High"
      "xhigh" -> "Extra high"
      "max" -> "Max"
      else -> level.replaceFirstChar { it.uppercase() }
    }

    fun hint(level: String): String? = when (level) {
      "auto" -> "The model decides"
      "off" -> "Answer straight away"
      "low" -> "Quick, light thinking"
      "high" -> "Thinks it through"
      "xhigh" -> "For hard coding and agent work"
      "max" -> "Slowest, most thorough"
      else -> null
    }

    /** An effort picked before the chat existed, shown as the chat's own. */
    fun withPending(e: ChatEffort, level: String) = ChatEffort(level, "chat", e.modelDefault, level)
  }
}

/** The model this chat uses (GET /api/chat/models `current`): its name and the efforts it takes. */
@Serializable
data class ChatModelInfo(
  val name: String = "",
  val model: String = "",
  val label: String? = null,
  val reasoning: String? = null,
  val reasoningLevels: List<String>? = null,
  val effort: ChatEffort? = null,
) {
  /** The effort shown; older runtimes report only the model's level. */
  val currentEffort: ChatEffort
    get() = effort ?: run {
      val r = reasoning ?: "auto"
      ChatEffort(r, if (r == "auto") "auto" else "model", r, null)
    }
}

/** Which kinds of media this Mercury can make (GET /api/media/models). */
data class MediaAvailability(
  val image: Boolean,
  val video: Boolean,
  val music: Boolean,
  /** The model each kind uses ("GPT Image 2"), when one is known. */
  val using: Map<String, String> = emptyMap(),
) {
  val any: Boolean get() = image || video || music
  fun has(kind: String): Boolean = when (kind) { MediaIntent.IMAGE -> image; MediaIntent.VIDEO -> video; else -> music }

  companion object {
    val unknown = MediaAvailability(image = true, video = true, music = true)

    fun from(j: JsonObject): MediaAvailability {
      val using = mutableMapOf<String, String>()
      fun has(k: String): Boolean {
        val info = j.obj(k) ?: return false
        val models = info.arr("models").orEmpty().mapNotNull { it as? JsonObject }
        val d = info.obj("default")
        val m = if (d?.bool("available") == true) models.firstOrNull { it.str("ref") == d.str("ref") } else null
        val label = m?.str("label") ?: info.obj("auto")?.str("label")
        if (label != null) using[k] = label
        return models.isNotEmpty()
      }
      return MediaAvailability(has(MediaIntent.IMAGE), has(MediaIntent.VIDEO), has(MediaIntent.MUSIC), using)
    }
  }
}

// MARK: Calls (none is owner-gated: a paired phone may call them all)

/** GET /api/suggestions: a greeting, a line, and a few things to ask. Throws on older runtimes. */
suspend fun MercuryClient.suggestions(n: Int = 4): SuggestionPick =
  SuggestionPick.from(json(request("GET", "/api/suggestions?n=$n"), 8))

/** The owner picked one: it leaves the pool. */
suspend fun MercuryClient.suggestionUsed(id: String) {
  runCatching { send(request("POST", "/api/suggestions/${MercuryClient.q(id)}/used", JsonObject(emptyMap()))) }
}

/** The model this chat uses and its effort (GET /api/chat/models `current`). */
suspend fun MercuryClient.chatModel(sessionId: String?): ChatModelInfo {
  val path = "/api/chat/models" + (sessionId?.let { "?sessionId=${MercuryClient.q(it)}" } ?: "")
  val cur = json(request("GET", path), 20).obj("current") ?: throw MercuryException.Server(200, "Mercury didn't say which model this chat uses.")
  return MercuryJson.decodeFromJsonElement(ChatModelInfo.serializer(), cur)
}

/** This chat's effort: a level the model takes, "auto", or null for the model's default. */
suspend fun MercuryClient.setEffort(sessionId: String, level: String?): ChatEffort? {
  val j = json(request("POST", "/api/chat/effort", buildJsonObject {
    put("sessionId", sessionId)
    if (level == null) put("level", JsonNull) else put("level", level)
  }))
  val e = j.obj("effort") ?: return null
  return runCatching { MercuryJson.decodeFromJsonElement(ChatEffort.serializer(), e) }.getOrNull()
}

/** Which media this Mercury can make (GET /api/media/models). */
suspend fun MercuryClient.mediaAvailability(): MediaAvailability =
  MediaAvailability.from(json(request("GET", "/api/media/models"), 20))

/** A file the person sent (`/api/chat/uploads/…`), as a URL the media views load with the token. */
fun MercuryClient.uploadUrl(path: String): String? =
  if (path.startsWith("/api/")) baseUrl.trimEnd('/') + path else null
