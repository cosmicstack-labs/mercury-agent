package sh.mercuryagent.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.time.Instant
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import sh.mercuryagent.core.MercuryJson
import sh.mercuryagent.ui.chats.ReadMarks

/** Each Mercury's read marks in DataStore, as {"<thread id>": epoch ms, "_since": epoch ms}. */
class ReadMarksStore(private val prefs: DataStore<Preferences>) {
  private fun key(scope: String) = stringPreferencesKey("chats.seen." + scope.ifEmpty { "default" })

  /** The marks for one Mercury; the first time, marks start now (so nothing shows as new). */
  suspend fun load(scope: String, now: Instant = Instant.now()): ReadMarks {
    val raw = prefs.data.first()[key(scope)]
    val o = raw?.let { runCatching { MercuryJson.parseToJsonElement(it) as? JsonObject }.getOrNull() }
    val since = (o?.get(SINCE) as? JsonPrimitive)?.longOrNull?.let(Instant::ofEpochMilli)
    val seen = o.orEmpty().filterKeys { it != SINCE }
      .mapNotNull { (k, v) -> (v as? JsonPrimitive)?.longOrNull?.let { k to Instant.ofEpochMilli(it) } }.toMap()
    val marks = ReadMarks(seen, since ?: now)
    if (since == null) save(scope, marks)
    return marks
  }

  suspend fun save(scope: String, marks: ReadMarks) {
    val o = JsonObject(marks.seen.mapValues { JsonPrimitive(it.value.toEpochMilli()) } + (SINCE to JsonPrimitive(marks.since.toEpochMilli())))
    prefs.edit { it[key(scope)] = o.toString() }
  }

  private companion object { const val SINCE = "_since" }
}
