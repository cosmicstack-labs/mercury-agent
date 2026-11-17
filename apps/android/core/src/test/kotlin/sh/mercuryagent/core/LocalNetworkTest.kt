package sh.mercuryagent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalNetworkTest {
  @Test fun privateAndLocalAllowCleartext() {
    listOf("127.0.0.1", "localhost", "192.168.1.7", "10.0.0.2", "172.20.1.1", "169.254.3.3", "100.101.102.103",
      "mymac.local", "mymac", "::1", "fd7a:115c::1", "fe80::1", "[::1]").forEach { assertTrue(it, LocalNetwork.allowsCleartext(it)) }
  }

  @Test fun publicNeedsHttps() {
    listOf("8.8.8.8", "172.32.0.1", "mercury.example.com", "2001:db8::1", "192.169.0.1", "")
      .forEach { assertFalse(it, LocalNetwork.allowsCleartext(it)) }
  }

  @Test fun normalize() {
    assertEquals("https://mercury.example.com", MercuryClient.normalize("  mercury.example.com/ "))
    assertEquals("http://192.168.1.7:6175", MercuryClient.normalize("http://192.168.1.7:6175/app?x=1#y"))
    assertEquals("https://host:8443", MercuryClient.normalize("HTTPS://user:pw@host:8443/"))
    assertEquals("http://mac.local", MercuryClient.normalize("http://mac.local:80"))
    assertNull(MercuryClient.normalize("ftp://x"))
    assertNull(MercuryClient.normalize("a b"))
    assertNull(MercuryClient.normalize(""))
  }

  @Test fun deviceIdFromToken() {
    assertEquals("ab12cd34", MercuryClient.deviceIdFromToken("mdt_ab12cd34_" + "f".repeat(64)))
    assertNull(MercuryClient.deviceIdFromToken("other"))
  }
}
