package com.cactus.remoteterminal.ui

/**
 * What a scanned pairing QR code is allowed to contain. Kept separate from the
 * scanner screen so the accepted shapes are testable without a camera.
 *
 * Two forms are accepted:
 *  - a bare six-digit code, as the agent prints it and a paired phone shows it;
 *  - a `remoteterminal://pair?relay=…&code=…` link, which also carries the relay.
 *
 * Anything else is rejected: the scanner must not silently take a relay URL
 * from an arbitrary QR code a user happens to point the camera at.
 */
object PairingPayload {

    data class Parsed(val relay: String?, val code: String)

    private val CODE = Regex("^[0-9]{6}$")

    fun parse(text: String?): Parsed? {
        val trimmed = text?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        if (CODE.matches(trimmed)) return Parsed(null, trimmed)

        val scheme = trimmed.substringBefore("://", missingDelimiterValue = "").lowercase()
        if (scheme != "remoteterminal") return null
        val query = trimmed.substringAfter('?', missingDelimiterValue = "")
        if (query.isEmpty()) return null

        val params = HashMap<String, String>()
        for (pair in query.split('&')) {
            val key = pair.substringBefore('=')
            if (key.isEmpty()) continue
            params[key.lowercase()] = decode(pair.substringAfter('=', missingDelimiterValue = ""))
        }

        val code = params["code"]?.filter { it.isDigit() } ?: return null
        if (!CODE.matches(code)) return null

        val relay = params["relay"]?.takeIf { it.isNotEmpty() }
        // Only relay URLs we would connect to anyway; never an arbitrary scheme.
        if (relay != null && !relay.startsWith("ws://") && !relay.startsWith("wss://")) return null
        return Parsed(relay, code)
    }

    /** Minimal percent-decoding; pairing links carry only a URL and digits. */
    private fun decode(value: String): String {
        if ('%' !in value && '+' !in value) return value
        return try {
            java.net.URLDecoder.decode(value, "UTF-8")
        } catch (_: Exception) {
            value
        }
    }
}
