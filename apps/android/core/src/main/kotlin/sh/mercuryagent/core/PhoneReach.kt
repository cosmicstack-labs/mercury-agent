package sh.mercuryagent.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

/*
 * Calls and notifications from Mercury to this phone (ADR-046, src/reach; iOS: PhoneReach.swift).
 * They arrive only over the live activity stream the app keeps open (/api/chat/activity): `ring`,
 * `ring_end` and `notify` events. Nothing reaches the phone through a push service; what it missed
 * while it wasn't connected waits on the server (GET /api/devices/me/missed).
 */

/** Mercury is ringing this phone. */
data class RingInvite(
  val id: String,
  val caller: String = "Mercury",
  /** Why Mercury is calling: its first words when the call is answered. */
  val reason: String,
  val urgency: String = "normal",
  val expiresAt: Instant? = null,
)

/** A notification from Mercury. */
data class ReachNotice(
  val id: String,
  val title: String,
  val body: String,
  val kind: String = "info",
  val urgency: String = "normal",
  val threadId: String? = null,
  /** Quiet hours: show it without a sound. */
  val silent: Boolean = false,
)

/** A call nobody answered or a notification no phone was connected for. */
data class MissedItem(val id: String, val kind: String, val title: String, val body: String, val threadId: String? = null, val at: Instant? = null)

enum class RingOutcome(val wire: String) { Answered("answered"), Declined("declined"), Missed("missed") }

/** One reach event from the activity stream. */
sealed interface ReachEvent {
  data class Ring(val invite: RingInvite) : ReachEvent
  /** The ring stopped elsewhere: "answered_elsewhere", "declined" or "missed". */
  data class RingEnd(val id: String, val outcome: String) : ReachEvent
  data class Notify(val notice: ReachNotice) : ReachEvent

  companion object {
    /** Parses a `ring`, `ring_end` or `notify` event; null for any other event or a malformed one. */
    fun parse(name: String, data: String): ReachEvent? {
      if (name != "ring" && name != "ring_end" && name != "notify") return null
      val j = runCatching { parseObject(data) }.getOrNull() ?: return null
      val id = j.str("id")?.takeIf { it.isNotEmpty() } ?: return null
      return when (name) {
        "ring" -> Ring(RingInvite(id, j.str("caller") ?: "Mercury", j.str("reason").orEmpty(), j.str("urgency") ?: "normal", j["expiresAt"].asInstant()))
        "ring_end" -> RingEnd(id, j.str("outcome") ?: "missed")
        else -> Notify(ReachNotice(id, j.str("title") ?: "Mercury", j.str("body").orEmpty(), j.str("kind") ?: "info", j.str("urgency") ?: "normal", j.str("threadId"), j.bool("silent") ?: false))
      }
    }
  }
}

/** The owner's settings for calls from Mercury (the part the app shows; src/reach/settings.ts). */
data class ReachSettings(
  val calls: Boolean = true,
  val notifications: Boolean = true,
  val quietHours: Boolean = false,
  /** "HH:MM", local time on the computer Mercury runs on. */
  val quietStart: String = "22:00",
  val quietEnd: String = "07:00",
  val maxCallsPerHour: Int = 4,
) {
  /** The body for PUT /api/reach/settings. */
  fun patch() = buildJsonObject {
    put("calls", calls)
    put("notifications", notifications)
    put("quietHours", buildJsonObject { put("enabled", quietHours); put("start", quietStart); put("end", quietEnd) })
  }

  companion object {
    fun decode(raw: String): ReachSettings {
      val j = parseObject(raw).obj("settings") ?: return ReachSettings()
      val q = j.obj("quietHours")
      return ReachSettings(
        calls = j.bool("calls") ?: true, notifications = j.bool("notifications") ?: true,
        quietHours = q?.bool("enabled") ?: false, quietStart = q?.str("start") ?: "22:00", quietEnd = q?.str("end") ?: "07:00",
        maxCallsPerHour = j.int("maxCallsPerHour") ?: 4,
      )
    }

    fun decodeMissed(raw: String): List<MissedItem> = (parseObject(raw).arr("items") ?: JsonArray(emptyList())).mapNotNull { e ->
      val o = e as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
      MissedItem(o.str("id") ?: return@mapNotNull null, o.str("kind") ?: "notification", o.str("title") ?: "Mercury", o.str("body").orEmpty(), o.str("threadId"), o["at"].asInstant())
    }
  }
}

/** PUT /api/devices/me/reach: tells Mercury this is an Android phone and whether to ring it. */
suspend fun MercuryClient.registerReach(ring: Boolean, notify: Boolean, appVersion: String, capabilities: List<String>) {
  json(request("PUT", "/api/devices/me/reach", buildJsonObject {
    put("platform", "android"); put("appVersion", appVersion); put("ring", ring); put("notify", notify)
    put("capabilities", buildJsonArray { capabilities.forEach { add(JsonPrimitive(it)) } })
  }))
}

/** POST /api/devices/me/ring/:id: what happened to a ring. */
suspend fun MercuryClient.reportRing(id: String, outcome: RingOutcome) {
  json(request("POST", "/api/devices/me/ring/${MercuryClient.q(id)}", buildJsonObject { put("outcome", outcome.wire) }))
}

/** POST /api/devices/me/test-ring: Mercury rings this phone now. */
suspend fun MercuryClient.testRing() { json(request("POST", "/api/devices/me/test-ring", buildJsonObject {})) }

/** GET /api/devices/me/missed: what came while no phone was connected. */
suspend fun MercuryClient.missed(): List<MissedItem> {
  val r = send(request("GET", "/api/devices/me/missed"))
  if (r.code !in 200..299) throw MercuryException.Server(r.code, parseObject(r.body).str("error"))
  return ReachSettings.decodeMissed(r.body)
}

/** POST /api/devices/me/missed/ack: they were shown (for every phone). */
suspend fun MercuryClient.ackMissed(ids: List<String>) {
  if (ids.isEmpty()) return
  json(request("POST", "/api/devices/me/missed/ack", buildJsonObject { put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) }))
}

suspend fun MercuryClient.reachSettings(): ReachSettings {
  val r = send(request("GET", "/api/reach/settings"))
  if (r.code !in 200..299) throw MercuryException.Server(r.code, parseObject(r.body).str("error"))
  return ReachSettings.decode(r.body)
}

suspend fun MercuryClient.updateReachSettings(s: ReachSettings): ReachSettings {
  val r = send(request("PUT", "/api/reach/settings", s.patch()))
  if (r.code !in 200..299) throw MercuryException.Server(r.code, parseObject(r.body).str("error"))
  return ReachSettings.decode(r.body)
}
