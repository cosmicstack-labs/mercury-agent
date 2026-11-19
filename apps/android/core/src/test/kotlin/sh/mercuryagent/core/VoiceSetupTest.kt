package sh.mercuryagent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.VoiceSetup.Choice.State
import sh.mercuryagent.core.VoiceSetup.Decision
import sh.mercuryagent.core.VoiceSetup.Next
import sh.mercuryagent.core.VoiceSetup.Trigger

/** "Set up voice": which screen for each capabilities/providers combination (iOS: VoiceSetupTests). */
class VoiceSetupTest {
  private fun openai(set: Boolean = false) = VoiceProvider(
    "openai", "OpenAI", null, listOf("calls", "dictation", "optimus"), set, if (set) "provider" else null, if (set) "wxyz" else null, canEdit = false,
  )
  private fun gemini(set: Boolean = false, source: String? = if (set) "store" else null, canEdit: Boolean = source != "env") =
    VoiceProvider("gemini", "Google Gemini", "GEMINI_API_KEY", listOf("calls", "optimus"), set, source, if (set) "1234" else null, canEdit)
  private fun deepgram(set: Boolean = false) =
    VoiceProvider("deepgram", "Deepgram", "DEEPGRAM_API_KEY", listOf("dictation", "optimus"), set, if (set) "store" else null, null, true)
  private fun elevenlabs(set: Boolean = false, source: String? = if (set) "store" else null) =
    VoiceProvider("elevenlabs", "ElevenLabs", "ELEVENLABS_API_KEY", listOf("dictation", "optimus"), set, source, null, source != "env")
  private val cartesia = VoiceProvider("cartesia", "Cartesia", "CARTESIA_API_KEY", listOf("optimus"), false, null, null, true)

  /** In the server's order (voice-providers.ts VOICE_PROVIDER_IDS). */
  private fun list(o: VoiceProvider = openai(), g: VoiceProvider = gemini(), e: VoiceProvider = elevenlabs(), d: VoiceProvider = deepgram()) =
    listOf(o, g, e, d, cartesia)

  private val nothing = VoiceCapabilities(call = false, dictation = false, callSetup = "Add a key.")
  private val callsOnly = VoiceCapabilities(call = true, callEngine = "gemini", dictation = false)
  private val everything = VoiceCapabilities(call = true, callEngine = "openai", dictation = true, dictationEngine = "openai")

  @Test fun decides() {
    // Available: go ahead, whatever the server.
    assertEquals(Decision.Proceed, VoiceSetup.decide(Trigger.Call, supported = true, caps = everything))
    assertEquals(Decision.Proceed, VoiceSetup.decide(Trigger.Call, supported = false, caps = callsOnly))
    assertEquals(Decision.Proceed, VoiceSetup.decide(Trigger.Dictation, supported = true, caps = everything))
    // An older Mercury keeps today's message / fallback call.
    assertEquals(Decision.Legacy, VoiceSetup.decide(Trigger.Call, supported = false, caps = nothing))
    assertEquals(Decision.Legacy, VoiceSetup.decide(Trigger.Dictation, supported = false, caps = VoiceCapabilities.tooOld))
    // Couldn't read the capabilities: don't guess.
    assertEquals(Decision.Legacy, VoiceSetup.decide(Trigger.Call, supported = true, caps = null))
    // Not set up on a Mercury with voice.providers: the sheet.
    assertEquals(Decision.Setup, VoiceSetup.decide(Trigger.Call, supported = true, caps = nothing))
    assertEquals(Decision.Setup, VoiceSetup.decide(Trigger.Dictation, supported = true, caps = nothing))
    // Calls work but the mic doesn't: only the mic asks.
    assertEquals(Decision.Proceed, VoiceSetup.decide(Trigger.Call, supported = true, caps = callsOnly))
    assertEquals(Decision.Setup, VoiceSetup.decide(Trigger.Dictation, supported = true, caps = callsOnly))
  }

  @Test fun nothingSetFromACall() {
    val p = VoiceSetup.plan(Trigger.Call, list())
    assertEquals(listOf("openai", "gemini"), p.choices.map { it.id })
    assertTrue(p.more.isEmpty())
    assertTrue(p.choices.all { it.state == State.Add })
    assertNull(p.ready)
    assertEquals("Natural, quick replies. Calls and dictation.", p.choices[0].line)
  }

  @Test fun openAIFromTheModelIsReadyWithNoSteps() {
    val p = VoiceSetup.plan(Trigger.Call, list(o = openai(set = true)))
    assertEquals("openai", p.ready?.id)
    assertEquals("Ready · uses your OpenAI key", p.ready?.line)
    // The mic too: OpenAI dictates.
    assertEquals("openai", VoiceSetup.plan(Trigger.Dictation, list(o = openai(set = true))).ready?.id)
  }

  @Test fun aKeySetOnTheComputer() {
    // Gemini from ~/.mercury/.env: ready for calls, said where it's from.
    val ready = VoiceSetup.plan(Trigger.Call, list(g = gemini(set = true, source = "env")))
    assertEquals("Ready · set on your computer", ready.ready?.line)
    // ElevenLabs from .env is ready for the mic.
    val mic = VoiceSetup.plan(Trigger.Dictation, list(e = elevenlabs(set = true, source = "env")))
    assertEquals("elevenlabs", mic.ready?.id)
    // Not editable and not set (an env-managed provider the phone can't change): locked, explained.
    val locked = VoiceProvider("gemini", "Google Gemini", "GEMINI_API_KEY", listOf("calls"), set = false, canEdit = false)
    assertEquals(State.Locked, VoiceSetup.plan(Trigger.Call, listOf(openai(), locked)).choices[1].state)
    assertEquals("Set on your computer", VoiceSetup.plan(Trigger.Call, listOf(openai(), locked)).choices[1].line)
  }

  @Test fun theMicListsWhatDictatesWithMoreOptions() {
    val p = VoiceSetup.plan(Trigger.Dictation, list())
    // An older Mercury lists Gemini for calls only: not offered for the mic there.
    assertEquals(listOf("openai"), p.choices.map { it.id })
    assertEquals(listOf("deepgram", "elevenlabs"), p.more.map { it.id })
    // A Gemini key doesn't make the mic ready.
    assertNull(VoiceSetup.plan(Trigger.Dictation, list(g = gemini(set = true))).ready)
  }

  @Test fun settingsListsCallsThenDictationOnly() {
    val p = VoiceSetup.plan(Trigger.Settings, list(d = deepgram(set = true)))
    assertEquals(listOf("openai", "gemini"), p.choices.map { it.id })
    assertEquals(listOf("deepgram", "elevenlabs"), p.more.map { it.id })
    assertEquals(State.Ready, p.more[0].state)
    // Optimus-only providers never show.
    assertFalse((p.choices + p.more).any { it.id == "cartesia" })
  }

  @Test fun settingsOffersSetupOnlyWhenNoPhoneVoiceIsSet() {
    assertTrue(VoiceSetup.settingsOffersSetup(list()))
    assertTrue(VoiceSetup.settingsOffersSetup(list() + cartesia.copy(set = true)))
    assertFalse(VoiceSetup.settingsOffersSetup(list(d = deepgram(set = true))))
    assertFalse(VoiceSetup.settingsOffersSetup(list(o = openai(set = true))))
  }

  @Test fun afterSaving() {
    assertEquals(Next.StartCall, VoiceSetup.next(Trigger.Call, callsOnly))
    assertEquals(Next.StartDictation, VoiceSetup.next(Trigger.Dictation, everything))
    assertEquals(Next.Done, VoiceSetup.next(Trigger.Settings, callsOnly))
    assertEquals(Next.Done, VoiceSetup.next(Trigger.Settings, null))
    // Saved a voice that can't do what was asked: say so.
    assertEquals(Next.StillMissing(VoiceCapabilities.DEFAULT_DICTATION_SETUP), VoiceSetup.next(Trigger.Dictation, callsOnly.copy(dictationSetup = null)))
    assertEquals(Next.StillMissing("Add a key."), VoiceSetup.next(Trigger.Call, nothing))
    assertTrue(VoiceSetup.next(Trigger.Call, null) is Next.StillMissing)
  }

  @Test fun keyPages() {
    assertEquals("https://platform.openai.com/api-keys", VoiceSetup.keyPage("openai"))
    assertEquals("https://aistudio.google.com/apikey", VoiceSetup.keyPage("gemini"))
    assertEquals("https://console.deepgram.com", VoiceSetup.keyPage("deepgram"))
    assertEquals("https://elevenlabs.io/app/developers/api-keys", VoiceSetup.keyPage("elevenlabs"))
    assertNull(VoiceSetup.keyPage("cartesia"))
  }
}
