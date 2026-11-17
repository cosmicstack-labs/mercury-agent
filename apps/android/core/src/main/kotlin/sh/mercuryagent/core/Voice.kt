package sh.mercuryagent.core

import java.time.Duration
import java.time.Instant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Voice from the phone (src/web/api/mobile-voice.ts; iOS: MercuryCore/Speech.swift and Dictation.swift).
// Mercury only mints short-lived tokens: API keys never leave the computer. The phone runs the
// voice itself with Mercury's shared Rust engine (the :voice module).

/**
 * What this Mercury's voice can do from the phone (GET /api/mobile/voice/capabilities): live calls,
 * and live dictation in the message box. The route only looks at which keys are set.
 */
@Serializable
data class VoiceCapabilities(
  val call: Boolean = false,
  val callEngine: String? = null,
  /** The call engine as people say it ("OpenAI Realtime", "Gemini Live"). */
  val callEngineName: String? = null,
  val callSetup: String? = null,
  val dictation: Boolean = false,
  val dictationEngine: String? = null,
  /** The dictation engine as people say it ("Gemini", "Deepgram"). */
  val dictationEngineName: String? = null,
  /** What to add for dictation, in plain words, when it isn't available. */
  val dictationSetup: String? = null,
  /** "device": this Mercury has no speech service, so the phone dictates with its own speech recognition. */
  val dictationFallback: String? = null,
) {
  /** What to tell the owner about dictation without a speech service. */
  val setupLine: String get() = dictationSetup ?: DEFAULT_DICTATION_SETUP

  /** "Gemini", for "Listening · Gemini"; null when Mercury has no speech service. */
  val dictationName: String? get() = if (dictation) dictationEngineName ?: dictationEngine?.let(::engineName) else null

  companion object {
    /** The setup line when the Mercury didn't send one. */
    const val DEFAULT_DICTATION_SETUP =
      "Dictation uses this phone's own speech recognition. For better dictation, add a Gemini, OpenAI, Deepgram or ElevenLabs key in Settings → Voice."

    fun engineName(id: String): String = when (id) {
      "openai" -> "OpenAI"
      "gemini" -> "Gemini"
      "deepgram" -> "Deepgram"
      "elevenlabs" -> "ElevenLabs"
      else -> id
    }

    /** A Mercury from before the route: no dictation. */
    val tooOld = VoiceCapabilities(
      call = false, dictation = false,
      dictationSetup = "Live dictation needs a newer Mercury. Update Mercury on your computer, then try again.",
    )

    fun decode(code: Int, body: String): VoiceCapabilities {
      val j = parseObject(body)
      return when (code) {
        200 -> VoiceCapabilities(
          call = j.bool("call") ?: false, callEngine = j.str("callEngine"), callEngineName = j.str("callEngineName"), callSetup = j.str("callSetup"),
          dictation = j.bool("dictation") ?: false, dictationEngine = j.str("dictationEngine"),
          dictationEngineName = j.str("dictationEngineName"), dictationSetup = j.str("dictationSetup"),
          dictationFallback = j.str("dictationFallback"),
        )
        404 -> tooOld
        401 -> throw MercuryException.Unauthorized()
        else -> throw MercuryException.Server(code, j.str("error"))
      }
    }
  }
}

/** A live call's start: a short-lived token for the voice engine (POST /api/mobile/voice/session). */
data class VoiceSession(
  /** "openai" or "gemini". */
  val engine: String,
  val token: String,
  val ephemeral: Boolean = true,
  val expiresAt: Instant? = null,
  val model: String? = null,
  val voice: String? = null,
  val url: String? = null,
  val instructions: String = "",
  /** The tools for the voice (ask_mercury, end_conversation, answer_approval), as a JSON array. */
  val toolsJson: String = "[]",
)

/** What the session route answered. */
sealed interface VoiceSessionResult {
  data class Live(val session: VoiceSession) : VoiceSessionResult
  /** No live voice on this Mercury: why, and what to add, in plain words. */
  data class Unavailable(val reason: String) : VoiceSessionResult

  companion object {
    /** A Mercury without the route (it predates `voice.mobile`). */
    const val TOO_OLD = "Your Mercury is too old for voice calls from the phone. Update Mercury on your computer, then try again."
    const val NO_VOICE = "Voice calls on the phone need an OpenAI key (Settings → Models) or a Gemini key (Settings → Voice)."

    fun decode(code: Int, body: String): VoiceSessionResult {
      val j = parseObject(body)
      return when (code) {
        200 -> {
          val engine = j.str("engine"); val token = j.str("token")
          if (engine == null || token.isNullOrEmpty()) throw MercuryException.Server(200, "Mercury didn't send a voice token.")
          Live(VoiceSession(
            engine = engine, token = token, ephemeral = j.bool("ephemeral") ?: true, expiresAt = j["expiresAt"].asInstant(),
            model = j.str("model"), voice = j.str("voice"), url = j.str("url"), instructions = j.str("instructions") ?: "",
            toolsJson = j.arr("tools")?.toString() ?: "[]",
          ))
        }
        401 -> throw MercuryException.Unauthorized()
        404 -> Unavailable(TOO_OLD)
        409 -> Unavailable(j.str("error") ?: NO_VOICE)
        else -> throw MercuryException.Server(code, j.str("error"))
      }
    }
  }
}

/**
 * Who listens when the owner taps the mic (iOS: DictationRoute): the speech service Mercury uses
 * (the owner's voice choice, the same one Desktop's voice typing uses), or, when Mercury has none
 * or is too old to say, this phone's own speech recognition. The mic is never greyed out for want
 * of a key.
 */
sealed interface DictationRoute {
  /** Mercury mints a token for its speech service ("Gemini", "OpenAI", …; null when not yet known). */
  data class Server(val name: String?) : DictationRoute
  /** The phone's speech recognition (on the device when it can). */
  data object Device : DictationRoute
  /** Nothing can listen: why, in plain words. */
  data class Unavailable(val reason: String) : DictationRoute

  /** The box's placeholder while listening: "Listening · Gemini", "Listening · On this phone". */
  val listeningLabel: String
    get() = when (this) {
      is Server -> if (name != null) "Listening · $name" else "Listening…"
      Device -> "Listening · $DEVICE_NAME"
      is Unavailable -> "Listening…"
    }

  companion object {
    const val DEVICE_NAME = "On this phone"
    const val DURING_CALL = "Dictation is off during a voice call."
    const val NO_SPEECH = "This phone can't recognise speech right now, and Mercury has no speech service. Add a Gemini, OpenAI, Deepgram or ElevenLabs key in Settings → Voice."

    /** [caps]: null when not known yet (Mercury is asked first). [deviceAvailable]: the phone has a recogniser. */
    fun decide(caps: VoiceCapabilities?, deviceAvailable: Boolean, callRunning: Boolean = false): DictationRoute = when {
      callRunning -> Unavailable(DURING_CALL)
      caps == null -> Server(null)
      caps.dictation -> Server(caps.dictationName)
      deviceAvailable -> Device
      else -> Unavailable(NO_SPEECH)
    }

    /** Mercury couldn't start its speech service (none set up, an older Mercury, or offline). */
    fun afterServerRefused(why: String, deviceAvailable: Boolean): DictationRoute = if (deviceAvailable) Device else Unavailable(why)
  }
}

/** A short-lived token for live dictation (POST /api/mobile/voice/dictation). */
data class DictationSession(
  /** "openai", "gemini", "deepgram" or "elevenlabs". */
  val engine: String,
  val token: String,
  val ephemeral: Boolean = true,
  val expiresAt: Instant? = null,
  val model: String? = null,
  val url: String? = null,
  val language: String? = null,
) {
  /** Still good to open a stream with (a little margin for the connection). */
  fun fresh(now: Instant = Instant.now()): Boolean = expiresAt?.let { Duration.between(now, it).seconds > 15 } ?: false
}

sealed interface DictationStart {
  data class Live(val session: DictationSession) : DictationStart
  /** No speech service on this Mercury (the phone uses its own): what to add, in plain words. */
  data class Unavailable(val setup: String) : DictationStart

  companion object {
    fun decode(code: Int, body: String): DictationStart {
      val j = parseObject(body)
      return when (code) {
        200 -> {
          val engine = j.str("engine"); val token = j.str("token")
          if (engine == null || token.isNullOrEmpty()) throw MercuryException.Server(200, "Mercury didn't send a dictation token.")
          Live(DictationSession(engine, token, j.bool("ephemeral") ?: true, j["expiresAt"].asInstant(), j.str("model"), j.str("url"), j.str("language")))
        }
        404 -> Unavailable(VoiceCapabilities.tooOld.setupLine)
        409 -> Unavailable(j.str("setup") ?: j.str("error") ?: VoiceCapabilities.DEFAULT_DICTATION_SETUP)
        401 -> throw MercuryException.Unauthorized()
        else -> throw MercuryException.Server(code, j.str("error"))
      }
    }
  }
}

private fun engineBody(engine: String?): JsonObject = buildJsonObject { engine?.let { put("engine", JsonPrimitive(it)) } }

/** GET /api/mobile/voice/capabilities: can this Mercury do live calls and live dictation? */
suspend fun MercuryClient.voiceCapabilities(): VoiceCapabilities {
  val r = send(request("GET", "/api/mobile/voice/capabilities"), 8)
  return VoiceCapabilities.decode(r.code, r.body)
}

/** POST /api/mobile/voice/session: a token for a live call, or why there can't be one. */
suspend fun MercuryClient.voiceSession(engine: String? = null): VoiceSessionResult {
  val r = send(request("POST", "/api/mobile/voice/session", engineBody(engine)), 12)
  return VoiceSessionResult.decode(r.code, r.body)
}

/** POST /api/mobile/voice/dictation: a token for live dictation, or what to add for it. */
suspend fun MercuryClient.dictationSession(engine: String? = null): DictationStart {
  val r = send(request("POST", "/api/mobile/voice/dictation", engineBody(engine)), 10)
  return DictationStart.decode(r.code, r.body)
}

// MARK: Voice providers (src/web/api/voice-providers.ts, feature `voice.providers`)

/** The api-contract feature that says this Mercury has [voiceProviders] and [setVoiceKey]. */
const val VOICE_PROVIDERS_FEATURE = "voice.providers"

/**
 * One voice provider's key (GET /api/voice/providers). Never carries the key: only whether it's
 * set, where from, and its last four characters.
 */
@Serializable
data class VoiceProvider(
  val id: String,
  val name: String = "",
  /** Its name in ~/.mercury/.env (DEEPGRAM_API_KEY…). */
  val env: String? = null,
  /** "calls", "dictation", "optimus". */
  val uses: List<String> = emptyList(),
  val set: Boolean = false,
  /** "env" (set on the computer), "store" (set from a screen), "provider" (the model provider's key), or null. */
  val source: String? = null,
  /** The key's last four characters. */
  val hint: String? = null,
  val canEdit: Boolean = false,
  val note: String? = null,
) {
  /** Only the Optimus plugin uses it (computer voice), not the phone's calls or dictation. */
  val optimusOnly: Boolean get() = uses.none { it == "calls" || it == "dictation" }

  /** What it's used for, in plain words: "Calls · Dictation · Computer voice". */
  val usedFor: String
    get() = uses.mapNotNull {
      when (it) { "calls" -> "Calls"; "dictation" -> "Dictation"; "optimus" -> "Computer voice"; else -> null }
    }.joinToString(" · ")

  /** "Not set", "Set · ••••1234", "Set on the computer", "From your OpenAI model". */
  val status: String
    get() = when {
      !set -> "Not set"
      source == "env" -> "Set on the computer"
      source == "provider" -> "From your ${name.ifEmpty { "OpenAI" }} model"
      !hint.isNullOrEmpty() -> "Set · ••••$hint"
      else -> "Set"
    }
}

object VoiceProviderList : KSerializer<List<VoiceProvider>> by LossyList(VoiceProvider.serializer())

@Serializable
data class VoiceProvidersResponse(
  @Serializable(with = VoiceProviderList::class) val providers: List<VoiceProvider> = emptyList(),
  val capabilities: VoiceCapabilities = VoiceCapabilities(),
)

/** PUT /api/voice/providers/:id's answer. */
@Serializable
data class VoiceKeyResult(
  val ok: Boolean = false,
  /** The provider accepted the key (false when it couldn't be checked). */
  val verified: Boolean = false,
  val message: String? = null,
  val error: String? = null,
  val provider: VoiceProvider? = null,
  val capabilities: VoiceCapabilities? = null,
)

/** GET /api/voice/providers: every voice provider's key status, and what calls and dictation use. */
suspend fun MercuryClient.voiceProviders(): VoiceProvidersResponse =
  decode(VoiceProvidersResponse.serializer(), request("GET", "/api/voice/providers"))

/**
 * PUT /api/voice/providers/:id: saves [apiKey] (checked with the provider first), or removes the
 * key when it's null. 428 → [MercuryException.NeedsOwner] (repeat with the approval's id); a key the
 * provider rejected (400) or one set on the computer (409) → [MercuryException.Server] with the
 * reason. The key is only ever in the request body.
 */
suspend fun MercuryClient.setVoiceKey(id: String, apiKey: String?, approval: String? = null): VoiceKeyResult {
  val body = buildJsonObject { put("apiKey", apiKey) }
  return decode(VoiceKeyResult.serializer(), gated("PUT", "/api/voice/providers/${MercuryClient.q(id)}", body, approval), 30)
}

/** Turns a reply into what's said on a call (iOS: Spoken). */
object Spoken {
  private val rules = listOf(
    Regex("```[\\s\\S]*?```") to " ",
    Regex("!\\[[^\\]]*\\]\\([^)]*\\)") to "",
    Regex("\\[([^\\]]+)\\]\\([^)]*\\)") to "$1",
    Regex("https?://\\S+") to "",
    Regex("(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+[.)])\\s+") to "",
    Regex("[*_~`|]+") to "",
    Regex("\\s*\\n+\\s*") to " ",
    Regex(" {2,}") to " ",
  )

  /** Drops Markdown that sounds wrong out loud: code, links' addresses, emphasis marks, headings, bullets. */
  fun text(markdown: String): String = rules.fold(markdown) { s, (r, with) -> r.replace(s, with) }.trim()

  private val forTheChat = Regex("(^|\\n)\\s*\\**\\s*for the chat\\s*:?\\**\\s*:?", RegexOption.IGNORE_CASE)

  /**
   * A call answer's two parts (src/plugins/channel-bridge.ts spokenPart/chatPart): what's said,
   * everything before a final "For the chat:" line, and the details after it, kept in the chat.
   */
  fun split(answer: String): Pair<String, String> {
    val m = forTheChat.find(answer) ?: return answer.trim() to ""
    return answer.substring(0, m.range.first).trim() to answer.substring(m.range.last + 1).trim()
  }
}
