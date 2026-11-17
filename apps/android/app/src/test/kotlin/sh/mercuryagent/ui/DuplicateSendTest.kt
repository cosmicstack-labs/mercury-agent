package sh.mercuryagent.ui

import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.ui.conversation.ConversationViewModel

/**
 * The vivo's double chat: a welcome idea was sent, POST /api/chat/threads took seconds, the welcome
 * (and its ideas) stayed on screen with nothing sent showing, and the idea went again: two chats on
 * Mercury with the same first message, and the message twice on screen. One tap = one message =
 * one chat.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DuplicateSendTest {
  private val creates = AtomicInteger()
  private val sends = AtomicInteger()
  /** Holds POST /api/chat/threads until released: a slow Mercury. */
  private val release = CountDownLatch(1)

  private val fake = Interceptor { chain ->
    val r = chain.request()
    val path = r.url.encodedPath
    val (code, body) = when {
      r.method == "POST" && path == "/api/chat/threads" -> {
        val n = creates.incrementAndGet()
        release.await(5, TimeUnit.SECONDS)
        200 to """{"id":"t$n","createdAt":"2026-11-16T10:00:00Z","messages":[]}"""
      }
      r.method == "POST" && path == "/api/chat/send" -> { sends.incrementAndGet(); 200 to """{"ok":true}""" }
      path == "/api/chat/events" -> 404 to "{}"
      else -> 404 to "{}"
    }
    Response.Builder().request(r).protocol(Protocol.HTTP_1_1).code(code).message("x")
      .body(body.toResponseBody("application/json".toMediaType())).build()
  }

  private val client = MercuryClient("http://127.0.0.1:6175", "mdt_x_y", OkHttpClient.Builder().addInterceptor(fake).build())

  @Before fun setUp() = Dispatchers.setMain(Dispatchers.Unconfined)
  @After fun tearDown() = Dispatchers.resetMain()

  private suspend fun until(what: () -> Boolean) = withTimeout(5_000) { while (!what()) delay(10) }

  @Test fun aSecondTapWhileTheChatIsCreatedMakesNoSecondChat() = runBlocking {
    val created = mutableListOf<String>()
    val vm = ConversationViewModel(client, null, onCreated = { created += it })
    val idea = "Create an Instagram carousel post"
    vm.draft.setTextAndPlaceCursorAtEnd(idea)
    vm.send()
    until { creates.get() == 1 }
    // Shown at once: the welcome is gone before Mercury answers.
    assertEquals(listOf(idea), vm.ui.value.messages.filter { it.role == "user" }.map { it.content })
    // The idea again (picked again, or the IME put it back) and Send again, while the chat is created.
    vm.draft.setTextAndPlaceCursorAtEnd(idea)
    vm.send()
    release.countDown()
    until { sends.get() >= 1 && vm.ui.value.threadId != null }
    delay(200)
    assertEquals(1, creates.get())
    assertEquals(1, sends.get())
    assertEquals(listOf("t1"), created)
    assertEquals(1, vm.ui.value.messages.count { it.role == "user" })
  }

  @Test fun twoDifferentMessagesRacingShareOneChat() = runBlocking {
    val vm = ConversationViewModel(client, null)
    vm.draft.setTextAndPlaceCursorAtEnd("first")
    vm.send()
    until { creates.get() == 1 }
    vm.draft.setTextAndPlaceCursorAtEnd("second")
    vm.send()
    release.countDown()
    until { sends.get() == 2 }
    delay(100)
    assertEquals(1, creates.get())
    assertEquals("t1", vm.ui.value.threadId)
    assertEquals(listOf("first", "second"), vm.ui.value.messages.filter { it.role == "user" }.map { it.content })
  }
}
