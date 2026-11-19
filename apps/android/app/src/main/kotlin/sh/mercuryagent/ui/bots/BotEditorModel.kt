package sh.mercuryagent.ui.bots

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.coroutines.cancellation.CancellationException
import sh.mercuryagent.core.BotChanges
import sh.mercuryagent.core.BotDraft
import sh.mercuryagent.core.BotForms
import sh.mercuryagent.core.BotManifest
import sh.mercuryagent.core.BotModelRef
import sh.mercuryagent.core.BotPlan
import sh.mercuryagent.core.BotSchedule
import sh.mercuryagent.core.BotTiers
import sh.mercuryagent.core.BotWords
import sh.mercuryagent.core.CrewSpec
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.ModelCatalog
import sh.mercuryagent.core.NewBot
import sh.mercuryagent.core.addCrew
import sh.mercuryagent.core.autoCrew
import sh.mercuryagent.core.botManifest
import sh.mercuryagent.core.botPersona
import sh.mercuryagent.core.botTiers
import sh.mercuryagent.core.buildPersona
import sh.mercuryagent.core.createBot
import sh.mercuryagent.core.deleteBot
import sh.mercuryagent.core.modelCatalog
import sh.mercuryagent.core.planBot
import sh.mercuryagent.core.promoteBot
import sh.mercuryagent.core.removeBotAvatar
import sh.mercuryagent.core.runBotNow
import sh.mercuryagent.core.setBotAvatar
import sh.mercuryagent.core.setBotEnabled
import sh.mercuryagent.core.setBotPersona
import sh.mercuryagent.core.setBotTier
import sh.mercuryagent.core.startAllBots
import sh.mercuryagent.core.startBot
import sh.mercuryagent.core.stopAllBots
import sh.mercuryagent.core.stopBot
import sh.mercuryagent.core.updateBot
import sh.mercuryagent.ui.more.OwnerGate

/** The fields a bot is made of, shared by the new-bot form and a bot's Edit page (iOS: BotFields). */
data class BotFields(
  val name: String = "",
  val description: String = "",
  val persona: String = "",
  val tier: String = "readonly",
  val schedules: List<BotSchedule> = emptyList(),
  val model: BotModelRef? = null,
  val budget: String = BotForms.DEFAULT_BUDGET.toString(),
)

private inline fun <T> attempt(block: () -> T): Result<T> =
  try { Result.success(block()) } catch (e: CancellationException) { throw e } catch (e: Exception) { Result.failure(e) }

/**
 * A new bot (iOS: NewBotModel): say what it should do and Mercury drafts it (the persona builder
 * writes the instructions, the plan says one bot or a team, schedule and level are read from your
 * words), or fill it in yourself. Nothing exists until [create].
 */
@Stable
class NewBotForm(val client: MercuryClient, val existingIds: List<String>) {
  enum class Step { Describe, Form }
  enum class Busy { Drafting, Structuring, Planning, Creating }

  var step by mutableStateOf(Step.Describe)
  var ask by mutableStateOf("")
  var fields by mutableStateOf(BotFields())
  var plan by mutableStateOf<BotPlan?>(null)
  var asFleet by mutableStateOf(false)
  var crew by mutableStateOf<List<CrewSpec>>(emptyList())
  var maxCrew by mutableStateOf(6)
  var personaBefore by mutableStateOf<String?>(null)
  var busy by mutableStateOf<Busy?>(null)
  var error by mutableStateOf<String?>(null)
  var note by mutableStateOf<String?>(null)
  var createdId by mutableStateOf<String?>(null)
  var tiers by mutableStateOf(BotTiers.ids)
  var catalog by mutableStateOf<ModelCatalog?>(null)

  val id: String get() = BotForms.uniqueId(BotForms.slugify(fields.name.ifEmpty { "bot" }), existingIds)
  val problem: String? get() = BotForms.problem(fields.name, fields.persona, fields.budget, fields.schedules)

  suspend fun loadChoices() {
    attempt { client.botTiers() }.getOrNull()?.let { tiers = it }
    if (catalog == null) catalog = attempt { client.modelCatalog() }.getOrNull()
  }

  suspend fun draft() {
    val text = ask.trim()
    if (text.length < 10) { error = "Say a little more about what it should do."; return }
    busy = Busy.Drafting; error = null; note = null
    try {
      val name = BotDraft.name(text).ifEmpty { "New bot" }
      var f = fields.copy(name = name, description = BotDraft.description(text), tier = BotDraft.tier(text),
        schedules = listOfNotNull(BotDraft.schedule(text)))
      f = attempt { client.buildPersona(text, name) }.fold({ f.copy(persona = it) }, {
        note = "The persona builder didn't answer (${it.message}) so your words are its instructions. You can try again below."
        f.copy(persona = text)
      })
      fields = f
      attempt { client.planBot(f.name, f.description, f.persona) }.getOrNull()?.let { (p, max) ->
        plan = p; maxCrew = max; asFleet = p.isFleet; crew = p.crew
      }
      step = Step.Form
    } finally { busy = null }
  }

  fun manual() {
    if (fields.persona.isEmpty()) fields = fields.copy(persona = ask.trim())
    if (fields.name.isEmpty() && ask.isNotBlank()) fields = fields.copy(name = BotDraft.name(ask))
    error = null
    step = Step.Form
  }

  suspend fun structure() {
    busy = Busy.Structuring; error = null
    try {
      attempt { client.buildPersona(fields.persona, fields.name) }
        .onSuccess { personaBefore = fields.persona; fields = fields.copy(persona = it); note = null }
        .onFailure { error = it.message }
    } finally { busy = null }
  }

  fun undoStructure() { personaBefore?.let { fields = fields.copy(persona = it); personaBefore = null } }

  suspend fun askForTeam() {
    problem?.let { error = it; return }
    busy = Busy.Planning; error = null
    try {
      attempt { client.planBot(fields.name.trim(), fields.description.trim(), fields.persona.trim(), fleet = true) }
        .onSuccess { (p, max) ->
          maxCrew = max
          if (!p.isFleet || p.crew.isEmpty()) error = "Mercury couldn't design a team for this right now. Try again, or add the crew yourself."
          else { plan = p; crew = p.crew; asFleet = true }
        }
        .onFailure { error = it.message }
    } finally { busy = null }
  }

  /** Makes it: the bot (through [gate] when its level needs the owner), its crew, then its schedules. */
  suspend fun create(gate: OwnerGate): String? {
    val team = crew.filter { it.name.isNotBlank() }
    (problem ?: if (asFleet) BotForms.crewProblem(team) else null)?.let { error = it; return null }
    if (asFleet && team.isEmpty()) { error = "Add at least one crew member, or make it one bot."; return null }
    val budget = BotForms.parseBudget(fields.budget) ?: return null
    busy = Busy.Creating; error = null
    try {
      val new = NewBot(id, fields.name, fields.description, fields.persona, fields.tier, fields.model, budget)
      val made = attempt { gate.run { approval -> client.createBot(new, approval) } }.getOrElse { error = it.message; return null }
      createdId = made.id
      attempt {
        if (asFleet) {
          client.promoteBot(made.id)
          val taken = (existingIds + made.id).toMutableList()
          for (c in team) {
            val crewId = BotForms.uniqueId(BotForms.slugify(c.name), taken).also { taken += it }
            client.addCrew(made.id, c.copy(id = crewId))
          }
        }
        if (fields.schedules.isNotEmpty()) client.updateBot(made.id, BotChanges(schedules = fields.schedules.map { BotSchedule(it.name, it.cron.trim(), it.prompt.trim()) }))
      }.onFailure { error = "${made.name} was made, but not all of it: ${it.message} Finish it from its Edit page." }
      return made.id
    } finally { busy = null }
  }
}

/** A bot's Edit page (iOS: EditBotModel): only what changed is sent. */
@Stable
class EditBotForm(val client: MercuryClient, val id: String, tier: String?) {
  var bot by mutableStateOf<BotManifest?>(null)
  var persona by mutableStateOf("")
  var tier by mutableStateOf(tier)
  var fields by mutableStateOf(BotFields())
  var personaBefore by mutableStateOf<String?>(null)
  var loaded by mutableStateOf(false)
  var busy by mutableStateOf(false)
  var structuring by mutableStateOf(false)
  var avatarBusy by mutableStateOf(false)
  var error by mutableStateOf<String?>(null)
  var tiers by mutableStateOf(BotTiers.ids)
  var catalog by mutableStateOf<ModelCatalog?>(null)

  suspend fun load() {
    attempt { client.botManifest(id) to client.botPersona(id) }
      .onSuccess { (b, p) ->
        bot = b; persona = p
        fields = BotFields(b.name, b.description, p, tier ?: "readonly", b.schedules, b.model, b.dailyTokenBudget?.toString().orEmpty())
        error = null
      }
      .onFailure { error = it.message }
    loaded = true
    attempt { client.botTiers() }.getOrNull()?.let { tiers = it }
    if (catalog == null) catalog = attempt { client.modelCatalog() }.getOrNull()
  }

  val changes: BotChanges? get() = bot?.let { BotChanges.between(it, fields.name, fields.description, fields.model, fields.schedules, fields.budget) }
  val personaChanged: Boolean get() = fields.persona.trim() != persona.trim()
  val tierChanged: Boolean get() = fields.tier != (tier ?: "readonly") && fields.tier != "custom"
  val dirty: Boolean get() = (changes?.isEmpty == false) || personaChanged || tierChanged
  val problem: String? get() = BotForms.editProblem(fields.name, fields.persona, fields.budget, fields.schedules)

  suspend fun save(gate: OwnerGate): Boolean {
    problem?.let { error = it; return false }
    val changes = changes ?: return false
    busy = true; error = null
    return try {
      attempt {
        if (!changes.isEmpty) client.updateBot(id, changes)?.let { bot = it }
        if (personaChanged) { client.setBotPersona(id, fields.persona); persona = fields.persona }
        if (tierChanged) { val t = fields.tier; gate.run { a -> client.setBotTier(id, t, a) }; tier = t }
      }.onFailure { error = it.message }.isSuccess
    } finally { busy = false }
  }

  suspend fun structure() {
    structuring = true; error = null
    try {
      attempt { client.buildPersona(fields.persona, fields.name) }
        .onSuccess { personaBefore = fields.persona; fields = fields.copy(persona = it) }
        .onFailure { error = it.message }
    } finally { structuring = false }
  }

  fun undoStructure() { personaBefore?.let { fields = fields.copy(persona = it); personaBefore = null } }

  /** A photo for its face, already made a small JPEG by the caller. */
  suspend fun setAvatar(jpeg: ByteArray): Boolean {
    avatarBusy = true; error = null
    return try { attempt { client.setBotAvatar(id, jpeg) }.onFailure { error = it.message }.isSuccess } finally { avatarBusy = false }
  }

  suspend fun removeAvatar(): Boolean {
    avatarBusy = true; error = null
    return try { attempt { client.removeBotAvatar(id) }.onFailure { error = it.message }.isSuccess } finally { avatarBusy = false }
  }
}

// MARK: Managing bots from the Bots screen

enum class BotControl { RunNow, Stop, Start, TurnOn, TurnOff, MakeFleet, SuggestCrew }

/** One of a bot's controls. Returns what to tell the owner. */
suspend fun BotsViewModel.control(c: BotControl, id: String): String {
  val said = attempt {
    when (c) {
      BotControl.RunNow -> client.runBotNow(id).let { if (it.accepted) "Started a run." else BotWords.refused(it.reasonCode) }
      BotControl.Stop -> client.stopBot(id).message ?: "Stopped."
      BotControl.Start -> client.startBot(id).message ?: "Started."
      BotControl.TurnOn -> { client.setBotEnabled(id, true); "Turned on." }
      BotControl.TurnOff -> { client.setBotEnabled(id, false); "Turned off. It won't run until you turn it on." }
      BotControl.MakeFleet -> { client.promoteBot(id); "It now leads a fleet. Add crew, or let Mercury suggest some." }
      BotControl.SuggestCrew -> { client.autoCrew(id); "Mercury is designing crew for this fleet (a minute or two). They appear here as they're made." }
    }
  }.getOrElse { it.message ?: "Something went wrong." }
  load()
  return said
}

/** Deletes a bot (a lead takes its crew). Returns why it couldn't, or null. */
suspend fun BotsViewModel.delete(id: String): String? {
  val r = attempt { client.deleteBot(id) }
  load()
  return r.exceptionOrNull()?.let { it.message ?: "Couldn't delete it." }
}

/** Stop all / Start all, in words. */
suspend fun BotsViewModel.all(stop: Boolean): String {
  val r = attempt { if (stop) client.stopAllBots() else client.startAllBots() }
  load()
  return r.fold({ if (stop) "Every bot is stopped. Queued work is held until you start them." else "Every bot is started." }, { it.message ?: "Couldn't do that." })
}

/** A crew member written on the phone joins a lead's fleet. */
suspend fun BotsViewModel.addCrewMember(leadId: String, member: CrewSpec): String? {
  BotForms.crewProblem(listOf(member))?.let { return it }
  val id = BotForms.uniqueId(BotForms.slugify(member.name), ui.value.bots.map { it.id })
  val r = attempt { client.addCrew(leadId, member.copy(id = id)) }
  load()
  return r.exceptionOrNull()?.let { it.message ?: "Couldn't add it." }
}
