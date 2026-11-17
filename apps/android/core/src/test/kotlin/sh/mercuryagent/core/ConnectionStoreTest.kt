package sh.mercuryagent.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionStoreTest {
  @Test fun addActivateRemovePersist() = runBlocking {
    val kv = MemoryKeyValueStore(); val secrets = MemorySecretStore()
    val revoked = mutableListOf<String>()
    val store = ConnectionStore(kv, secrets) { url, token -> MercuryClient("http://127.0.0.1:1", token).also { revoked += url } }
    val a = Connection(id = "a", name = "Home", baseUrl = "http://192.168.1.7:6175")
    val b = Connection(id = "b", name = "Work", baseUrl = "https://w.example.com")
    store.add(a, "mdt_a"); store.add(b, "mdt_b")
    assertEquals("b", store.active?.id)
    assertEquals("mdt_a", secrets.get("connection:a"))
    store.activate("a")
    val reloaded = ConnectionStore(kv, secrets)
    assertEquals(listOf("a", "b"), reloaded.state.value.connections.map { it.id })
    assertEquals("a", reloaded.active?.id)
    assertEquals("mdt_a", reloaded.client(reloaded.active!!).token)
    store.remove("a")
    assertEquals("b", store.active?.id)
    assertNull(secrets.get("connection:a"))
    assertEquals(listOf("http://192.168.1.7:6175"), revoked)
  }
}
