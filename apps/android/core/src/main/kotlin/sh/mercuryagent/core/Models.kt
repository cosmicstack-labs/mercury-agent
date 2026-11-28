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
  /** Which of the Mercury logos this one wears ([ConnectionLogos.ids]); null in records saved before logos. */
  val logo: String? = null,
) {
  /** The logo to draw: the saved one, else the first. */
  val logoId: String get() = logo?.takeIf { it in ConnectionLogos.ids } ?: ConnectionLogos.ids[0]

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
  /** The computer's host name (newer runtimes, only to a signed-in device): the friendly name's first guess. */
  val host: String? = null,
)

@Serializable
data class Device(val id: String, val name: String = "", val platform: String? = null)

/** A change only the owner may allow (428 from the owner gate): approve [code], then it's repeated. */
data class OwnerQuestion(val id: String, val code: String, val where: String, val message: String)

/** Everything a call to Mercury can fail with, worded for the person holding the phone. */
sealed class MercuryException(message: String) : Exception(message) {
  class BadAddress : MercuryException("That doesn't look like a web address. Try something like https://mercury.example.com")
  class Unreachable(val why: String) : MercuryException("Couldn't reach that Mercury. $why")
  /** A pasted device token that Mercury doesn't know (GET /api/health said 401 or 404). */
  class BadToken : MercuryException("That Mercury doesn't know this token. Check the address, or make a new token with /server token on the computer it runs on.")
  class BadPairCode : MercuryException("This pairing code isn't valid. Make a new one on the computer Mercury runs on.")
  class TooManyAttempts(val retryAfter: Int?) : MercuryException(
    retryAfter?.let { "Too many tries. Wait $it seconds and try again." }
      ?: "Too many tries. Try again in a minute.",
  )
  class Unauthorized : MercuryException("This phone isn't signed in to that Mercury any more. Connect again.")
  class Server(val code: Int, msg: String?) : MercuryException(msg ?: "Mercury answered with an error ($code).")
  class NeedsOwner(val question: OwnerQuestion) : MercuryException(question.message)
}
