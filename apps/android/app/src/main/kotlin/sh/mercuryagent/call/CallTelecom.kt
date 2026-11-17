package sh.mercuryagent.call

import android.content.Context
import android.net.Uri
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The call as Android sees it (iOS: CallKitCall): an outgoing self-managed call to "Mercury"
 * through Jetpack's core-telecom, so it shows as an ongoing call, keeps running in the background,
 * follows Bluetooth and car audio, and is held by a real phone call (Telecom puts it inactive).
 * Without Telecom (it refused) the app runs the call itself. Callbacks come on the main thread.
 */
class CallTelecom(private val context: Context, private val scope: CoroutineScope) {
  /** Hung up from outside the app (the system's call UI, a headset button, another call). */
  var onEndedOutside: () -> Unit = {}
  /** Another call put this one on hold (true) or let it go (false). */
  var onHold: (Boolean) -> Unit = {}
  /** The system's microphone mute changed (a headset button, the system UI). */
  var onMuted: (Boolean) -> Unit = {}

  private var control: CallControlScope? = null
  private var job: Job? = null
  private var endpoints: List<CallEndpointCompat> = emptyList()
  @Volatile private var endingHere = false

  val active: Boolean get() = control != null && !endingHere

  /** Adds the outgoing call and makes it active. False when Telecom won't (then the app runs the call itself). */
  suspend fun start(): Boolean {
    val manager = CallsManager(context)
    try {
      manager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
    } catch (e: Exception) {
      Log.w(TAG, "telecom: can't register (${e.message}), running in the app"); return false
    }
    val attrs = CallAttributesCompat(
      displayName = "Mercury",
      address = Uri.parse("mercury:voice"),
      direction = CallAttributesCompat.DIRECTION_OUTGOING,
      callType = CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
      callCapabilities = 0,
    )
    val ready = CompletableDeferred<Boolean>()
    job = scope.launch(Dispatchers.Default) {
      try {
        manager.addCall(
          attrs,
          onAnswer = { _ -> },
          onDisconnect = { _ ->
            control = null
            if (!endingHere) withContext(Dispatchers.Main) { onEndedOutside() }
          },
          onSetActive = { withContext(Dispatchers.Main) { onHold(false) } },
          onSetInactive = { withContext(Dispatchers.Main) { onHold(true) } },
        ) {
          control = this
          launch { availableEndpoints.collect { endpoints = it } }
          launch { isMuted.collect { m -> withContext(Dispatchers.Main) { onMuted(m) } } }
          launch { ready.complete(setActive() is CallControlResult.Success) }
        }
      } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        Log.w(TAG, "telecom: addCall failed (${e.message}), running in the app")
        ready.complete(false)
      }
    }
    val ok = withTimeoutOrNull(5_000) { ready.await() } ?: false
    if (!ok) { end(failed = true); control = null }
    return ok
  }

  /** Tells Telecom where the sound went, so its call state (and the system UI) agrees. */
  fun route(target: CallRouting.Target) {
    val c = control ?: return
    val type = when (target) {
      CallRouting.Target.SPEAKER -> listOf(CallEndpointCompat.TYPE_SPEAKER)
      CallRouting.Target.EARPIECE -> listOf(CallEndpointCompat.TYPE_EARPIECE)
      CallRouting.Target.EXTERNAL -> listOf(CallEndpointCompat.TYPE_BLUETOOTH, CallEndpointCompat.TYPE_WIRED_HEADSET)
    }
    val e = endpoints.firstOrNull { it.type in type } ?: return
    c.launch { runCatching { c.requestEndpointChange(e) } }
  }

  /** Ends the call from the app (a failed call reports an error to Telecom). */
  fun end(failed: Boolean = false) {
    if (endingHere) return
    endingHere = true
    val c = control
    control = null
    if (c == null) { job?.cancel(); return }
    c.launch {
      runCatching { c.disconnect(DisconnectCause(if (failed) DisconnectCause.ERROR else DisconnectCause.LOCAL)) }
      job?.cancel()
    }
  }

  private companion object { const val TAG = "MercuryCall" }
}
