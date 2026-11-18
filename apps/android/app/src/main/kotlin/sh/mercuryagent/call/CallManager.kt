package sh.mercuryagent.call

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.VoiceCapabilities
import sh.mercuryagent.core.voiceCapabilities
import sh.mercuryagent.ui.conversation.ConversationViewModel

/**
 * The app's one voice call (it outlives the screens: the call keeps going in the background, held
 * by [CallService]), and what each Mercury's voice can do, asked once in a while.
 */
class CallManager(private val app: Context) {
  private val scope = MainScope()

  /** The call on screen (running, or ended and not closed yet). */
  var current by mutableStateOf<VoiceCallModel?>(null)
    private set

  /** A call is running: the microphone is its. */
  val running: Boolean get() = current?.isEnded == false

  /** Starts a call in [conversation] (or returns the one already running). The microphone is allowed. */
  fun start(conversation: ConversationViewModel, ring: sh.mercuryagent.core.RingInvite? = null): VoiceCallModel {
    current?.takeIf { !it.isEnded }?.let { return it }
    val m = VoiceCallModel(app, conversation, conversation.client, scope, onFinished = { CallService.stop(app) }, ring = ring)
    current = m
    CallService.start(app)
    m.start()
    return m
  }

  /** The call screen closed: hang up if it still runs. */
  fun close() {
    current?.end()
    current = null
  }

  private val caps = HashMap<String, Pair<Long, VoiceCapabilities>>()

  /** GET /api/mobile/voice/capabilities, kept for five minutes per Mercury. Null when it can't be asked. */
  suspend fun capabilities(client: MercuryClient, refresh: Boolean = false): VoiceCapabilities? {
    val now = System.currentTimeMillis()
    caps[client.baseUrl]?.let { (at, c) -> if (!refresh && now - at < 5 * 60_000) return c }
    val c = runCatching { client.voiceCapabilities() }.getOrNull() ?: return caps[client.baseUrl]?.second
    caps[client.baseUrl] = now to c
    return c
  }

  /** Dictation found it can't run: remember until the next refresh. */
  fun forget(client: MercuryClient) { caps.remove(client.baseUrl) }

  private val _changes = MutableStateFlow(0)

  /**
   * Bumped whenever a Mercury's voice changed (a voice key saved or removed): the mic and the call
   * button ask again ([capabilities]) instead of waiting out the five minutes.
   */
  val changes: StateFlow<Int> = _changes.asStateFlow()

  /**
   * A voice key changed on [client]'s Mercury: keep [fresh] (the save's answer) when it came with
   * one, else forget what was known, and tell everyone listening to [changes].
   */
  fun voiceChanged(client: MercuryClient, fresh: VoiceCapabilities? = null) {
    if (fresh != null) caps[client.baseUrl] = System.currentTimeMillis() to fresh else caps.remove(client.baseUrl)
    _changes.value++
  }

  private val features = HashMap<String, Pair<Long, Set<String>>>()

  /** The Mercury's api-contract features (GET /api/health), kept for five minutes. Empty when it can't be asked. */
  suspend fun features(client: MercuryClient): Set<String> {
    val now = System.currentTimeMillis()
    features[client.baseUrl]?.let { (at, f) -> if (now - at < 5 * 60_000) return f }
    val f = runCatching { client.health().features.orEmpty().toSet() }.getOrNull() ?: return features[client.baseUrl]?.second.orEmpty()
    features[client.baseUrl] = now to f
    return f
  }
}
