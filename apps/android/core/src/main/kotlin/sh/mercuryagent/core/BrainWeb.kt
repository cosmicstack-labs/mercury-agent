package sh.mercuryagent.core

import java.net.URLEncoder
import kotlinx.serialization.Serializable

// The second brain's mind map, ported from Mercury Desktop (apps/desktop/src/views/brain/NoteWeb.tsx,
// MindMap.tsx, NoteHoverCard.tsx). Everything here is pure and matches the desktop's output exactly:
// toWeb (dots and lines), themeColors (FNV-1a hues with collision skipping) and shortLabel. The same
// functions live in iOS's MercuryCore (BrainWeb.swift); the test suites share their cases.

/** GET /api/brain/map: themes → sub-themes → notes, with the sparse "related" links (src/memory/knowledge-map.ts). */
@Serializable
data class BrainMap(
  val themes: List<Theme> = emptyList(),
  /** note id → the theme (or sub-theme) it sits in. */
  val placement: Map<String, String> = emptyMap(),
  val links: List<Link> = emptyList(),
  val notes: List<Note> = emptyList(),
) {
  @Serializable
  data class Theme(val id: String, val label: String = id, val terms: List<String> = emptyList(), val parent: String? = null, val size: Int = 0)

  @Serializable
  data class Link(val a: String, val b: String, val w: Double = 0.0)

  @Serializable
  data class Note(
    val id: String,
    val text: String = "",
    val kind: String = "",
    val at: Double = 0.0,
    val confidence: Double = 0.0,
    val archived: Boolean = false,
  )
}

/** GET /api/brain/memory/:id: one note's full record. Times are milliseconds since 1970. */
@Serializable
data class BrainMemory(
  val id: String,
  val type: String = "",
  val summary: String = "",
  val detail: String? = null,
  val evidenceKind: String? = null,
  val confidence: Double = 0.0,
  val evidenceCount: Int? = null,
  val createdAt: Double? = null,
  val updatedAt: Double? = null,
)

/** GET /api/brain/map[?archive=1]. */
suspend fun MercuryClient.brainMap(archive: Boolean = false): BrainMap =
  decode(BrainMap.serializer(), request("GET", "/api/brain/map" + if (archive) "?archive=1" else ""), 30)

/** GET /api/brain/memory/:id. */
suspend fun MercuryClient.brainMemory(id: String): BrainMemory =
  decode(BrainMemory.serializer(), request("GET", "/api/brain/memory/" + URLEncoder.encode(id, "UTF-8").replace("+", "%20")))

/** One dot: a note, its top theme's colour, and how many lines it has. */
data class WebNode(val id: String, val label: String, val theme: String, val color: String, val degree: Int, val kind: String)

/** One line, by node index into [WebGraph.nodes] (desktop: source/target ids). */
data class WebLink(val source: Int, val target: Int, val w: Double)

data class WebGraph(val nodes: List<WebNode> = emptyList(), val links: List<WebLink> = emptyList()) {
  /** The link list as ids, for parity checks with the desktop's output. */
  val linkIds: List<Pair<String, String>> get() = links.map { nodes[it.source].id to nodes[it.target].id }
}

data class LocalGraph(val id: String, val depth: Int)

data class WebOptions(
  val orphans: Boolean = true,
  val hidden: Set<String> = emptySet(),
  val query: String = "",
  val local: LocalGraph? = null,
)

object BrainWeb {
  const val LOOSE = "loose"
  /** Twelve hues that read on light and dark; a theme keeps its hue while its id lives. */
  val HUES = listOf("#5B8DEF", "#E0739B", "#3FB37F", "#D4A72C", "#9B7BD8", "#E8894A", "#2BB5C9", "#C9644F", "#7AA33B", "#B565C9", "#4F9AA8", "#D08A2E")
  const val LOOSE_COLOR = "#8A97A3"
  val KIND_LABEL = mapOf(
    "fact" to "Fact", "preference" to "Preference", "trait" to "Trait", "situation" to "Situation", "relationship" to "Relationship", "goal" to "Goal", "project" to "Project",
    "episode" to "Moment", "identity" to "Identity", "habit" to "Habit", "decision" to "Decision", "constraint" to "Constraint", "reflection" to "Reflection",
  )

  /** FNV-1a over UTF-16 code units, as the desktop's `hash` (Math.imul, >>> 0). */
  fun hash(s: String): Long {
    var h = 2166136261L.toInt()
    for (c in s) { h = h xor c.code; h *= 16777619 }
    return h.toLong() and 0xFFFFFFFFL
  }

  /** Stable colours: each theme hashes to a hue; clashes step to the next free one. */
  fun themeColors(ids: List<String>): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    val used = HashSet<Int>()
    for (id in ids) {
      if (id == LOOSE) { out[id] = LOOSE_COLOR; continue }
      var i = (hash(id) % HUES.size).toInt()
      var k = 0
      while (k < HUES.size && i in used) { i = (i + 1) % HUES.size; k++ }
      used.add(i)
      if (used.size == HUES.size) used.clear()
      out[id] = HUES[i]
    }
    return out
  }

  /** Top-level themes, biggest first, Loose last (the desktop's order for colours and Groups). Stable. */
  fun tops(m: BrainMap): List<BrainMap.Theme> =
    m.themes.filter { it.parent == null }.sortedWith { a, b -> if (a.id == LOOSE) 1 else if (b.id == LOOSE) -1 else b.size - a.size }

  /** A note's top theme (sub-themes roll up to their parent; unplaced notes are Loose). */
  fun topOf(m: BrainMap, noteId: String): String {
    val at = m.placement[noteId]
    if (at.isNullOrEmpty()) return LOOSE
    val parent = m.themes.firstOrNull { it.id == at }?.parent
    return parent ?: at
  }

  /** Notes and links → dots and lines, with degree and theme colour (the desktop's toWeb). */
  fun toWeb(m: BrainMap, opts: WebOptions): WebGraph {
    val parentOf = HashMap<String, String?>()
    for (t in m.themes) parentOf[t.id] = t.parent
    fun topOf(id: String?): String = if (id.isNullOrEmpty()) LOOSE else (parentOf[id] ?: id)
    val colors = themeColors(tops(m).map { it.id })
    val q = opts.query.trim().lowercase()

    var keep: Set<String> = m.notes.filter { opts.hidden.contains(topOf(m.placement[it.id])).not() && (q.isEmpty() || it.text.lowercase().contains(q)) }.map { it.id }.toHashSet()
    var links = m.links.filter { it.a in keep && it.b in keep }

    val local = opts.local
    if (local != null && local.id in keep) {
      val adj = HashMap<String, MutableList<String>>()
      for (l in links) { adj.getOrPut(l.a) { mutableListOf() }.add(l.b); adj.getOrPut(l.b) { mutableListOf() }.add(l.a) }
      val seen = hashSetOf(local.id)
      var frontier = listOf(local.id)
      repeat(maxOf(0, local.depth)) {
        val next = mutableListOf<String>()
        for (id in frontier) for (j in adj[id].orEmpty()) if (seen.add(j)) next.add(j)
        frontier = next
      }
      keep = seen
      links = links.filter { it.a in keep && it.b in keep }
    }

    val degree = HashMap<String, Int>()
    for (l in links) { degree[l.a] = (degree[l.a] ?: 0) + 1; degree[l.b] = (degree[l.b] ?: 0) + 1 }
    val nodes = m.notes
      .filter { it.id in keep && (opts.orphans || (degree[it.id] ?: 0) > 0) }
      .map { n -> val theme = topOf(m.placement[n.id]); WebNode(n.id, n.text, theme, colors[theme] ?: LOOSE_COLOR, degree[n.id] ?: 0, n.kind) }
      .sortedWith { a, b -> b.degree - a.degree } // Hubs first, so their labels win the space (stable, like JS).
    val index = HashMap<String, Int>(nodes.size * 2)
    nodes.forEachIndexed { i, n -> index[n.id] = i }
    val out = links.mapNotNull { l -> val s = index[l.a]; val t = index[l.b]; if (s != null && t != null) WebLink(s, t, l.w) else null }
    return WebGraph(nodes, out)
  }

  // Spaces written out: Android's regex engine (ICU) refuses the (?U) flag and the app crashed
  // at start (ICU's \s is Unicode already, the JVM's isn't, so name them for both).
  private const val WS = "\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000"
  private val SPACES = Regex("[$WS]+")
  private val STOP = Regex("[.。]+$")
  private val CLAUSE = Regex("^(.{12,}?)(?:[,;:][$WS]|[$WS][—–-][$WS]|[$WS]\\()")
  private val DANGLING = Regex("[$WS,;:.(—–-]+$")

  /** A note's label for the canvas: its first clause or first few words, never cut mid-word (the desktop's shortLabel). */
  fun shortLabel(text: String, max: Int = 32): String {
    val s = text.replace(SPACES, " ").trim().replace(STOP, "")
    if (s.length <= max) return s
    // A natural break early enough reads better than a cut ("…, and later…").
    val clause = CLAUSE.find(s)
    if (clause != null && clause.groupValues[1].length <= max - 1) return clause.groupValues[1].trimEnd() + "…"
    val cut = s.substring(0, max - 1)
    val space = cut.lastIndexOf(' ')
    val base = if (space >= max * 0.5) cut.substring(0, space) else cut
    return base.replace(DANGLING, "") + "…"
  }

  /** The desktop's node radius: grows with connections, times the Node size setting. */
  fun radius(degree: Int, nodeSize: Double): Double = (2.2 + Math.sqrt(degree.toDouble()) * 1.15) * nodeSize

  /** Label fade: hubs fade in a little sooner; lit labels always show. */
  fun labelAlpha(scale: Double, degree: Int, textFade: Double, lit: Boolean): Double {
    if (lit) return 1.0
    val fadeAt = textFade / (1 + minOf(1.2, degree / 8.0))
    return maxOf(0.0, minOf(1.0, (scale - fadeAt) / (fadeAt * 0.5)))
  }

  /** Unlit line opacity: faint, a little stronger for close notes; fainter still while a note is lit. */
  fun linkAlpha(w: Double, hovering: Boolean): Double = if (hovering) 0.05 else 0.1 + minOf(0.25, w * 0.4)

  /** Neighbours of every node (both ways), by index. */
  fun adjacency(g: WebGraph): List<Set<Int>> {
    val adj = List(g.nodes.size) { HashSet<Int>() }
    for (l in g.links) { adj[l.source].add(l.target); adj[l.target].add(l.source) }
    return adj
  }

  /** A note's related notes in the whole map, strongest first (the note sheet's list). */
  fun related(m: BrainMap, id: String): List<Pair<BrainMap.Note, Double>> {
    val byId = m.notes.associateBy { it.id }
    val out = mutableListOf<Pair<BrainMap.Note, Double>>()
    for (l in m.links) {
      if (l.a == id) byId[l.b]?.let { out.add(it to l.w) } else if (l.b == id) byId[l.a]?.let { out.add(it to l.w) }
    }
    return out.sortedByDescending { it.second }
  }
}

/** The mind map's settings (desktop: localStorage "mercury.brain.web.settings.v1", same field names). */
@Serializable
data class WebSettings(
  val orphans: Boolean = true,
  val nodeSize: Double = 1.0,
  val linkWidth: Double = 1.0,
  /** Zoom level from which labels fade in (Obsidian's "text fade threshold"). */
  val textFade: Double = 1.6,
  val center: Double = 0.06,
  val repel: Double = 40.0,
  val linkForce: Double = 0.5,
  val linkDistance: Double = 34.0,
  val hidden: List<String> = emptyList(),
) {
  val forces: ForceParams get() = ForceParams(center, repel, linkForce, linkDistance, nodeSize)

  fun encode(): String = MercuryJson.encodeToString(serializer(), this)

  companion object {
    const val STORAGE_KEY = "mercury.brain.web.settings.v1"
    val DEFAULTS = WebSettings()

    /** `{ ...DEFAULTS, ...stored }`: missing fields keep their defaults; anything unreadable is the defaults. */
    fun decode(json: String?): WebSettings =
      json?.let { runCatching { MercuryJson.decodeFromString(serializer(), it) }.getOrNull() } ?: DEFAULTS
  }
}
