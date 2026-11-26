package sh.mercuryagent.ui.more

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.PluginDetail
import sh.mercuryagent.core.PluginField
import sh.mercuryagent.core.VoiceCapabilities
import sh.mercuryagent.core.VoiceProvider
import sh.mercuryagent.core.VoiceProvidersResponse

/** Settings → Voice never opens blank (the catalog's bare Optimus entry used to render an empty form). */
class VoiceScreenStateTest {
  /** What GET /api/plugins/optimus answers when Optimus is only in the catalog: no version, no settings. */
  private val catalogOnly = PluginDetail(id = "optimus", name = "Optimus")
  /** Installed, but its manifest didn't load (status error): a version, no settings. */
  private val broken = PluginDetail(id = "optimus", name = "Optimus", installedVersion = "1.2.0")
  private val installed = PluginDetail(
    id = "optimus", name = "Optimus", installedVersion = "1.2.0",
    settings = listOf(PluginField(key = "voiceEngine", type = "enum", options = listOf("openai", "gemini"), value = JsonPrimitive("openai"))),
  )
  private val providers = VoiceProvidersResponse(
    providers = listOf(VoiceProvider(id = "deepgram", name = "Deepgram", uses = listOf("dictation", "optimus"), canEdit = true)),
    capabilities = VoiceCapabilities(call = false, dictation = false),
  )

  private fun state(feature: Boolean = false, providers: VoiceProvidersResponse? = null, providersError: String? = null, plugin: PluginDetail? = null, pluginError: String? = null, loaded: Boolean = true) =
    voiceScreenState(loaded, feature, providers, providersError, plugin, pluginError)

  private fun content(s: VoiceScreenState): VoiceScreenState.Content = s as VoiceScreenState.Content

  @Test fun loadingFirst() {
    assertSame(VoiceScreenState.Loading, state(loaded = false, plugin = installed))
  }

  @Test fun catalogOnlyOptimusIsNotInstalled() {
    assertFalse(optimusInstalled(catalogOnly))
    assertFalse(optimusInstalled(broken))
    assertFalse(optimusInstalled(null))
    assertTrue(optimusInstalled(installed))
  }

  @Test fun noOptimusShowsTheFooterNotAnEmptyForm() {
    for (p in listOf(catalogOnly, broken, null)) {
      val c = content(state(plugin = p))
      assertNull(c.optimus)
      assertTrue(c.optimusFooter)
      assertFalse(c.showProviders)
    }
  }

  @Test fun installedOptimusShowsItsSettings() {
    val c = content(state(plugin = installed))
    assertSame(installed, c.optimus)
    assertFalse(c.optimusFooter)
  }

  @Test fun aLoadErrorOffersRetry() {
    assertEquals(VoiceScreenState.Failed("Couldn't reach Mercury."), state(pluginError = "Couldn't reach Mercury."))
    // With voice.providers and nothing loaded at all.
    assertEquals(VoiceScreenState.Failed("Offline."), state(feature = true, providersError = "Offline.", pluginError = "Offline."))
  }

  @Test fun withVoiceProvidersTheSectionIsAlwaysThere() {
    // No Optimus (catalog-only, 404) or Optimus installed: the providers show either way.
    for (p in listOf(catalogOnly, broken, null, installed)) {
      val c = content(state(feature = true, providers = providers, plugin = p))
      assertTrue(c.showProviders)
      assertSame(providers, c.providers)
      assertNull(c.providersError)
      assertEquals(p === installed, c.optimus != null)
      assertEquals(p !== installed, c.optimusFooter)
    }
    // Optimus failed to load: the providers still show.
    val c = content(state(feature = true, providers = providers, pluginError = "boom"))
    assertTrue(c.showProviders)
    assertTrue(c.optimusFooter)
    // The providers failed but Optimus is there: the section stays, with its error and Retry.
    val e = content(state(feature = true, providersError = "Offline.", plugin = installed))
    assertTrue(e.showProviders)
    assertNull(e.providers)
    assertEquals("Offline.", e.providersError)
    assertSame(installed, e.optimus)
  }

  @Test fun voiceOffersOptimusOnlyWhenItIsntInstalled() {
    assertTrue(offersOptimusInstall(catalogOnly, canManage = true))
    assertTrue(offersOptimusInstall(null, canManage = true))
    assertFalse(offersOptimusInstall(catalogOnly, canManage = false))
    // Installed (even with settings that didn't load): no Install card.
    assertFalse(offersOptimusInstall(broken, canManage = true))
    assertFalse(offersOptimusInstall(installed, canManage = true))
  }
}
