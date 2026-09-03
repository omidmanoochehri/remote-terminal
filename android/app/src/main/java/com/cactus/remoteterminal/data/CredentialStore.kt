package com.cactus.remoteterminal.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Long-lived relay credentials. The device token is encrypted with an
 * AES-256-GCM key that lives in the Android Keystore (never exported), so the
 * SharedPreferences file holds only ciphertext. A key that was reset by the
 * OS (factory reset, some OEM security events) makes decryption fail; the
 * store then reports "not paired" and the user pairs again.
 *
 * Keystore operations can take tens of milliseconds: call from a worker thread.
 */
class CredentialStore(context: Context) {
    data class Credentials(val relayUrl: String, val deviceId: String, val deviceToken: String, val accountId: String)

    private val prefs = context.applicationContext.getSharedPreferences("rt_credentials", Context.MODE_PRIVATE)

    val isPaired: Boolean get() = prefs.contains(KEY_TOKEN) && prefs.contains(KEY_RELAY)
    val relayUrl: String? get() = prefs.getString(KEY_RELAY, null)
    val deviceId: String? get() = prefs.getString(KEY_DEVICE, null)
    val accountId: String? get() = prefs.getString(KEY_ACCOUNT, null)

    /** Decrypt and return the credentials, or null when not paired / undecryptable. */
    fun load(): Credentials? {
        val relay = relayUrl ?: return null
        val device = deviceId ?: return null
        val blob = prefs.getString(KEY_TOKEN, null) ?: return null
        val token = try { decrypt(blob) } catch (t: Throwable) {
            Log.w(TAG, "device token undecryptable; clearing credentials", t)
            clear()
            return null
        }
        return Credentials(relay, device, token, accountId ?: "default")
    }

    fun save(c: Credentials) {
        val blob = encrypt(c.deviceToken)
        prefs.edit()
            .putString(KEY_RELAY, c.relayUrl)
            .putString(KEY_DEVICE, c.deviceId)
            .putString(KEY_ACCOUNT, c.accountId)
            .putString(KEY_TOKEN, blob)
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    /* ------------------------------ keystore ------------------------------ */

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String {
        val parts = blob.split(':')
        require(parts.size == 2) { "malformed blob" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val ct = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(ct), Charsets.UTF_8)
    }

    companion object {
        private const val TAG = "CredentialStore"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "rt_device_token_v1"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val KEY_RELAY = "relay_url"
        private const val KEY_DEVICE = "device_id"
        private const val KEY_ACCOUNT = "account_id"
        private const val KEY_TOKEN = "device_token_enc"
    }
}
