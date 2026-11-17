package sh.mercuryagent.core

/**
 * Plain http:// is allowed only to this phone's own network, as iOS's NSAllowsLocalNetworking:
 * loopback, private and link-local addresses (10/8, 172.16/12, 192.168/16, 169.254/16, Tailscale's
 * 100.64/10, IPv6 ULA and link-local), `.local` names (Bonjour) and single-label names. Anything
 * else must be https://. The manifest's network security config allows cleartext so this check
 * is the one that decides (Android's config can't name IP ranges).
 */
object LocalNetwork {
  fun allowsCleartext(host: String): Boolean {
    val h = host.trim().lowercase().removePrefix("[").removeSuffix("]").trimEnd('.')
    if (h.isEmpty()) return false
    if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
    ipv4(h)?.let { b -> return isPrivate4(b) }
    if (h.contains(':')) return isPrivate6(h)
    // A single-label name ("mymac") only resolves on the local network.
    return !h.contains('.')
  }

  private fun ipv4(h: String): IntArray? {
    val parts = h.split('.')
    if (parts.size != 4) return null
    val out = IntArray(4)
    for ((i, p) in parts.withIndex()) {
      if (p.isEmpty() || p.length > 3 || !p.all(Char::isDigit)) return null
      out[i] = p.toInt().takeIf { it <= 255 } ?: return null
    }
    return out
  }

  private fun isPrivate4(b: IntArray): Boolean = when {
    b[0] == 127 || b[0] == 10 -> true
    b[0] == 172 && b[1] in 16..31 -> true
    b[0] == 192 && b[1] == 168 -> true
    b[0] == 169 && b[1] == 254 -> true
    b[0] == 100 && b[1] in 64..127 -> true
    else -> false
  }

  private fun isPrivate6(h: String): Boolean {
    if (h == "::1") return true
    val first = h.substringBefore(':').ifEmpty { return false }.toIntOrNull(16) ?: return false
    // fc00::/7 (unique local) and fe80::/10 (link-local)
    return (first and 0xfe00) == 0xfc00 || (first and 0xffc0) == 0xfe80
  }
}
