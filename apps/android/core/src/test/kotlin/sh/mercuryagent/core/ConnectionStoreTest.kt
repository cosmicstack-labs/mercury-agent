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

  /** A record list as version 1 saved it: no logo field at all. */
  private fun oldRecords(vararg names: String): MemoryKeyValueStore {
    val items = names.mapIndexed { i, n -> """{"id":"c$i","name":"$n","baseUrl":"http://192.168.1.${i + 2}:6175","createdAt":"2026-01-01T00:00:00Z"}""" }
    return MemoryKeyValueStore().also { it.putString(ConnectionStore.KEY, """{"version":1,"connections":[${items.joinToString(",")}],"activeId":"c1"}""") }
  }

  @Test fun oldRecordsKeepTheirNameAndGetTheRotationsLogos() {
    val kv = oldRecords("studio.local", "Home", "")
    val store = ConnectionStore(kv, MemorySecretStore())
    assertEquals(listOf("studio.local", "Home", "192.168.1.4"), store.state.value.connections.map { it.name })
    assertEquals(listOf("shades", "party", "headphones"), store.state.value.connections.map { it.logo })
    assertEquals("c1", store.active?.id)
    // Saved once: a second launch reads the same logos back.
    val again = ConnectionStore(kv, MemorySecretStore())
    assertEquals(listOf("shades", "party", "headphones"), again.state.value.connections.map { it.logo })
  }

  @Test fun newMercurysTakeTheNextLogoNotInUse() {
    val store = ConnectionStore(MemoryKeyValueStore(), MemorySecretStore())
    assertEquals("shades", store.nextLogo)
    store.add(Connection(id = "a", name = "A", baseUrl = "http://a.local"), "mdt_a")
    store.add(Connection(id = "b", name = "B", baseUrl = "http://b.local"), "mdt_b")
    assertEquals(listOf("shades", "party"), store.state.value.connections.map { it.logo })
    assertEquals("headphones", store.nextLogo)
    // The first switched to Headphones: Shades is free again and comes next.
    store.update("a", "A", "headphones")
    assertEquals("shades", store.nextLogo)
    store.add(Connection(id = "c", name = "C", baseUrl = "http://c.local", logo = "pirate"), "mdt_c")
    assertEquals("pirate", store.active?.logo)
    val all = ConnectionLogos.ids.map { Connection(name = it, baseUrl = "http://x.local", logo = it) }
    assertEquals("shades", ConnectionLogos.next(all))
    assertEquals("party", ConnectionLogos.next(all + all[0]))
  }

  @Test fun renameAndLogoPersistAndBlankNamesAreIgnored() {
    val kv = oldRecords("Home", "Work")
    val store = ConnectionStore(kv, MemorySecretStore())
    store.update("c0", "  Mercury on MacBook  ", "wizard")
    store.update("c1", "   ", "not-a-logo")
    val again = ConnectionStore(kv, MemorySecretStore())
    assertEquals(listOf("Mercury on MacBook", "Work"), again.state.value.connections.map { it.name })
    assertEquals(listOf("wizard", "party"), again.state.value.connections.map { it.logo })
    assertEquals("shades", Connection(name = "x", baseUrl = "http://x", logo = "gone").logoId)
  }

  @Test fun suggestedNamesComeFromTheComputersNameThenTheAddress() {
    val ip = "http://192.168.1.7:6175"
    assertEquals("Mercury on Salmans MacBook Pro", ConnectionLogos.suggestedName("Salmans-MacBook-Pro.local", ip))
    assertEquals("Mercury on studio", ConnectionLogos.suggestedName("studio", ip))
    assertEquals("Mercury", ConnectionLogos.suggestedName("  ", ip))
    assertEquals("Mercury", ConnectionLogos.suggestedName(null, ip))
    assertEquals("Mercury", ConnectionLogos.suggestedName(null, "http://localhost:6174"))
    assertEquals("Mercury", ConnectionLogos.suggestedName(null, "http://[::1]:6174"))
    assertEquals("Mercury on salmans mac", ConnectionLogos.suggestedName(null, "http://salmans-mac.local:6175"))
    assertEquals("mercury.tail1234.ts.net", ConnectionLogos.suggestedName(null, "https://mercury.tail1234.ts.net"))
  }
}
