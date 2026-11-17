package sh.mercuryagent.core

import java.time.Duration
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// Voice from the phone (src/web/api/mobile-voice.ts; iOS: MercuryCore/Speech.swift and Dictation.swift).
// Mercury only mints short-lived tokens: API keys never leave the computer. The phone runs the
// voice itself with Mercury's shared Rust engine (the :voice module).

/**
 * What this Mercury's voice can do from the phone (GET /api/mobile/voice/capabilities): live calls,
 * and live dictation in the message box. The route only looks at which keys are set.
 */
data class VoiceCapabilities(
  val call: Boolean,
  val callEngine: String? = null,
  val callSetup: String? = null,
  val dictation: Boolean,
  val dictationEngine: String? = null,
  /** What to add for dictation, in plain words, when it isn't available. */
  val dictationSetup: String? = null,
) {
  /** What to tell the owner when the mic is greyed out. */
  val setupLine: String get() = dictationSetup ?: DEFAULT_DICTATION_SETUP

  companion object {
    /** The setup line when the Mercury didn't send one. */
    const val DEFAULT_DICTATION_SETUP =
      "Live dictation needs a speech provider. Add an OpenAI key in Settings → Models, or a Deepgram or ElevenLabs key in Settings → Voice."

    /** A Mercury from before the route: no dictation. */
    val tooOld = VoiceCapabilities(
      call = false, dictation = false,
      dictationSetup = "Live dictation needs a newer Mercury. Update Mercury on your computer, then try again.",
    )

    fun decode(code: Int, body: String): VoiceCapabilities {
      val j = parseObject(body)
      return when (code) {
        200 -> VoiceCapabilities(
          call = j.bool("call") ?: false, callEngine = j.str("callEngine"), callSetup = j.str("callSetup"),
          dictation = j.bool("dictation") ?: false, dictationEngine = j.str("dictationEngine"), dictationSetup = j.str("dictationSetup"),
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

/** A short-lived token for live dictation (POST /api/mobile/voice/dictation). */
data class DictationSession(
  /** "openai", "deepgram" or "elevenlabs". */
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
  /** No dictation on this Mercury: what to add, in plain words. */
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
