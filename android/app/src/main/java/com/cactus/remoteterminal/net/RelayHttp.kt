package com.cactus.remoteterminal.net

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * The relay's HTTPS identity endpoints (PROTOCOL.md §2). Blocking; call from
 * an IO dispatcher. Uses the platform HTTP stack so TLS validation and
 * hostname verification are the system's.
 */
object RelayHttp {
    class RelayException(val status: Int, val code: String, message: String) : IOException(message)

    data class Response(val status: Int, val body: JSONObject)
    data class PairResult(val deviceId: String, val deviceToken: String, val accountId: String)
    data class PairCode(val code: String, val expiresAt: Long, val ttlSec: Int)

    /** ws(s):// → http(s):// base URL without trailing slash. */
    fun httpBase(relayUrl: String): String {
        val u = URI(relayUrl.trim())
        val scheme = when (u.scheme?.lowercase()) {
            "ws", "http" -> "http"
            "wss", "https" -> "https"
            else -> throw IllegalArgumentException("Relay URL must start with ws:// or wss://")
        }
        val host = u.host ?: throw IllegalArgumentException("Relay URL needs a host")
        val port = if (u.port > 0) ":${u.port}" else ""
        val path = (u.rawPath ?: "").trimEnd('/')
        return "$scheme://$host$port$path"
    }

    /** Normalise what the user typed into a ws(s):// URL. */
    fun normalizeRelayUrl(input: String): String {
        var s = input.trim().trimEnd('/')
        if (s.startsWith("https://")) s = "wss://" + s.removePrefix("https://")
        else if (s.startsWith("http://")) s = "ws://" + s.removePrefix("http://")
        else if (!s.startsWith("ws://") && !s.startsWith("wss://")) s = "wss://$s"
        URI(s).host ?: throw IllegalArgumentException("Relay URL needs a host")
        return s
    }

    fun postJson(relayUrl: String, path: String, body: JSONObject, bearer: String? = null, timeoutMs: Int = 15_000): Response {
        val conn = URL(httpBase(relayUrl) + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", "RemoteTerminal-Android")
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer $bearer")
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            val json = try { if (text.isBlank()) JSONObject() else JSONObject(text) } catch (_: Exception) { JSONObject().put("error", "bad_response").put("message", text.take(200)) }
            return Response(status, json)
        } finally {
            conn.disconnect()
        }
    }

    private fun fail(r: Response, fallback: String): Nothing {
        val code = r.body.optString("error", "http_$${r.status}")
        val msg = r.body.optString("message").ifEmpty { fallback }
        throw RelayException(r.status, code, msg)
    }

    /** Redeem a pairing code for this device's long-lived token. */
    fun redeem(relayUrl: String, code: String, deviceName: String, appVersion: String): PairResult {
        val r = postJson(relayUrl, "/v3/pair/redeem", JSONObject()
            .put("code", code.trim()).put("deviceName", deviceName).put("platform", "android").put("appVersion", appVersion))
        if (r.status != 201) fail(r, "pairing failed (HTTP ${r.status})")
        return PairResult(r.body.getString("deviceId"), r.body.getString("deviceToken"), r.body.optString("accountId", "default"))
    }

    /** Mint a pairing code for another phone ("Add phone"). */
    fun pairCode(relayUrl: String, deviceToken: String): PairCode {
        val r = postJson(relayUrl, "/v3/pair/code", JSONObject(), bearer = deviceToken)
        if (r.status != 201) fail(r, "could not create a pairing code (HTTP ${r.status})")
        return PairCode(r.body.getString("code"), r.body.optLong("expiresAt", 0L), r.body.optInt("ttlSec", 300))
    }
}
