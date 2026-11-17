package sh.mercuryagent.ui

import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.mercuryagent.core.ActivityEvent
import sh.mercuryagent.core.ChatThread
import sh.mercuryagent.core.TurnsInfo
import sh.mercuryagent.ui.chats.ChatFilter
import sh.mercuryagent.ui.chats.ChatSections
import sh.mercuryagent.ui.chats.ChatStatus
import sh.mercuryagent.ui.chats.ChatsViewModel
import sh.mercuryagent.ui.chats.ReadMarks
import sh.mercuryagent.ui.chats.RelativeTime
import sh.mercuryagent.ui.conversation.DaySeparators

class ChatListTest {
  private val zone: ZoneId = ZoneOffset.UTC
  private fun at(s: String): Instant = LocalDateTime.parse(s).toInstant(ZoneOffset.UTC)
  private fun t(id: String, updated: String, saved: String? = null, title: String = id, preview: String? = null) =
    ChatThread(id = id, title = title, createdAt = at("2026-01-01T00:00"), updatedAt = at(updated), savedAt = saved?.let(::at), preview = preview)

  private val now = at("2026-11-16T01:00")

  @Test fun dayTitlesCountCalendarDays() {
    assertEquals("Today", ChatSections.title(at("2026-11-16T00:10"), now, zone))
    assertEquals("Yesterday", ChatSections.title(at("2026-11-15T23:00"), now, zone))
    assertEquals("Previous 7 days", ChatSections.title(at("2026-11-14T12:00"), now, zone))
    assertEquals("Previous 7 days", ChatSections.title(at("2026-11-10T12:00"), now, zone))
    assertEquals("Previous 30 days", ChatSections.title(at("2026-11-09T12:00"), now, zone))
    assertEquals("Older", ChatSections.title(at("2026-10-17T12:00"), now, zone))
    assertEquals("Today", ChatSections.title(at("2026-11-17T12:00"), now, zone)) // Mercury's clock ahead
  }

  @Test fun sectionsInOrderOfFirstAppearance() {
    val s = ChatSections.byDay(listOf(t("a", "2026-11-16T00:30"), t("b", "2026-11-15T10:00"), t("c", "2026-11-16T00:20"), t("d", "2026-01-01T00:00")), now, zone)
    assertEquals(listOf("Today", "Yesterday", "Older"), s.map { it.title })
    assertEquals(listOf("a", "c"), s[0].threads.map { it.id })
  }

  @Test fun filterSearchAndSaved() {
    val list = listOf(
      t("a", "2026-11-16T00:30", title = "Trip to Lisbon"),
      t("b", "2026-11-15T10:00", saved = "2026-11-15T11:00", preview = "flights booked"),
      t("c", "2026-11-14T10:00", saved = "2026-11-16T00:00"),
    )
    assertEquals(listOf("a", "b", "c"), ChatFilter.visible(list, "", false).map { it.id })
    assertEquals(listOf("c", "b"), ChatFilter.visible(list, "", true).map { it.id })
    assertEquals(listOf("a"), ChatFilter.visible(list, " lisbon ", false).map { it.id })
    assertEquals(listOf("b"), ChatFilter.visible(list, "FLIGHTS", false).map { it.id })
    assertEquals(listOf("Saved"), ChatFilter.sections(list, "", true).map { it.title })
    assertTrue(ChatFilter.sections(list, "zzz", true).isEmpty())
  }

  @Test fun unreadWithSlackAndFirstLaunch() {
    val since = at("2026-11-16T00:00")
    var marks = ReadMarks(emptyMap(), since)
    // First launch: older chats aren't new; one that moved since is.
    assertFalse(marks.isUnread(t("old", "2026-11-15T10:00")))
    assertFalse(marks.isUnread(t("slack", "2026-11-16T00:00:00.900")))
    assertTrue(marks.isUnread(t("new", "2026-11-16T00:00:02")))
    // The open chat is never unread.
    assertFalse(marks.isUnread(t("new", "2026-11-16T00:00:02"), open = "new"))
    marks = marks.markSeen("new", at("2026-11-16T00:00:02"))
    assertFalse(marks.isUnread(t("new", "2026-11-16T00:00:02")))
    // An older mark never replaces a newer one.
    assertSame(marks, marks.markSeen("new", at("2026-11-16T00:00:01")))
    assertTrue(marks.isUnread(t("new", "2026-11-16T00:05")))
  }

  @Test fun markAllAndPrune() {
    val n = at("2026-11-16T01:00")
    val threads = listOf(t("a", "2026-11-16T02:00"), t("b", "2026-11-15T00:00"))
    val m = ReadMarks(emptyMap(), at("2026-11-01T00:00")).markAllSeen(threads, n)
    assertEquals(at("2026-11-16T02:00"), m.seen["a"]) // Mercury ahead: its time, not the phone's
    assertEquals(n, m.seen["b"])
    assertTrue(threads.none { m.isUnread(it) })
    val pruned = m.prune(setOf("a"), at("2026-11-16T01:30"))
    assertEquals(setOf("a"), pruned.seen.keys)
    // A fresh mark stays even when its chat isn't in the list yet.
    assertEquals(setOf("a", "b"), m.prune(setOf("a"), at("2026-11-16T01:05")).seen.keys)
  }

  @Test fun previewLine() {
    assertEquals("You: hi", ChatThread(id = "x", createdAt = now, preview = "hi", lastRole = "user").previewLine)
    assertEquals("hi", ChatThread(id = "x", createdAt = now, preview = "hi", lastRole = "assistant").previewLine)
  }

  @Test fun runningAndActivityMarkers() {
    var s = mapOf<String, ChatStatus>("gone" to ChatStatus.Working, "asks" to ChatStatus.NeedsYou("ok?"), "bad" to ChatStatus.Failed)
    s = ChatsViewModel.applyTurns(s, TurnsInfo(running = listOf(TurnsInfo.Running("a"), TurnsInfo.Running("asks")), waiting = listOf(TurnsInfo.Waiting(channelId = "w"))))
    assertEquals(mapOf("asks" to ChatStatus.NeedsYou("ok?"), "bad" to ChatStatus.Failed, "a" to ChatStatus.Working, "w" to ChatStatus.Waiting), s)
    s = ChatsViewModel.applyActivity(s, ActivityEvent("needs_you", "a", prompt = "Run?"))
    assertEquals(ChatStatus.NeedsYou("Run?"), s["a"])
    s = ChatsViewModel.applyActivity(s, ActivityEvent("resolved", "a"))
    assertEquals(ChatStatus.Working, s["a"])
    s = ChatsViewModel.applyActivity(s, ActivityEvent("done", "a"))
    assertFalse("a" in s)
    s = ChatsViewModel.applyActivity(s, ActivityEvent("failed", "z"))
    assertEquals(ChatStatus.Failed, s["z"])
  }

  @Test fun relativeTime() {
    val n = at("2026-11-16T15:00")
    assertEquals("now", RelativeTime.short(at("2026-11-16T14:59:30"), n, zone))
    assertEquals("5m", RelativeTime.short(at("2026-11-16T14:55"), n, zone))
    assertEquals("3h", RelativeTime.short(at("2026-11-16T12:00"), n, zone))
    assertEquals("Yesterday", RelativeTime.short(at("2026-11-15T12:00"), n, zone))
    assertEquals("Fri", RelativeTime.short(at("2026-11-13T12:00"), n, zone, java.util.Locale.UK))
    assertEquals("3 Nov", RelativeTime.short(at("2026-11-03T12:00"), n, zone, java.util.Locale.UK))
  }

  @Test fun daySeparators() {
    fun m(id: String, ts: String) = sh.mercuryagent.core.ChatMessage(id = id, role = "user", content = "x", timestamp = at(ts))
    val n = at("2026-11-16T12:00")
    val today = DaySeparators.make(listOf(m("a", "2026-11-16T09:00"), m("b", "2026-11-16T10:00")), n, zone)
    assertTrue(today.isEmpty())
    val mixed = DaySeparators.make(listOf(m("a", "2026-11-14T09:00"), m("b", "2026-11-15T10:00"), m("c", "2026-11-15T11:00"), m("d", "2026-11-16T10:00")), n, zone)
    assertEquals(setOf("a", "b", "d"), mixed.keys)
    assertEquals("Yesterday", mixed["b"]); assertEquals("Today", mixed["d"])
  }
}
