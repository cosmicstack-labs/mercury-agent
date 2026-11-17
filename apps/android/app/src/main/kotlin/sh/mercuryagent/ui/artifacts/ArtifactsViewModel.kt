package sh.mercuryagent.ui.artifacts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ArtifactCleanup
import sh.mercuryagent.core.ArtifactGroup
import sh.mercuryagent.core.ArtifactItem
import sh.mercuryagent.core.ArtifactUsage
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.artifactUsage
import sh.mercuryagent.core.artifacts
import sh.mercuryagent.core.deleteArtifact
import sh.mercuryagent.core.deleteArtifacts

/** One filter tab: the kind the server filters by, and its label. */
data class ArtifactKind(val value: String, val label: String)

/** What the Artifacts screen shows (iOS: ArtifactsModel). */
data class ArtifactsUi(
  val items: List<ArtifactItem> = emptyList(),
  /** Cards: batches (images made together) are one. */
  val groups: List<ArtifactGroup> = emptyList(),
  val counts: Map<String, Int> = emptyMap(),
  val kind: String = "all",
  val query: String = "",
  val next: String? = null,
  val loaded: Boolean = false,
  val refreshing: Boolean = false,
  val loadingMore: Boolean = false,
  val error: String? = null,
  /** Space taken, as the server counts it (the overflow menu and Clean up). */
  val usage: ArtifactUsage? = null,
  /** A list of rows instead of the grid of cards. */
  val listMode: Boolean = false,
  /** Select mode: ticked artifact ids (a batch ticks all of its own). */
  val picking: Boolean = false,
  val picked: Set<String> = emptySet(),
  val deleting: Boolean = false,
  val cleanup: CleanupUi = CleanupUi(),
) {
  /** Same tabs as Mercury Desktop; a kind shows once there is something in it. */
  val shownKinds: List<ArtifactKind>
    get() = ArtifactsViewModel.kinds.filter { it.value == "all" || it.value == kind || (counts[it.value] ?: 0) > 0 }

  fun isPicked(g: ArtifactGroup): Boolean = g.items.all { it.id in picked }
  val pickedItems: List<ArtifactItem> get() = items.filter { it.id in picked }
  val pickedBytes: Long get() = pickedItems.sumOf { it.size ?: 0 }
  /** Cards ticked (a batch counts as one), for "3 selected". */
  val pickedCards: Int get() = groups.count { isPicked(it) }
  val isFiltered: Boolean get() = kind != "all" || query.isNotEmpty()
}

/** The clean-up sheet: the age picked for "older than", and what the last clean-up did. */
data class CleanupUi(val age: Int = 30, val busy: Boolean = false, val note: String? = null, val error: String? = null)

class ArtifactsViewModel(val client: MercuryClient) : ViewModel() {
  private val _ui = MutableStateFlow(ArtifactsUi())
  val ui: StateFlow<ArtifactsUi> = _ui.asStateFlow()

  private val _messages = Channel<String>(Channel.BUFFERED)
  /** One-off notes for a snackbar: what a delete did, or why it failed. */
  val messages: Flow<String> = _messages.receiveAsFlow()

  private var loadJob: Job? = null
  private var moreJob: Job? = null
  private var searchJob: Job? = null

  init { load() }

  companion object {
    val kinds = listOf(
      ArtifactKind("all", "All"), ArtifactKind("image", "Images"), ArtifactKind("video", "Videos"), ArtifactKind("audio", "Audio"),
      ArtifactKind("pdf", "PDFs"), ArtifactKind("document", "Documents"), ArtifactKind("text", "Notes"), ArtifactKind("file", "Files"),
    )
    val ages = listOf(7, 30, 90)
  }

  private fun setItems(items: List<ArtifactItem>, s: ArtifactsUi): ArtifactsUi = s.copy(items = items, groups = ArtifactGroup.group(items))

  // MARK: Loading

  /** The first page for the current kind and search, and the space taken alongside it. */
  fun load(refresh: Boolean = false) {
    loadJob?.cancel()
    moreJob?.cancel()
    if (refresh) _ui.update { it.copy(refreshing = true) }
    loadJob = viewModelScope.launch {
      val snapshot = _ui.value
      val usage = async { runCatching { client.artifactUsage() }.getOrNull() }
      try {
        val page = client.artifacts(kind = snapshot.kind, query = snapshot.query)
        _ui.update { setItems(page.items, it).copy(next = page.nextCursor, counts = page.counts ?: it.counts, error = null, loadingMore = false) }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        _ui.update { it.copy(error = e.message ?: "Couldn't load artifacts.") }
      } finally {
        _ui.update { it.copy(refreshing = false) }
      }
      usage.await()?.let { u -> _ui.update { it.copy(usage = u) } }
      _ui.update { it.copy(loaded = true) }
    }
  }

  fun refresh() = load(refresh = true)

  /** The next page, when the list is scrolled near its end. */
  fun more() {
    val s = _ui.value
    val cursor = s.next ?: return
    if (s.loadingMore || loadJob?.isActive == true) return
    _ui.update { it.copy(loadingMore = true) }
    moreJob = viewModelScope.launch {
      try {
        val page = client.artifacts(kind = s.kind, query = s.query, cursor = cursor)
        _ui.update { cur ->
          val have = cur.items.mapTo(HashSet()) { it.id }
          setItems(cur.items + page.items.filter { it.id !in have }, cur).copy(next = page.nextCursor)
        }
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {
        // Scrolling back to the end tries again (iOS keeps quiet too).
      } finally {
        _ui.update { it.copy(loadingMore = false) }
      }
    }
  }

  fun refreshUsage() {
    viewModelScope.launch {
      try {
        val u = client.artifactUsage()
        _ui.update { it.copy(usage = u, cleanup = it.cleanup.copy(error = null)) }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        _ui.update { it.copy(cleanup = it.cleanup.copy(error = e.message ?: "Couldn't count the space.")) }
      }
    }
  }

  // MARK: Filter and search

  fun setKind(kind: String) {
    if (kind == _ui.value.kind) return
    _ui.update { it.copy(kind = kind) }
    load()
  }

  /** Typing searches after a short pause; clearing shows everything again at once. */
  fun setQuery(q: String) {
    if (q == _ui.value.query) return
    _ui.update { it.copy(query = q) }
    searchJob?.cancel()
    searchJob = viewModelScope.launch {
      if (q.isNotEmpty()) delay(400)
      load()
    }
  }

  /** The keyboard's search key: now, without waiting. */
  fun search() {
    searchJob?.cancel()
    load()
  }

  fun setListMode(on: Boolean) = _ui.update { it.copy(listMode = on) }

  // MARK: Select

  fun toggle(g: ArtifactGroup) = _ui.update {
    if (it.isPicked(g)) it.copy(picked = it.picked - g.ids.toSet()) else it.copy(picked = it.picked + g.ids)
  }

  fun startPicking(group: ArtifactGroup? = null) = _ui.update { it.copy(picking = true, picked = group?.ids?.toSet() ?: emptySet()) }

  fun stopPicking() = _ui.update { it.copy(picking = false, picked = emptySet()) }

  /** "Select all shown" when nothing is ticked, else clear. */
  fun selectAllOrClear() = _ui.update {
    if (it.picked.isEmpty()) it.copy(picked = it.items.mapTo(HashSet()) { a -> a.id }) else it.copy(picked = emptySet())
  }

  // MARK: Delete

  /** Deletes for real: Mercury's own files go, files in the person's projects stay. */
  fun delete(ids: List<String>) {
    if (ids.isEmpty() || _ui.value.deleting) return
    _ui.update { it.copy(deleting = true) }
    viewModelScope.launch {
      try {
        val r = if (ids.size == 1) client.deleteArtifact(ids[0]) else client.deleteArtifacts(ArtifactCleanup.Ids(ids))
        removeLocally(ids)
        _ui.update { it.copy(picking = false, picked = emptySet()) }
        _messages.trySend(r.summary)
        load()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        _messages.trySend(e.message ?: "Couldn't delete it.")
      } finally {
        _ui.update { it.copy(deleting = false) }
      }
    }
  }

  /** One deleted from the full-screen viewer; throws so the viewer keeps it on failure. */
  suspend fun deleteOne(id: String) {
    val r = client.deleteArtifact(id)
    removeLocally(listOf(id))
    _messages.trySend(r.summary)
    refreshUsage()
  }

  private fun removeLocally(ids: List<String>) = _ui.update { s ->
    val gone = ids.toSet()
    val counts = s.counts.toMutableMap()
    for (a in s.items) if (a.id in gone) {
      counts[a.kind] = maxOf((counts[a.kind] ?: 1) - 1, 0)
      counts["all"] = maxOf((counts["all"] ?: 1) - 1, 0)
    }
    setItems(s.items.filter { it.id !in gone }, s).copy(counts = counts, picked = s.picked - gone)
  }

  // MARK: Clean up

  /** The sheet opened: a fresh count, and last time's note gone. */
  fun openCleanup() {
    _ui.update { it.copy(cleanup = it.cleanup.copy(note = null, error = null)) }
    refreshUsage()
  }

  fun setAge(days: Int) = _ui.update { it.copy(cleanup = it.cleanup.copy(age = days)) }

  fun runCleanup(scope: ArtifactCleanup) {
    if (_ui.value.cleanup.busy) return
    _ui.update { it.copy(cleanup = it.cleanup.copy(busy = true, note = null, error = null)) }
    viewModelScope.launch {
      try {
        val r = client.deleteArtifacts(scope)
        _ui.update { it.copy(cleanup = it.cleanup.copy(note = r.summary)) }
        _messages.trySend(r.summary)
        load()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        _ui.update { it.copy(cleanup = it.cleanup.copy(error = e.message ?: "Couldn't delete them.")) }
      } finally {
        _ui.update { it.copy(cleanup = it.cleanup.copy(busy = false)) }
      }
    }
  }
}
