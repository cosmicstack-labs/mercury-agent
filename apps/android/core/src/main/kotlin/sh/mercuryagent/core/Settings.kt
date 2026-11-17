package sh.mercuryagent.core

import java.time.Instant
import java.util.Locale
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import okhttp3.Request

// The settings Mercury Desktop manages, read and changed over the same API (iOS: MercuryCore/Settings.swift;
// apps/desktop/src/api/*.ts is the reference for every shape here). Changes from a remote device may need
// the owner's go-ahead first (428 → MercuryException.NeedsOwner): repeat them with the approval's id.

// MARK: Owner approval

enum class ApprovalStatus { PENDING, ALLOWED, DENIED, EXPIRED;
  companion object {
    fun from(s: String?): ApprovalStatus? = entries.firstOrNull { it.name.equals(s, ignoreCase = true) }
  }
}

/** GET /api/security/approvals/:id/status: this device's own question. Anything unreadable counts as expired. */
suspend fun MercuryClient.approvalStatus(id: String): ApprovalStatus {
  val reply = send(request("GET", "/api/security/approvals/${MercuryClient.q(id)}/status"))
  return ApprovalStatus.from(parseObject(reply.body).str("status")) ?: ApprovalStatus.EXPIRED
}

/** A request that may need the owner's go-ahead, carrying it (`X-Mercury-Approval`) once it was given. */
fun MercuryClient.gated(method: String, path: String, body: JsonObject? = null, approval: String? = null): Request {
  val r = request(method, path, body)
  return if (approval == null) r else r.newBuilder().header(APPROVAL_HEADER, approval).build()
}

const val APPROVAL_HEADER = "X-Mercury-Approval"

// MARK: Loose JSON values (plugin and channel settings)

/** As text, the way a setting compares and shows ("true", "60", "1.5", "gemini"); "" for null, arrays and objects. */
val JsonElement?.settingText: String
  get() {
    val p = this as? JsonPrimitive ?: return ""
    if (p is JsonNull) return ""
    if (p.isString) return p.content
    p.booleanOrNull?.let { return if (it) "true" else "false" }
    val d = p.doubleOrNull ?: return ""
    return if (d.isFinite() && d == Math.rint(d) && Math.abs(d) < 9.0E15) d.toLong().toString() else d.toString()
  }

/** A JSON boolean (not the string "true"). */
val JsonElement?.settingBool: Boolean?
  get() = (this as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.booleanOrNull

/** A JSON number. */
val JsonElement?.settingNumber: Double?
  get() = (this as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString && it.booleanOrNull == null }?.doubleOrNull

// MARK: Models

@Serializable
data class ProviderInfo(
  val id: String,
  val label: String = "",
  val kind: String = "",
  val blurb: String = "",
  val needsKey: Boolean = false,
  val needsBaseUrl: Boolean = false,
  val signInOnly: Boolean = false,
  val keyUrl: String? = null,
  val keyHint: String? = null,
  /** Masked ("sk-a••••b3c4"); never sent back. */
  val apiKey: String = "",
  val hasKey: Boolean = false,
  val baseUrl: String = "",
  val model: String = "",
  val enabled: Boolean = false,
  val configured: Boolean = false,
  val isDefault: Boolean = false,
  val recommended: Boolean = false,
)

object ProviderInfoList : KSerializer<List<ProviderInfo>> by LossyList(ProviderInfo.serializer())

@Serializable
data class ProviderSettings(
  @Serializable(with = ProviderInfoList::class) val providers: List<ProviderInfo> = emptyList(),
  @SerialName("default") val defaultModel: Default = Default(),
  val roles: Roles = Roles(),
) {
  @Serializable data class Default(val provider: String = "", val model: String = "")
  /** Which provider learning and bot crews use; null means the same as chat. */
  @Serializable data class Roles(val learning: String? = null, val crew: String? = null)
}

@Serializable
data class ProviderCheck(
  val ok: Boolean = false,
  val models: List<String>? = null,
  val recommendedModel: String? = null,
  val error: String? = null,
  val field: String? = null,
)

@Serializable
data class SaveResult(
  val success: Boolean? = null,
  val applied: Boolean? = null,
  val restarting: Boolean? = null,
  val restartRequired: Boolean? = null,
  val error: String? = null,
)

/** A role's provider for [setModelRoles]: a provider id, or null for "same as chat". */
data class RoleChoice(val provider: String?)

suspend fun MercuryClient.providerSettings(): ProviderSettings =
  decode(ProviderSettings.serializer(), request("GET", "/api/providers/settings"))

/** A live check of what's typed; an omitted key means the saved one. Lists the models it offers. */
suspend fun MercuryClient.checkProvider(id: String, apiKey: String? = null, baseUrl: String? = null): ProviderCheck {
  val body = buildJsonObject {
    apiKey?.let { put("apiKey", it) }
    baseUrl?.let { put("baseUrl", it) }
  }
  return decode(ProviderCheck.serializer(), request("POST", "/api/providers/${MercuryClient.q(id)}/check", body), 30)
}

suspend fun MercuryClient.saveProvider(
  id: String,
  apiKey: String? = null,
  baseUrl: String? = null,
  model: String? = null,
  enabled: Boolean? = null,
  approval: String? = null,
): SaveResult {
  val body = buildJsonObject {
    apiKey?.let { put("apiKey", it) }
    baseUrl?.let { put("baseUrl", it) }
    model?.let { put("model", it) }
    enabled?.let { put("enabled", it) }
  }
  return decode(SaveResult.serializer(), gated("POST", "/api/providers/${MercuryClient.q(id)}", body, approval), 30)
}

suspend fun MercuryClient.forgetProviderKey(id: String, approval: String? = null): SaveResult =
  decode(SaveResult.serializer(), gated("DELETE", "/api/providers/${MercuryClient.q(id)}/key", null, approval))

/**
 * PUT /api/providers/roles: the default model, and which provider learning and bot crews use.
 * A null [learning] or [crew] leaves it alone; `RoleChoice(null)` sets it back to "same as chat".
 */
suspend fun MercuryClient.setModelRoles(
  defaultProvider: String? = null,
  model: String? = null,
  learning: RoleChoice? = null,
  crew: RoleChoice? = null,
  approval: String? = null,
): SaveResult {
  val body = buildJsonObject {
    if (defaultProvider != null) {
      put("default", buildJsonObject { put("provider", defaultProvider); model?.let { put("model", it) } })
    }
    learning?.let { r -> if (r.provider == null) put("learning", JsonNull) else put("learning", r.provider) }
    crew?.let { r -> if (r.provider == null) put("crew", JsonNull) else put("crew", r.provider) }
  }
  return decode(SaveResult.serializer(), gated("PUT", "/api/providers/roles", body, approval))
}

// MARK: Plugin settings (Voice is Optimus's)

/** One setting a plugin declares, with when it applies. */
@Serializable
data class PluginField(
  val key: String,
  /** boolean, enum, secret, number, string… */
  val type: String = "string",
  val label: String? = null,
  val description: String? = null,
  val options: List<String>? = null,
  val optionLabels: Map<String, String>? = null,
  val value: JsonElement? = null,
  val isSet: Boolean? = null,
  val group: String? = null,
  /** One condition (an object) or several (an array of objects, any of them). */
  @SerialName("when") val whenRaw: JsonElement? = null,
) {
  /** The conditions, any one of which makes it apply. */
  val conditions: List<JsonObject>
    get() = when (val w = whenRaw) {
      is JsonObject -> listOf(w)
      is JsonArray -> w.mapNotNull { it as? JsonObject }
      else -> emptyList()
    }

  /** Does it apply, given the current values? (Mirrors the runtime's `whenMatches`.) */
  fun applies(values: Map<String, JsonElement?>): Boolean {
    val all = conditions
    if (all.isEmpty()) return true
    return all.any { cond ->
      cond.all { (key, want) ->
        val v = values[key].settingText
        if (want is JsonArray) want.any { it.settingText == v } else want.settingText == v
      }
    }
  }
}

object PluginFieldList : KSerializer<List<PluginField>> by LossyList(PluginField.serializer())

@Serializable
data class PluginGroup(val id: String, val label: String = "", val description: String? = null, val ready: Boolean = false)

@Serializable
data class PluginMissing(val key: String = "", val needs: String = "", val fix: String = "")

/**
 * One plugin as GET /api/plugins lists it and GET /api/plugins/:id describes it (PluginListItem in
 * src/plugins/types.ts). A catalog-only entry (not installed) has no [installedVersion].
 */
@Serializable
data class PluginDetail(
  val id: String,
  val name: String = "",
  val enabled: Boolean = false,
  val running: Boolean = false,
  val installedVersion: String? = null,
  @Serializable(with = PluginFieldList::class) val settings: List<PluginField> = emptyList(),
  val settingGroups: List<PluginGroup> = emptyList(),
  val missing: List<PluginMissing> = emptyList(),
  val description: String? = null,
  /** "in-process" or "out-of-process". */
  val kind: String? = null,
  /** "official", "community" or "local". */
  val tier: String? = null,
  /** available, installed, enabled, disabled, update-available, incompatible, error. */
  val status: String? = null,
  val latestVersion: String? = null,
  val sizeBytes: Long? = null,
  val tools: List<String> = emptyList(),
  val permissions: PluginPermissions? = null,
  val disabled: PluginDisabled? = null,
  val lastError: String? = null,
  val incompatibleReason: String? = null,
)

@Serializable
data class PluginDisabled(val code: String? = null, val message: String? = null)

/** What a plugin may reach (the manifest's `permissions`; a catalog entry only has network and secrets). */
@Serializable
data class PluginPermissions(
  val network: List<String> = emptyList(),
  val secrets: List<String> = emptyList(),
  /** It sees the screen and uses the mouse and keyboard (Plugin API 1.2). */
  val desktop: Boolean? = null,
  val optionalSecrets: Map<String, String>? = null,
  val providers: Map<String, PluginProviderNeed>? = null,
)

@Serializable
data class PluginProviderNeed(val unlocks: String? = null)

@Serializable
data class VoiceKeyCheck(val ok: Boolean = false, val verified: Boolean = false, val message: String = "")

@Serializable private class PluginReply(val plugin: PluginDetail? = null)
@Serializable private class OkReply(val ok: Boolean? = null)

/** GET /api/plugins/:id; null when it isn't installed. */
suspend fun MercuryClient.plugin(id: String): PluginDetail? = try {
  decode(PluginReply.serializer(), request("GET", "/api/plugins/${MercuryClient.q(id)}")).plugin
} catch (e: MercuryException.Server) {
  if (e.code == 404) null else throw e
}

/** POST /api/plugins/:id/settings `{ key, value }`. */
suspend fun MercuryClient.setPluginSetting(id: String, key: String, value: JsonElement, approval: String? = null) {
  val body = buildJsonObject { put("key", key); put("value", value) }
  // A plugin may restart to read the change; newer servers answer first, older ones only after it.
  decode(OkReply.serializer(), gated("POST", "/api/plugins/${MercuryClient.q(id)}/settings", body, approval), timeoutSeconds = 60)
}

/** POST /api/voice/check: is this voice key good? With no key, checks the saved one. */
suspend fun MercuryClient.checkVoiceKey(vendor: String, key: String? = null): VoiceKeyCheck {
  val body = buildJsonObject { put("vendor", vendor); key?.let { put("key", it) } }
  return decode(VoiceKeyCheck.serializer(), request("POST", "/api/voice/check", body), 30)
}

// MARK: Channels

@Serializable
data class ChannelPerson(
  val id: String,
  val name: String = "",
  val detail: String? = null,
  val role: String? = null,
  val code: String? = null,
)

object ChannelPersonList : KSerializer<List<ChannelPerson>> by LossyList(ChannelPerson.serializer())

@Serializable
data class ChannelAccess(
  @Serializable(with = ChannelPersonList::class) val admins: List<ChannelPerson> = emptyList(),
  @Serializable(with = ChannelPersonList::class) val members: List<ChannelPerson> = emptyList(),
  @Serializable(with = ChannelPersonList::class) val pending: List<ChannelPerson> = emptyList(),
)

@Serializable
data class ChannelInfo(
  val type: String,
  val label: String = "",
  val enabled: Boolean = false,
  val configured: Boolean = false,
  val running: Boolean = false,
  /** Keys masked; has<Key> says whether one is saved. */
  val settings: JsonObject = JsonObject(emptyMap()),
  val access: ChannelAccess = ChannelAccess(),
) {
  val id: String get() = type
}

object ChannelInfoList : KSerializer<List<ChannelInfo>> by LossyList(ChannelInfo.serializer())

@Serializable
data class ChannelCheck(val ok: Boolean = false, val identity: String? = null, val message: String = "", val field: String? = null)

@Serializable private class ChannelsReply(@Serializable(with = ChannelInfoList::class) val channels: List<ChannelInfo> = emptyList())
@Serializable private class ChannelReply(val channel: ChannelInfo, val error: String? = null)

suspend fun MercuryClient.channels(): List<ChannelInfo> =
  decode(ChannelsReply.serializer(), request("GET", "/api/channels")).channels

/** POST /api/channels/:type/check with what's typed (empty fields left out). */
suspend fun MercuryClient.checkChannel(type: String, draft: JsonObject): ChannelCheck =
  decode(ChannelCheck.serializer(), request("POST", "/api/channels/${MercuryClient.q(type)}/check", draft), 30)

suspend fun MercuryClient.saveChannel(type: String, patch: JsonObject, approval: String? = null): ChannelInfo =
  decode(ChannelReply.serializer(), gated("PUT", "/api/channels/${MercuryClient.q(type)}", patch, approval), 30).channel

/** approve · reject · remove · promote · demote, for one person. */
suspend fun MercuryClient.channelAccess(type: String, action: String, id: String, approval: String? = null): ChannelInfo {
  val body = buildJsonObject { put("action", action); put("id", id) }
  return decode(ChannelReply.serializer(), gated("POST", "/api/channels/${MercuryClient.q(type)}/access", body, approval)).channel
}

// MARK: Budgets

@Serializable
data class BudgetState(
  val daily: Daily = Daily(),
  val saver: Saver = Saver(),
  val bots: Bots = Bots(),
) {
  @Serializable data class Daily(val budget: Long = 0, val used: Long = 0, val remaining: Long = 0, val percentage: Double = 0.0)
  @Serializable data class Saver(
    /** "on" or "off" */
    val state: String = "off",
    val autoEnabled: Boolean = false,
    val autoThreshold: Int = 75,
    val savedToday: Long = 0,
    val savedLifetime: Long = 0,
  )
  @Serializable data class Bots(val enabled: Boolean = false, val perBot: Long = 0, val fleet: Long = 0)
}

suspend fun MercuryClient.budget(): BudgetState = decode(BudgetState.serializer(), request("GET", "/api/budget"))

/** dailyBudget · saver { manual, autoEnabled, autoThreshold } · bots { perBot, fleet } */
suspend fun MercuryClient.setBudget(patch: JsonObject, approval: String? = null): BudgetState =
  decode(BudgetState.serializer(), gated("PUT", "/api/budget", patch, approval))

// MARK: Activity

@Serializable
data class UsageDay(
  /** yyyy-MM-dd */
  val date: String,
  val tokens: Long = 0,
  val inputTokens: Long = 0,
  val outputTokens: Long = 0,
  val requests: Int = 0,
) {
  val id: String get() = date
}

object UsageDayList : KSerializer<List<UsageDay>> by LossyList(UsageDay.serializer())

@Serializable private class UsageReply(@Serializable(with = UsageDayList::class) val days: List<UsageDay> = emptyList())

/** GET /api/usage/history?days=n: oldest first, one entry a day. */
suspend fun MercuryClient.usageHistory(days: Int): List<UsageDay> =
  decode(UsageReply.serializer(), request("GET", "/api/usage/history?days=$days"), 20).days

// MARK: Paired devices

@Serializable
data class PairedDevice(
  val id: String,
  val name: String = "",
  val platform: String = "",
  @SerialName("createdAt") val createdAtRaw: JsonElement? = null,
  @SerialName("lastSeenAt") val lastSeenAtRaw: JsonElement? = null,
) {
  val createdAt: Instant? get() = createdAtRaw.asInstant()
  val lastSeenAt: Instant? get() = lastSeenAtRaw.asInstant()
}

object PairedDeviceList : KSerializer<List<PairedDevice>> by LossyList(PairedDevice.serializer())

/** Every device with a token, and which one is asking. */
@Serializable
data class PairedDevices(
  @Serializable(with = PairedDeviceList::class) val devices: List<PairedDevice> = emptyList(),
  val current: String? = null,
)

@Serializable private class SuccessReply(val success: Boolean? = null)

suspend fun MercuryClient.pairedDevices(): PairedDevices = decode(PairedDevices.serializer(), request("GET", "/api/auth/devices"))

suspend fun MercuryClient.revokeDevice(id: String, approval: String? = null) {
  decode(SuccessReply.serializer(), gated("DELETE", "/api/auth/devices/${MercuryClient.q(id)}", null, approval))
}

// MARK: Formatting

/** "2.4M", "750k", "1.5k", "42". */
object Tokens {
  fun short(n: Long): String = when {
    n >= 1_000_000 -> trim(n / 1_000_000.0) + "M"
    n >= 10_000 -> "${n / 1000}k"
    n >= 1000 -> trim(n / 1000.0) + "k"
    else -> "$n"
  }

  private fun trim(d: Double): String {
    val s = String.format(Locale.US, "%.1f", d)
    return if (s.endsWith(".0")) s.dropLast(2) else s
  }
}
