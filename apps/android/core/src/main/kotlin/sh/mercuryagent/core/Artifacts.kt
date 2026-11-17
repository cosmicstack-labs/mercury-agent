package sh.mercuryagent.core

import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.chrono.IsoChronology
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// Everything Mercury made (iOS: Artifacts.swift, MercuryClient+Artifacts.swift; Desktop's
// ArtifactsView). The file itself is at GET /api/artifacts/:id/file and needs the device token.

/** Something Mercury made, listed in GET /api/artifacts. */
@Serializable
data class ArtifactItem(
  val id: String,
  val threadId: String? = null,
  val threadTitle: String? = null,
  val name: String = "",
  /** image, video, audio, pdf, document, text or file */
  val kind: String = "file",
  val mime: String? = null,
  val size: Long? = null,
  /** Milliseconds since 1970. */
  val createdAt: Double? = null,
  /** Made together, in one turn by one media tool (five images for one ask): shown as one card. */
  val batch: String? = null,
  val prompt: String? = null,
  val tool: String? = null,
  /** Deleting it deletes the file itself (Mercury's own output). */
  val owned: Boolean? = null,
  val originalExists: Boolean? = null,
) {
  /** The file sits in the person's project: deleting keeps it and removes only Mercury's copy. */
  val keepsOriginal: Boolean get() = owned == false
}

@Serializable
data class ArtifactPage(
  @Serializable(with = ArtifactItemList::class) val items: List<ArtifactItem> = emptyList(),
  val nextCursor: String? = null,
  val counts: Map<String, Int>? = null,
)

object ArtifactItemList : kotlinx.serialization.KSerializer<List<ArtifactItem>> by LossyList(ArtifactItem.serializer())

/** One card in the artifacts list: a single artifact, or a batch made together (a mosaic). */
data class ArtifactGroup(val items: List<ArtifactItem>) {
  val id: String get() = if (items.size > 1) "batch:${items[0].batch ?: items[0].id}" else items[0].id
  val lead: ArtifactItem get() = items[0]
  val isBatch: Boolean get() = items.size > 1
  val ids: List<String> get() = items.map { it.id }
  val size: Long get() = items.sumOf { it.size ?: 0 }

  companion object {
    /** Batches gathered into one card at their newest member's place (the list is newest first). */
    fun group(items: List<ArtifactItem>): List<ArtifactGroup> {
      val out = mutableListOf<MutableList<ArtifactItem>>()
      val at = mutableMapOf<String, Int>()
      for (a in items) {
        val b = a.batch
        if (!b.isNullOrEmpty()) {
          val i = at[b]
          if (i != null) { out[i] += a; continue }
          at[b] = out.size
        }
        out += mutableListOf(a)
      }
      return out.map { ArtifactGroup(it) }
    }
  }
}

/** GET /api/artifacts/usage: space taken, counted the way the disk does. */
@Serializable
data class ArtifactUsage(
  val count: Int = 0,
  val bytes: Long = 0,
  val byKind: Map<String, Kind> = emptyMap(),
  /** What deleting every artifact would give back. */
  val freeable: Long = 0,
  /** Artifacts whose file lives in a project: deleting keeps that file. */
  val outside: Int = 0,
) {
  @Serializable data class Kind(val count: Int = 0, val bytes: Long = 0)
  data class Row(val kind: String, val usage: Kind, val share: Double)

  /** Kinds with something in them, biggest first, each with its share of the largest (0…1). */
  val kinds: List<Row>
    get() {
      val rows = byKind.filter { it.value.count > 0 }.entries
        .sortedWith(compareByDescending<Map.Entry<String, Kind>> { it.value.bytes }.thenBy { it.key })
      val top = (rows.firstOrNull()?.value?.bytes ?: 0).coerceAtLeast(1).toDouble()
      return rows.map { Row(it.key, it.value, it.value.bytes / top) }
    }
}

/** What to delete in one go (POST /api/artifacts/delete). */
sealed interface ArtifactCleanup {
  data class Ids(val ids: List<String>) : ArtifactCleanup
  data class OfKind(val kind: String) : ArtifactCleanup
  data class OlderThan(val days: Int) : ArtifactCleanup
  data object All : ArtifactCleanup

  fun body(): JsonObject = when (this) {
    is Ids -> buildJsonObject { putJsonArray("ids") { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } }
    is OfKind -> buildJsonObject { put("kind", kind) }
    is OlderThan -> buildJsonObject { put("olderThanDays", days) }
    All -> buildJsonObject { put("all", true) }
  }
}

/** What deleting did: records gone, bytes the disk got back, originals left in place. */
@Serializable
data class ArtifactRemoved(val removed: Int = 0, val freed: Long = 0, val keptOriginals: Int = 0) {
  /** "3 deleted, 4.2 MB freed." (and the project files that stayed), as Mercury Desktop says it. */
  val summary: String
    get() {
      val space = if (freed > 0) ", ${ArtifactFormat.bytes(freed)} freed" else ""
      val kept = if (keptOriginals > 0) ". $keptOriginals file${if (keptOriginals == 1) "" else "s"} in your projects stayed where they are" else ""
      return "$removed deleted$space$kept."
    }
}

object ArtifactFormat {
  /** 512 B, 38 KB, 4.2 MB, 1.25 GB: the same numbers Mercury Desktop shows. */
  fun bytes(n: Long): String {
    val d = n.coerceAtLeast(0).toDouble()
    return when {
      d < 1024 -> "${n.coerceAtLeast(0)} B"
      d < 1024 * 1024 -> "${Math.round(d / 1024)} KB"
      d < 1024.0 * 1024 * 1024 -> String.format(Locale.US, "%.1f MB", d / (1024 * 1024))
      else -> String.format(Locale.US, "%.2f GB", d / (1024.0 * 1024 * 1024))
    }
  }

  /**
   * When it was made: the time today, else the day ("Nov 3" in en-US, "3 Nov" in en-GB) with the
   * year when it isn't this year ("Nov 14, 2023"), in the phone's own order, as iOS's templates.
   */
  fun `when`(ms: Double?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    ms ?: return ""
    val d = Instant.ofEpochMilli(ms.toLong()).atZone(zone)
    val n = now.atZone(zone)
    if (d.toLocalDate() == n.toLocalDate()) return DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(d)
    val full = runCatching {
      DateTimeFormatterBuilder.getLocalizedDateTimePattern(FormatStyle.MEDIUM, null, IsoChronology.INSTANCE, locale)
    }.getOrNull() ?: "MMM d, y"
    val pattern = if (d.year == n.year) withoutYear(full) else full
    return runCatching { DateTimeFormatter.ofPattern(pattern, locale).format(d) }.getOrElse { DateTimeFormatter.ofPattern("MMM d", locale).format(d) }
  }

  /** A localized date pattern without its year: "MMM d, y" → "MMM d", "d MMM y" → "d MMM", "dd.MM.y" → "dd.MM". */
  internal fun withoutYear(pattern: String): String =
    pattern.replace(Regex("""(\s*'[^']*')?[\s,./\-]*[yu]+[年.]?"""), "").trim(' ', ',', '/', '-').ifEmpty { "MMM d" }

  /** "4 images", "1 video": what a batch holds. */
  fun batchLabel(items: List<ArtifactItem>): String {
    val kinds = items.map { it.kind }.toSet()
    val n = items.size
    val s = if (n == 1) "" else "s"
    return when (if (kinds.size == 1) kinds.first() else "") {
      "image" -> "$n image$s"
      "video" -> "$n video$s"
      "audio" -> "$n sound$s"
      else -> "$n file$s"
    }
  }

  /** Plural label for a kind, as the filters and clean-up rows show it. */
  fun kindLabel(kind: String): String = when (kind) {
    "image" -> "Images"
    "video" -> "Videos"
    "audio" -> "Audio"
    "pdf" -> "PDFs"
    "document" -> "Documents"
    "text" -> "Notes"
    else -> "Other files"
  }

  fun deleteTitle(a: ArtifactItem): String = if (a.keepsOriginal) "Remove from Mercury? (your file stays)" else "Delete this file?"

  fun deleteDetail(a: ArtifactItem): String =
    if (a.keepsOriginal) "Removes it from Mercury. The file in your project stays." else "Deletes the file."

  /** Confirming several: how many, and what happens to files in projects. */
  fun deleteDetail(items: List<ArtifactItem>): String {
    val kept = items.count { it.keepsOriginal }
    if (items.size == 1) return deleteDetail(items[0])
    if (kept == 0) return "Deletes the files."
    if (kept == items.size) return "Removes them from Mercury. The files in your projects stay."
    return "Deletes the files. $kept in your projects stay; only Mercury's copies go."
  }

  /** Under the clean-up actions: what deleting does to files in projects (`outside` from usage). */
  fun outsideNote(outside: Int): String =
    if (outside > 0) {
      "$outside artifact${if (outside == 1) " is a file" else "s are files"} in your projects: deleting removes " +
        "${if (outside == 1) "it" else "them"} from Mercury, ${if (outside == 1) "the file stays" else "the files stay"}."
    } else "Deleting removes the files from your output folder too."
}

// MARK: Calls

suspend fun MercuryClient.artifacts(kind: String? = null, query: String? = null, cursor: String? = null, limit: Int = 40): ArtifactPage {
  val q = buildList {
    add("limit=$limit")
    if (kind != null && kind != "all") add("kind=${MercuryClient.q(kind)}")
    if (!query.isNullOrEmpty()) add("q=${MercuryClient.q(query)}")
    if (cursor != null) add("cursor=${MercuryClient.q(cursor)}")
  }.joinToString("&")
  return decode(ArtifactPage.serializer(), request("GET", "/api/artifacts?$q"))
}

/** GET /api/artifacts/:id/file as a full URL. */
fun MercuryClient.artifactFileUrl(id: String): String = "${baseUrl.trimEnd('/')}/api/artifacts/${MercuryClient.q(id)}/file"

/**
 * A file at [url] downloaded (with the token when it is this Mercury's) into [cacheDir]/media,
 * kept there so viewing, sharing and thumbnails reuse one download.
 */
suspend fun MercuryClient.cachedFile(url: String, name: String?, cacheDir: File): File {
  val key = java.lang.Long.toString(fnv1a(url) ushr 1, 36)
  val fallback = url.substringAfterLast('/').substringBefore('?').let { if (it.isEmpty()) "file" else it }
  val clean = (name?.takeIf { it.isNotEmpty() } ?: fallback).replace('/', '-')
  val dest = File(File(cacheDir, "media/$key"), clean)
  if (dest.exists() && dest.length() > 0) return dest
  downloadTo(url, dest)
  return dest
}

/** DELETE /api/artifacts/:id: Mercury's copy, and the original when Mercury owns it. */
suspend fun MercuryClient.deleteArtifact(id: String): ArtifactRemoved =
  decode(ArtifactRemoved.serializer(), request("DELETE", "/api/artifacts/${MercuryClient.q(id)}"))

/** GET /api/artifacts/usage: the space artifacts take, as the disk counts it, per kind. */
suspend fun MercuryClient.artifactUsage(): ArtifactUsage = decode(ArtifactUsage.serializer(), request("GET", "/api/artifacts/usage"))

/** POST /api/artifacts/delete: many at once, by ids or by a kind / an age, or everything. */
suspend fun MercuryClient.deleteArtifacts(scope: ArtifactCleanup): ArtifactRemoved =
  decode(ArtifactRemoved.serializer(), request("POST", "/api/artifacts/delete", scope.body()), 60)

/** FNV-1a: a cache key that never changes between launches. */
fun fnv1a(s: String): Long {
  var h = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
  for (b in s.toByteArray()) { h = (h xor (b.toLong() and 0xff)) * 0x100000001b3L }
  return h
}
