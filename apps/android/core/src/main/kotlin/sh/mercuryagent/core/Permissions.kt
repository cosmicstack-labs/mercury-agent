package sh.mercuryagent.core

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Ask Me / Allow All: whether Mercury asks before anything risky, or acts without asking. One
// setting for the whole Mercury, the same one Desktop's composer picker and status bar switch
// (apps/desktop/src/app/permission.ts is the reference; iOS: MercuryCore/Permissions.swift).

enum class PermissionMode(val wire: String, val title: String, val detail: String) {
  ASK_ME("ask-me", "Ask Me", "Mercury asks before anything risky"),
  ALLOW_ALL("allow-all", "Allow All", "Mercury acts without asking");

  val allowAll: Boolean get() = this == ALLOW_ALL

  companion object {
    fun of(allowAll: Boolean): PermissionMode = if (allowAll) ALLOW_ALL else ASK_ME
    fun fromWire(s: String?): PermissionMode? = entries.firstOrNull { it.wire == s }

    /** GET/PUT /api/chat/settings: `permissionMode` when the Mercury sends it, else `bypassPermissions`. */
    fun decode(body: String): PermissionMode? {
      val j = parseObject(body)
      return fromWire(j.str("permissionMode")) ?: j.bool("bypassPermissions")?.let(::of)
    }

    /** The runtime's live `status` event (`permission: "allow-all" | "ask-me"`), null when it doesn't say. */
    fun fromStatus(raw: String): PermissionMode? = fromWire(parseObject(raw).str("permission"))
  }
}

/** GET /api/chat/settings: Ask Me or Allow All. */
suspend fun MercuryClient.permissionMode(): PermissionMode {
  val j = json(request("GET", "/api/chat/settings"))
  return PermissionMode.decode(j.toString()) ?: throw MercuryException.Server(200, "Mercury didn't say how it asks.")
}

/**
 * PUT /api/chat/settings { bypassPermissions }. A current Mercury switches at once for a paired
 * device; an older one answers 428 for Allow All ([MercuryException.NeedsOwner]: run it through an
 * OwnerGate, [approval] then carries the owner's go-ahead). Returns the mode Mercury now has.
 */
suspend fun MercuryClient.setPermissionMode(mode: PermissionMode, approval: String? = null): PermissionMode {
  val j = json(gated("PUT", "/api/chat/settings", buildJsonObject { put("bypassPermissions", mode.allowAll) }, approval))
  return PermissionMode.decode(j.toString()) ?: mode
}

/** What the composer shows: the mode (null until Mercury has said), a switch on its way, why the last one failed. */
data class PermissionState(val mode: PermissionMode? = null, val saving: Boolean = false, val error: String? = null) {
  val allowAll: Boolean get() = mode == PermissionMode.ALLOW_ALL
}

/**
 * Ask Me / Allow All for the composer (iOS: PermissionModel). Reads Mercury's setting when the
 * screen appears, switches optimistically and puts it back with a message when Mercury refuses,
 * and follows the runtime's live `status` events so a change made anywhere shows here too.
 */
class PermissionSwitch(
  private val load: suspend () -> PermissionMode,
  private val save: suspend (PermissionMode) -> PermissionMode,
) {
  private val _state = MutableStateFlow(PermissionState())
  val state: StateFlow<PermissionState> = _state.asStateFlow()
  /** Bumped by every switch and live update, so a late answer can't undo a newer one. */
  private var version = 0

  /** Reads the setting (the screen appeared). Keeps what's known when Mercury can't be asked. */
  suspend fun refresh() {
    val v = version
    val m = try { load() } catch (e: CancellationException) { throw e } catch (e: Exception) { return }
    if (v == version && !_state.value.saving) _state.update { it.copy(mode = m) }
  }

  /** Switches now, then confirms with Mercury; on failure puts the old mode back and says why. */
  suspend fun set(next: PermissionMode) {
    val before = _state.value.mode
    if (next == before) return
    val v = ++version
    _state.value = PermissionState(mode = next, saving = true)
    try {
      val now = save(next)
      if (v == version) _state.value = PermissionState(mode = now)
    } catch (e: CancellationException) {
      if (v == version) _state.value = PermissionState(mode = before)
      throw e
    } catch (e: Exception) {
      if (v == version) _state.value = PermissionState(mode = before, error = "Couldn't switch to ${next.title}: ${e.message ?: "something went wrong."}")
    }
  }

  /** The runtime's live `status` event: a change made anywhere. */
  fun applyStatus(raw: String) {
    val m = PermissionMode.fromStatus(raw) ?: return
    if (_state.value.saving) return
    version++
    _state.update { it.copy(mode = m) }
  }

  fun dismissError() = _state.update { it.copy(error = null) }

  /** Previews and tests: a known mode, no Mercury. */
  fun show(mode: PermissionMode?) = _state.update { it.copy(mode = mode) }
}
