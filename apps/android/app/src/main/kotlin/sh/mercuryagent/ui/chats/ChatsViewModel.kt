package sh.mercuryagent.ui.chats

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ActivityEvent
import sh.mercuryagent.core.ChatThread
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.MercuryJson
import sh.mercuryagent.core.TurnsInfo
import sh.mercuryagent.data.ReadMarksStore

data class ChatsUi(
  val threads: List<ChatThread> = emptyList(),
  val status: Map<String, ChatStatus> = emptyMap(),
  val loaded: Boolean = false,
  val refreshing: Boolean = false,
  val error: String? = null,
  val query: String = "",
  /** Only saved chats (the drawer's Saved row). */
  val savedOnly: Boolean = false,
  /** Chats deleted a moment ago that Undo can still bring back (newest last). */
  val deleted: List<ChatThread> = emptyList(),
  /** The chat on screen now: never unread, whatever arrives in it. */
  val open: String? = null,
  val marks: ReadMarks? = null,
) {
  val hasSaved: Boolean get() = threads.any { it.savedAt != null }
  fun isUnread(t: ChatThread): Boolean = marks?.isUnread(t, open) ?: false
  val anyUnread: Boolean get() = threads.any(::isUnread)
}

/**
 * The conversation list and what each one is doing right now (iOS: ChatsModel.swift): seeded from
 * /api/chat/running and kept current by the /api/chat/activity stream while the screen is started.
 * One per connection; the conversation screen tells it what changed and what was seen.
 */
class ChatsViewModel(
  private val client: MercuryClient,
  /** Keeps read marks apart per Mercury (the connection's id). */
  private val scope: String,
  private val marksStore: ReadMarksStore,
  /** The app's one activity stream (ActivityMonitor): every line of /api/chat/activity. */
  private val activity: kotlinx.coroutines.flow.Flow<ActivityEvent>,
) : ViewModel() {
  private val _ui = MutableStateFlow(ChatsUi())
  val ui: StateFlow<ChatsUi> = _ui.asStateFlow()

  /** One-off messages for a snackbar: a deleted chat (with Undo), an error. */
  data class Message(val text: String, val undoDelete: ChatThread? = null)
  private val _messages = MutableSharedFlow<Message>(extraBufferCapacity = 4)
  val messages: SharedFlow<Message> = _messages

  private var listener: Job? = null
  private val pendingDeletes = mutableMapOf<String, Job>()
  private var loading: Job? = null

  init {
    viewModelScope.launch {
      val marks = marksStore.load(scope)
      _ui.update { it.copy(marks = marks) }
      load()
    }
  }

  fun setQuery(q: String) = _ui.update { it.copy(query = q) }
  fun setSavedOnly(on: Boolean) = _ui.update { it.copy(savedOnly = on) }

  /**
   * The history as the drawer shows it, grouped and filtered on a background thread and only when
   * the chats, the search or the Saved filter change (590 chats never sort during a frame).
   */
  val history: StateFlow<ChatHistory> = _ui
    .map { HistoryKey(it.threads, it.query, it.savedOnly, java.time.LocalDate.now()) }
    .distinctUntilChanged()
    .map { ChatHistory.build(it.threads, it.query, it.savedOnly) }
    .flowOn(Dispatchers.Default)
    .stateIn(viewModelScope, SharingStarted.Eagerly, ChatHistory())

  /** The day too, so the labels move on after midnight. */
  private data class HistoryKey(val threads: List<ChatThread>, val query: String, val savedOnly: Boolean, val day: java.time.LocalDate)

  fun refresh() {
    _ui.update { it.copy(refreshing = true) }
    viewModelScope.launch { load(); _ui.update { it.copy(refreshing = false) } }
  }

  suspend fun load() {
    try {
      val threads = client.threads().filter { it.id !in pendingDeletes }
      _ui.update { s ->
        s.copy(threads = threads, error = null)
      }
      updateMarks { it.prune(threads.map(ChatThread::id).toSet()) }
    } catch (e: Exception) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      _ui.update { it.copy(error = e.message) }
    }
    _ui.update { it.copy(loaded = true) }
    syncRunning()
  }

  /** Reloads soon, once, however many asks arrive together. */
  fun reload() {
    if (loading?.isActive == true) return
    loading = viewModelScope.launch { load() }
  }

  /** Which chats are working or waiting now (the stream only tells what changes after it opens). */
  suspend fun syncRunning() {
    val turns = client.runningTurns() ?: return
    _ui.update { it.copy(status = applyTurns(it.status, turns)) }
  }

  /** The activity stream, while the list is on screen (started from the screen's lifecycle). */
  fun listen() {
    if (listener?.isActive == true) return
    listener = viewModelScope.launch { activity.collect { apply(it) } }
  }

  fun stopListening() { listener?.cancel(); listener = null }

  fun apply(a: ActivityEvent) {
    _ui.update { s ->
      val status = applyActivity(s.status, a)
      val i = s.threads.indexOfFirst { it.id == a.sessionId }
      val threads = if (i >= 0 && a.kind != "done") s.threads.toMutableList().also { list ->
        val t = list[i]
        list[i] = t.copy(updatedAt = Instant.now(), title = a.title?.takeIf { it.isNotEmpty() } ?: t.title)
      } else s.threads
      s.copy(status = status, threads = threads)
    }
    if (_ui.value.threads.none { it.id == a.sessionId } || a.kind == "done") reload()
  }

  /** A chat came on screen (true), left it (false), or was seen some other way (null). */
  fun viewing(id: String, open: Boolean?) {
    val last = _ui.value.threads.firstOrNull { it.id == id }?.lastActivity ?: Instant.MIN
    updateMarks { it.markSeen(id, maxOf(Instant.now(), last)) }
    _ui.update { s ->
      when {
        open == true -> s.copy(open = id)
        open == false && s.open == id -> s.copy(open = null)
        else -> s
      }
    }
  }

  fun markAllRead() = updateMarks { it.markAllSeen(_ui.value.threads) }

  private fun updateMarks(change: (ReadMarks) -> ReadMarks) {
    val old = _ui.value.marks ?: return
    val new = change(old)
    if (new == old) return
    _ui.update { it.copy(marks = new) }
    viewModelScope.launch { marksStore.save(scope, new) }
  }

  /** Save a chat to come back to, or unsave it. Shown at once; put back if Mercury says no. */
  fun toggleSaved(t: ChatThread) {
    val was = _ui.value.threads.firstOrNull { it.id == t.id }?.savedAt
    val saving = was == null
    setSaved(t.id, if (saving) Instant.now() else null)
    viewModelScope.launch {
      try {
        val at = client.setThreadSaved(t.id, saving)
        if (saving && at != null) setSaved(t.id, at)
      } catch (e: Exception) {
        setSaved(t.id, was)
        _messages.tryEmit(Message(e.message ?: "Couldn't save that chat."))
      }
    }
  }

  private fun setSaved(id: String, at: Instant?) = _ui.update { s ->
    val threads = s.threads.map { if (it.id == id) it.copy(savedAt = at) else it }
    s.copy(threads = threads)
  }

  /** The owner's name for a chat: Mercury keeps it, whatever it would have named it. */
  fun rename(t: ChatThread, name: String) {
    val title = name.trim().take(120)
    if (title.isEmpty()) return
    viewModelScope.launch {
      try {
        val saved = client.renameThread(t.id, title)
        _ui.update { s -> s.copy(threads = s.threads.map { if (it.id == t.id) it.copy(title = saved) else it }) }
      } catch (e: Exception) {
        _messages.tryEmit(Message(e.message ?: "Couldn't rename that chat."))
      }
    }
  }

  /**
   * Gone from the list at once; deleted on Mercury after a few seconds unless Undo is pressed (the
   * drawer shows its own Undo bar; [announce] also says so in the app's snackbar).
   */
  fun delete(t: ChatThread, announce: Boolean = false) {
    _ui.update { s -> s.copy(threads = s.threads.filter { it.id != t.id }, deleted = s.deleted.filter { it.id != t.id } + t) }
    pendingDeletes[t.id]?.cancel()
    pendingDeletes[t.id] = viewModelScope.launch {
      delay(UNDO_WINDOW_MS)
      _ui.update { s -> s.copy(deleted = s.deleted.filter { it.id != t.id }) }
      runCatching { client.deleteThread(t.id) }.onFailure {
        if (it is kotlinx.coroutines.CancellationException) throw it
        _messages.tryEmit(Message(it.message ?: "Couldn't delete that chat.")); reload()
      }
      pendingDeletes.remove(t.id)
    }
    if (announce) _messages.tryEmit(Message("Chat deleted", undoDelete = t))
  }

  fun undoDelete(t: ChatThread) {
    pendingDeletes.remove(t.id)?.cancel() ?: return
    _ui.update { s ->
      val back = if (s.threads.any { it.id == t.id }) s.threads else s.threads + t
      s.copy(threads = back, deleted = s.deleted.filter { it.id != t.id })
    }
  }

  @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
  override fun onCleared() {
    // Deletes waiting out their Undo still happen.
    val ids = pendingDeletes.keys.toList()
    pendingDeletes.values.forEach { it.cancel() }
    if (ids.isNotEmpty()) kotlinx.coroutines.GlobalScope.launch { ids.forEach { runCatching { client.deleteThread(it) } } }
  }

  companion object {
    const val UNDO_WINDOW_MS = 5_000L

    /** Markers from /api/chat/running: a marker for a chat that isn't running any more goes. */
    fun applyTurns(status: Map<String, ChatStatus>, turns: TurnsInfo): Map<String, ChatStatus> {
      val running = turns.running.mapNotNull { it.sessionId ?: it.channelId }.toSet()
      val waiting = turns.waiting.mapNotNull { it.sessionId ?: it.channelId }.toSet()
      val out = status.filter { (id, s) -> !((s == ChatStatus.Working || s == ChatStatus.Waiting) && id !in running && id !in waiting) }.toMutableMap()
      for (id in running) if (out[id] !is ChatStatus.NeedsYou) out[id] = ChatStatus.Working
      for (id in waiting) if (out[id] == null) out[id] = ChatStatus.Waiting
      return out
    }

    fun applyActivity(status: Map<String, ChatStatus>, a: ActivityEvent): Map<String, ChatStatus> {
      val out = status.toMutableMap()
      when (a.kind) {
        "started", "research", "resolved" -> out[a.sessionId] = ChatStatus.Working
        "needs_you" -> out[a.sessionId] = ChatStatus.NeedsYou(a.prompt)
        "done", "stopped" -> out.remove(a.sessionId)
        "failed" -> out[a.sessionId] = ChatStatus.Failed
      }
      return out
    }
  }
}
