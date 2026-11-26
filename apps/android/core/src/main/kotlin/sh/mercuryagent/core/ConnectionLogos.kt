package sh.mercuryagent.core

import java.net.URI

/**
 * The playful Mercury logos a connection can wear (drawn by the app's `MercuryLogo`), and the rules
 * for a new connection's name and logo. iOS: ConnectionLogos.swift, the same ids and order.
 */
object ConnectionLogos {
  /** In the default rotation's order: the first Mercury gets the first, the next the second, and so on. */
  val ids = listOf(
    "shades", "party", "headphones", "wizard", "astronaut", "chef",
    "crown", "sleepy", "wink", "hearts", "ninja", "pirate",
  )

  /** The first logo in the rotation no saved Mercury wears yet, else the rotation continued by count. */
  fun next(connections: List<Connection>): String {
    val used = connections.mapNotNull { it.logo }.toSet()
    return ids.firstOrNull { it !in used } ?: ids[connections.size % ids.size]
  }

  /**
   * Records saved before logos: each gets its place in the rotation (the first #1, the second #2…),
   * a name when it has none (its host), and keeps everything else. Null when nothing changed.
   */
  fun migrate(connections: List<Connection>): List<Connection>? {
    var changed = false
    val out = connections.mapIndexed { i, c ->
      var n = c
      if (n.logo == null || n.logo !in ids) { n = n.copy(logo = ids[i % ids.size]); changed = true }
      if (n.name.isBlank()) { n = n.copy(name = hostOf(n.baseUrl).ifEmpty { "Mercury" }); changed = true }
      n
    }
    return if (changed) out else null
  }

  /**
   * A first guess at a friendly name: "Mercury on MacBook Pro" from the host name the runtime reports,
   * else from the address's own name when it's one ("studio.local"), else the address's host
   * ("mercury.example.com"), and plain "Mercury" for a bare IP or localhost.
   */
  fun suggestedName(host: String?, url: String): String {
    host?.let(::pretty)?.takeIf { it.isNotEmpty() }?.let { return "Mercury on $it" }
    val h = hostOf(url)
    if (h.isEmpty() || h == "localhost" || h.all { it.isDigit() || it == '.' } || h.contains(':')) return "Mercury"
    if (h.endsWith(".local")) return "Mercury on ${pretty(h)}"
    return h
  }

  /** "Salmans-MacBook-Pro.local" → "Salmans MacBook Pro". */
  fun pretty(host: String): String {
    var h = host.trim()
    for (suffix in listOf(".local", ".lan", ".home", ".localdomain")) if (h.lowercase().endsWith(suffix)) h = h.dropLast(suffix.length)
    return h.replace('-', ' ').replace('_', ' ').split(' ').filter { it.isNotEmpty() }.joinToString(" ")
  }

  private fun hostOf(url: String): String = runCatching { URI(url).host }.getOrNull()?.removePrefix("[")?.removeSuffix("]").orEmpty()
}
