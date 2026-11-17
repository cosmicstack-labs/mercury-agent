package sh.mercuryagent.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The composer's model pill and picker (Mercury Desktop: views/chat/Composer.tsx's model menu).
// Mercury has no per-chat model: GET /api/chat/models lists what every configured provider offers
// and which one is current; POST /api/chat/models/switch changes Mercury's model for every chat
// (it isn't owner-gated). "Auto" is the default Mercury is configured with
// (GET /api/providers/settings `default`), so picking it goes back to that.

/** One model a provider offers (GET /api/chat/models `providers[]`). */
@Serializable
data class ModelChoice(
  /** The provider's id ("anthropic", "openrouter"). */
  val name: String,
  val model: String,
  val label: String? = null,
  /** The family Mercury files it under ("Claude", "GPT"), for the picker's groups. */
  val group: String? = null,
  val available: Boolean = true,
  val isCurrent: Boolean = false,
) {
  val title: String get() = label?.takeIf { it.isNotBlank() } ?: model
  fun same(provider: String, model: String) = name == provider && this.model == model
}

/** Every model, the current one, and what Mercury runs by default. */
data class ModelCatalog(
  val models: List<ModelChoice>,
  val current: ModelChoice?,
  /** The configured default (provider, model): "Auto". Null when this Mercury didn't say. */
  val default: Pair<String, String>? = null,
  val notices: List<String> = emptyList(),
) {
  /** Running the configured default: the pill says "Auto". */
  val isAuto: Boolean get() = current != null && default != null && current.same(default.first, default.second)
  /** What the pill says. */
  val pill: String get() = if (isAuto || current == null) "Auto" else current.title
  val defaultChoice: ModelChoice? get() = default?.let { (p, m) -> models.firstOrNull { it.same(p, m) } ?: ModelChoice(p, m) }
}

/** The picker's rows: "Auto" first, then the models by group, filtered as you type. */
object ModelMenu {
  data class Group(val title: String, val models: List<ModelChoice>)

  fun groups(models: List<ModelChoice>, query: String = ""): List<Group> {
    val q = query.trim()
    val shown = if (q.isEmpty()) models else models.filter {
      it.title.contains(q, true) || it.model.contains(q, true) || it.name.contains(q, true) || (it.group?.contains(q, true) == true)
    }
    val out = LinkedHashMap<String, MutableList<ModelChoice>>()
    for (m in shown) out.getOrPut(m.group?.takeIf { it.isNotBlank() } ?: providerName(m.name)) { mutableListOf() } += m
    return out.map { Group(it.key, it.value) }
  }

  /** "openrouter" → "OpenRouter", "mercuryCloud" → "Mercury Cloud". */
  fun providerName(id: String): String = when (id) {
    "openai" -> "OpenAI"
    "openrouter" -> "OpenRouter"
    "anthropic" -> "Anthropic"
    "deepseek" -> "DeepSeek"
    "mercuryCloud" -> "Mercury Cloud"
    "ollama" -> "Ollama"
    "lmstudio" -> "LM Studio"
    else -> id.replace(Regex("([a-z])([A-Z])"), "$1 $2").replaceFirstChar { it.uppercase() }
  }

  /** Where a pick goes: Auto goes back to the configured default. */
  fun target(c: ModelCatalog, pick: ModelChoice?): Pair<String, String>? =
    if (pick == null) c.default else pick.name to pick.model
}

@Serializable private class ModelsReply(
  val providers: List<ModelChoice> = emptyList(),
  val current: ModelChoice? = null,
  val notices: List<String> = emptyList(),
)

/** What models there are and which runs now; with the configured default when Mercury says. */
suspend fun MercuryClient.modelCatalog(sessionId: String? = null): ModelCatalog {
  val path = "/api/chat/models" + (sessionId?.let { "?sessionId=${MercuryClient.q(it)}" } ?: "")
  val r = decode(ModelsReply.serializer(), request("GET", path), 30)
  val default = runCatching { providerSettings().defaultModel }.getOrNull()?.takeIf { it.provider.isNotEmpty() }
  val current = r.providers.firstOrNull { it.isCurrent } ?: r.current
  return ModelCatalog(r.providers, current, default?.let { it.provider to it.model.ifEmpty { current?.model.orEmpty() } }, r.notices)
}

/** Switches Mercury's model (every chat). Throws with Mercury's words when it says no. */
suspend fun MercuryClient.switchModel(provider: String, model: String) {
  val j: JsonObject = json(request("POST", "/api/chat/models/switch", buildJsonObject { put("provider", provider); put("model", model) }), 30)
  if (j.bool("ok") == false || j.bool("success") == false) throw MercuryException.Server(200, j.str("message") ?: j.str("error") ?: "Mercury couldn't switch to that model.")
}
