package sh.mercuryagent.ui.connect

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import sh.mercuryagent.core.Connection
import sh.mercuryagent.core.ConnectionLogos
import sh.mercuryagent.core.ConnectionStore
import sh.mercuryagent.core.Device
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.MercuryException
import sh.mercuryagent.core.Pairing
import sh.mercuryagent.core.PairingStatus
import sh.mercuryagent.core.SignInResult

sealed interface ConnectStep {
  data object Welcome : ConnectStep
  data object SignIn : ConnectStep
  data object Token : ConnectStep
  data class Waiting(val pairing: Pairing) : ConnectStep
  /** Connected, not saved yet: a friendly name and a logo, then it's saved. */
  data object Name : ConnectStep
}

/** Connected, not saved yet: what the name step saves. */
data class PendingConnection(val url: String, val token: String, val deviceId: String?)

data class ConnectUi(
  val step: ConnectStep = ConnectStep.Welcome,
  val address: String = "",
  val username: String = "",
  val password: String = "",
  val token: String = "",
  val busy: Boolean = false,
  val error: String? = null,
  val pending: PendingConnection? = null,
  val name: String = "",
  val logo: String = ConnectionLogos.ids[0],
  /** The name as first guessed, until the person types their own. */
  val suggestedName: String = "",
) {
  val canSignIn: Boolean get() = address.isNotBlank() && username.isNotBlank() && password.isNotEmpty() && !busy
  val canUseToken: Boolean get() = address.isNotBlank() && token.trim().startsWith("mdt_") && !busy
}

/**
 * The connect flow (ADR-035; iOS: ConnectModel.swift): an address and the owner's sign-in, then (off
 * the owner's computer) a 5-character code the owner approves before Mercury hands this phone a token.
 * Or a device token made elsewhere, checked with a health probe first. Last, once it's connected, a
 * friendly name (the computer's name as a first guess) and a logo, as Mercury Desktop names a remote
 * when it's added; the Mercury is saved when that step is done.
 */
class ConnectViewModel(
  private val store: ConnectionStore,
  private val deviceName: String,
  private val makeClient: (String, String?) -> MercuryClient = { url, token -> MercuryClient(url, token) },
) : ViewModel() {
  private val _ui = MutableStateFlow(ConnectUi())
  val ui: StateFlow<ConnectUi> = _ui.asStateFlow()
  private var poll: Job? = null

  fun go(step: ConnectStep) { poll?.cancel(); _ui.update { it.copy(step = step, error = null) } }
  fun setAddress(v: String) = _ui.update { it.copy(address = v) }
  fun setUsername(v: String) = _ui.update { it.copy(username = v) }
  fun setPassword(v: String) = _ui.update { it.copy(password = v) }
  fun setToken(v: String) = _ui.update { it.copy(token = v) }
  fun setName(v: String) = _ui.update { it.copy(name = v) }
  fun setLogo(v: String) = _ui.update { it.copy(logo = v) }

  /** Back within the flow; false when there's nowhere further back to go. */
  fun back(): Boolean = when (_ui.value.step) {
    ConnectStep.Welcome -> false
    // Connected: back saves it as it is rather than dropping a token Mercury has already handed out.
    ConnectStep.Name -> { save(); true }
    is ConnectStep.Waiting -> { cancelWaiting(); true }
    else -> { go(ConnectStep.Welcome); true }
  }

  fun signIn() {
    val s = _ui.value
    val url = MercuryClient.normalize(s.address) ?: return fail(MercuryException.BadAddress())
    _ui.update { it.copy(busy = true, error = null) }
    viewModelScope.launch {
      try {
        when (val r = makeClient(url, null).signIn(s.username.trim(), s.password, deviceName)) {
          is SignInResult.SignedIn -> finish(url, r.token, r.device)
          is SignInResult.Pending -> {
            _ui.update { it.copy(password = "", step = ConnectStep.Waiting(r.pairing)) }
            wait(r.pairing, url)
          }
        }
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      } finally {
        _ui.update { it.copy(busy = false) }
      }
    }
  }

  /** Long-polls until the owner approves, denies, or the code expires. */
  private fun wait(p: Pairing, url: String) {
    poll?.cancel()
    poll = viewModelScope.launch {
      val client = makeClient(url, null)
      while (isActive) {
        try {
          when (val st = client.pairingStatus(p)) {
            PairingStatus.Waiting -> continue
            is PairingStatus.Approved -> { finish(url, st.token, st.device); return@launch }
            is PairingStatus.Denied -> { _ui.update { it.copy(error = st.why, step = ConnectStep.SignIn) }; return@launch }
            is PairingStatus.Expired -> { _ui.update { it.copy(error = st.why, step = ConnectStep.SignIn) }; return@launch }
          }
        } catch (e: Exception) {
          if (e is CancellationException) throw e
          delay(3_000)
        }
      }
    }
  }

  fun cancelWaiting() { poll?.cancel(); poll = null; _ui.update { it.copy(step = ConnectStep.SignIn) } }

  fun useToken() {
    val s = _ui.value
    val url = MercuryClient.normalize(s.address) ?: return fail(MercuryException.BadAddress())
    val token = s.token.trim()
    _ui.update { it.copy(busy = true, error = null) }
    viewModelScope.launch {
      try {
        makeClient(url, token).health()
        finish(url, token, null)
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      } finally {
        _ui.update { it.copy(busy = false) }
      }
    }
  }

  private fun fail(e: Exception) = _ui.update { it.copy(error = e.message) }

  /**
   * Connected: on to the name step, with the address as a first guess, then the computer's own name
   * when it says (GET /api/health's `host`) unless the person has started typing.
   */
  private fun finish(url: String, token: String, device: Device?) {
    val guess = ConnectionLogos.suggestedName(null, url)
    _ui.update {
      it.copy(
        step = ConnectStep.Name, pending = PendingConnection(url, token, device?.id ?: MercuryClient.deviceIdFromToken(token)),
        name = guess, suggestedName = guess, logo = store.nextLogo, error = null,
      )
    }
    viewModelScope.launch {
      val host = runCatching { makeClient(url, token).health().host }.getOrNull() ?: return@launch
      suggest(host, url)
    }
  }

  fun suggest(host: String?, url: String) {
    val better = ConnectionLogos.suggestedName(host, url)
    _ui.update { it.copy(name = if (it.name == it.suggestedName) better else it.name, suggestedName = better) }
  }

  /** Saves the Mercury with its name (the guess when left blank) and logo, and makes it active. */
  fun save() {
    val s = _ui.value
    val p = s.pending ?: return
    val n = s.name.trim().ifEmpty { s.suggestedName }.take(60)
    _ui.update { it.copy(pending = null) }
    store.add(Connection(name = n, baseUrl = p.url, deviceId = p.deviceId, logo = s.logo), p.token)
  }
}
