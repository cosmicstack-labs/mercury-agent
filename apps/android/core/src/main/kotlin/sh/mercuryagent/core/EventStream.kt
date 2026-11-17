package sh.mercuryagent.core

/**
 * Reads a text/event-stream line by line. Mercury writes `event: <name>`, one `data: <json>` line
 * and a blank line per event, `id:` lines on streams that can resume, and `: keepalive` comments.
 * An event is dispatched at the blank line (several data lines join with "\n"); the last id is kept
 * so a reconnect can resume from it (Last-Event-ID).
 */
class SseParser {
  var lastId: String? = null
    private set
  private var name: String? = null
  private val data = StringBuilder()
  private var hasData = false

  /** Feeds one line (without its line break); returns an event when this line completes one. */
  fun feed(line: String): ServerEvent? {
    if (line.isEmpty()) return dispatch()
    if (line.startsWith(":")) return null
    val colon = line.indexOf(':')
    val field = if (colon < 0) line else line.substring(0, colon)
    var value = if (colon < 0) "" else line.substring(colon + 1)
    if (value.startsWith(" ")) value = value.substring(1)
    when (field) {
      "event" -> name = value
      "data" -> { if (hasData) data.append('\n'); data.append(value); hasData = true }
      "id" -> if (!value.contains('\u0000')) lastId = value
      else -> Unit // retry and unknown fields: ignored
    }
    return null
  }

  /** The stream ended: an event still being read is dropped, as EventSource does. */
  fun reset() { name = null; data.setLength(0); hasData = false }

  private fun dispatch(): ServerEvent? {
    if (!hasData) { name = null; return null }
    val e = ServerEvent(name = name?.ifEmpty { null } ?: "message", data = data.toString(), id = lastId)
    reset()
    return e
  }
}
