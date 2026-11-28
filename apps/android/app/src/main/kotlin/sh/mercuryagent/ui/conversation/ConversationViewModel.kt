package sh.mercuryagent.ui.conversation

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import sh.mercuryagent.core.ServerEvent
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import sh.mercuryagent.core.AttachmentProblem
import sh.mercuryagent.core.ChatEffort
import sh.mercuryagent.core.ChatMessage
import sh.mercuryagent.core.ChatModelInfo
import sh.mercuryagent.core.ChatThread
import sh.mercuryagent.core.MediaAvailability
import sh.mercuryagent.core.MediaIntent
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.permissionMode
import sh.mercuryagent.core.setPermissionMode
import sh.mercuryagent.core.OutgoingAttachment
import sh.mercuryagent.core.SentAttachment
import sh.mercuryagent.core.Suggestion
import sh.mercuryagent.core.SuggestionPick
import sh.mercuryagent.core.chatModel
import sh.mercuryagent.core.mediaAvailability
import sh.mercuryagent.core.modelCatalog
import sh.mercuryagent.core.switchModel
import sh.mercuryagent.core.setEffort
import sh.mercuryagent.core.suggestionUsed
import sh.mercuryagent.core.suggestions

/** The composer's settings for the next message (iOS: ConversationModel's composer part). */
data class ComposerState(
  /** The Create switch for the next message (image, video or music). */
  val media: MediaIntent? = null,
  val model: ChatModelInfo? = null,
  val mediaAvailable: MediaAvailability? = null,
  /** An effort picked before the chat existed: applied when it's created. */
  val pendingEffort: String? = null,
  /**
   * Code (the top bar's Ask | Code): each message is a coding turn (POST /api/chat/send
   * `programming: "auto"`: Mercury plans or executes, works with files and commands, verifies), in
   * Mercury's project folder (`cwd`, from GET /api/workspace/info), as Mercury Desktop's Code view
   * sends it. Ask is a normal chat.
   */
  val code: Boolean = false,
  /** The folder Code works in (null until loaded, or on an older runtime). */
  val workspace: sh.mercuryagent.core.WorkspaceInfo? = null,
  /** The models Mercury offers and which runs (the composer's model pill). */
  val catalog: sh.mercuryagent.core.ModelCatalog? = null,
  /** A model switch is on its way. */
  val switching: Boolean = false,
) {
  /** The chat's own effort, shown as a chip (only when the model takes efforts). */
  val ownEffort: String?
    get() {
      val e = model?.effort ?: return null
      if (e.source != "chat" || model.reasoningLevels.isNullOrEmpty()) return null
      return e.chat
    }
}

/** A new chat's welcome: the runtime's greeting and ideas, refreshed on "More ideas". */
data class WelcomeState(val pick: SuggestionPick? = null, val round: Int = 0)

/**
 * One conversation: its messages, the turn as it happens, the questions it waits on, and the
 * composer (iOS: ConversationModel.swift). Events go through [ConversationEvents.reduce].
 *
 * Extension points for later phases: [attachments] (the attach button), dictation into [draft],
 * a voice call ([callId]: what's sent is said on that call), media intents in [send].
 */
class ConversationViewModel(
  val client: MercuryClient,
  thread: ChatThread?,
  /** Something the list shows changed (a reply, a title, saved). */
  private val onChange: () -> Unit = {},
  /** A new chat got its id on Mercury (the app remembers it as the last chat). */
  private val onCreated: (id: String) -> Unit = {},
  /** A message went out (the app may ask for notifications the first time). */
  private val onSent: () -> Unit = {},
  /** This chat was seen: on screen (true), left (false), or seen without a screen (null). */
  private val onSeen: (id: String, open: Boolean?) -> Unit = { _, _ -> },
) : ViewModel() {
  private val _ui = MutableStateFlow(ConversationState(threadId = thread?.id, title = thread?.displayTitle ?: "New chat", savedAt = thread?.savedAt))
  val ui: StateFlow<ConversationState> = _ui.asStateFlow()

  /** The composer's text. */
  val draft = TextFieldState()
  /** Files to send with the next message. */
  val attachments = MutableStateFlow<List<OutgoingAttachment>>(emptyList())
  val composer = MutableStateFlow(ComposerState())
  val welcome = MutableStateFlow(WelcomeState())
  /** The owner's go-ahead for a change an older Mercury gates (Allow All). */
  val gate = sh.mercuryagent.ui.more.OwnerGate(client)
  /** Ask Me / Allow All: the model sheet's Permissions and the indicator by the model pill. */
  val permissions = sh.mercuryagent.core.PermissionSwitch(
    load = { client.permissionMode() },
    save = { m -> gate.run { approval -> client.setPermissionMode(m, approval) } },
  )
  /** Set while a voice call runs in this conversation: what's sent is said on that call. */
  var callId: String? = null
  /** A voice call listens for each turn's end (with its reply, when there was one). */
  var onTurnEnd: ((ChatMessage?) -> Unit)? = null

  private var listener: Job? = null
  private var stopFallback: Job? = null
  private var titleCheck: Job? = null
  private var onScreen = false
  /** One new chat per conversation: concurrent sends wait for the same POST /api/chat/threads. */
  private val creating = Mutex()
  /** Messages on their way (text as typed): the same one again before it lands is a double send. */
  private val inFlight = mutableSetOf<String>()

  init {
    viewModelScope.launch { load() }
    viewModelScope.launch { loadComposerInfo() }
    viewModelScope.launch { loadModels() }
    if (thread == null) viewModelScope.launch { loadSuggestions() }
  }

  private val id: String? get() = _ui.value.threadId

  suspend fun load() {
    val id = id ?: run { _ui.update { it.copy(loaded = true) }; return }
    try {
      val t = client.thread(id)
      _ui.update { it.withMessages(t.messages).copy(title = t.displayTitle, savedAt = t.savedAt, error = null) }
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      _ui.update { it.copy(error = e.message) }
    }
    _ui.update { it.copy(loaded = true) }
    listen()
    catchUp(id)
  }

  /** What happened while this screen wasn't watching: questions, the plan, a place in line, the live reply. */
  private suspend fun catchUp(id: String) {
    val pending = viewModelScope.async { client.pendingPrompts(id) }
    val plan = viewModelScope.async { client.plan(id) }
    val queue = viewModelScope.async { client.queuePosition(id) }
    val snap = viewModelScope.async { client.liveTurn(id) }
    val jobs = viewModelScope.async { client.mediaJobs(id) }
    for (e in pending.await()) handle(e.name, e.data)
    plan.await()?.let { p -> _ui.update { it.copy(plan = p) } }
    queue.await()?.let { q -> _ui.update { it.copy(queued = q, agent = if (it.agent == Agent.Idle) Agent.Thinking else it.agent) } }
    snap.await()?.let { s -> _ui.update { it.restore(s) } }
    val j = jobs.await()
    _ui.update { it.copy(pendingMedia = j) }
  }

  private fun listen() {
    val id = id ?: return
    listener?.cancel()
    listener = viewModelScope.launch {
      client.events("/api/chat/events?sessionId=${MercuryClient.q(id)}").collect { handle(it.name, it.data) }
    }
  }

  /**
   * Re-read the chat and its running turn: a reply that finished while nobody watched (the app in
   * the background, the screen locked, the stream dropped) and whether a turn still runs or waits.
   */
  private suspend fun resync() {
    val id = id ?: return
    val t = try { client.thread(id) } catch (e: Exception) { if (e is CancellationException) throw e; return }
    if (this.id != id) return
    _ui.update { it.withMessages(t.messages).copy(title = t.displayTitle, savedAt = t.savedAt, queued = null) }
    catchUp(id)
  }

  fun handle(event: String, raw: String) {
    if (event == ServerEvent.RECONNECTED) { viewModelScope.launch { resync() }; return }
    // The runtime's live status: Ask Me / Allow All changed anywhere (Desktop, a terminal, a phone).
    if (event == "status") permissions.applyStatus(raw)
    val r = ConversationEvents.reduce(_ui.value, event, raw)
    _ui.value = r.state
    if (r.changed) onChange()
    if (r.turnEnded) {
      stopFallback?.cancel()
      onChange()
      // A chat open on screen has been read, whatever just landed in it.
      if (onScreen || callId != null) id?.let { onSeen(it, null) }
      refreshTitle()
      onTurnEnd?.invoke(r.reply)
    }
  }

  // MARK: Sending

  fun send() {
    val text = draft.text.toString().trim()
    val files = attachments.value
    if (text.isEmpty() && files.isEmpty()) return
    // One tap is one message: the same words again while the first is still on its way (a second
    // tap, a suggestion picked again while a slow new chat is created) are dropped, not sent twice.
    if (files.isEmpty() && text in inFlight) { draft.clearText(); return }
    // The Create switch is for a real ask: never a command or a voice call.
    val keptMedia = composer.value.media
    val intent = if (callId == null && text.isNotEmpty() && !text.startsWith("/") && !text.startsWith("#")) keptMedia else null
    draft.clearText(); attachments.value = emptyList(); composer.update { it.copy(media = null) }
    viewModelScope.launch {
      if (submit(text, files, intent) != null) {
        if (draft.text.isEmpty()) draft.setTextAndPlaceCursorAtEnd(text)
        attachments.value = files
        composer.update { it.copy(media = keptMedia) }
      }
    }
  }

  /** A voice call's question (CallChat): sent as typed, leaving the box alone. The error, or null. */
  suspend fun sendSpoken(text: String): String? = submit(text.trim(), emptyList(), null)

  /** Sends one message (creating the chat first when it's new). Returns the error, or null when it went. */
  private suspend fun submit(text: String, files: List<OutgoingAttachment>, intent: MediaIntent?): String? {
    if (text.isEmpty() && files.isEmpty()) return "Nothing to send."
    val shown = text.ifEmpty { "(Attached: ${files.joinToString(", ") { it.name }})" }
    val optimistic = ChatMessage(
      role = "user", content = shown, timestamp = Instant.now(),
      attachments = files.map { SentAttachment(it.name, if (it.mime.startsWith("image/")) "image" else "document", it.mime) },
    )
    // Shown at once, before the chat exists: the welcome and its ideas go away, so nothing invites
    // a second tap while a slow POST /api/chat/threads runs (the vivo made two chats that way).
    _ui.update {
      it.copy(messages = it.messages + optimistic, agent = Agent.Thinking, live = TurnTrace(), stopping = false, notice = null, error = null)
    }
    if (files.isEmpty()) inFlight += text
    try {
      val tid = ensureThread()
      val coding = composer.value.code && callId == null
      if (coding && composer.value.workspace == null) loadWorkspace()
      client.sendMessage(
        text, tid, files, media = intent, voiceCall = callId,
        programming = if (coding) "auto" else null, cwd = if (coding) composer.value.workspace?.cwd else null,
      )
      onChange()
      onSent()
      return null
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      _ui.update {
        it.copy(
          // A call says its own errors out loud; the chat shows the rest.
          error = if (callId == null) e.message else it.error, messages = it.messages.filter { m -> m.id != optimistic.id },
          live = if (it.live?.hasProcess == true) it.live else null,
          agent = if (it.live?.hasProcess == true) it.agent else Agent.Idle,
        )
      }
      return e.message ?: "The message didn't go."
    } finally {
      if (files.isEmpty()) inFlight -= text
    }
  }

  /** This chat's id, creating it on Mercury first when it's new: once, however many sends race here. */
  private suspend fun ensureThread(): String = creating.withLock {
    id?.let { return@withLock it }
    val t = client.createThread()
    _ui.update { it.copy(threadId = t.id) }
    // A chat you start yourself is never "new" in the list.
    onSeen(t.id, if (onScreen) true else null)
    onCreated(t.id)
    listen()
    composer.value.pendingEffort?.let { e ->
      composer.update { it.copy(pendingEffort = null) }
      runCatching { client.setEffort(t.id, e) }
    }
    t.id
  }

  /**
   * Stop: what was running shows as stopped at once, this chat's turn is asked to stop (others keep
   * running), and the turn ends when the runtime confirms, or after a few seconds if it never does.
   */
  fun stop() {
    val id = id ?: return
    if (_ui.value.stopping) return
    _ui.update { it.copy(stopping = true, live = it.live?.markStopped()) }
    viewModelScope.launch {
      try {
        client.stop(id)
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(stopping = false, error = e.message) }
        return@launch
      }
      stopFallback?.cancel()
      stopFallback = viewModelScope.launch {
        delay(8_000)
        if (_ui.value.stopping) {
          val r = ConversationEvents.finishStopped(_ui.value)
          _ui.value = r.state
          onChange()
        }
      }
    }
  }

  fun answer(p: Prompt, value: String) {
    viewModelScope.launch {
      try {
        client.answer(p.id, value, p.targetId)
        _ui.update { it.copy(prompts = it.prompts.filter { q -> q.id != p.id }) }
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      }
    }
  }

  /** Answers a question the turn waits on, now (a call's approval). Throws when Mercury can't be reached. */
  suspend fun answerPrompt(id: String, targetId: String?, value: String) {
    client.answer(id, value, targetId)
    _ui.update { it.copy(prompts = it.prompts.filter { q -> q.id != id }) }
  }

  fun rename(name: String) {
    val t = name.trim().take(120)
    val id = id ?: return
    if (t.isEmpty()) return
    viewModelScope.launch {
      try {
        val saved = client.renameThread(id, t)
        _ui.update { it.copy(title = saved) }
        onChange()
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      }
    }
  }

  /** Save this chat to come back to, or unsave it (the same bookmark as the list's and Desktop's). */
  fun toggleSaved() {
    val id = id ?: return
    val was = _ui.value.savedAt
    val saving = was == null
    _ui.update { it.copy(savedAt = if (saving) Instant.now() else null) }
    viewModelScope.launch {
      try {
        val at = client.setThreadSaved(id, saving)
        if (saving && at != null) _ui.update { it.copy(savedAt = at) }
        onChange()
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(savedAt = was, error = e.message) }
      }
    }
  }

  /** Deletes this chat on Mercury; [done] runs once it's gone. */
  fun delete(done: () -> Unit) {
    val id = id ?: return
    viewModelScope.launch {
      try {
        client.deleteThread(id)
        onChange()
        done()
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      }
    }
  }

  // MARK: Composer

  fun setMedia(m: MediaIntent?) = composer.update { it.copy(media = m) }

  /** Ask (a chat) or Code (coding turns in Mercury's project folder), for the messages from now on. */
  fun setCode(on: Boolean) {
    composer.update { it.copy(code = on) }
    if (on && composer.value.workspace == null) viewModelScope.launch { loadWorkspace() }
  }

  /** Mercury's project folder, for Code (quietly nothing on an older runtime). */
  suspend fun loadWorkspace() {
    val w = client.workspaceInfo() ?: return
    composer.update { it.copy(workspace = w) }
  }

  /** The model pill's list: every model Mercury offers, the current one, the default ("Auto"). */
  suspend fun loadModels() {
    val c = runCatching { client.modelCatalog(id) }.getOrNull() ?: return
    composer.update { it.copy(catalog = c) }
  }

  /**
   * Switches Mercury's model ([pick] null: back to the configured default, "Auto"). Mercury has
   * one model for every chat, so this changes it everywhere; the sheet says so.
   */
  fun pickModel(pick: sh.mercuryagent.core.ModelChoice?) {
    val c = composer.value.catalog ?: return
    val (provider, model) = sh.mercuryagent.core.ModelMenu.target(c, pick) ?: return
    composer.update { it.copy(switching = true) }
    viewModelScope.launch {
      try {
        client.switchModel(provider, model)
        loadModels()
        loadComposerInfo()
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      } finally {
        composer.update { it.copy(switching = false) }
      }
    }
  }

  /** Reads Ask Me / Allow All again (the screen appeared, or the app came back). */
  fun refreshPermissions() { viewModelScope.launch { permissions.refresh() } }

  /** Ask Me or Allow All, at once; put back with a message when Mercury refuses. */
  fun setPermission(mode: sh.mercuryagent.core.PermissionMode) { viewModelScope.launch { permissions.set(mode) } }

  /** The model's efforts and which media this Mercury can make, for the composer's sheet. */
  suspend fun loadComposerInfo() {
    val m = runCatching { client.chatModel(id) }.getOrNull()
    val a = runCatching { client.mediaAvailability() }.getOrNull()
    composer.update { c ->
      val model = m?.let { mm -> c.pendingEffort?.let { mm.copy(effort = ChatEffort.withPending(mm.currentEffort, it)) } ?: mm }
      c.copy(model = model ?: c.model, mediaAvailable = a ?: c.mediaAvailable)
    }
  }

  /** This chat's thinking effort: a level, "auto", or null for the model's default. */
  fun setEffort(level: String?) {
    val id = id
    if (id == null) {
      composer.update { c ->
        val m = c.model
        val shown = m?.let {
          if (level != null) ChatEffort.withPending(it.currentEffort, level)
          else ChatEffort(it.currentEffort.modelDefault, "model", it.currentEffort.modelDefault, null)
        }
        c.copy(pendingEffort = level, model = m?.copy(effort = shown))
      }
      return
    }
    viewModelScope.launch {
      try {
        client.setEffort(id, level)?.let { e -> composer.update { c -> c.copy(model = c.model?.copy(effort = e)) } }
        runCatching { client.chatModel(id) }.getOrNull()?.let { m -> composer.update { it.copy(model = m) } }
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      }
    }
  }

  /** Adds a file to the next message, or says why it can't go. */
  fun attach(name: String, data: ByteArray) {
    if (attachments.value.size >= OutgoingAttachment.MAX_FILES) { _ui.update { it.copy(error = AttachmentProblem.TooMany().message) }; return }
    OutgoingAttachment.make(name, data)
      .onSuccess { a -> attachments.update { it + a } }
      .onFailure { e -> _ui.update { it.copy(error = e.message) } }
  }

  fun removeAttachment(id: String) = attachments.update { list -> list.filter { it.id != id } }

  fun showError(message: String) = _ui.update { it.copy(error = message) }

  // MARK: Welcome

  suspend fun loadSuggestions() {
    val p = runCatching { client.suggestions(4) }.getOrNull() ?: return
    welcome.update { WelcomeState(p, it.round + 1) }
  }

  fun moreSuggestions() { viewModelScope.launch { loadSuggestions() } }

  /** A suggestion goes into the box (to send or edit) and leaves the pool. */
  fun useSuggestion(s: Suggestion) {
    draft.setTextAndPlaceCursorAtEnd(s.prompt)
    viewModelScope.launch { client.suggestionUsed(s.id) }
  }

  /** Puts a message of yours back in the box to change and send again. */
  fun edit(text: String) = draft.setTextAndPlaceCursorAtEnd(text)

  fun dismissError() = _ui.update { it.copy(error = null) }
  fun dismissNotice() = _ui.update { it.copy(notice = null) }

  /** The screen came into view or left it: the list marks the chat read. */
  fun setOnScreen(visible: Boolean) {
    val back = visible && !onScreen && _ui.value.loaded
    onScreen = visible
    id?.let { onSeen(it, visible) }
    // Back from another app or a locked screen: the stream may have died quietly and the reply may
    // have finished meanwhile, so connect again and re-read the chat.
    if (back && id != null) { listen(); viewModelScope.launch { resync() } }
  }

  /**
   * Mercury names a thread from its first message, then again in the background once the first
   * answer is in (no event says so), so look a few times after a turn.
   */
  private fun refreshTitle() {
    val id = id ?: return
    titleCheck?.cancel()
    titleCheck = viewModelScope.launch {
      for (wait in listOf(500L, 4_000L, 10_000L)) {
        delay(wait)
        val t = runCatching { client.threads().firstOrNull { it.id == id } }.getOrNull() ?: continue
        if (t.displayTitle != _ui.value.title) { _ui.update { it.copy(title = t.displayTitle) }; onChange() }
      }
    }
  }

  override fun onCleared() { listener?.cancel() }
}
