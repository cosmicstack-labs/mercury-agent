package sh.mercuryagent.core

import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Plugins from the phone: the list, install, on/off, update and remove, over the API Mercury
// Desktop uses (src/web/api/plugins.ts, apps/desktop/src/views/plugins; iOS: MercuryCore/Plugins.swift).
// Every change runs code on the computer, so from a phone it needs the owner's approval (428 → OwnerGate).

/** GET /api/plugins: installed plugins and the catalog, merged into one list. */
@Serializable
data class PluginList(
  val items: List<PluginDetail> = emptyList(),
  val catalogError: String? = null,
  val stale: Boolean = false,
  val safeMode: Boolean = false,
)

/** POST /api/plugins/install's answer. */
@Serializable
data class PluginInstalled(val id: String = "", val name: String? = null, val version: String? = null, val unchanged: Boolean? = null)

/** The decisions behind the Plugins screens, kept apart from the UI so they're tested on the JVM. */
object Plugins {
  /**
   * A Mercury takes plugin changes from a phone when it has the plugins API and the owner's approval
   * for remote changes (before `security.remote`, remote plugin changes were refused).
   */
  val manageFeatures = listOf("plugins", "security.remote")

  fun canManage(features: Collection<String>?): Boolean = features != null && features.containsAll(manageFeatures)

  /**
   * Installed means an installed version. GET /api/plugins/:id also answers for a plugin that's only
   * in the catalog (no installedVersion, no settings): that isn't installed.
   */
  fun isInstalled(p: PluginDetail?): Boolean = p?.installedVersion != null

  /** Plugins that use the screen, mouse and keyboard. The catalog doesn't say so, so known ones are named. */
  val desktopPlugins = setOf("optimus")

  fun controlsComputer(p: PluginDetail): Boolean = p.permissions?.desktop == true || p.id in desktopPlugins

  fun updateAvailable(p: PluginDetail): Boolean = isInstalled(p) && p.status == "update-available"

  fun installed(items: List<PluginDetail>) = items.filter { isInstalled(it) }
  fun available(items: List<PluginDetail>) = items.filter { !isInstalled(it) }

  enum class Tone { Good, Off, Warn }

  /** The line under a plugin's name. */
  fun statusLine(p: PluginDetail): Pair<String, Tone> {
    if (!isInstalled(p)) {
      if (p.status == "incompatible") return (needsComputerLine(p) ?: "Can't be installed on this computer") to Tone.Off
      return p.description.orEmpty() to Tone.Off
    }
    if (p.status == "error" || (p.enabled && p.lastError != null && !p.running)) {
      return (p.lastError?.let { friendlyError(it, p) } ?: "Isn't running") to Tone.Warn
    }
    if (!p.enabled) return (if (p.disabled == null || p.disabled.code == "user") "Off" else p.disabled.message ?: "Off") to Tone.Off
    if (p.missing.isNotEmpty()) return "Needs setting up" to Tone.Warn
    return "On" to Tone.Good
  }

  // MARK: Asking first

  /** What's shown before a plugin is installed or turned on. */
  sealed interface Consent {
    val title: String
    /** It controls the computer: one clear sentence. */
    data class ControlsComputer(override val title: String, val body: String) : Consent
    /** Anything else: what it can reach. */
    data class Access(override val title: String, val lines: List<String>) : Consent
  }

  fun consent(p: PluginDetail, computer: String, enabling: Boolean = false): Consent {
    val verb = if (enabling) "Turn on" else "Install"
    if (controlsComputer(p)) {
      return Consent.ControlsComputer(
        "$verb ${p.name}?",
        "${p.name} lets Mercury see the screen and use the mouse and keyboard on $computer. It asks before anything that submits, sends or deletes.",
      )
    }
    return Consent.Access("$verb ${p.name}?", accessLines(p, computer))
  }

  /** What a plugin can reach, one line each. */
  fun accessLines(p: PluginDetail, computer: String): List<String> {
    val lines = mutableListOf<String>()
    if (controlsComputer(p)) lines += "Sees the screen and uses the mouse and keyboard on $computer"
    val hosts = p.permissions?.network.orEmpty()
    if (hosts.size > 3) lines += "Connects to ${hosts.size} services, like ${hosts.take(2).joinToString(" and ")}"
    else if (hosts.isNotEmpty()) lines += "Connects to ${hosts.joinToString(", ")}"
    val secrets = p.permissions?.secrets.orEmpty()
    if (secrets.isNotEmpty()) {
      lines += "Can read ${if (secrets.size == 1) "the key" else "${secrets.size} keys"} it needs: ${secrets.take(3).joinToString(", ")}${if (secrets.size > 3) "…" else ""}"
    }
    p.permissions?.providers.orEmpty().toSortedMap().forEach { (id, need) ->
      lines += "Uses your ${providerName(id)} key" + (need.unlocks?.let { " for ${it.replaceFirstChar { c -> c.lowercaseChar() }}" } ?: "")
    }
    if (p.tools.isNotEmpty()) lines += "Gives Mercury ${p.tools.size} tool${if (p.tools.size == 1) "" else "s"}"
    lines += if (p.kind == "in-process") "Runs inside Mercury on $computer" else "Runs in its own process on $computer"
    if (hosts.isEmpty() && secrets.isEmpty() && !controlsComputer(p)) lines += "Doesn't reach the internet or read any keys"
    return lines
  }

  private fun providerName(id: String) = when (id) {
    "openai" -> "OpenAI"
    "grok", "xai" -> "Grok"
    "gemini", "google" -> "Gemini"
    "anthropic" -> "Anthropic"
    else -> id.replaceFirstChar { it.uppercaseChar() }
  }

  // MARK: Errors

  private fun needsComputerLine(p: PluginDetail): String? =
    if (controlsComputer(p)) "${p.name} needs a desktop computer (a Mac, Windows or Linux with a screen)" else null

  /**
   * The server's error in plain words. Install refuses a platform it has no build for ("Optimus can't
   * be installed here: not available for android-arm64 …"); on a server with no screen it installs but
   * can't start (the error then mentions the display).
   */
  fun friendlyError(message: String, p: PluginDetail): String {
    val m = message.lowercase()
    val platform = "can't be installed here" in m || "not available for" in m
    val noScreen = listOf("display", "x11", "xcb", "wayland", "no screen").any { it in m }
    val line = needsComputerLine(p)
    if (line != null && (platform || noScreen)) return "$line. This Mercury runs where there isn't one."
    if ("safe mode" in m) return "Mercury is in safe mode, so plugins are off. Restart Mercury normally to use them."
    return message
  }

  fun needsComputer(message: String): Boolean = "needs a desktop computer" in message

  // MARK: After installing

  /** Where a plugin stands once an install or turn-on went through. */
  sealed interface After {
    /** Installed and running. */
    data object Running : After
    /** Installed and on, but it wants something set first. */
    data object NeedsSetup : After
    /** Installed, still starting. */
    data object Starting : After
    /** Installed, but it didn't start: why. */
    data class Failed(val why: String) : After
    /** Not there at all. */
    data object Missing : After
  }

  fun after(p: PluginDetail?): After {
    if (p == null || !isInstalled(p)) return After.Missing
    (p.lastError ?: if (p.status == "error") "It didn't start." else null)?.let { return After.Failed(friendlyError(it, p)) }
    if (!p.enabled && p.disabled != null && p.disabled.code != "user") return After.Failed(p.disabled.message ?: "It was turned off.")
    if (p.missing.isNotEmpty()) return After.NeedsSetup
    if (p.running || (p.enabled && p.kind == "in-process")) return After.Running
    return After.Starting
  }

  /**
   * After an install or turn-on went through: look at the plugin until it's running, wants setting up,
   * or failed ([times] looks, [everyMs] apart). Returns where it ended and the plugin as last seen.
   */
  suspend fun watch(client: MercuryClient, id: String, times: Int = 20, everyMs: Long = 1000): Pair<After, PluginDetail?> {
    var last: PluginDetail? = null
    var after: After = After.Missing
    for (i in 0 until maxOf(1, times)) {
      runCatching { client.plugin(id) }.getOrNull()?.let { last = it }
      after = after(last)
      if (after != After.Starting && after != After.Missing) break
      if (i < times - 1) delay(everyMs)
    }
    return after to last
  }
}

/** GET /api/plugins (`refresh`: check the catalog again). */
suspend fun MercuryClient.pluginList(refresh: Boolean = false): PluginList =
  decode(PluginList.serializer(), request("GET", if (refresh) "/api/plugins?refresh=1" else "/api/plugins"), 30)

/** Installs a catalog plugin and turns it on. The computer downloads it, so it can take a while. */
suspend fun MercuryClient.installPlugin(id: String, approval: String? = null): PluginInstalled {
  val body = buildJsonObject { put("source", id); put("enable", true) }
  return decode(PluginInstalled.serializer(), gated("POST", "/api/plugins/install", body, approval), 600)
}

@Serializable private class PluginOk(val ok: Boolean? = null)

suspend fun MercuryClient.setPluginEnabled(id: String, on: Boolean, approval: String? = null) {
  decode(PluginOk.serializer(), gated("POST", "/api/plugins/${MercuryClient.q(id)}/${if (on) "enable" else "disable"}", null, approval), 120)
}

/** Updates one plugin to the catalog's version. */
suspend fun MercuryClient.updatePlugin(id: String, approval: String? = null) {
  json(gated("POST", "/api/plugins/${MercuryClient.q(id)}/update", null, approval), 600)
}

/** Removes a plugin (its settings stay unless [purge]). */
suspend fun MercuryClient.uninstallPlugin(id: String, purge: Boolean = false, approval: String? = null) {
  decode(PluginOk.serializer(), gated("DELETE", "/api/plugins/${MercuryClient.q(id)}${if (purge) "?purge=1" else ""}", null, approval), 120)
}
