package com.cactus.remoteterminal.data

import org.json.JSONObject

/**
 * Wake-on-LAN: the magic packet (six 0xFF then the MAC sixteen times), MAC
 * parsing, and the directed broadcast of an interface. Pure, so it is tested
 * on the JVM; the UDP send lives with the UI.
 *
 * Kept identical to the desktop's Wake-on-LAN helpers.
 */
object WakeOnLan {
    const val DEFAULT_BROADCAST = "255.255.255.255"
    const val DEFAULT_PORT = 9

    /**
     * What is remembered per machine under `wol.<agentId>`. [manual] marks
     * details the user typed, which a later `sys.info` must not overwrite.
     */
    data class Target(
        val mac: String,
        val broadcast: String = DEFAULT_BROADCAST,
        val port: Int = DEFAULT_PORT,
        val manual: Boolean = false,
    ) {
        fun toJson(): JSONObject = JSONObject().put("mac", mac).put("broadcast", broadcast).put("port", port)
            .also { if (manual) it.put("manual", true) }

        companion object {
            fun fromJson(raw: String?): Target? {
                if (raw.isNullOrEmpty()) return null
                return try {
                    val o = JSONObject(raw)
                    Target(
                        mac = o.optString("mac", ""),
                        broadcast = o.optString("broadcast", "").ifEmpty { DEFAULT_BROADCAST },
                        port = o.optInt("port", DEFAULT_PORT).takeIf { it in 1..65535 } ?: DEFAULT_PORT,
                        manual = o.optBoolean("manual", false),
                    )
                } catch (_: Exception) { null }
            }
        }
    }

    /**
     * Six bytes from `aa:bb:cc:dd:ee:ff`, `aa-bb-…`, `aabb.ccdd.eeff` or
     * `aabbccddeeff` (any case), or null when it is not a MAC address.
     */
    fun parseMac(text: String): ByteArray? {
        val hex = text.trim().replace(":", "").replace("-", "").replace(".", "")
        if (hex.length != 12 || !hex.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null
        return ByteArray(6) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    /** `aa:bb:cc:dd:ee:ff`. */
    fun formatMac(bytes: ByteArray): String = bytes.joinToString(":") { String.format(java.util.Locale.ROOT, "%02x", it.toInt() and 0xFF) }

    /** A MAC as typed, tidied to the canonical form, or null. */
    fun normalizeMac(text: String): String? = parseMac(text)?.let { formatMac(it) }

    /** 102 bytes: 6 × 0xFF, then the MAC 16 times. */
    fun magicPacket(mac: ByteArray): ByteArray {
        require(mac.size == 6) { "A MAC address has six bytes" }
        val out = ByteArray(6 + 16 * 6)
        for (i in 0 until 6) out[i] = 0xFF.toByte()
        for (r in 0 until 16) System.arraycopy(mac, 0, out, 6 + r * 6, 6)
        return out
    }

    private fun parseIpv4(s: String): Long? {
        val parts = s.trim().split('.')
        if (parts.size != 4) return null
        var v = 0L
        for (p in parts) {
            val n = p.toIntOrNull() ?: return null
            if (n !in 0..255 || p.isEmpty() || (p.length > 1 && p.startsWith("0"))) return null
            v = (v shl 8) or n.toLong()
        }
        return v
    }

    private fun formatIpv4(v: Long): String = listOf(24, 16, 8, 0).joinToString(".") { ((v shr it) and 0xFF).toString() }

    fun isIpv4(s: String): Boolean = parseIpv4(s) != null

    /**
     * The directed broadcast of an IPv4 `address/prefix` (`192.168.1.20/24` →
     * `192.168.1.255`), or null for IPv6, a bad value, or a /31–/32 which has
     * no broadcast address.
     */
    fun directedBroadcast(cidr: String): String? {
        val slash = cidr.indexOf('/')
        if (slash <= 0) return null
        val ip = parseIpv4(cidr.substring(0, slash)) ?: return null
        val prefix = cidr.substring(slash + 1).toIntOrNull() ?: return null
        if (prefix !in 0..30) return null
        val hostMask = (1L shl (32 - prefix)) - 1
        return formatIpv4((ip or hostMask) and 0xFFFFFFFFL)
    }

    /**
     * The target suggested by a `sys.info` answer: the first interface that has
     * a MAC and an IPv4 address, broadcasting to that network (or everywhere
     * when its prefix is unknown). Null when no interface qualifies.
     */
    fun suggest(info: com.cactus.remoteterminal.protocol.SysInfo): Target? {
        for (iface in info.interfaces) {
            val mac = iface.mac?.let { normalizeMac(it) } ?: continue
            if (mac == "00:00:00:00:00:00") continue
            val v4 = iface.addresses.firstOrNull { it.family == "IPv4" } ?: continue
            val broadcast = v4.cidr?.let { directedBroadcast(it) } ?: DEFAULT_BROADCAST
            return Target(mac, broadcast, DEFAULT_PORT)
        }
        return null
    }
}
