package sh.mercuryagent.ui

import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.ChatThread
import sh.mercuryagent.core.ModelCatalog
import sh.mercuryagent.core.ModelChoice
import sh.mercuryagent.core.ModelMenu
import sh.mercuryagent.ui.chats.ChatHistory
import sh.mercuryagent.ui.chats.ChatSearch
import sh.mercuryagent.ui.chats.ChatStatus
import sh.mercuryagent.ui.chats.RowLook
import sh.mercuryagent.ui.chats.RowMarker

class ChatHistoryTest {
  private fun at(s: String): Instant = LocalDateTime.parse(s).toInstant(ZoneOffset.UTC)
  private fun t(id: String, updated: String, saved: String? = null, title: String = id, preview: String? = null) =
    ChatThread(id = id, title = title, createdAt = at("2026-01-01T00:00"), updatedAt = at(updated), savedAt = saved?.let(::at), preview = preview)

  private val list = listOf(
    t("a", "2026-11-16T09:00", title = "Instagram carousel"),
    t("b", "2026-11-15T09:00", title = "Trip to Lahore", preview = "Book the carousel ride"),
    t("c", "2026-11-12T09:00"),
    t("s1", "2026-11-01T09:00", saved = "2026-11-02T00:00"),
    t("s2", "2026-11-17T09:00", saved = "2026-11-05T00:00"),
  )

  @Test fun oneFlatListNewestFirst() {
    val h = ChatHistory.build(list, "", savedOnly = false)
    assertEquals(listOf("s2", "a", "b", "c", "s1"), h.threads.map { it.id })
    assertEquals("Conversations", h.label)
  }

  @Test fun savedIsNewestSaveFirst() {
    val h = ChatHistory.build(list, "", savedOnly = true)
    assertEquals(listOf("s2", "s1"), h.threads.map { it.id })
    assertEquals("Saved", h.label)
  }

  @Test fun searchFiltersTitlesAndPreviewsLive() {
    val h = ChatHistory.build(list, "  CAROUSEL ", false)
    assertEquals(listOf("a", "b"), h.threads.map { it.id })
    assertEquals("Results", h.label)
    assertTrue(ChatHistory.build(list, "zzz", false).isEmpty)
    assertTrue(ChatHistory.build(list, "carousel", true).isEmpty)
  }

  @Test fun matchRangesAreCaseInsensitiveAndEveryOccurrence() {
    assertEquals(listOf(0..2, 8..10), ChatSearch.ranges("Car and car", "CAR"))
    assertTrue(ChatSearch.ranges("anything", " ").isEmpty())
  }

  @Test fun rowsAreOneLineWithMarkersOnlyWhenRelevant() {
    assertEquals(RowLook(null, false), RowLook.of(null, unread = false))
    assertEquals(RowLook(null, true), RowLook.of(null, unread = true))
    assertEquals(RowMarker.Working, RowLook.of(ChatStatus.Working, false).marker)
    assertEquals(RowMarker.NeedsYou, RowLook.of(ChatStatus.NeedsYou("Run a command"), false).marker)
    assertEquals(RowMarker.Failed, RowLook.of(ChatStatus.Failed, false).marker)
    assertEquals(RowMarker.Waiting, RowLook.of(ChatStatus.Waiting, false).marker)
  }

  // MARK: The model picker

  private val models = listOf(
    ModelChoice("anthropic", "claude-sonnet-4-5", label = "Claude Sonnet 4.5", group = "Claude", isCurrent = true),
    ModelChoice("anthropic", "claude-haiku-4-5", label = "Claude Haiku 4.5", group = "Claude"),
    ModelChoice("openrouter", "openai/gpt-5", label = "GPT-5", group = "GPT"),
    ModelChoice("ollama", "llama3", label = null, group = null),
  )

  @Test fun modelsGroupInOrderAndFilterAsYouType() {
    assertEquals(listOf("Claude", "GPT", "Ollama"), ModelMenu.groups(models).map { it.title })
    assertEquals(listOf("llama3"), ModelMenu.groups(models).last().models.map { it.title })
    assertEquals(listOf("GPT-5"), ModelMenu.groups(models, "gpt").flatMap { it.models }.map { it.title })
    assertEquals(2, ModelMenu.groups(models, "anthropic").single().models.size)
    assertTrue(ModelMenu.groups(models, "zzz").isEmpty())
    assertEquals("Mercury Cloud", ModelMenu.providerName("mercuryCloud"))
    assertEquals("LM Studio", ModelMenu.providerName("lmstudio"))
  }

  @Test fun thePillSaysAutoOnTheConfiguredDefault() {
    val auto = ModelCatalog(models, models[0], "anthropic" to "claude-sonnet-4-5")
    assertTrue(auto.isAuto)
    assertEquals("Auto", auto.pill)
    val other = auto.copy(current = models[2])
    assertEquals("GPT-5", other.pill)
    // Auto goes back to the default; a model goes to itself.
    assertEquals("anthropic" to "claude-sonnet-4-5", ModelMenu.target(other, null))
    assertEquals("openrouter" to "openai/gpt-5", ModelMenu.target(auto, models[2]))
    // A Mercury that doesn't say its default: the current model is named.
    assertEquals("Claude Sonnet 4.5", ModelCatalog(models, models[0]).pill)
  }
}
