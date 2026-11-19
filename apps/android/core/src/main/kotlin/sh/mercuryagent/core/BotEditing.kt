package sh.mercuryagent.core

import java.text.Normalizer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

// Making and changing bots from the phone, over the routes Mercury Desktop uses
// (apps/desktop/src/views/bots/CreateBot.tsx, BotSettings.tsx, BotForms.tsx; src/web/api/bots.ts).
// iOS: MercuryCore/BotEditing.swift and MercuryClient+BotEditing.swift, the same rules.

/** One routine: when (cron) and what to do each time. */
data class BotSchedule(val name: String, val cron: String, val prompt: String) {
  fun json(): JsonObject = buildJsonObject { put("name", name); put("cron", cron.trim()); put("prompt", prompt.trim()) }
}

/** The model a bot thinks with; null everywhere means Mercury's default. */
data class BotModelRef(val provider: String, val model: String?) {
  fun json(): JsonObject = buildJsonObject { put("provider", provider); if (model != null) put("model", model) }
}

/** A bot's settings (GET /api/bots/:id `bot`). */
data class BotManifest(
  val id: String,
  val name: String,
  val description: String = "",
  val enabled: Boolean = true,
  val model: BotModelRef? = null,
  val schedules: List<BotSchedule> = emptyList(),
  /** Every autonomy limit as the runtime has it, so a save keeps the ones the phone doesn't show. */
  val autonomy: Map<String, Double> = emptyMap(),
  val fleetRole: String? = null,
  val parent: String? = null,
) {
  val dailyTokenBudget: Int? get() = autonomy["dailyTokenBudget"]?.toInt()

  companion object {
    fun from(j: JsonObject?): BotManifest? {
      val id = j?.str("id")?.takeIf { it.isNotEmpty() } ?: return null
      val model = j.obj("model")?.let { m -> m.str("provider")?.takeIf { it.isNotEmpty() }?.let { BotModelRef(it, m.str("model")?.takeIf { s -> s.isNotEmpty() }) } }
      val schedules = (j.arr("schedules") ?: JsonArray(emptyList())).mapNotNull { e ->
        val s = e as? JsonObject ?: return@mapNotNull null
        val name = s.str("name") ?: return@mapNotNull null
        val cron = s.str("cron") ?: return@mapNotNull null
        BotSchedule(name, cron, s.str("prompt").orEmpty())
      }
      val autonomy = j.obj("autonomy")?.mapNotNull { (k, v) ->
        (v as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull }?.content?.toDoubleOrNull()?.let { k to it }
      }?.toMap().orEmpty()
      return BotManifest(id, j.str("name") ?: id, j.str("description").orEmpty(), j.bool("enabled") ?: true, model, schedules, autonomy,
        j.str("fleetRole"), j.str("parent"))
    }
  }
}

/** A crew member, written by you or proposed by Mercury. */
data class CrewSpec(val id: String = "", val name: String = "", val description: String = "", val persona: String = "")

/** "Let Mercury decide" (POST /api/bots/plan): one bot or a fleet, why, and the crew it proposes. */
data class BotPlan(val shape: String, val reason: String, val crew: List<CrewSpec> = emptyList()) {
  val isFleet: Boolean get() = shape == "fleet"

  companion object {
    fun from(j: JsonObject?): BotPlan = BotPlan(
      j?.str("shape") ?: "solo", j?.str("reason").orEmpty(),
      (j?.arr("crew") ?: JsonArray(emptyList())).mapNotNull { e ->
        (e as? JsonObject)?.let { CrewSpec(it.str("id").orEmpty(), it.str("name").orEmpty(), it.str("description").orEmpty(), it.str("persona").orEmpty()) }
      },
    )
  }
}

// MARK: Permissions in plain words

object BotTiers {
  data class Words(val title: String, val can: String, val cant: String)

  /** readonly, builder, operator, full: least to most. */
  val ids = listOf("readonly", "builder", "operator", "full")

  fun words(id: String): Words? = when (id) {
    "readonly" -> Words("Read only", "Browse the web, search, read files, message other bots, report back.", "Can't write files or run commands.")
    "builder" -> Words("Writes files", "Everything in Read only, plus create and edit files in its own folder.", "Can't run commands or delete anything.")
    "operator" -> Words("Runs commands", "Everything in Writes files, plus run commands inside its own folder.", "Can't delete files or touch the rest of your computer.")
    "full" -> Words("Full access", "Everything, including deleting files and reading and writing your whole home folder.", "Only for automation you fully trust.")
    else -> null
  }

  fun title(id: String?): String = when (id) {
    null -> "Not set"
    "custom" -> "Custom (edited by hand)"
    else -> words(id)?.title ?: id
  }

  /** From another device these need the owner's go-ahead (src/web/api/bots.ts POWERFUL_TIERS). */
  fun needsOwner(id: String): Boolean = id == "operator" || id == "full"
}

// MARK: The form's rules (desktop BotForms.tsx, CreateBot.tsx)

object BotForms {
  const val DEFAULT_BUDGET = 1_000_000
  const val MIN_BUDGET = 10_000

  /** A bot id from its name: lowercase, dashes, at most 30 characters, starting with a letter. */
  fun slugify(name: String): String {
    val folded = Normalizer.normalize(name.lowercase(), Normalizer.Form.NFKD)
    var s = folded.replace(Regex("[^a-z0-9_\\s-]"), "").trim()
      .replace(Regex("[\\s_]+"), "-").replace(Regex("-+"), "-").take(30).trim('-')
    if (s.firstOrNull()?.let { it in 'a'..'z' } == true) return s
    if (s.isEmpty()) s = "new"
    return "bot-$s"
  }

  /** [base], or base-2, base-3… when it's taken. */
  fun uniqueId(base: String, taken: Collection<String>): String {
    if (base !in taken) return base
    var i = 2
    while ("$base-$i" in taken) i++
    return "$base-$i"
  }

  /** Common schedules, in words. Anything else is a custom cron. */
  val presets = listOf(
    "Every hour" to "0 * * * *",
    "Every 4 hours" to "0 */4 * * *",
    "Every morning at 9" to "0 9 * * *",
    "Weekdays at 9" to "0 9 * * 1-5",
    "Every evening at 6" to "0 18 * * *",
    "Mondays at 9" to "0 9 * * 1",
  )

  fun describeCron(cron: String): String = presets.firstOrNull { it.second == cron.trim() }?.first ?: cron

  /** Runs more often than every 15 minutes are slowed to that by Mercury. */
  fun tooFrequent(cron: String): Boolean {
    val minute = cron.trim().split(Regex("\\s+")).firstOrNull().orEmpty()
    if (minute == "*") return true
    val step = Regex("^\\*/(\\d+)$").find(minute) ?: return false
    return step.groupValues[1].toInt() < 15
  }

  fun nextRoutineName(list: List<BotSchedule>): String {
    var i = 1
    while (true) {
      val name = if (i == 1) "routine" else "routine-$i"
      if (list.none { it.name == name }) return name
      i++
    }
  }

  /** "1,000,000", "1 000 000" and "1_000_000" are all a million; null when it isn't a number. */
  fun parseBudget(s: String): Int? {
    val digits = s.replace(Regex("[,\\s_]"), "")
    if (digits.isEmpty()) return null
    val d = digits.toDoubleOrNull() ?: return null
    return if (d.isFinite()) Math.round(d).toInt() else null
  }

  /** What's missing before a bot can be made, in the order the form shows it; null when it's ready. */
  fun problem(name: String, persona: String, budget: String, schedules: List<BotSchedule>, manualFleet: Boolean = false, crew: List<CrewSpec> = emptyList()): String? {
    if (name.isBlank()) return "Give it a name."
    if (persona.isBlank()) return "Say how it should work (its instructions)."
    val b = parseBudget(budget)
    if (b == null || b < MIN_BUDGET) return "The daily budget must be at least 10,000 tokens."
    if (schedules.any { it.prompt.isBlank() }) return "Every schedule needs instructions."
    if (manualFleet && crew.none { it.name.isNotBlank() }) return "Add at least one crew member, or pick another option."
    return null
  }

  fun crewProblem(crew: List<CrewSpec>): String? =
    if (crew.any { it.name.isBlank() || it.persona.isBlank() }) "Every crew member needs a name and instructions." else null

  /** The edit screen's rules: a name, instructions, a budget when one is set, and instructions on every schedule. */
  fun editProblem(name: String, persona: String, budget: String, schedules: List<BotSchedule>): String? {
    if (name.isBlank()) return "Give it a name."
    if (persona.isBlank()) return "Its instructions can't be empty."
    if (budget.isNotBlank()) {
      val b = parseBudget(budget)
      if (b == null || b < MIN_BUDGET) return "The daily budget must be at least 10,000 tokens."
    }
    schedules.firstOrNull { !ScheduleRule.isValid(it.cron) }?.let { return "“${it.cron}” isn't a schedule Mercury understands." }
    if (schedules.any { it.prompt.isBlank() }) return "Every schedule needs instructions."
    return null
  }
}

// MARK: Schedules, picked in words

/** A schedule the way a person picks one, and the cron Mercury stores. Anything else stays a custom cron. */
sealed interface ScheduleRule {
  data class EveryMinutes(val n: Int) : ScheduleRule
  data class EveryHours(val n: Int) : ScheduleRule
  data class Daily(val hour: Int, val minute: Int) : ScheduleRule
  data class Weekdays(val hour: Int, val minute: Int) : ScheduleRule
  /** day: 0 Sunday … 6 Saturday */
  data class Weekly(val day: Int, val hour: Int, val minute: Int) : ScheduleRule
  data class Custom(val expr: String) : ScheduleRule

  enum class Kind(val title: String) { Minutes("Every few minutes"), Hours("Every few hours"), Daily("Every day"), Weekdays("Weekdays"), Weekly("Once a week"), Custom("Custom (cron)") }

  val cron: String get() = when (this) {
    is EveryMinutes -> "*/$n * * * *"
    is EveryHours -> if (n <= 1) "0 * * * *" else "0 */$n * * *"
    is Daily -> "$minute $hour * * *"
    is Weekdays -> "$minute $hour * * 1-5"
    is Weekly -> "$minute $hour * * $day"
    is Custom -> expr.trim()
  }

  val words: String get() = when (this) {
    is EveryMinutes -> "Every $n minutes"
    is EveryHours -> if (n <= 1) "Every hour" else "Every $n hours"
    is Daily -> "Every day at ${time(hour, minute)}"
    is Weekdays -> "Weekdays at ${time(hour, minute)}"
    is Weekly -> "${DAY_NAMES[day % 7]}s at ${time(hour, minute)}"
    is Custom -> if (expr.isEmpty()) "Custom" else "Custom: $expr"
  }

  val kind: Kind get() = when (this) {
    is EveryMinutes -> Kind.Minutes
    is EveryHours -> Kind.Hours
    is Daily -> Kind.Daily
    is Weekdays -> Kind.Weekdays
    is Weekly -> Kind.Weekly
    is Custom -> Kind.Custom
  }

  val hourOfDay: Int get() = when (this) { is Daily -> hour; is Weekdays -> hour; is Weekly -> hour; else -> 9 }
  val minuteOfHour: Int get() = when (this) { is Daily -> minute; is Weekdays -> minute; is Weekly -> minute; else -> 0 }

  /** Switching kind keeps the time of day when there is one. */
  fun with(kind: Kind): ScheduleRule = when (kind) {
    Kind.Minutes -> this as? EveryMinutes ?: EveryMinutes(30)
    Kind.Hours -> this as? EveryHours ?: EveryHours(1)
    Kind.Daily -> Daily(hourOfDay, minuteOfHour)
    Kind.Weekdays -> Weekdays(hourOfDay, minuteOfHour)
    Kind.Weekly -> this as? Weekly ?: Weekly(1, hourOfDay, minuteOfHour)
    Kind.Custom -> Custom(cron)
  }

  /** The same kind at another time of day. */
  fun at(hour: Int, minute: Int): ScheduleRule = when (this) {
    is Daily -> Daily(hour, minute)
    is Weekdays -> Weekdays(hour, minute)
    is Weekly -> Weekly(day, hour, minute)
    else -> this
  }

  companion object {
    val MINUTE_STEPS = listOf(15, 20, 30)
    val HOUR_STEPS = listOf(1, 2, 4, 6, 12)
    val DAY_NAMES = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

    fun time(h: Int, m: Int): String = "%d:%02d".format(h, m)

    fun from(cron: String): ScheduleRule {
      val t = cron.trim()
      val f = t.split(Regex("\\s+"))
      if (f.size != 5) return Custom(t)
      val (mi, ho, dom, mon, dow) = f
      if (dom != "*" || mon != "*") return Custom(t)
      if (ho == "*" && dow == "*" && mi.startsWith("*/")) mi.drop(2).toIntOrNull()?.takeIf { it in 1..59 }?.let { return EveryMinutes(it) }
      if (mi == "0" && dow == "*") {
        if (ho == "*") return EveryHours(1)
        if (ho.startsWith("*/")) ho.drop(2).toIntOrNull()?.takeIf { it in 1..23 }?.let { return EveryHours(it) }
      }
      val m = mi.toIntOrNull()?.takeIf { it in 0..59 } ?: return Custom(t)
      val h = ho.toIntOrNull()?.takeIf { it in 0..23 } ?: return Custom(t)
      return when (dow) {
        "*" -> Daily(h, m)
        "1-5" -> Weekdays(h, m)
        else -> dow.toIntOrNull()?.takeIf { it in 0..7 }?.let { Weekly(it % 7, h, m) } ?: Custom(t)
      }
    }

    /** Five fields, each a number, a range, a list, a step or *. */
    fun isValid(cron: String): Boolean {
      val f = cron.trim().split(Regex("\\s+"))
      return f.size == 5 && f.all { Regex("^[0-9*,/\\-]+$").matches(it) }
    }
  }
}

// MARK: A first draft from what you said

/** From plain words to a first draft: a name, a line, a schedule, a level. The persona comes from the server. */
object BotDraft {
  private val leads = listOf("i want a bot that", "i want a bot to", "i need a bot that", "i need a bot to", "a bot that", "a bot to", "bot that", "bot to",
    "please", "can you", "make a bot that", "make a bot to", "create a bot that", "create a bot to")
  private val stops = setOf("for", "and", "every", "each", "daily", "weekly", "hourly", "at", "then", "when", "on", "to", "about", "in", "with", "from", "that", "if")

  fun name(text: String): String {
    var s = text.trim()
    for (l in leads) if (s.lowercase().startsWith("$l ")) s = s.drop(l.length + 1)
    val words = mutableListOf<String>()
    for (raw in s.split(Regex("\\s+"))) {
      val w = raw.trim { !it.isLetterOrDigit() }
      if (w.isEmpty()) continue
      if (words.isNotEmpty() && w.lowercase() in stops) break
      words += w
      if (words.size == 4 || raw.lastOrNull()?.let { it in ".,;:!?" } == true) break
    }
    return words.joinToString(" ") { w -> if (w.first().isLowerCase()) w.replaceFirstChar { it.uppercase() } else w }.take(40)
  }

  fun description(text: String): String {
    val t = text.trim().replace(Regex("\\s+"), " ")
    val first = Regex("[.!?](\\s|$)").find(t)?.let { t.substring(0, it.range.first) } ?: t
    return if (first.length > 120) first.take(117) + "…" else first
  }

  fun schedule(text: String): BotSchedule? {
    val t = " " + text.lowercase() + " "
    fun has(p: String) = Regex(p).containsMatchIn(t)
    fun number(p: String) = Regex(p).find(t)?.value?.filter { it.isDigit() }?.toIntOrNull()
    val at = time(t)
    val dayIndex = ScheduleRule.DAY_NAMES.indexOfFirst { d -> val l = d.lowercase(); has("\\b(every|each|on) ${l}s?\\b") || has("\\b${l}s\\b") }
    val rule: ScheduleRule = when {
      number("every \\d+ ?(minutes|mins|min)\\b") != null -> ScheduleRule.EveryMinutes(number("every \\d+ ?(minutes|mins|min)\\b")!!.coerceIn(15, 59))
      number("every \\d+ ?(hours|hrs|h)\\b") != null -> ScheduleRule.EveryHours(number("every \\d+ ?(hours|hrs|h)\\b")!!.coerceIn(1, 23))
      has("\\b(hourly|every hour|each hour)\\b") -> ScheduleRule.EveryHours(1)
      has("\\b(weekdays|every weekday|each weekday|workdays)\\b") -> ScheduleRule.Weekdays(at?.first ?: 9, at?.second ?: 0)
      dayIndex >= 0 -> ScheduleRule.Weekly(dayIndex, at?.first ?: 9, at?.second ?: 0)
      has("\\b(weekly|every week|once a week)\\b") -> ScheduleRule.Weekly(1, at?.first ?: 9, at?.second ?: 0)
      has("\\b(every|each) (evening|night)\\b") || has("\\bnightly\\b") -> ScheduleRule.Daily(at?.first ?: 18, at?.second ?: 0)
      has("\\b(every|each) (morning|day)\\b") || has("\\bdaily\\b") || (at != null && has("\\bevery\\b")) -> ScheduleRule.Daily(at?.first ?: 9, at?.second ?: 0)
      else -> return null
    }
    return BotSchedule("routine", rule.cron, description(text))
  }

  /** "at 7", "at 7:30", "at 7am", "at 6 pm", "at 18:00". */
  internal fun time(t: String): Pair<Int, Int>? {
    val m = Regex("\\bat (\\d{1,2})(:(\\d{2}))? ?(am|pm|a\\.m\\.|p\\.m\\.)?").find(t) ?: return null
    var h = m.groupValues[1].toInt()
    val min = m.groupValues[3].toIntOrNull() ?: 0
    val ap = m.groupValues[4]
    if (ap.startsWith("p") && h < 12) h += 12
    if (ap.startsWith("a") && h == 12) h = 0
    return if (h in 0..23 && min in 0..59) h to min else null
  }

  /** Read only, unless the job is to make files: then Writes files. More is never guessed. */
  fun tier(text: String): String {
    val t = " " + text.lowercase() + " "
    val writes = listOf("\\bfiles?\\b", "\\bsaves?\\b", "\\bdrafts?\\b", "\\bdocuments?\\b", "\\bwrites?\\b", "\\bmarkdown\\b", "\\.md\\b", "\\bspreadsheets?\\b", "\\bcsv\\b")
    return if (writes.any { Regex(it).containsMatchIn(t) }) "builder" else "readonly"
  }
}

// MARK: Request bodies

/** POST /api/bots: what a new bot starts with. */
data class NewBot(
  val id: String,
  val name: String,
  val description: String = "",
  val persona: String,
  val tier: String = "readonly",
  val model: BotModelRef? = null,
  val dailyTokenBudget: Int = BotForms.DEFAULT_BUDGET,
) {
  fun body(): JsonObject = buildJsonObject {
    put("id", id)
    put("name", name.trim())
    if (description.isNotBlank()) put("description", description.trim())
    put("persona", persona.trim())
    put("tier", tier)
    putJsonObject("manifest") {
      putJsonObject("autonomy") { put("dailyTokenBudget", dailyTokenBudget) }
      if (model != null) put("model", model.json())
    }
  }
}

/** PATCH /api/bots/:id: only what changed. [clearModel] sends null (back to Mercury's default). */
data class BotChanges(
  val name: String? = null,
  val description: String? = null,
  val model: BotModelRef? = null,
  val clearModel: Boolean = false,
  val schedules: List<BotSchedule>? = null,
  val autonomy: Map<String, Double>? = null,
) {
  val isEmpty: Boolean get() = name == null && description == null && model == null && !clearModel && schedules == null && autonomy == null

  fun body(): JsonObject = buildJsonObject {
    name?.let { put("name", it) }
    description?.let { put("description", it) }
    if (model != null) put("model", model.json()) else if (clearModel) put("model", JsonNull)
    schedules?.let { list -> putJsonArray("schedules") { list.forEach { add(it.json()) } } }
    autonomy?.let { a ->
      putJsonObject("autonomy") { a.toSortedMap().forEach { (k, v) -> if (v == Math.rint(v)) put(k, v.toLong()) else put(k, v) } }
    }
  }

  companion object {
    fun between(bot: BotManifest, name: String, description: String, model: BotModelRef?, schedules: List<BotSchedule>, budget: String): BotChanges {
      val cleaned = schedules.map { BotSchedule(it.name, it.cron.trim(), it.prompt.trim()) }
      val newBudget = if (budget.isBlank()) null else BotForms.parseBudget(budget)?.toDouble()
      return BotChanges(
        name = name.trim().takeIf { it != bot.name },
        description = description.trim().takeIf { it != bot.description },
        model = model.takeIf { it != bot.model && it != null },
        clearModel = model == null && bot.model != null,
        schedules = cleaned.takeIf { it != bot.schedules },
        autonomy = if (newBudget != bot.autonomy["dailyTokenBudget"]) bot.autonomy.toMutableMap().apply {
          if (newBudget == null) remove("dailyTokenBudget") else put("dailyTokenBudget", newBudget)
        } else null,
      )
    }
  }
}

/** What Stop / Start / Run now said. */
data class BotControlResult(val accepted: Boolean, val message: String? = null, val reasonCode: String? = null)

object BotWords {
  fun refused(code: String?): String = when (code) {
    "target_disabled" -> "It's off. Turn it on first."
    "stopped" -> "It's stopped. Start it first."
    "target_unknown" -> "That bot is gone."
    "duplicate", "busy" -> "It's already working on that."
    else -> "Not started (${(code ?: "refused").replace('_', ' ')})."
  }
}

// MARK: Calls (same routes, bodies and headers as iOS)

private fun botPath(id: String) = "/api/bots/${MercuryClient.q(id)}"
private val EMPTY = JsonObject(emptyMap())

/** POST /api/bots. Mercury may lowercase the id: the bot it made is returned. Powerful levels → NeedsOwner. */
suspend fun MercuryClient.createBot(bot: NewBot, approval: String? = null): BotManifest =
  BotManifest.from(json(gated("POST", "/api/bots", bot.body(), approval)).obj("bot"))
    ?: throw MercuryException.Server(200, "Mercury sent something this app can't read.")

/** POST /api/bots/persona-builder: rough words in, structured instructions out. Nothing is saved. */
suspend fun MercuryClient.buildPersona(text: String, name: String): String =
  json(request("POST", "/api/bots/persona-builder", buildJsonObject { put("text", text); put("name", name) }), 120).str("persona")
    ?.takeIf { it.isNotBlank() } ?: throw MercuryException.Server(200, "The persona builder sent nothing back.")

/** POST /api/bots/plan: one bot or a team. Nothing is made. */
suspend fun MercuryClient.planBot(name: String, description: String, persona: String, fleet: Boolean = false): Pair<BotPlan, Int> {
  val j = json(request("POST", "/api/bots/plan", buildJsonObject {
    put("name", name); put("description", description); put("persona", persona); if (fleet) put("fleet", true)
  }), 120)
  return BotPlan.from(j.obj("plan")) to (j.int("maxCrew") ?: 6)
}

suspend fun MercuryClient.botManifest(id: String): BotManifest =
  BotManifest.from(json(request("GET", botPath(id))).obj("bot")) ?: throw MercuryException.Server(404, "That bot is gone.")

suspend fun MercuryClient.botPersona(id: String): String = json(request("GET", "${botPath(id)}/persona")).str("persona").orEmpty()

suspend fun MercuryClient.updateBot(id: String, changes: BotChanges): BotManifest? =
  BotManifest.from(json(request("PATCH", botPath(id), changes.body())).obj("bot"))

suspend fun MercuryClient.setBotPersona(id: String, persona: String) {
  json(request("PUT", "${botPath(id)}/persona", buildJsonObject { put("persona", persona) }))
}

/** PUT /api/bots/:id/permissions with a level. Runs commands / Full access need the owner from a phone. */
suspend fun MercuryClient.setBotTier(id: String, tier: String, approval: String? = null) {
  json(gated("PUT", "${botPath(id)}/permissions", buildJsonObject { put("tier", tier) }, approval))
}

suspend fun MercuryClient.botTiers(): List<String> =
  (json(request("GET", "/api/bots/tiers")).arr("tiers") ?: JsonArray(emptyList())).mapNotNull { (it as? JsonObject)?.str("id") }.ifEmpty { BotTiers.ids }

/** PUT /api/bots/:id/avatar: a png, jpeg, webp or gif, 2 MB at most. */
suspend fun MercuryClient.setBotAvatar(id: String, image: ByteArray) {
  json(request("PUT", "${botPath(id)}/avatar", buildJsonObject { put("data", java.util.Base64.getEncoder().encodeToString(image)) }), 60)
}

suspend fun MercuryClient.removeBotAvatar(id: String) { json(request("DELETE", "${botPath(id)}/avatar")) }

suspend fun MercuryClient.setBotEnabled(id: String, on: Boolean) { json(request("POST", botPath(id) + if (on) "/enable" else "/disable", EMPTY)) }

suspend fun MercuryClient.stopBot(id: String): BotControlResult = BotControlResult(true, json(request("POST", "${botPath(id)}/stop", EMPTY)).str("message"))

suspend fun MercuryClient.startBot(id: String): BotControlResult = BotControlResult(true, json(request("POST", "${botPath(id)}/start", EMPTY)).str("message"))

/** POST /api/bots/:id/run. Refused (off, stopped, busy…) is `accepted = false`, not an error. */
suspend fun MercuryClient.runBotNow(id: String): BotControlResult {
  val reply = send(request("POST", "${botPath(id)}/run", EMPTY))
  val j = parseObject(reply.body)
  return when (reply.code) {
    in 200..299 -> BotControlResult(true)
    409 -> BotControlResult(false, reasonCode = j.str("reasonCode"))
    401 -> throw MercuryException.Unauthorized()
    else -> throw MercuryException.Server(reply.code, j.str("error"))
  }
}

/** DELETE /api/bots/:id: the bot and its folder; a lead takes its whole crew with it. */
suspend fun MercuryClient.deleteBot(id: String) { json(request("DELETE", botPath(id))) }

suspend fun MercuryClient.stopAllBots() { json(request("POST", "/api/bots-stop-all", EMPTY)) }
suspend fun MercuryClient.startAllBots() { json(request("POST", "/api/bots-start-all", EMPTY)) }

suspend fun MercuryClient.promoteBot(id: String) { json(request("POST", "${botPath(id)}/promote", EMPTY)) }
suspend fun MercuryClient.autoCrew(id: String) { json(request("POST", "${botPath(id)}/autocrew", EMPTY)) }

suspend fun MercuryClient.addCrew(leadId: String, member: CrewSpec): BotManifest? =
  BotManifest.from(json(request("POST", "${botPath(leadId)}/crew", buildJsonObject {
    put("id", member.id); put("name", member.name.trim()); put("description", member.description.trim()); put("persona", member.persona.trim())
  })).obj("bot"))

@Suppress("unused") private fun JsonElement?.unused() = Unit
