package sh.mercuryagent.ui.bots

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.mercuryagent.core.BotActivityEvent
import sh.mercuryagent.core.BotApproval
import sh.mercuryagent.core.BotFleet
import sh.mercuryagent.core.BotInboxEntry
import sh.mercuryagent.core.BotRosterLayout
import sh.mercuryagent.core.BotRunRecord
import sh.mercuryagent.core.BotRunTranscript
import sh.mercuryagent.core.BotStatus
import sh.mercuryagent.core.BotStreamEvent
import sh.mercuryagent.core.LiveRuns
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.MercuryException
import sh.mercuryagent.core.answerBot
import sh.mercuryagent.core.botActivity
import sh.mercuryagent.core.botApprovals
import sh.mercuryagent.core.botEvents
import sh.mercuryagent.core.botInbox
import sh.mercuryagent.core.botJournal
import sh.mercuryagent.core.botRun
import sh.mercuryagent.core.bots
import sh.mercuryagent.core.markBotInboxRead
import sh.mercuryagent.core.messageBot

/** Everything the Bots screens show (iOS: BotsModel). */
data class BotsUi(
  val bots: List<BotStatus> = emptyList(),
  val available: Boolean = true,
  val unread: Int = 0,
  val approvals: List<BotApproval> = emptyList(),
  /** Recent bot events, oldest first, capped ([LiveRuns.CAP]). */
  val live: List<BotActivityEvent> = emptyList(),
  /** What each running bot is doing right now, in a few words (the roster's subtitle). */
  val activity: Map<String, String> = emptyMap(),
  val loaded: Boolean = false,
  val refreshing: Boolean = false,
  val error: String? = null,
  /** Bumped when an inbox entry arrives, so open inbox lists reload. */
  val inboxVersion: Int = 0,
  /** A clock (ms) for elapsed times, "ended" runs and how long questions wait. */
  val now: Double = System.currentTimeMillis().toDouble(),
) {
  val layout: Pair<List<BotFleet>, List<BotStatus>> by lazy { BotRosterLayout.organise(bots) }
  val running: Set<String> get() = bots.filter { it.isRunning }.map { it.id }.toSet()
  fun bot(id: String): BotStatus? = bots.firstOrNull { it.id == id }

  /** A fleet's members (lead first), or just the bot. */
  fun members(leadId: String): List<BotStatus> =
    layout.first.firstOrNull { it.lead.id == leadId }?.members ?: listOfNotNull(bot(leadId))
}

/**
 * The Bots screen's state: the roster, the questions waiting, and a capped log of what the bots are
 * doing. One stream (/api/bots/events) feeds every Bots sub-screen while the screen is started
 * ([start]/[stop], tied to the lifecycle); sub-screens filter what they show.
 */
class BotsViewModel(val client: MercuryClient) : ViewModel() {
  private val _ui = MutableStateFlow(BotsUi())
  val ui: StateFlow<BotsUi> = _ui.asStateFlow()

  /** One-off messages for the snackbar. */
  private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
  val messages: SharedFlow<String> = _messages

  private var listener: Job? = null
  private var clock: Job? = null
  private var rosterReload: Job? = null
  /** The bots whose feed is open: reloaded after the stream reconnects. */
  private var watching: List<String> = emptyList()

  init {
    viewModelScope.launch { load() }
  }

  // MARK: Loading

  suspend fun load() {
    try {
      val r = client.bots()
      _ui.update { it.copy(bots = r.bots, available = r.available, unread = r.unread ?: it.unread, error = null) }
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      _ui.update { it.copy(error = e.message ?: "Couldn't load the bots.") }
    }
    _ui.update { it.copy(loaded = true) }
    loadApprovals()
  }

  fun refresh() {
    _ui.update { it.copy(refreshing = true) }
    viewModelScope.launch {
      load()
      if (watching.isNotEmpty()) loadActivity(watching)
      _ui.update { it.copy(refreshing = false) }
    }
  }

  suspend fun loadApprovals() {
    quietly { client.botApprovals() }?.let { a -> _ui.update { it.copy(approvals = a) } }
  }

  /** The recent past of some bots' feed (a fleet: all of its members), merged into the log. */
  suspend fun loadActivity(ids: List<String>) {
    watching = ids
    quietly { client.botActivity(ids) }?.let { add(it) }
  }

  private fun add(events: List<BotActivityEvent>) = _ui.update { it.copy(live = LiveRuns.merge(it.live, events)) }

  // MARK: The stream, while the screen is started

  fun start() {
    if (listener?.isActive != true) {
      listener = viewModelScope.launch { client.botEvents().collect { handle(it) } }
    }
    if (clock?.isActive != true) {
      clock = viewModelScope.launch {
        while (true) {
          _ui.update { it.copy(now = System.currentTimeMillis().toDouble()) }
          delay(15_000)
        }
      }
    }
    // Back from the background: catch up.
    viewModelScope.launch { load(); if (watching.isNotEmpty()) loadActivity(watching) }
  }

  fun stop() {
    listener?.cancel(); listener = null
    clock?.cancel(); clock = null
  }

  /** Ticks the clock now (a sub-screen opened). */
  fun tick() = _ui.update { it.copy(now = System.currentTimeMillis().toDouble()) }

  private fun handle(e: BotStreamEvent) {
    when (e) {
      is BotStreamEvent.Roster -> {
        _ui.update { it.copy(bots = e.bots, loaded = true) }
        // Sent on every (re)connect: catch up on what happened while the stream was down.
        val ids = watching
        viewModelScope.launch { loadApprovals(); if (ids.isNotEmpty()) loadActivity(ids) }
      }
      is BotStreamEvent.Activity -> {
        val ev = e.event
        add(listOf(ev))
        if (ev.kind == "thinking" || ev.kind == "queued") return
        _ui.update { u -> u.copy(activity = if (ev.kind == "turn-end") u.activity - ev.botId else u.activity + (ev.botId to ev.label)) }
        if (ev.kind == "turn-end" || ev.kind == "turn-start") reloadRoster()
      }
      BotStreamEvent.ApprovalsChanged -> viewModelScope.launch { loadApprovals() }
      is BotStreamEvent.Inbox -> {
        _ui.update { it.copy(inboxVersion = it.inboxVersion + 1) }
        reloadRoster()
      }
    }
  }

  /** The roster (states, unread counts) after a run starts or ends; bursts reload once. */
  private fun reloadRoster() {
    rosterReload?.cancel()
    rosterReload = viewModelScope.launch {
      delay(400)
      quietly { client.bots() }?.let { r -> _ui.update { it.copy(bots = r.bots, unread = r.unread ?: it.unread) } }
      loadApprovals()
    }
  }

  // MARK: Talking to bots

  /** Messages a bot. Returns why it wasn't sent, or null. A message to a busy bot shows as queued at once. */
  suspend fun send(text: String, to: String): String? {
    val t = text.trim()
    if (t.isEmpty()) return null
    return try {
      val r = client.messageBot(to, t)
      if (!r.accepted) {
        return if (r.reasonCode == "target_disabled") "That bot is off. Turn it on to message it."
        else "Not sent (${(r.reasonCode ?: "refused").replace('_', ' ')})."
      }
      val job = r.jobId
      val u = _ui.value
      if (job != null && u.live.none { it.jobId == job }) {
        val busy = u.bot(to)?.isRunning == true
        add(listOf(BotActivityEvent(
          botId = to, jobId = job, kind = "queued", label = if (busy) "Queued: runs when the current run finishes" else "Starting",
          stepIndex = 0, at = System.currentTimeMillis().toDouble(), botName = u.bot(to)?.name, trigger = "api", prompt = t,
        )))
      }
      null
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      e.message ?: "Couldn't send it."
    }
  }

  /** Answers a bot's question. The buttons go at once; a question that already went says why. */
  suspend fun answer(a: BotApproval, value: String): String? {
    _ui.update { u -> u.copy(approvals = u.approvals.filter { it.id != a.id }) }
    return try {
      client.answerBot(a.id, value)
      null
    } catch (e: CancellationException) {
      throw e
    } catch (e: MercuryException.Server) {
      if (e.code == 409) e.message ?: "That question is no longer waiting." else e.message
    } catch (e: Exception) {
      e.message ?: "Couldn't answer."
    } finally {
      viewModelScope.launch { loadApprovals() }
    }
  }

  /** The same, from a button: a problem goes to the snackbar. */
  fun answerFromUi(a: BotApproval, value: String) {
    viewModelScope.launch { answer(a, value)?.let { _messages.tryEmit(it) } }
  }

  // MARK: Inbox

  /** Some bots' inbox (a fleet: each member's, merged), or every bot's when [botIds] is null; newest first. */
  suspend fun inbox(botIds: List<String>?, unreadOnly: Boolean): List<BotInboxEntry>? {
    val wanted: List<String?> = botIds ?: listOf(null)
    var any = false
    val all = mutableListOf<BotInboxEntry>()
    for (id in wanted) {
      quietly { client.botInbox(bot = id, unreadOnly = unreadOnly, limit = 200) }?.let { all += it.entries; any = true }
    }
    loadApprovals()
    return if (any || wanted.isEmpty()) all.sortedByDescending { it.at } else null
  }

  fun markRead(ids: List<String>?) {
    viewModelScope.launch {
      quietly { client.markBotInboxRead(ids) }?.let { left -> _ui.update { it.copy(unread = left) } }
      reloadRoster()
    }
  }

  // MARK: History

  /** Every finished run of these bots, newest first. */
  suspend fun history(members: List<String>): List<BotRunRecord> {
    val all = mutableListOf<BotRunRecord>()
    for (id in members) quietly { client.botJournal(id, 60) }?.let { all += it }
    return all.sortedByDescending { it.startedAt }
  }

  suspend fun transcript(run: BotRunRecord): Result<BotRunTranscript> =
    try {
      Result.success(client.botRun(run.botId, run.runId, fallback = run))
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Result.failure(e)
    }

  fun say(text: String) { _messages.tryEmit(text) }

  private suspend fun <T> quietly(block: suspend () -> T): T? =
    try { block() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }

  override fun onCleared() { stop() }
}
