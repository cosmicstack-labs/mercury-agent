package sh.mercuryagent.core

import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.net.UnknownHostException
import java.net.UnknownServiceException
import java.time.Instant
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Talks to one Mercury runtime over its HTTP API (src/web/api-contract.ts, API_VERSION 1).
 * The only credential is `Authorization: Bearer <device token>`. Mirrors iOS's MercuryClient.
 */
class MercuryClient(
  /** An origin, as [normalize] makes it: "https://mercury.example.com" or "http://192.168.1.7:6175". */
  val baseUrl: String,
  val token: String? = null,
  private val http: OkHttpClient = sharedHttp,
) {
  /** A plain answer: status, body and headers we read. */
  class Reply(val code: Int, val body: String, val retryAfter: String?)

  // MARK: Requests

  /**
   * `path` may end in an already-encoded query ("/api/chat/events?sessionId=…"). Accept and the
   * Bearer token on every request; a JSON body sets Content-Type: application/json, as iOS does.
   */
  fun request(method: String, path: String, body: JsonObject? = null): Request {
    val url = (baseUrl.trimEnd('/') + path).toHttpUrlOrNull() ?: throw MercuryException.BadAddress()
    val b = Request.Builder().url(url).header("Accept", "application/json")
    token?.let { b.header("Authorization", "Bearer $it") }
    if (body != null) {
      b.header("Content-Type", "application/json")
      b.method(method, body.toString().toByteArray().toRequestBody(null))
    } else {
      b.method(method, if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody(null) else null)
    }
    return b.build()
  }

  /** Sends a request with an overall time limit, mapping network failures to [MercuryException.Unreachable]. */
  suspend fun send(r: Request, timeoutSeconds: Long = 15): Reply = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
    // Off the main thread throughout: Android forbids network reads there (a large body such as
    // the chat list is read while `string()` runs, and threw NetworkOnMainThreadException).
    val call = http.newCall(r)
    call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
    val res = try {
      call.await()
    } catch (e: CancellationException) {
      throw e
    } catch (e: MercuryException) {
      throw e
    } catch (e: IOException) {
      throw MercuryException.Unreachable(describe(e))
    }
    res.use { Reply(it.code, it.body?.string().orEmpty(), it.header("Retry-After")) }
  }

  /** 2xx → the JSON object; 401 → unauthorized; 428 → the owner must allow it; else a server error. */
  suspend fun json(r: Request, timeoutSeconds: Long = 15): JsonObject {
    val reply = send(r, timeoutSeconds)
    return when (reply.code) {
      in 200..299 -> parseObject(reply.body)
      else -> throw failure(reply)
    }
  }

  suspend fun <T> decode(strategy: DeserializationStrategy<T>, r: Request, timeoutSeconds: Long = 15): T {
    val reply = send(r, timeoutSeconds)
    if (reply.code !in 200..299) throw failure(reply)
    return try {
      MercuryJson.decodeFromString(strategy, reply.body)
    } catch (e: Exception) {
      throw MercuryException.Server(reply.code, "Mercury sent something this app can't read.")
    }
  }

  private fun failure(reply: Reply): MercuryException {
    val j = parseObject(reply.body)
    return when (reply.code) {
      401 -> MercuryException.Unauthorized()
      428 -> {
        val id = j.str("approvalId"); val code = j.str("code")
        if (id != null && code != null) {
          MercuryException.NeedsOwner(OwnerQuestion(id, code, j.str("where") ?: "this computer", j.str("error") ?: "Waiting for the owner."))
        } else MercuryException.Server(428, j.str("error"))
      }
      else -> MercuryException.Server(reply.code, j.str("error"))
    }
  }

  // MARK: Health

  /** GET /api/health. Remote callers need a valid token: without one Mercury answers 404 so scanners can't find it. */
  suspend fun health(): Health {
    val reply = send(request("GET", "/api/health"), 5)
    return when (reply.code) {
      200 -> MercuryJson.decodeFromString(Health.serializer(), reply.body)
      401, 404 -> throw MercuryException.Unauthorized()
      else -> throw MercuryException.Server(reply.code, parseObject(reply.body).str("error"))
    }
  }

  // MARK: Pairing (ADR-035)

  /** POST /api/auth/token. Off the runtime's own computer this starts a pairing the owner must approve. */
  suspend fun signIn(username: String, password: String, deviceName: String, platform: String = "android"): SignInResult {
    val body = buildJsonObject {
      put("username", username); put("password", password); put("deviceName", deviceName); put("platform", platform)
    }
    val reply = send(request("POST", "/api/auth/token", body))
    val j = parseObject(reply.body)
    return when (reply.code) {
      200 -> SignInResult.SignedIn(j.str("token") ?: throw MercuryException.Server(200, "Mercury didn't send a token."), device(j["device"]))
      202 -> {
        val id = j.str("pairingId"); val poll = j.str("pollToken"); val code = j.str("code")
        if (id == null || poll == null || code == null) throw MercuryException.Server(202, "Mercury started a pairing but left out its code.")
        SignInResult.Pending(Pairing(id, poll, code, j.str("message"), j["expiresAt"].asInstant()))
      }
      401 -> throw MercuryException.BadCredentials()
      404 -> throw MercuryException.Unreachable("That address answers, but it isn't a Mercury (or it's too old to pair a phone).")
      409 -> throw MercuryException.DeviceLimit()
      429 -> throw MercuryException.TooManyAttempts(reply.retryAfter?.trim()?.toIntOrNull())
      else -> throw MercuryException.Server(reply.code, j.str("error"))
    }
  }

  /** POST /api/auth/token/pending: holds for up to about 25 s, then answers with the pairing's status. */
  suspend fun pairingStatus(p: Pairing): PairingStatus {
    val body = buildJsonObject { put("pairingId", p.pairingId); put("pollToken", p.pollToken); put("waitMs", 25_000) }
    val reply = send(request("POST", "/api/auth/token/pending", body), 40)
    val j = parseObject(reply.body)
    val error = j.str("error")
    return when (j.str("status")) {
      "pending" -> PairingStatus.Waiting
      "approved" -> PairingStatus.Approved(
        j.str("token") ?: throw MercuryException.Server(reply.code, "Approved, but Mercury didn't send a token."), device(j["device"]),
      )
      "denied" -> PairingStatus.Denied(error ?: "The owner said no.")
      "expired" -> PairingStatus.Expired(error ?: "The code expired.")
      else -> if (reply.code == 410 || reply.code == 404) PairingStatus.Expired(error ?: "The code expired.")
      else throw MercuryException.Server(reply.code, error)
    }
  }

  /** POST /api/auth/token/revoke: forget this phone on the runtime. Never throws. */
  suspend fun revoke() {
    runCatching { send(request("POST", "/api/auth/token/revoke", JsonObject(emptyMap()))) }
  }

  // MARK: Threads

  @Serializable private class ThreadList(val threads: List<ChatThread> = emptyList())

  suspend fun threads(): List<ChatThread> = decode(ThreadList.serializer(), request("GET", "/api/chat/threads")).threads

  suspend fun thread(id: String): ChatThread = decode(ChatThread.serializer(), request("GET", "/api/chat/threads/${q(id)}"))

  suspend fun createThread(title: String? = null): ChatThread =
    decode(ChatThread.serializer(), request("POST", "/api/chat/threads", buildJsonObject { title?.let { put("title", it) } }))

  /** PUT /api/chat/threads/:id/title. The owner's name survives automatic naming. Returns the saved title. */
  suspend fun renameThread(id: String, title: String): String =
    json(request("PUT", "/api/chat/threads/${q(id)}/title", buildJsonObject { put("title", title) })).str("title") ?: title

  /** POST /api/chat/threads/:id/save: a bookmark Mercury keeps (Desktop shares it). When it was saved, null once unsaved. */
  suspend fun setThreadSaved(id: String, saved: Boolean): Instant? =
    json(request("POST", "/api/chat/threads/${q(id)}/save", buildJsonObject { put("saved", saved) }))["savedAt"].asInstant()

  suspend fun deleteThread(id: String) {
    json(request("POST", "/api/chat/threads/${q(id)}/delete", buildJsonObject { put("confirmSessionId", id) }))
  }

  // MARK: Sending and stopping

  /** POST /api/chat/send. The reply doesn't come back here: it streams on /api/chat/events. */
  suspend fun sendMessage(
    content: String,
    sessionId: String,
    attachments: List<OutgoingAttachment> = emptyList(),
    media: MediaIntent? = null,
    voiceCall: String? = null,
    /** Mercury's coding mode for this turn only ("auto", "plan", "execute"): the bar's Code. */
    programming: String? = null,
    /**
     * The project folder a coding turn works in, as Mercury Desktop's Code view sends it (the server
     * checks it's a folder, points the turn there and lets it write there). Sent only with
     * [programming]: the server ignores it otherwise.
     */
    cwd: String? = null,
  ) {
    val body = buildJsonObject {
      put("content", content); put("sessionId", sessionId)
      programming?.let {
        put("programming", it)
        cwd?.takeIf { c -> c.isNotEmpty() }?.let { c -> put("cwd", c) }
      }
      if (attachments.isNotEmpty()) putJsonArray("attachments") { attachments.forEach { add(it.toJson()) } }
      media?.let { put("media", it.toJson()) }
      voiceCall?.let { put("voiceCall", it) }
    }
    json(request("POST", "/api/chat/send", body), if (attachments.isEmpty()) 15 else 90)
  }

  /** Stops this chat's turn only (other chats keep running, ADR-037). Returns the runtime's note, if any. */
  suspend fun stop(threadId: String): String? =
    json(request("POST", "/api/chat/stop", buildJsonObject { put("threadId", threadId) })).str("note")

  /** Answers a permission or choice prompt: "yes", "always", "no" or a choice's value. */
  suspend fun answer(promptId: String, action: String, targetId: String?) {
    json(request("POST", "/api/chat/permission/${q(promptId)}", buildJsonObject {
      put("action", action); targetId?.let { put("targetId", it) }
    }))
  }

  // MARK: What runs now (each optional: older runtimes answer null)

  /** Which chats are working and which wait (null on runtimes before ADR-037). */
  /**
   * GET /api/workspace/info: Mercury's project folder (the workspace set in Settings, else the folder
   * Mercury runs in) and its name, where Code turns work. Null on an older runtime.
   */
  suspend fun workspaceInfo(): WorkspaceInfo? {
    val j = runCatching { json(request("GET", "/api/workspace/info")) }.getOrNull() ?: return null
    val cwd = j.str("cwd")?.takeIf { it.isNotEmpty() } ?: return null
    return WorkspaceInfo(cwd, j.str("projectName")?.takeIf { it.isNotEmpty() } ?: cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\'))
  }

  suspend fun runningTurns(): TurnsInfo? =
    runCatching { decode(TurnsInfo.serializer(), request("GET", "/api/chat/running")) }.getOrNull()

  /** Is this chat's message waiting in line behind another chat? Its position when it is. */
  suspend fun queuePosition(threadId: String): Int? {
    val j = runCatching { json(request("GET", "/api/chat/threads/${q(threadId)}/queue")) }.getOrNull() ?: return null
    return if (j.str("state") == "queued") j.int("position") ?: 1 else null
  }

  /** The reply this chat is working on now, as far as it got. */
  suspend fun liveTurn(threadId: String): LiveSnapshot? {
    val j = runCatching { json(request("GET", "/api/chat/threads/${q(threadId)}/live")) }.getOrNull() ?: return null
    return LiveSnapshot(j.bool("running") ?: false, j.double("startedAt"), j.str("activity"), StoredTrace.from(j["trace"]), j.str("text"))
  }

  /** Questions still waiting in this chat, as the events that asked them. */
  suspend fun pendingPrompts(sessionId: String): List<ServerEvent> {
    val j = runCatching { json(request("GET", "/api/chat/pending?sessionId=${q(sessionId)}")) }.getOrNull() ?: return emptyList()
    return j.arr("prompts").orEmpty().mapNotNull { p ->
      val o = p as? JsonObject ?: return@mapNotNull null
      val type = o.str("type") ?: return@mapNotNull null
      ServerEvent(type, o.toString())
    }
  }

  @Serializable private class PlanReply(val plan: ChatPlan? = null)
  @Serializable private class JobsReply(val jobs: List<PendingMedia> = emptyList())

  /** The plan Mercury was working through in this chat, if any. */
  suspend fun plan(sessionId: String): ChatPlan? =
    runCatching { decode(PlanReply.serializer(), request("GET", "/api/chat/plan?sessionId=${q(sessionId)}")).plan }.getOrNull()

  /** Videos or songs still being made for this chat. */
  suspend fun mediaJobs(sessionId: String): List<PendingMedia> =
    runCatching { decode(JobsReply.serializer(), request("GET", "/api/media/jobs?sessionId=${q(sessionId)}")).jobs }.getOrNull().orEmpty()

  fun artifactUrl(id: String): String = "${baseUrl.trimEnd('/')}/api/artifacts/${q(id)}/file"

  // MARK: Files

  /** Whether [url] is on this Mercury, so it gets the device token. Other hosts never see it. */
  fun owns(url: String): Boolean {
    val u = url.toHttpUrlOrNull() ?: return false
    val b = baseUrl.toHttpUrlOrNull() ?: return false
    return u.scheme == b.scheme && u.host == b.host && u.port == b.port
  }

  /**
   * Downloads [url] (with the token when it is this Mercury's) into [dest], through a temporary
   * file so a broken download never leaves half a file behind.
   */
  suspend fun downloadTo(url: String, dest: java.io.File, timeoutSeconds: Long = 120) {
    val u = url.toHttpUrlOrNull() ?: throw MercuryException.BadAddress()
    val b = Request.Builder().url(u)
    if (owns(url)) token?.let { b.header("Authorization", "Bearer $it") }
    val call = http.newCall(b.build())
    call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
    val res = try { call.await() } catch (e: CancellationException) { throw e } catch (e: IOException) { throw MercuryException.Unreachable(describe(e)) }
    res.use {
      if (it.code == 401) throw MercuryException.Unauthorized()
      if (it.code != 200) throw MercuryException.Server(it.code, "Couldn't download it.")
      val body = it.body ?: throw MercuryException.Server(it.code, "Couldn't download it.")
      dest.parentFile?.mkdirs()
      val tmp = java.io.File(dest.parentFile, dest.name + ".part")
      kotlinx.coroutines.withContext(Dispatchers.IO) {
        tmp.outputStream().use { out -> body.byteStream().use { inp -> inp.copyTo(out) } }
        if (!tmp.renameTo(dest)) { tmp.copyTo(dest, overwrite = true); tmp.delete() }
      }
    }
  }

  // MARK: Event streams

  /**
   * Opens a server-sent event stream with the Bearer token and reconnects with a 1 to 15 s backoff,
   * resuming from the last event id, until the collector stops. Mirrors iOS's `events(_:)`.
   */
  fun events(path: String): Flow<ServerEvent> = flow {
    val parser = SseParser()
    var delayMs = 1000L
    while (true) {
      try {
        val r = request("GET", path).newBuilder().header("Accept", "text/event-stream").apply {
          parser.lastId?.let { header("Last-Event-ID", it) }
        }.build()
        val call = streamHttp.newCall(r)
        coroutineScope {
          // Cancelling the collector cancels the call, which unblocks the read below.
          val watcher = launch { try { awaitCancellation() } finally { call.cancel() } }
          try {
            call.execute().use { res ->
              if (res.code != 200) throw IOException("stream refused (${res.code})")
              delayMs = 1000
              val source = res.body?.source() ?: throw IOException("no body")
              while (true) {
                val line = source.readUtf8Line() ?: break
                parser.feed(line)?.let { emit(it) }
              }
            }
          } finally {
            parser.reset()
            watcher.cancel()
          }
        }
      } catch (e: CancellationException) {
        throw e
      } catch (_: IOException) {
        // Dropped or refused: wait, then reconnect.
      }
      delay(delayMs)
      delayMs = (delayMs * 2).coerceAtMost(15_000)
    }
  }.flowOn(Dispatchers.IO)

  private val streamHttp: OkHttpClient by lazy {
    // Mercury writes a keepalive every 15 s: 45 s of silence means the connection is gone.
    http.newBuilder().readTimeout(45, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()
  }

  companion object {
    /** Plain http:// only on the local network ([LocalNetwork]); https:// anywhere. */
    val localOnlyCleartext = Interceptor { chain ->
      val url = chain.request().url
      if (!url.isHttps && !LocalNetwork.allowsCleartext(url.host)) {
        throw UnknownServiceException("CLEARTEXT to ${url.host} isn't allowed: use https://")
      }
      chain.proceed(chain.request())
    }

    val sharedHttp: OkHttpClient by lazy {
      OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .addInterceptor(localOnlyCleartext)
        .build()
    }

    /** Turns what the person typed into an origin: adds https:// when missing, drops paths and trailing slashes. */
    fun normalize(typed: String): String? {
      var s = typed.trim()
      if (s.isEmpty() || s.contains(' ')) return null
      if (!s.contains("://")) s = "https://$s"
      val scheme = s.substringBefore("://").lowercase()
      if (scheme != "http" && scheme != "https") return null
      val url = ("$scheme://" + s.substringAfter("://")).toHttpUrlOrNull() ?: return null
      if (url.host.isEmpty()) return null
      val host = if (url.host.contains(':')) "[${url.host}]" else url.host
      val defaultPort = if (scheme == "https") 443 else 80
      return "$scheme://$host" + if (url.port != defaultPort) ":${url.port}" else ""
    }

    /** Percent-encodes a path segment or query value. */
    fun q(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    fun describe(e: IOException): String = when {
      e is UnknownHostException -> "That address doesn't exist."
      e is ConnectException -> "Nothing is answering there. Is Mercury running?"
      e is SocketTimeoutException || (e is InterruptedIOException && e.message == "timeout") -> "It didn't answer in time."
      e is SSLException -> "Its HTTPS certificate isn't trusted."
      e is UnknownServiceException && e.message?.contains("CLEARTEXT") == true ->
        "Plain http:// works only on your own network. Use https:// for anything else."
      else -> e.message ?: "The connection failed."
    }

    internal fun device(e: JsonElement?): Device? {
      val o = e as? JsonObject ?: return null
      val id = o.str("id") ?: return null
      return Device(id, o.str("name") ?: "", o.str("platform"))
    }

    /** `mdt_<8 hex device id>_<64 hex>`: the device id is the middle part. */
    fun deviceIdFromToken(token: String): String? {
      val parts = token.split("_")
      return if (parts.size == 3 && parts[0] == "mdt") parts[1] else null
    }
  }
}

/** Runs an OkHttp call without blocking a thread; cancelling the coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
  cont.invokeOnCancellation { runCatching { cancel() } }
  enqueue(object : Callback {
    // A response that arrives after cancelling is closed off the main thread: closing can touch the
    // socket, and this handler may run on Dispatchers.Main (it crashed the app there).
    override fun onResponse(call: Call, response: Response) { cont.resume(response) { _, r, _ -> closeQuietly(r) } }
    override fun onFailure(call: Call, e: IOException) { if (!cont.isCancelled) cont.resumeWithException(e) }
  })
}

private val closer = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "mercury-close").apply { isDaemon = true } }

private fun closeQuietly(r: Response) { closer.execute { runCatching { r.close() } } }

/** The folder a Code turn works in (GET /api/workspace/info). */
data class WorkspaceInfo(val cwd: String, val name: String)
