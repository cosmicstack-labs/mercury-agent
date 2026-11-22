package sh.mercuryagent.ui

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.MercuryException
import sh.mercuryagent.core.OwnerTask
import sh.mercuryagent.core.OwnerTaskEvent
import sh.mercuryagent.core.OwnerTaskReply
import sh.mercuryagent.core.answerOwnerTask
import sh.mercuryagent.core.declineOwnerTask
import sh.mercuryagent.core.ownerTaskCode
import sh.mercuryagent.core.ownerTaskMediaUrl
import sh.mercuryagent.core.ownerTasks
import sh.mercuryagent.ui.owner.OwnerTaskStore

/** Owner tasks (ADR-048) on Android: the stream's events, the store, the answers and the reach notification. */
class OwnerTasksTest {
  private val captcha = """{"change":"new","id":"ot_1","code":"K7Q2","title":"Solve a CAPTCHA","prompt":"Type the letters","who":"Mercury",
    |"media":{"kind":"image","mimeType":"image/png","url":"/api/owner/tasks/ot_1/media"},"answerKind":"text","expiresAt":1900000000000,"status":"pending"}""".trimMargin()

  private fun task(id: String, expiresAt: Long = 2_000_000, status: String = "pending", answerKind: String = "text") =
    OwnerTask(id, "C$id", "Task $id", "Do it", "Mercury", answerKind = answerKind, expiresAt = expiresAt, status = status)

  @Test fun parsesNewAndSettled() {
    val e = OwnerTaskEvent.parse("owner_task", captcha)
    assertTrue(e is OwnerTaskEvent.New)
    val t = (e as OwnerTaskEvent.New).task
    assertEquals("ot_1", t.id)
    assertEquals("K7Q2", t.code)
    assertEquals("Mercury", t.who)
    assertEquals(1_900_000_000_000, t.expiresAt)
    assertEquals(OwnerTask.Media("image", "image/png", "/api/owner/tasks/ot_1/media"), t.media)
    assertTrue(t.needsText)
    assertNull(t.link)

    assertEquals(OwnerTaskEvent.Settled("ot_1"), OwnerTaskEvent.parse("owner_task", """{"change":"settled","id":"ot_1","status":"answered","expiresAt":1}"""))
    // "new" but no longer pending, or missing what a card needs: settled (it goes).
    assertEquals(OwnerTaskEvent.Settled("ot_2"), OwnerTaskEvent.parse("owner_task", """{"change":"new","id":"ot_2","status":"expired","expiresAt":1}"""))
    assertEquals(OwnerTaskEvent.Settled("ot_3"), OwnerTaskEvent.parse("owner_task", """{"change":"new","id":"ot_3","status":"pending"}"""))
    assertNull(OwnerTaskEvent.parse("activity", captcha))
    assertNull(OwnerTaskEvent.parse("owner_task", """{"change":"new"}"""))
    assertNull(OwnerTaskEvent.parse("owner_task", "not json"))
  }

  @Test fun doneTasksAndLinks() {
    val e = OwnerTaskEvent.parse("owner_task", """{"change":"new","id":"ot_9","code":"AB","title":"Finish signing in","prompt":"","who":"Scout","link":"https://example.com/login","answerKind":"done","expiresAt":1900000000000,"status":"pending"}""")
    val t = (e as OwnerTaskEvent.New).task
    assertEquals("done", t.answerKind)
    assertEquals("https://example.com/login", t.link)
    assertEquals("Scout needs you: Finish signing in", OwnerTaskStore.heading(t))
    assertEquals("done", OwnerTaskStore.answerFor(t, ""))
    assertEquals("ok now", OwnerTaskStore.answerFor(t, "  ok now "))
  }

  @Test fun answersKeepTheirCase() {
    val t = task("a")
    assertNull(OwnerTaskStore.answerFor(t, "   "))
    assertEquals("xK7q", OwnerTaskStore.answerFor(t, " xK7q "))
  }

  @Test fun theStoreUpsertsRemovesAndDropsExpired() {
    val s = OwnerTaskStore()
    s.upsert(task("a")); s.upsert(task("b"))
    s.upsert(task("a").copy(title = "Changed"))
    assertEquals(listOf("a", "b"), s.items.value.map { it.id })
    assertEquals("Changed", s.items.value[0].title)
    s.upsert(task("b", status = "answered"))
    assertEquals(listOf("a"), s.items.value.map { it.id })

    s.apply(OwnerTaskEvent.New(task("c")))
    s.apply(OwnerTaskEvent.Settled("a"))
    assertEquals(listOf("c"), s.items.value.map { it.id })

    s.replace(listOf(task("x", expiresAt = 1_000), task("y"), task("y"), task("z", status = "declined")))
    assertEquals(listOf("x", "y"), s.items.value.map { it.id })
    assertEquals(listOf("y"), OwnerTaskStore.live(s.items.value, 1_000).map { it.id })
    s.prune(1_000)
    assertEquals(listOf("y"), s.items.value.map { it.id })
    s.remove("y")
    assertTrue(s.items.value.isEmpty())
  }

  @Test fun theFooter() {
    val t = task("a", expiresAt = 10 * 60_000L)
    assertEquals("Code Ca · expires in 4 min · never a password or PIN", OwnerTaskStore.footer(t, 6 * 60_000L))
    assertEquals(1, t.minutesLeft(10 * 60_000L - 5_000))
  }

  @Test fun recognisesMercurysOwnerTaskNotification() {
    // src/core/agent.ts: title "Mercury needs you: <title>", body "<prompt>\nCode <code>".
    assertEquals("K7Q2M", ownerTaskCode("Mercury needs you: Solve a CAPTCHA", "Type the letters\nCode K7Q2M"))
    assertEquals("AB12", ownerTaskCode("Mercury needs you: Finish signing in", "Code AB12"))
    assertNull(ownerTaskCode("Mercury needs you", "Type the letters\nCode K7Q2M"))
    assertNull(ownerTaskCode("Reminder", "Type the letters\nCode K7Q2M"))
    assertNull(ownerTaskCode("Mercury needs you: Solve a CAPTCHA", "Type the letters"))
    assertNull(ownerTaskCode("Mercury needs you: Solve a CAPTCHA", "Code k7q2m is lowercase"))
  }

  @Test fun theApi() = runBlocking {
    val server = MockWebServer().apply { start() }
    try {
      val base = MercuryClient.normalize(server.url("/").toString())!!
      val c = MercuryClient(base, "mdt_ab12cd34_x")
      fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
      server.enqueue(json(200, """{"pending":[${captcha.replace("\"change\":\"new\",", "")}]}"""))
      server.enqueue(json(200, """{"task":{}}"""))
      server.enqueue(json(409, """{"error":"Already answered or expired"}"""))
      server.enqueue(json(404, """{"error":"No such task"}"""))
      server.enqueue(json(500, """{"error":"boom"}"""))
      server.enqueue(json(404, """{"error":"Not found"}"""))

      val pending = c.ownerTasks()
      assertEquals(listOf("ot_1"), pending.map { it.id })
      val get = server.takeRequest()
      assertEquals("/api/owner/tasks", get.path)
      assertEquals("Bearer mdt_ab12cd34_x", get.getHeader("Authorization"))

      assertEquals(OwnerTaskReply.Sent, c.answerOwnerTask("ot 1", "xK7q"))
      val post = server.takeRequest()
      assertEquals("POST", post.method)
      assertEquals("/api/owner/tasks/ot%201", post.path)
      assertEquals("""{"answer":"xK7q"}""", post.body.readUtf8())

      assertEquals(OwnerTaskReply.Gone, c.declineOwnerTask("ot_1"))
      assertEquals("""{"decline":true}""", server.takeRequest().body.readUtf8())
      assertEquals(OwnerTaskReply.Gone, c.answerOwnerTask("ot_1", "x"))
      server.takeRequest()
      try { c.answerOwnerTask("ot_1", "x"); fail() } catch (e: MercuryException.Server) { assertEquals("boom", e.message) }
      server.takeRequest()
      // An older Mercury without the route has nothing waiting.
      assertTrue(c.ownerTasks().isEmpty())

      assertEquals("$base/api/owner/tasks/ot_1/media", c.ownerTaskMediaUrl(pending[0].media!!))
      assertTrue(c.owns(c.ownerTaskMediaUrl(pending[0].media!!)))
    } finally {
      server.shutdown()
    }
  }
}
