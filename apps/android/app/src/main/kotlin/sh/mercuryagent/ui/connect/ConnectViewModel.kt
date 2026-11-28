package sh.mercuryagent.ui.connect

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ConnectSecret
import sh.mercuryagent.core.Connection
import sh.mercuryagent.core.ConnectionLogos
import sh.mercuryagent.core.ConnectionStore
import sh.mercuryagent.core.Device
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.MercuryException
import sh.mercuryagent.core.PairCode
import sh.mercuryagent.core.PairLink
import sh.mercuryagent.core.pair

sealed interface ConnectStep {
  data object Welcome : ConnectStep
  /** "Enter a code or token": the address, and a pairing code or a device token (when scanning isn't possible). */
  data object Enter : ConnectStep
  /** Connected, not saved yet: a friendly name and a logo, then it's saved. */
  data object Name : ConnectStep
}

/** Connected, not saved yet: what the name step saves. */
data class PendingConnection(val url: String, val token: String, val deviceId: String?)

data class ConnectUi(
  val step: ConnectStep = ConnectStep.Welcome,
  val address: String = "",
  /** A pairing code as typed ("K7Q2M-9ABCD-…", any grouping) or a device token (mdt_…); told apart when it's sent. */
  val secret: String = "",
  /** A scanned or opened pairing link, waiting for "Connect to <host>?". Never paired without it. */
  val confirm: PairLink? = null,
  val busy: Boolean = false,
  val error: String? = null,
  val pending: PendingConnection? = null,
  val name: String = "",
  val logo: String = ConnectionLogos.ids[0],
  /** The name as first guessed, until the person types their own. */
  val suggestedName: String = "",
) {
  val canConnect: Boolean get() = address.isNotBlank() && secret.isNotBlank() && !busy
}

/**
 * The connect flow (iOS: ConnectModel.swift). There is no password sign-in. First choice: scan the
 * pairing QR the computer shows (`mercury://pair?u=<address>&c=<code>`, asked about before anything is
 * sent); POST /api/auth/pair hands back a device token. Or "Enter a code or token": the address with
 * that code typed, or a device token made on the computer (`/server token <name>`), checked with a
 * health probe first. Last, once it's connected, a friendly name (the computer's name as a first guess)
 * and a logo, as Mercury Desktop names a remote when it's added; the Mercury is saved when that step is done.
 */
class ConnectViewModel(
  private val store: ConnectionStore,
  private val deviceName: String,
  private val makeClient: (String, String?) -> MercuryClient = { url, token -> MercuryClient(url, token) },
) : ViewModel() {
  private val _ui = MutableStateFlow(ConnectUi())
  val ui: StateFlow<ConnectUi> = _ui.asStateFlow()

  fun go(step: ConnectStep) = _ui.update { it.copy(step = step, error = null) }
  fun setAddress(v: String) = _ui.update { it.copy(address = v) }
  fun setSecret(v: String) = _ui.update { it.copy(secret = v) }
  fun setName(v: String) = _ui.update { it.copy(name = v) }
  fun setLogo(v: String) = _ui.update { it.copy(logo = v) }

  /** Back within the flow; false when there's nowhere further back to go. */
  fun back(): Boolean = when (_ui.value.step) {
    ConnectStep.Welcome -> false
    // Connected: back saves it as it is rather than dropping a token Mercury has already handed out.
    ConnectStep.Name -> { save(); true }
    else -> { go(ConnectStep.Welcome); true }
  }

  // ── Pairing codes: the computer shows a QR (mercury://pair?u=<address>&c=<code>) or the code ──

  /**
   * A scanned QR code or an opened mercury://pair link: asks "Connect to <host>?" first, never pairs
   * on its own. What isn't a pairing link, or is plain http:// off the local network, is refused.
   */
  fun openLink(raw: String) {
    // Already connected and naming it: that token is kept, not swapped for another.
    if (_ui.value.step == ConnectStep.Name) return
    val link = PairLink.parse(raw)
    when {
      link == null -> { go(ConnectStep.Enter); _ui.update { it.copy(confirm = null, error = "That isn't a Mercury pairing code. Make a new one on the computer Mercury runs on.") } }
      link.insecure -> { go(ConnectStep.Enter); _ui.update { it.copy(confirm = null, error = INSECURE) } }
      else -> _ui.update { it.copy(confirm = link, error = null) }
    }
  }

  /** Scanning didn't happen (no Google Play services, or the scanner failed): enter the code instead. */
  fun scanUnavailable(why: String) { go(ConnectStep.Enter); _ui.update { it.copy(error = why) } }

  fun dismissConfirm() = _ui.update { it.copy(confirm = null) }

  /** "Connect" in the confirm dialog: redeem the link's code. The form is filled in case it fails. */
  fun confirmPair() {
    val link = _ui.value.confirm ?: return
    _ui.update { it.copy(confirm = null, address = link.address, secret = PairCode.group(link.code), step = ConnectStep.Enter) }
    pair(link.address, link.code)
  }

  /** "Enter a code or token": a token (mdt_…) is checked with the Mercury and kept; anything else must be a whole pairing code. */
  fun connectTyped() {
    val s = _ui.value
    if (s.busy) return
    val url = MercuryClient.normalize(s.address) ?: return fail(MercuryException.BadAddress())
    if (PairLink(url, "").insecure) return _ui.update { it.copy(error = INSECURE) }
    when (val secret = ConnectSecret.read(s.secret)) {
      is ConnectSecret.Code -> pair(url, secret.code)
      is ConnectSecret.Token -> useToken(url, secret.token)
      is ConnectSecret.Invalid -> _ui.update { it.copy(error = secret.message) }
    }
  }

  /** A device token made on the computer (`/server token <name>`), checked with GET /api/health first. */
  private fun useToken(url: String, token: String) {
    _ui.update { it.copy(busy = true, error = null) }
    viewModelScope.launch {
      try {
        makeClient(url, token).checkToken()
        finish(url, token, null)
      } catch (e: Exception) {
        if (e is CancellationException) throw e
        _ui.update { it.copy(error = e.message) }
      } finally {
        _ui.update { it.copy(busy = false) }
      }
    }
  }

  private fun pair(url: String, code: String) {
    if (_ui.value.busy) return
    _ui.update { it.copy(busy = true, error = null) }
    viewModelScope.launch {
      try {
        val p = makeClient(url, null).pair(code, deviceName)
        finish(url, p.token, p.device)
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

  private companion object {
    const val INSECURE = "Plain http:// works only on your own network. Use https:// for anything else."
  }
}
