package sh.mercuryagent.core

import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable

/** Device tokens, encrypted at rest (Android: [KeystoreSecretStore]). */
interface SecretStore {
  fun get(account: String): String?
  fun set(account: String, value: String)
  fun remove(account: String)
}

/** Small plain records (Android: SharedPreferences). */
interface KeyValueStore {
  fun getString(key: String): String?
  fun putString(key: String, value: String?)
}

class MemorySecretStore : SecretStore {
  private val map = mutableMapOf<String, String>()
  override fun get(account: String) = map[account]
  override fun set(account: String, value: String) { map[account] = value }
  override fun remove(account: String) { map.remove(account) }
}

class MemoryKeyValueStore : KeyValueStore {
  val map = mutableMapOf<String, String>()
  override fun getString(key: String) = map[key]
  override fun putString(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}

/**
 * The phone's Mercurys and which one is active (iOS: ConnectionStore.swift). Records are plain
 * JSON in [kv]; tokens go in [secrets] under `connection:<id>`.
 */
class ConnectionStore(
  private val kv: KeyValueStore,
  private val secrets: SecretStore,
  private val makeClient: (baseUrl: String, token: String?) -> MercuryClient = { url, token -> MercuryClient(url, token) },
) {
  data class State(val connections: List<Connection> = emptyList(), val activeId: String? = null) {
    val active: Connection? get() = connections.firstOrNull { it.id == activeId }
  }

  @Serializable private data class Saved(val version: Int = 2, val connections: List<Connection> = emptyList(), val activeId: String? = null)

  private val _state = MutableStateFlow(load())
  val state: StateFlow<State> = _state.asStateFlow()
  val active: Connection? get() = _state.value.active

  private fun load(): State {
    val raw = kv.getString(KEY) ?: return State()
    val saved = runCatching { MercuryJson.decodeFromString(Saved.serializer(), raw) }.getOrNull() ?: return State()
    // Saved before friendly names and logos: each gets its logo once, kept from then on.
    val migrated = ConnectionLogos.migrate(saved.connections)
    val state = State(migrated ?: saved.connections, saved.activeId)
    if (migrated != null) kv.putString(KEY, MercuryJson.encodeToString(Saved.serializer(), Saved(2, state.connections, state.activeId)))
    return state
  }

  /** The logo a Mercury added now would get by default. */
  val nextLogo: String get() = ConnectionLogos.next(_state.value.connections)

  fun client(c: Connection): MercuryClient = makeClient(c.baseUrl, secrets.get(account(c.id)))

  /** Saves a newly paired Mercury and makes it active (with the next logo when it has none). */
  fun add(c: Connection, token: String) {
    secrets.set(account(c.id), token)
    _state.update { s ->
      val withLogo = if (c.logo == null) c.copy(logo = ConnectionLogos.next(s.connections)) else c
      State(s.connections.filter { it.id != c.id } + withLogo, c.id)
    }
    save()
  }

  fun activate(id: String) {
    _state.update { s ->
      if (s.connections.none { it.id == id }) s
      else State(s.connections.map { if (it.id == id) it.copy(lastUsedAt = Instant.now()) else it }, id)
    }
    save()
  }

  fun rename(id: String, name: String) {
    val n = name.trim().ifEmpty { return }
    _state.update { s -> s.copy(connections = s.connections.map { if (it.id == id) it.copy(name = n.take(60)) else it }) }
    save()
  }

  /** A new friendly name (ignored when blank) and logo for a saved Mercury. */
  fun update(id: String, name: String, logo: String) {
    val n = name.trim().take(60)
    _state.update { s ->
      s.copy(connections = s.connections.map {
        if (it.id != id) it
        else it.copy(name = n.ifEmpty { it.name }, logo = if (logo in ConnectionLogos.ids) logo else it.logo)
      })
    }
    save()
  }

  /** Forgets a Mercury: tells it to revoke this phone's token, then deletes the token and the record. */
  suspend fun remove(id: String) {
    val c = _state.value.connections.firstOrNull { it.id == id } ?: return
    client(c).revoke()
    secrets.remove(account(id))
    _state.update { s ->
      val rest = s.connections.filter { it.id != id }
      State(rest, if (s.activeId == id) rest.firstOrNull()?.id else s.activeId)
    }
    save()
  }

  private fun save() {
    val s = _state.value
    kv.putString(KEY, MercuryJson.encodeToString(Saved.serializer(), Saved(2, s.connections, s.activeId)))
  }

  companion object {
    const val KEY = "mercury-connections"
    fun account(id: String) = "connection:$id"
  }
}
