package sh.mercuryagent.core

import kotlin.math.ceil
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// Mercury's bots (ADR-012) as the runtime reports them: GET /api/bots, /api/bots/activity,
// /api/bots/approvals, /api/bots/inbox, /api/bots/:id/journal, /api/bots/:id/runs/:runId and the
// /api/bots/events stream (src/web/api/bots.ts). Times are milliseconds since 1970.
// iOS: MercuryCore/Bots.swift and MercuryClient+Bots.swift.
//
// Every model reads itself from a raw JSON object (each field may be missing or odd, numbers may
// come as 3 or 3.0), so one strange field never fails a whole list.

private fun JsonObject.strings(key: String): List<String> =
  arr(key)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

private fun JsonElement?.objects(): List<JsonObject> = (this as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

/** One bot in the roster, with its live state. */
data class BotStatus(
  val id: String,
  val name: String,
  val enabled: Boolean = true,
  /** disabled, idle, queued, running or paused */
  val state: String = "idle",
  val activity: String? = null,
  val lastRunAt: Double? = null,
  val lastRunState: String? = null,
  val needsYou: Boolean = false,
  /** lead or crew */
  val fleetRole: String? = null,
  val parent: String? = null,
  val crewWorking: Int? = null,
  val hasAvatar: Boolean? = null,
  /** Unread inbox entries from this bot. */
  val unread: Int? = null,
  val tier: String? = null,
  /** Stopped by the owner; stays stopped until Start. */
  val stopped: Boolean? = null,
  val description: String? = null,
) {
  val isRunning: Boolean get() = state == "running"
  val isOff: Boolean get() = !enabled || state == "disabled" || stopped == true

  companion object {
    fun from(o: JsonObject): BotStatus? {
      val id = o.str("id") ?: return null
      return BotStatus(
        id = id, name = o.str("name") ?: id, enabled = o.bool("enabled") ?: true, state = o.str("state") ?: "idle",
        activity = o.str("activity"), lastRunAt = o.double("lastRunAt"), lastRunState = o.str("lastRunState"),
        needsYou = o.bool("needsYou") ?: false, fleetRole = o.str("fleetRole"), parent = o.str("parent"),
        crewWorking = o.int("crewWorking"), hasAvatar = o.bool("hasAvatar"), unread = o.int("unread"), tier = o.str("tier"),
        stopped = o.bool("stopped"), description = o.str("description"),
      )
    }

    fun list(e: JsonElement?): List<BotStatus> = e.objects().mapNotNull(::from)
  }
}

/** GET /api/bots */
data class BotRoster(val bots: List<BotStatus>, val available: Boolean = true, val unread: Int? = null) {
  companion object {
    fun from(o: JsonObject) = BotRoster(BotStatus.list(o["bots"]), o.bool("available") ?: true, o.int("unread"))
  }
}

/** One thing a bot did, as the live feed sees it (the stream's `bot_activity`, and the recent past). */
data class BotActivityEvent(
  val botId: String,
  /** The run (job); "" or null for events outside a run (a delivery). */
  val jobId: String? = null,
  /** turn-start, step, tool, turn-end, thinking or queued */
  val kind: String,
  val label: String,
  val detail: String? = null,
  val stepIndex: Int? = null,
  val status: String? = null,
  val reasoningTail: String? = null,
  val textTail: String? = null,
  val at: Double? = null,
  val botName: String? = null,
  /** What started the run: api (you), cron (a schedule), mailbox (another bot), … */
  val trigger: String? = null,
  val prompt: String? = null,
  val fromBot: String? = null,
  val elapsedMs: Double? = null,
) {
  companion object {
    fun from(o: JsonObject): BotActivityEvent? {
      val botId = o.str("botId") ?: return null
      val kind = o.str("kind") ?: return null
      return BotActivityEvent(
        botId = botId, jobId = o.str("jobId"), kind = kind, label = o.str("label") ?: "", detail = o.str("detail"),
        stepIndex = o.int("stepIndex"), status = o.str("status"), reasoningTail = o.str("reasoningTail"), textTail = o.str("textTail"),
        at = o.double("at"), botName = o.str("botName"), trigger = o.str("trigger"), prompt = o.str("prompt"), fromBot = o.str("fromBot"),
        elapsedMs = o.double("elapsedMs"),
      )
    }
  }
}

/** A bot asking the owner mid-run (GET /api/bots/approvals). */
data class BotApproval(
  val id: String,
  val botId: String,
  val botName: String,
  val runId: String,
  /** "Run command: …", "Write to file: …", "Read file: …" */
  val prompt: String,
  val at: Double,
  val expiresAt: Double,
) {
  companion object {
    fun from(o: JsonObject): BotApproval? {
      val id = o.str("id") ?: return null
      val botId = o.str("botId") ?: return null
      return BotApproval(
        id, botId, o.str("botName") ?: botId, o.str("runId") ?: "", o.str("prompt") ?: "",
        o.double("at") ?: 0.0, o.double("expiresAt") ?: 0.0,
      )
    }
  }
}

/** One thing a bot did for you (GET /api/bots/inbox). */
data class BotInboxEntry(
  val id: String,
  val botId: String,
  val botName: String,
  val runId: String? = null,
  /** result, failed or needs-you */
  val kind: String = "result",
  val title: String = "",
  val summary: String = "",
  val files: List<String> = emptyList(),
  val complete: Boolean? = null,
  val reasonCode: String? = null,
  val approvalId: String? = null,
  val at: Double = 0.0,
  val read: Boolean = false,
) {
  companion object {
    fun from(o: JsonObject): BotInboxEntry? {
      val id = o.str("id") ?: return null
      val botId = o.str("botId") ?: return null
      return BotInboxEntry(
        id = id, botId = botId, botName = o.str("botName") ?: botId, runId = o.str("runId"), kind = o.str("kind") ?: "result",
        title = o.str("title") ?: "", summary = o.str("summary") ?: "", files = o.strings("files"), complete = o.bool("complete"),
        reasonCode = o.str("reasonCode"), approvalId = o.str("approvalId"), at = o.double("at") ?: 0.0, read = o.bool("read") ?: false,
      )
    }
  }
}

/** One finished run (GET /api/bots/:id/journal). */
data class BotRunRecord(
  val runId: String,
  val botId: String,
  val trigger: String = "",
  val state: String = "",
  val startedAt: Double = 0.0,
  val durationMs: Double = 0.0,
  val tokensIn: Int = 0,
  val tokensOut: Int = 0,
  val summary: String? = null,
  val error: String? = null,
  val reasonCode: String? = null,
  val steps: Int? = null,
  val toolCalls: Int? = null,
  /** deliverable, message, action, delegated, quiet, failed or none */
  val outcome: String? = null,
  /** result, no_update or failure */
  val report: String? = null,
  val complete: Boolean? = null,
  val deliverables: List<String>? = null,
) {
  val id: String get() = "$botId/$runId"

  /** A run in words: how the bot closed it when it did, else what it did (desktop Activity.tsx runLabel). */
  val label: String
    get() {
      if (state == "failed") return "failed"
      return when (outcome) {
        "failed" -> "couldn't do it"
        "quiet" -> "nothing new"
        "deliverable" -> if (complete == true) "delivered · done" else "delivered"
        "message" -> if (complete == true) "reported · done" else "reported"
        "action" -> "acted"
        "delegated" -> "delegated"
        "none" -> if (state == "completed") "no result" else state
        else -> state
      }
    }

  /** Failed, or the bot said it couldn't do it. */
  val failed: Boolean get() = state == "failed" || outcome == "failed"

  companion object {
    fun from(o: JsonObject): BotRunRecord? {
      val runId = o.str("runId") ?: return null
      val botId = o.str("botId") ?: return null
      return BotRunRecord(
        runId = runId, botId = botId, trigger = o.str("trigger") ?: "", state = o.str("state") ?: "",
        startedAt = o.double("startedAt") ?: 0.0, durationMs = o.double("durationMs") ?: 0.0,
        tokensIn = (o.double("tokensIn") ?: 0.0).toInt(), tokensOut = (o.double("tokensOut") ?: 0.0).toInt(),
        summary = o.str("summary"), error = o.str("error"), reasonCode = o.str("reasonCode"), steps = o.int("steps"),
        toolCalls = o.int("toolCalls"), outcome = o.str("outcome"), report = o.str("report"), complete = o.bool("complete"),
        deliverables = o.arr("deliverables")?.let { o.strings("deliverables") },
      )
    }
  }
}

/** One run, read back (GET /api/bots/:id/runs/:runId): what was asked, each tool call, what it concluded. */
data class BotRunTranscript(val record: BotRunRecord, val prompt: String, val output: String, val trace: List<Step>) {
  data class Step(val name: String, val ok: Boolean, val arg: String? = null)

  companion object {
    fun from(o: JsonObject, fallback: BotRunRecord? = null): BotRunTranscript? {
      val record = o.obj("record")?.let(BotRunRecord::from) ?: fallback ?: return null
      val trace = o["trace"].objects().mapNotNull { s -> s.str("name")?.let { Step(it, s.bool("ok") ?: true, s.str("arg")) } }
      return BotRunTranscript(record, o.str("prompt") ?: "", o.str("output") ?: "", trace)
    }
  }
}

/** Sending a message to a bot: accepted (with its job), or why not. */
data class BotMessageResult(val accepted: Boolean, val jobId: String? = null, val reasonCode: String? = null)

// MARK: Fleets

/** A lead with its crew. */
data class BotFleet(val lead: BotStatus, val crew: List<BotStatus>) {
  val id: String get() = lead.id
  val members: List<BotStatus> get() = listOf(lead) + crew
  val working: Int get() = members.count { it.isRunning }
}

object BotRosterLayout {
  private val byName = compareBy<BotStatus, String>(String.CASE_INSENSITIVE_ORDER) { it.name }

  /**
   * The roster the way the bots work: each fleet is a lead with its crew underneath; the rest on
   * their own. Both sorted by name. (desktop BotsView.tsx `organise`)
   */
  fun organise(bots: List<BotStatus>): Pair<List<BotFleet>, List<BotStatus>> {
    val ids = bots.map { it.id }.toSet()
    fun isCrew(b: BotStatus) = b.fleetRole == "crew" && b.parent != null && b.parent in ids
    val crewOf = LinkedHashMap<String, MutableList<BotStatus>>()
    for (b in bots) if (isCrew(b)) crewOf.getOrPut(b.parent!!) { mutableListOf() } += b
    val fleets = mutableListOf<BotFleet>()
    val solo = mutableListOf<BotStatus>()
    for (b in bots) {
      if (isCrew(b)) continue
      if (b.fleetRole == "lead" || crewOf.containsKey(b.id)) fleets += BotFleet(b, crewOf[b.id].orEmpty().sortedWith(byName))
      else solo += b
    }
    return fleets.sortedWith(compareBy<BotFleet, String>(String.CASE_INSENSITIVE_ORDER) { it.lead.name }) to solo.sortedWith(byName)
  }
}

// MARK: Questions

object BotQuestion {
  data class Option(val value: String, val label: String)

  /** After reading something untrusted there is nothing to "always" allow: once, or no. (desktop Approvals.tsx) */
  fun isInjectionWarning(prompt: String): Boolean =
    prompt.startsWith("⚠ Possible prompt injection") || prompt.startsWith("Mercury read content from outside")

  /** The answers a bot's question offers, the main one first. */
  fun options(a: BotApproval): List<Option> =
    if (isInjectionWarning(a.prompt)) listOf(Option("yes", "Allow once"), Option("no", "Deny"))
    else listOf(Option("yes", "Allow once"), Option("always", "Always allow for ${a.botName}"), Option("no", "Deny"))

  /** Whole minutes the bot still waits before it takes the silence as a no. */
  fun minutesLeft(a: BotApproval, now: Double): Int = maxOf(0, ceil((a.expiresAt - now) / 60_000).toInt())

  fun waits(a: BotApproval, now: Double): String = "${a.botName} waits ${minutesLeft(a, now)} min, then it's a no"
}

/**
 * What a bot's question asks, in words, split from the exact command or path. Permission prompts
 * arrive as "Run command: …", "Write to file: …" or "Read file: …" (src/capabilities/permissions.ts).
 */
data class BotAsk(val kind: Kind, val title: String, val detail: String? = null, val note: String? = null) {
  enum class Kind { Injection, Command, Write, Read, Other }

  companion object {
    fun of(a: BotApproval): BotAsk {
      val text = a.prompt
      fun after(prefix: String): String? {
        if (!text.startsWith(prefix)) return null
        val colon = text.indexOf(':')
        if (colon < 0) return null
        return text.substring(colon + 1).trim()
      }
      if (BotQuestion.isInjectionWarning(text)) return BotAsk(Kind.Injection, "Suspicious request", note = text)
      after("Run command")?.let { return BotAsk(Kind.Command, "Run a command", detail = it) }
      after("Write to file")?.let { return BotAsk(Kind.Write, "Write a file", detail = it) }
      after("Read file")?.let { return BotAsk(Kind.Read, "Read a file", detail = it) }
      return BotAsk(Kind.Other, "${a.botName} needs your OK", note = text)
    }
  }
}

// MARK: Faces

/**
 * A bot's drawn face, worked out exactly as Mercury Desktop does (apps/desktop/src/components/BotAvatar.tsx):
 * an FNV-1a hash over the id's UTF-16 code units, read with unsigned shifts. Same id, same face.
 */
data class BotFaceLook(val hue: Int, val hue2: Int, val shape: Int, val eyeGap: Int, val mouth: Int) {
  companion object {
    fun hash(s: String): UInt {
      var h = 2166136261u
      for (c in s) { h = h xor c.code.toUInt(); h *= 16777619u }
      return h
    }

    fun of(id: String): BotFaceLook {
      val h = hash(id)
      val hue = (h % 360u).toInt()
      val hue2 = ((hue.toUInt() + 28u + ((h shr 9) % 40u)) % 360u).toInt()
      return BotFaceLook(
        hue = hue, hue2 = hue2, shape = ((h shr 3) % 4u).toInt(), eyeGap = 9 + ((h shr 12) % 5u).toInt(), mouth = ((h shr 16) % 3u).toInt(),
      )
    }
  }
}

// MARK: The stream

/** What the bots stream (/api/bots/events) says. */
sealed interface BotStreamEvent {
  /** The roster changed (also sent first on every connect). */
  data class Roster(val bots: List<BotStatus>) : BotStreamEvent
  /** A bot did something. */
  data class Activity(val event: BotActivityEvent) : BotStreamEvent
  /** A bot asked, or its question was answered or timed out: reload the approvals. */
  data object ApprovalsChanged : BotStreamEvent
  /** A new inbox entry (a result, a reported failure, or a run that needs you). */
  data class Inbox(val entry: BotInboxEntry?) : BotStreamEvent

  companion object {
    /** One server-sent event, decoded; null for anything else. An activity without a time gets [now]. */
    fun from(e: ServerEvent, now: Double = System.currentTimeMillis().toDouble()): BotStreamEvent? = when (e.name) {
      "bot_roster" -> parseObject(e.data).takeIf { it.containsKey("bots") }?.let { Roster(BotStatus.list(it["bots"])) }
      "bot_activity" -> BotActivityEvent.from(parseObject(e.data))?.let { Activity(if (it.at == null) it.copy(at = now) else it) }
      "bot_approval" -> ApprovalsChanged
      "bot_inbox" -> Inbox(BotInboxEntry.from(parseObject(e.data)))
      else -> null
    }
  }
}

// MARK: Calls (same routes, bodies and headers as iOS)

private fun botPath(id: String) = "/api/bots/${MercuryClient.q(id)}"

/** GET /api/bots: the roster with live states and the inbox's unread count. */
suspend fun MercuryClient.bots(): BotRoster = BotRoster.from(json(request("GET", "/api/bots")))

/** GET /api/bots/activity: the live feed's recent past for some bots (all when empty), oldest first. */
suspend fun MercuryClient.botActivity(ids: List<String>, limit: Int = 400): List<BotActivityEvent> {
  val path = "/api/bots/activity?bots=${MercuryClient.q(ids.joinToString(","))}&limit=$limit"
  return json(request("GET", path))["events"].objects().mapNotNull(BotActivityEvent::from)
}

/** GET /api/bots/approvals: every bot question waiting for an answer. */
suspend fun MercuryClient.botApprovals(): List<BotApproval> =
  json(request("GET", "/api/bots/approvals"))["approvals"].objects().mapNotNull(BotApproval::from)

/** POST /api/bots/approvals/:id with yes, always or no. A question that's no longer waiting answers 409 ([MercuryException.Server]). */
suspend fun MercuryClient.answerBot(approvalId: String, answer: String) {
  json(request("POST", "/api/bots/approvals/${MercuryClient.q(approvalId)}", buildJsonObject { put("answer", answer) }))
}

/**
 * POST /api/bots/:id/message. Queued durably: it runs now, or after the bot's current run.
 * Refused (the bot is off, …) comes back as `accepted = false` with the reason, not as an error.
 */
suspend fun MercuryClient.messageBot(id: String, text: String): BotMessageResult {
  val reply = send(request("POST", "${botPath(id)}/message", buildJsonObject { put("message", text) }))
  val j = parseObject(reply.body)
  return when (reply.code) {
    in 200..299 -> BotMessageResult(true, jobId = j.str("jobId"))
    409 -> BotMessageResult(false, reasonCode = j.str("reasonCode"))
    401 -> throw MercuryException.Unauthorized()
    else -> throw MercuryException.Server(reply.code, j.str("error"))
  }
}

/** The inbox and how many entries are unread overall. */
data class BotInboxPage(val entries: List<BotInboxEntry>, val unread: Int)

/** GET /api/bots/inbox: results, reported failures and runs that need you, newest first. */
suspend fun MercuryClient.botInbox(bot: String? = null, unreadOnly: Boolean = false, limit: Int = 100): BotInboxPage {
  val query = buildList {
    add("limit=$limit")
    if (unreadOnly) add("unread=1")
    if (bot != null) add("bot=${MercuryClient.q(bot)}")
  }.joinToString("&")
  val j = json(request("GET", "/api/bots/inbox?$query"))
  return BotInboxPage(j["entries"].objects().mapNotNull(BotInboxEntry::from), j.int("unread") ?: 0)
}

/** POST /api/bots/inbox/read: some entries, or everything when [ids] is null. Returns what's still unread. */
suspend fun MercuryClient.markBotInboxRead(ids: List<String>?): Int {
  val body = buildJsonObject { if (ids != null) putJsonArray("ids") { ids.forEach { add(JsonPrimitive(it)) } } }
  return json(request("POST", "/api/bots/inbox/read", body)).int("unread") ?: 0
}

/** GET /api/bots/:id/journal: its finished runs. */
suspend fun MercuryClient.botJournal(id: String, limit: Int = 60): List<BotRunRecord> =
  json(request("GET", "${botPath(id)}/journal?limit=$limit"))["journal"].objects().mapNotNull(BotRunRecord::from)

/** GET /api/bots/:id/runs/:runId: one run read back. */
suspend fun MercuryClient.botRun(id: String, runId: String, fallback: BotRunRecord? = null): BotRunTranscript =
  BotRunTranscript.from(json(request("GET", "${botPath(id)}/runs/${MercuryClient.q(runId)}")), fallback)
    ?: throw MercuryException.Server(200, "Mercury sent something this app can't read.")

/** GET /api/bots/:id/avatar as a full URL (it needs the device token: [MercuryClient.downloadTo] adds it). */
fun MercuryClient.botAvatarUrl(id: String): String = baseUrl.trimEnd('/') + botPath(id) + "/avatar"

/** The bots stream, decoded. Reconnects by itself; every connect starts with the roster. */
fun MercuryClient.botEvents(): Flow<BotStreamEvent> = events("/api/bots/events").mapNotNull { BotStreamEvent.from(it) }
