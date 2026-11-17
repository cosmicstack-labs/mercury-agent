package sh.mercuryagent.core

import java.security.SecureRandom
import java.time.Instant
import kotlinx.serialization.Serializable

/** A Mercury this phone can reach. The token is never stored here: it lives in [SecretStore] under `connection:<id>`. */
@Serializable
data class Connection(
  val id: String = newId(),
  val name: String,
  /** An origin with no trailing slash, e.g. https://mercury.tail1234.ts.net */
  val baseUrl: String,
  val deviceId: String? = null,
  @Serializable(with = InstantIso::class) val createdAt: Instant = Instant.now(),
  @Serializable(with = InstantIso::class) val lastUsedAt: Instant? = null,
) {
  companion object {
    /** 12 random hex characters, like Mercury Desktop's connection ids. */
    fun newId(): String {
      val b = ByteArray(6).also { SecureRandom().nextBytes(it) }
      return b.joinToString("") { "%02x".format(it) }
    }
  }
}

/** GET /api/health */
@Serializable
data class Health(
  val ok: Boolean = false,
  val version: String? = null,
  val apiVersion: Int? = null,
  val features: List<String>? = null,
  val setupRequired: Boolean? = null,
)

@Serializable
data class Device(val id: String, val name: String = "", val platform: String? = null)

/** The result of asking a Mercury for a device token (POST /api/auth/token). */
sealed interface SignInResult {
  /** Signed in straight away (only happens on the runtime's own computer). */
  data class SignedIn(val token: String, val device: Device?) : SignInResult
  /** The owner must approve this phone with the pairing's code before a token is handed out. */
  data class Pending(val pairing: Pairing) : SignInResult
}

data class Pairing(
  val pairingId: String,
  val pollToken: String,
  /** 5 characters, e.g. "K7Q2M" */
  val code: String,
  /** Where the owner can approve, as the runtime words it. */
  val message: String? = null,
  val expiresAt: Instant? = null,
)

sealed interface PairingStatus {
  data object Waiting : PairingStatus
  data class Approved(val token: String, val device: Device?) : PairingStatus
  data class Denied(val why: String) : PairingStatus
  data class Expired(val why: String) : PairingStatus
}

/** A change only the owner may allow (428 from the owner gate): approve [code], then it's repeated. */
data class OwnerQuestion(val id: String, val code: String, val where: String, val message: String)

/** Everything a call to Mercury can fail with, worded for the person holding the phone. */
sealed class MercuryException(message: String) : Exception(message) {
  class BadAddress : MercuryException("That doesn't look like a web address. Try something like https://mercury.example.com")
  class Unreachable(val why: String) : MercuryException("Couldn't reach that Mercury. $why")
  class BadCredentials : MercuryException("That username or password isn't right.")
  class TooManyAttempts(val retryAfter: Int?) : MercuryException(
    retryAfter?.let { "Too many tries. Wait $it seconds and try again." }
      ?: "Too many tries, or a sign-in is already waiting. Try again in a minute.",
  )
  class DeviceLimit : MercuryException("This Mercury already has the most devices it allows. Remove one in Mercury Desktop, then try again.")
  class Unauthorized : MercuryException("This phone isn't signed in to that Mercury any more. Connect again.")
  class Server(val code: Int, msg: String?) : MercuryException(msg ?: "Mercury answered with an error ($code).")
  class NeedsOwner(val question: OwnerQuestion) : MercuryException(question.message)
}
