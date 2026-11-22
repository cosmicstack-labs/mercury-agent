package sh.mercuryagent.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * Owner tasks (ADR-048, src/security/owner-tasks.ts, src/web/api/owner-tasks.ts): something only
 * the owner can do (type the letters of a CAPTCHA, listen to an audio one, read out a code, finish
 * a step on a page and say "done"). Every app connected to Mercury shows it; the first answer from
 * anywhere wins. Desktop: apps/desktop/src/components/OwnerTasks.tsx.
 */

/** One task waiting for the owner. */
data class OwnerTask(
  val id: String,
  /** A short code that names the task, so the owner can match it to what Mercury said. */
  val code: String,
  val title: String,
  val prompt: String,
  /** Who asks: "Mercury", or a bot's name. */
  val who: String,
  /** A page to open (a sign-in step), if any. */
  val link: String? = null,
  val media: Media? = null,
  /** "text": type an answer; "done": do it, then say so. */
  val answerKind: String = "text",
  /** Milliseconds since 1970. */
  val expiresAt: Long,
  val status: String = "pending",
) {
  /** The image or audio to solve, behind the device token ([url] is a path on this Mercury). */
  data class Media(val kind: String, val mimeType: String, val url: String) {
    val isImage: Boolean get() = kind == "image"
    val isAudio: Boolean get() = kind == "audio"
  }

  val needsText: Boolean get() = answerKind != "done"
  val pending: Boolean get() = status == "pending"

  /** Whole minutes left, at least 1 (the footer's "expires in N min"). */
  fun minutesLeft(nowMs: Long): Long = maxOf(1L, Math.round((expiresAt - nowMs) / 60_000.0))

  companion object {
    /** A task as the API and the stream send it; null when it lacks an id or an expiry. */
    fun from(o: JsonObject): OwnerTask? {
      val id = o.str("id")?.takeIf { it.isNotEmpty() } ?: return null
      val expires = o["expiresAt"].asInstant()?.toEpochMilli() ?: return null
      val media = o.obj("media")?.let { m ->
        val url = m.str("url")?.takeIf { it.isNotEmpty() } ?: return@let null
        Media(m.str("kind") ?: "image", m.str("mimeType") ?: "application/octet-stream", url)
      }
      return OwnerTask(
        id = id, code = o.str("code").orEmpty(), title = o.str("title") ?: "A task", prompt = o.str("prompt").orEmpty(),
        who = o.str("who")?.takeIf { it.isNotBlank() } ?: "Mercury", link = o.str("link")?.takeIf { it.isNotBlank() },
        media = media, answerKind = if (o.str("answerKind") == "done") "done" else "text", expiresAt = expires,
        status = o.str("status") ?: "pending",
      )
    }
  }
}

/** An `owner_task` event from /api/chat/activity: a new task, or one settled (answered, declined, expired). */
sealed interface OwnerTaskEvent {
  val id: String

  data class New(val task: OwnerTask) : OwnerTaskEvent { override val id: String get() = task.id }
  data class Settled(override val id: String) : OwnerTaskEvent

  companion object {
    /** Null for any other event, or one without an id. A "new" task that isn't pending is settled. */
    fun parse(name: String, data: String): OwnerTaskEvent? {
      if (name != "owner_task") return null
      val o = parseObject(data)
      val id = o.str("id")?.takeIf { it.isNotEmpty() } ?: return null
      val task = OwnerTask.from(o)
      return if (o.str("change") == "new" && task != null && task.pending) New(task) else Settled(id)
    }
  }
}

/** How an answer went: taken, or the task was already answered elsewhere, expired or gone (409/404). */
enum class OwnerTaskReply { Sent, Gone }

/** GET /api/owner/tasks: what waits now. An older Mercury (no such route) has none. */
suspend fun MercuryClient.ownerTasks(): List<OwnerTask> {
  val reply = send(request("GET", "/api/owner/tasks"))
  if (reply.code == 404) return emptyList()
  if (reply.code == 401) throw MercuryException.Unauthorized()
  if (reply.code !in 200..299) throw MercuryException.Server(reply.code, parseObject(reply.body).str("error"))
  return parseObject(reply.body).arr("pending").orEmpty().mapNotNull { (it as? JsonObject)?.let(OwnerTask::from) }.filter { it.pending }
}

/** POST /api/owner/tasks/:id with the answer ("done" for a step the owner finished). */
suspend fun MercuryClient.answerOwnerTask(id: String, answer: String): OwnerTaskReply =
  settleOwnerTask(id, buildJsonObject { put("answer", answer) })

/** POST /api/owner/tasks/:id { decline: true }: Skip. */
suspend fun MercuryClient.declineOwnerTask(id: String): OwnerTaskReply =
  settleOwnerTask(id, buildJsonObject { put("decline", true) })

private suspend fun MercuryClient.settleOwnerTask(id: String, body: JsonObject): OwnerTaskReply {
  val reply = send(request("POST", "/api/owner/tasks/${MercuryClient.q(id)}", body))
  return when (reply.code) {
    in 200..299 -> OwnerTaskReply.Sent
    404, 409, 410 -> OwnerTaskReply.Gone
    401 -> throw MercuryException.Unauthorized()
    else -> throw MercuryException.Server(reply.code, parseObject(reply.body).str("error"))
  }
}

/** The task's media as a full URL on this Mercury (so [MercuryClient.downloadTo] sends the token). */
fun MercuryClient.ownerTaskMediaUrl(media: OwnerTask.Media): String =
  if (media.url.startsWith("http://") || media.url.startsWith("https://")) media.url
  else baseUrl.trimEnd('/') + "/" + media.url.trimStart('/')

/**
 * Mercury's phone notification for an owner task (src/core/agent.ts, sent through reach):
 * "Mercury needs you: <title>" with "<prompt>\nCode <code>". Its code when it is one, else null
 * (iOS: OwnerTasks.swift does the same).
 */
fun ownerTaskCode(title: String, body: String): String? {
  if (!title.startsWith("Mercury needs you: ")) return null
  return OWNER_TASK_CODE.find(body)?.groupValues?.get(1)
}

private val OWNER_TASK_CODE = Regex("(?m)^Code ([A-Z0-9]{4,10})$")
