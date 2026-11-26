package sh.mercuryagent.call

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import sh.mercuryagent.core.MissedItem
import sh.mercuryagent.core.ReachEvent
import sh.mercuryagent.core.ReachNotice
import sh.mercuryagent.core.RingInvite
import sh.mercuryagent.core.RingOutcome

/** How a ring stopped. */
enum class RingEnd { AnsweredHere, DeclinedHere, AnsweredElsewhere, DeclinedElsewhere, Unanswered, Failed }

/** What [PhoneRinger] needs from Android's call screen ([RingTelecom]; a fake in tests). */
interface RingPresenter {
  /** Shows the incoming call (Telecom + a full-screen notification). False when Android won't. */
  suspend fun show(invite: RingInvite): Boolean
  fun end(id: String, how: RingEnd)
  /** Mercury's own voice call is on: a new ring isn't shown. */
  val inCall: Boolean
}

/**
 * Mercury rings and notifies this phone (ADR-046; iOS: PhoneRinger.swift), over the live activity
 * stream only, so while the app's process is alive and its stream is open:
 *   - `ring` → a real incoming call ([RingPresenter]). Answer → Mercury's live voice call, which
 *     starts by saying why it called. Decline, or no answer before the ring expires → reported back,
 *     so Mercury retries or falls back (WhatsApp, a missed-call note, a message).
 *   - `ring_end` → the ring stopped elsewhere (another phone answered, or it timed out).
 *   - `notify` → a notification (silent in the owner's quiet hours).
 * Pure apart from its presenter and callbacks: time comes from [now] and the [scope]'s clock.
 */
class PhoneRinger(
  private val scope: CoroutineScope,
  var presenter: RingPresenter,
  /** Tells Mercury what happened to a ring. */
  private val report: suspend (id: String, outcome: RingOutcome) -> Unit,
  /** Shows a notification from Mercury (or a missed call). */
  private val post: (ReachNotice) -> Unit,
  private val now: () -> Long = System::currentTimeMillis,
) {
  /** Ring this phone for calls from Mercury. */
  var ringOn = true
  /** Show Mercury's notifications on this phone. */
  var notifyOn = true

  private val _ringing = MutableStateFlow<RingInvite?>(null)
  /** The ring showing now (the incoming-call screen follows it), or null. */
  val ringing: StateFlow<RingInvite?> = _ringing.asStateFlow()
  private var answered: RingInvite? = null
  private val seen = ArrayDeque<String>()
  private var expiry: Job? = null

  fun handle(e: ReachEvent) {
    when (e) {
      is ReachEvent.Ring -> ring(e.invite)
      is ReachEvent.RingEnd -> endedElsewhere(e.id, e.outcome)
      is ReachEvent.Notify -> {
        if (!remember(e.notice.id)) return
        if (notifyOn) post(e.notice)
      }
    }
  }

  fun ring(invite: RingInvite) {
    if (!remember(invite.id)) return
    val exp = invite.expiresAt?.toEpochMilli()
    if (exp != null && exp <= now()) return
    if (!ringOn || _ringing.value != null || presenter.inCall) {
      scope.launch { report(invite.id, RingOutcome.Missed) }
      return
    }
    _ringing.value = invite
    scope.launch {
      if (!presenter.show(invite)) {
        if (_ringing.value?.id == invite.id) _ringing.value = null
        post(missedNotice(invite))
        report(invite.id, RingOutcome.Missed)
        return@launch
      }
      val wait = ((exp ?: (now() + 45_000)) - now()).coerceAtLeast(1_000)
      expiry?.cancel()
      expiry = scope.launch {
        delay(wait)
        timedOut(invite.id)
      }
    }
  }

  private fun timedOut(id: String) {
    val r = _ringing.value ?: return
    if (r.id != id) return
    _ringing.value = null
    presenter.end(id, RingEnd.Unanswered)
    post(missedNotice(r))
    scope.launch { report(id, RingOutcome.Missed) }
  }

  private fun endedElsewhere(id: String, outcome: String) {
    val r = _ringing.value ?: return
    if (r.id != id) return
    _ringing.value = null
    expiry?.cancel()
    presenter.end(id, when (outcome) { "answered_elsewhere" -> RingEnd.AnsweredElsewhere; "declined" -> RingEnd.DeclinedElsewhere; else -> RingEnd.Unanswered })
  }

  /** Answered on this phone (the notification, the incoming-call screen, a headset). True when it was still ringing. */
  fun answerHere(id: String): Boolean {
    val r = _ringing.value ?: return false
    if (r.id != id) return false
    _ringing.value = null
    expiry?.cancel()
    presenter.end(id, RingEnd.AnsweredHere)
    answered = r
    scope.launch { report(id, RingOutcome.Answered) }
    return true
  }

  fun declineHere(id: String) {
    val r = _ringing.value ?: return
    if (r.id != id) return
    _ringing.value = null
    expiry?.cancel()
    presenter.end(id, RingEnd.DeclinedHere)
    scope.launch { report(id, RingOutcome.Declined) }
  }

  /** The answered ring, for the call that starts now (once). */
  fun takeAnswered(): RingInvite? = answered.also { answered = null }

  /** What came while no phone was connected: shown (once each). Returns the ids to acknowledge. */
  fun showMissed(items: List<MissedItem>): List<String> {
    for (m in items) if (remember(m.id)) post(ReachNotice(m.id, m.title, m.body, if (m.kind == "call") "missed-call" else "info", threadId = m.threadId))
    return items.map { it.id }
  }

  /** False when this id was already handled (the app can have more than one stream open). */
  private fun remember(id: String): Boolean {
    if (id in seen) return false
    seen.addLast(id)
    while (seen.size > 200) seen.removeFirst()
    return true
  }

  private fun missedNotice(r: RingInvite) = ReachNotice("missed-${r.id}", "Missed call from Mercury", r.reason, "missed-call")
}
