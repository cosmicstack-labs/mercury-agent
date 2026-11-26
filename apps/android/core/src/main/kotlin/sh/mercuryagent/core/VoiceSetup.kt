package sh.mercuryagent.core

/**
 * "Set up voice": what the phone does when the owner taps a call entry or the dictation mic and this
 * Mercury can't do it yet. Decided here, apart from the screens, so tests cover every case (iOS has
 * the same rules in MercuryCore/VoiceSetup.swift).
 *
 * - The feature works: go ahead (start the call, start dictating).
 * - A Mercury from before `voice.providers`: what the phone did before (the call starts and falls
 *   back on its own; the mic says what to add).
 * - Otherwise: the setup sheet, with the voices that can do what was asked first.
 */
object VoiceSetup {
  /** What opened it. */
  enum class Trigger {
    /** The top phone button, the composer's waveform, the drawer's Call Mercury, the launcher shortcut. */
    Call,
    /** The composer's mic. */
    Dictation,
    /** Settings → Voice. */
    Settings,
  }

  enum class Decision {
    /** It works: start it. */
    Proceed,
    /** An older Mercury (or what it can do couldn't be read): today's behaviour. */
    Legacy,
    /** Show "Set up voice". */
    Setup,
  }

  /** Whether the feature the trigger asks for is there. */
  fun available(trigger: Trigger, caps: VoiceCapabilities): Boolean = when (trigger) {
    Trigger.Call, Trigger.Settings -> caps.call
    Trigger.Dictation -> caps.dictation
  }

  /** [supported]: the Mercury's /api/health lists `voice.providers`. [caps]: null when they couldn't be read. */
  fun decide(trigger: Trigger, supported: Boolean, caps: VoiceCapabilities?): Decision {
    if (caps != null && available(trigger, caps)) return Decision.Proceed
    if (!supported) return Decision.Legacy
    // Couldn't read what it can do: let the call or mic try (and say why it can't) rather than guess.
    if (caps == null) return Decision.Legacy
    return Decision.Setup
  }

  /** One voice on the sheet. */
  data class Choice(val provider: VoiceProvider, val state: State) {
    enum class State {
      /** Set and usable for what was asked: "Ready · uses your OpenAI key". */
      Ready,
      /** Tap to paste a key. */
      Add,
      /** Can't be set from the phone (set on the computer): tap explains. */
      Locked,
    }

    val id: String get() = provider.id

    /** The one line under the name. */
    val line: String
      get() = when (state) {
        State.Ready -> when (provider.source) {
          "provider" -> "Ready · uses your OpenAI key"
          "env" -> "Ready · set on your computer"
          else -> provider.hint?.takeIf { it.isNotEmpty() }?.let { "Ready · key ••••$it" } ?: "Ready"
        }
        State.Locked -> "Set on your computer"
        State.Add -> blurb(provider.id)
      }
  }

  data class Plan(
    val trigger: Trigger,
    /** Voices that do what was asked, the ones that can also take calls first. */
    val choices: List<Choice>,
    /** "More options": dictation-only voices, when the mic (or Settings) opened it. */
    val more: List<Choice>,
  ) {
    /** A voice that's already set: "Start talking" with no steps. */
    val ready: Choice? get() = (choices + more).firstOrNull { it.state == Choice.State.Ready }
  }

  internal fun serves(p: VoiceProvider, trigger: Trigger): Boolean = when (trigger) {
    Trigger.Call, Trigger.Settings -> "calls" in p.uses
    Trigger.Dictation -> "dictation" in p.uses
  }

  internal fun choice(p: VoiceProvider, trigger: Trigger): Choice = when {
    p.set && serves(p, trigger) -> Choice(p, Choice.State.Ready)
    p.id == "openai" || p.canEdit -> Choice(p, Choice.State.Add)
    else -> Choice(p, Choice.State.Locked)
  }

  private val ORDER = listOf("openai", "gemini", "deepgram", "elevenlabs")
  private fun rank(id: String): Int = ORDER.indexOf(id).let { if (it < 0) 99 else it }

  /**
   * The sheet's rows from GET /api/voice/providers. Calls: OpenAI Realtime, Gemini Live. The mic:
   * the call voices that also dictate (OpenAI), then Deepgram and ElevenLabs under More options.
   * Settings: the call voices, dictation-only ones under More options.
   */
  fun plan(trigger: Trigger, providers: List<VoiceProvider>): Plan {
    val calls = providers.filter { "calls" in it.uses }.sortedBy { rank(it.id) }
    val dictationOnly = providers.filter { "dictation" in it.uses && "calls" !in it.uses }.sortedBy { rank(it.id) }
    return when (trigger) {
      Trigger.Call -> Plan(trigger, calls.map { choice(it, trigger) }, emptyList())
      Trigger.Dictation -> Plan(
        trigger,
        calls.filter { serves(it, Trigger.Dictation) }.map { choice(it, trigger) },
        dictationOnly.map { choice(it, trigger) },
      )
      Trigger.Settings -> Plan(trigger, calls.map { choice(it, trigger) }, dictationOnly.map { choice(it, Trigger.Dictation) })
    }
  }

  /** Settings → Voice shows "Set up voice" at the top when no voice the phone uses is set. */
  fun settingsOffersSetup(providers: List<VoiceProvider>): Boolean = providers.none { !it.optimusOnly && it.set }

  /** What happens once a key is saved and Mercury sent its new capabilities. */
  sealed interface Next {
    data object StartCall : Next
    data object StartDictation : Next
    /** From Settings: just "Voice is ready". */
    data object Done : Next
    /** Saved, but what was asked still isn't there (that voice can't do it): say so, back to the list. */
    data class StillMissing(val message: String) : Next
  }

  fun next(after: Trigger, caps: VoiceCapabilities?): Next {
    if (caps == null) {
      return if (after == Trigger.Settings) Next.Done
      else Next.StillMissing("Saved. Mercury couldn't say yet whether it works; try again in a moment.")
    }
    return when (after) {
      Trigger.Settings -> if (caps.call || caps.dictation) Next.Done else Next.StillMissing(caps.callSetup ?: "Saved, but calls still aren't set up.")
      Trigger.Call -> if (caps.call) Next.StartCall else Next.StillMissing(caps.callSetup ?: "Saved, but that voice can't take calls. Pick another one.")
      Trigger.Dictation -> if (caps.dictation) Next.StartDictation else Next.StillMissing(caps.setupLine)
    }
  }

  /** One line per voice, plain. */
  fun blurb(id: String): String = when (id) {
    "openai" -> "Natural, quick replies. Calls and dictation."
    "gemini" -> "Google's live voice. Calls and dictation."
    "deepgram" -> "Fast speech to text. Dictation."
    "elevenlabs" -> "Accurate speech to text. Dictation."
    else -> "Voice"
  }

  /** Where to get a key: each provider's own key page. */
  fun keyPage(id: String): String? = when (id) {
    "openai" -> "https://platform.openai.com/api-keys"
    "gemini" -> "https://aistudio.google.com/apikey"
    "deepgram" -> "https://console.deepgram.com"
    "elevenlabs" -> "https://elevenlabs.io/app/developers/api-keys"
    else -> null
  }

  const val TITLE = "Talk to Mercury"
  const val SUBTITLE = "Pick the voice Mercury talks with. Your key stays on your computer."
}

/**
 * The OpenAI key is the OpenAI model provider's (Settings → Models): checked live, then saved and
 * switched on through the provider routes, the same place Models saves it (nothing new stored).
 * Then the voice providers are read again for the new capabilities. A rejected key throws
 * [MercuryException.Server] with OpenAI's reason; 428 throws [MercuryException.NeedsOwner] (run it
 * through an OwnerGate, which repeats it with the approval).
 */
suspend fun MercuryClient.setOpenAIVoiceKey(apiKey: String, approval: String? = null): VoiceKeyResult {
  if (approval == null) {
    val check = checkProvider("openai", apiKey = apiKey)
    if (!check.ok) throw MercuryException.Server(400, check.error ?: "OpenAI didn't accept that key.")
  }
  val r = saveProvider("openai", apiKey = apiKey, enabled = true, approval = approval)
  r.error?.let { throw MercuryException.Server(400, it) }
  val v = runCatching { voiceProviders() }.getOrNull()
  return VoiceKeyResult(ok = true, verified = true, provider = v?.providers?.firstOrNull { it.id == "openai" }, capabilities = v?.capabilities)
}
