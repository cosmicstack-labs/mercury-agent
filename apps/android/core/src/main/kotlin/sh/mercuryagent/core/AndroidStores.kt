package sh.mercuryagent.core

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Tokens encrypted with an AES-256-GCM key that never leaves the Android Keystore (hardware-backed
 * where the phone has it), stored as base64(iv ‖ ciphertext) in app-private preferences. Excluded
 * from backups (res/xml/backup_rules.xml): a restored phone pairs again, as on iOS (ThisDeviceOnly).
 */
class KeystoreSecretStore(context: Context) : SecretStore {
  private val prefs: SharedPreferences = context.getSharedPreferences("mercury.secrets", Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  override fun get(account: String): String? {
    val stored = prefs.getString(account, null) ?: return null
    return runCatching {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val c = Cipher.getInstance(TRANSFORM)
      c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
      String(c.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
    }.getOrNull()
  }

  override fun set(account: String, value: String) {
    val c = Cipher.getInstance(TRANSFORM)
    c.init(Cipher.ENCRYPT_MODE, key())
    val out = c.iv + c.doFinal(value.toByteArray(Charsets.UTF_8))
    prefs.edit().putString(account, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
  }

  override fun remove(account: String) { prefs.edit().remove(account).apply() }

  private companion object {
    const val ALIAS = "mercury-device-tokens"
    const val TRANSFORM = "AES/GCM/NoPadding"
  }
}

class PrefsKeyValueStore(context: Context, name: String = "mercury") : KeyValueStore {
  private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
  override fun getString(key: String): String? = prefs.getString(key, null)
  override fun putString(key: String, value: String?) {
    prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
  }
}
