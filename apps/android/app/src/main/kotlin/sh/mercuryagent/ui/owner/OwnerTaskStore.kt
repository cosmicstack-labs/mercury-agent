package sh.mercuryagent.ui.owner

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import sh.mercuryagent.core.OwnerTask
import sh.mercuryagent.core.OwnerTaskEvent

/**
 * The owner tasks waiting on the active Mercury (ADR-048), for the whole app: loaded when the
 * activity stream opens (GET /api/owner/tasks), kept current by its `owner_task` events, and
 * cleared when another Mercury becomes active. Oldest first, as they arrived. Expired ones are
 * dropped by [live] (and [prune]), since the stream may say nothing when a task runs out.
 */
class OwnerTaskStore {
  private val _items = MutableStateFlow<List<OwnerTask>>(emptyList())
  val items: StateFlow<List<OwnerTask>> = _items.asStateFlow()

  /** A new or changed task: replaces one with its id, else joins the end. Settled ones leave. */
  fun upsert(t: OwnerTask) = _items.update { list ->
    if (!t.pending) list.filter { it.id != t.id }
    else if (list.any { it.id == t.id }) list.map { if (it.id == t.id) t else it }
    else list + t
  }

  fun remove(id: String) = _items.update { list -> list.filter { it.id != id } }

  /** What the server says waits now (on connect): replaces everything. */
  fun replace(tasks: List<OwnerTask>) { _items.value = tasks.filter { it.pending }.distinctBy { it.id } }

  fun clear() { _items.value = emptyList() }

  /** One `owner_task` event from the activity stream. */
  fun apply(e: OwnerTaskEvent) = when (e) {
    is OwnerTaskEvent.New -> upsert(e.task)
    is OwnerTaskEvent.Settled -> remove(e.id)
  }

  /** Drops tasks that have run out by [nowMs]. */
  fun prune(nowMs: Long) = _items.update { list -> live(list, nowMs) }

  companion object {
    /** The tasks still worth showing at [nowMs]. */
    fun live(tasks: List<OwnerTask>, nowMs: Long): List<OwnerTask> = tasks.filter { it.pending && it.expiresAt > nowMs }

    /** The answer to send: what was typed (trimmed), or "done" for a step with nothing typed; null when Send can't go yet. */
    fun answerFor(t: OwnerTask, typed: String): String? {
      val a = typed.trim()
      return if (t.needsText) a.ifEmpty { null } else a.ifEmpty { "done" }
    }

    /** "Code K7Q2 · expires in 4 min · never a password or PIN" */
    fun footer(t: OwnerTask, nowMs: Long): String =
      "Code ${t.code} · expires in ${t.minutesLeft(nowMs)} min · never a password or PIN"

    /** "Mercury needs you: Solve a CAPTCHA" */
    fun heading(t: OwnerTask): String = "${t.who} needs you: ${t.title}"
  }
}
