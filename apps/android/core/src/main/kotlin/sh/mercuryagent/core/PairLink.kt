package sh.mercuryagent.core

import java.net.URLDecoder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Pairing codes (src/security/pair-codes.ts): 25 characters from 0-9 and A-Z without I, L, O and U,
 * shown in groups of five. What's typed is forgiving, as the server is: case, dashes and spaces
 * don't matter, O reads as 0, I and L as 1.
 */
object PairCode {
  const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  const val LENGTH = 25

  fun normalize(typed: String): String =
    typed.uppercase().filter { it in '0'..'9' || it in 'A'..'Z' }.replace('O', '0').replace('I', '1').replace('L', '1')

  /** A normalized code that could be real: the right length, every character from the alphabet. */
  fun isValid(code: String): Boolean = code.length == LENGTH && code.all { it in ALPHABET }

  /** "ABCDE-FGHJK-…", as the computer shows it. */
  fun group(code: String): String = code.chunked(5).joinToString("-")
}

/**
 * A pairing link, `mercury://pair?u=<address>&c=<code>`, as the computer's QR code holds it.
 * [address] is an origin as [MercuryClient.normalize] makes it; [code] is normalized and valid.
 */
data class PairLink(val address: String, val code: String) {
  /** The host as the confirm dialog names it ("mac.tail1234.ts.net", with a port when there is one). */
  val host: String get() = address.substringAfter("://")

  /** Plain http:// to somewhere off the local network: refused, as every connection is ([LocalNetwork]). */
  val insecure: Boolean get() = !address.startsWith("https://") && !LocalNetwork.allowsCleartext(hostOf(address))

  companion object {
    /** Reads a scanned or opened link; null when it isn't a Mercury pairing link. */
    fun parse(raw: String): PairLink? {
      val s = raw.trim()
      val schemeEnd = s.indexOf("://").takeIf { it > 0 } ?: return null
      if (!s.substring(0, schemeEnd).equals("mercury", ignoreCase = true)) return null
      val rest = s.substring(schemeEnd + 3)
      val target = rest.substringBefore('?').substringBefore('#').trimEnd('/')
      if (!target.equals("pair", ignoreCase = true)) return null
      if (!rest.contains('?')) return null
      val params = rest.substringAfter('?').substringBefore('#').split('&').mapNotNull { part ->
        if (part.isEmpty()) null else decode(part.substringBefore('=')) to decode(part.substringAfter('=', ""))
      }.toMap()
      val address = params["u"]?.let(MercuryClient::normalize) ?: return null
      val code = params["c"]?.let(PairCode::normalize)?.takeIf(PairCode::isValid) ?: return null
      return PairLink(address, code)
    }

    private fun decode(s: String): String = runCatching { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)

    internal fun hostOf(origin: String): String = origin.toHttpUrlOrNull()?.host ?: origin.substringAfter("://").substringBefore(':')
  }
}

/** What POST /api/auth/pair answered: a device token, used exactly like a pasted one. */
data class Paired(val token: String, val device: Device?)

/**
 * POST /api/auth/pair: redeems a pairing code shown on the computer for a device token (no owner
 * approval: the code is the approval). 401 wrong or expired code, 429 too many tries, 403 remote
 * access off or this address blocked, 404 a Mercury too old to pair with a code.
 */
suspend fun MercuryClient.pair(code: String, deviceName: String, platform: String = "android"): Paired {
  val body = buildJsonObject { put("code", code); put("deviceName", deviceName); put("platform", platform) }
  val reply = send(request("POST", "/api/auth/pair", body))
  val j = parseObject(reply.body)
  return when (reply.code) {
    200 -> Paired(j.str("token") ?: throw MercuryException.Server(200, "Mercury didn't send a token."), MercuryClient.device(j["device"]))
    401 -> throw MercuryException.BadPairCode()
    404 -> throw MercuryException.Server(404, "That Mercury is too old to pair with a code. Update it, or connect with a device token.")
    429 -> throw MercuryException.TooManyAttempts(reply.retryAfter?.trim()?.toIntOrNull())
    403 -> throw MercuryException.Server(
      403,
      j.str("error") ?: when {
        j["remoteOff"] != null -> "Remote access is turned off on this Mercury. Turn it on with /server on the computer it runs on."
        j["addressBlocked"] != null -> "This address is not allowed to connect to this Mercury."
        else -> null
      },
    )
    else -> throw MercuryException.Server(reply.code, j.str("error"))
  }
}

/**
 * What the person typed in "Enter a code or token": a pairing code (`/server pair`, any grouping or
 * case) or a device token (`/server token <name>`, `mdt_<8 hex>_<64 hex>`). Nothing else connects.
 * iOS: ConnectSecret in PairLink.swift.
 */
sealed interface ConnectSecret {
  data class Code(val code: String) : ConnectSecret
  data class Token(val token: String) : ConnectSecret
  /** Neither: [message] says why, for under the field. */
  data class Invalid(val message: String) : ConnectSecret

  companion object {
    const val EMPTY = "Enter the pairing code or the device token from your computer."
    const val BAD_TOKEN = "That token isn't complete. Copy the whole line that starts with mdt_."
    const val NEITHER = "That isn't a pairing code or a device token. A code has 25 letters and numbers; a token starts with mdt_."

    private val TOKEN = Regex("^mdt_[0-9a-f]{8}_[0-9a-f]{64}$")

    /** Anything starting with `mdt_` is a token (spaces and line breaks from pasting dropped); anything else must be a whole code. */
    fun read(typed: String): ConnectSecret {
      val t = typed.trim()
      if (t.isEmpty()) return Invalid(EMPTY)
      if (isToken(t)) {
        val token = t.filterNot { it.isWhitespace() }
        return if (TOKEN.matches(token)) Token(token) else Invalid(BAD_TOKEN)
      }
      val code = PairCode.normalize(t)
      return if (PairCode.isValid(code)) Code(code) else Invalid(NEITHER)
    }

    /** Whether it's meant as a token (it starts with `mdt_`), complete or not. */
    fun isToken(typed: String): Boolean = typed.trim().startsWith("mdt_", ignoreCase = true)
  }
}
