package com.cactus.remoteterminal.net

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

/**
 * RFC 6455 framing, kept free of Android classes so it is unit-testable on the
 * JVM: client frame encoding (always masked), server frame decoding with
 * 16/64-bit lengths and a hard size cap, continuation-frame reassembly with
 * interleaved control frames, UTF-8 validation of text messages, and the
 * handshake key / accept computation.
 */
object FrameCodec {
    const val OP_CONTINUATION = 0x0
    const val OP_TEXT = 0x1
    const val OP_BINARY = 0x2
    const val OP_CLOSE = 0x8
    const val OP_PING = 0x9
    const val OP_PONG = 0xA

    class Frame(val fin: Boolean, val opcode: Int, val payload: ByteArray) {
        val isControl: Boolean get() = opcode >= 0x8
    }

    class ProtocolException(message: String) : IOException(message)

    /** Encode one complete (FIN) client frame with the given 4-byte mask. */
    fun encode(opcode: Int, payload: ByteArray, mask: ByteArray): ByteArray {
        require(mask.size == 4) { "mask must be 4 bytes" }
        val len = payload.size
        val headerLen = 2 + when { len < 126 -> 0; len < 65536 -> 2; else -> 8 } + 4
        val out = ByteArray(headerLen + len)
        out[0] = (0x80 or (opcode and 0x0F)).toByte()
        var i = 2
        when {
            len < 126 -> out[1] = (0x80 or len).toByte()
            len < 65536 -> { out[1] = (0x80 or 126).toByte(); out[2] = (len shr 8).toByte(); out[3] = len.toByte(); i = 4 }
            else -> {
                out[1] = (0x80 or 127).toByte()
                val l = len.toLong()
                for (s in 0 until 8) out[2 + s] = (l shr (8 * (7 - s))).toByte()
                i = 10
            }
        }
        System.arraycopy(mask, 0, out, i, 4)
        i += 4
        for (k in 0 until len) out[i + k] = (payload[k].toInt() xor mask[k and 3].toInt()).toByte()
        return out
    }

    private fun readFully(input: InputStream, buf: ByteArray, len: Int) {
        var off = 0
        while (off < len) {
            val n = input.read(buf, off, len - off)
            if (n < 0) throw EOFException("stream ended mid-frame")
            off += n
        }
    }

    private fun readByte(input: InputStream): Int {
        val b = input.read()
        if (b < 0) throw EOFException("stream ended")
        return b
    }

    /**
     * Read one frame. Returns null at a clean end-of-stream before any byte.
     * @param maxPayload frames larger than this are refused (memory safety).
     */
    fun read(input: InputStream, maxPayload: Long): Frame? {
        val b0 = input.read()
        if (b0 < 0) return null
        if (b0 and 0x70 != 0) throw ProtocolException("reserved bits set")
        val fin = b0 and 0x80 != 0
        val opcode = b0 and 0x0F
        val b1 = readByte(input)
        val masked = b1 and 0x80 != 0
        var len = (b1 and 0x7F).toLong()
        if (len == 126L) {
            len = ((readByte(input) shl 8) or readByte(input)).toLong()
        } else if (len == 127L) {
            len = 0
            for (s in 0 until 8) len = (len shl 8) or readByte(input).toLong()
            if (len < 0) throw ProtocolException("invalid 64-bit length")
        }
        if (opcode >= 0x8 && (len > 125 || !fin)) throw ProtocolException("invalid control frame")
        if (len > maxPayload) throw ProtocolException("frame too large ($len bytes)")
        val mask = if (masked) ByteArray(4).also { readFully(input, it, 4) } else null
        val payload = ByteArray(len.toInt())
        readFully(input, payload, payload.size)
        if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        return Frame(fin, opcode, payload)
    }

    class Message(val opcode: Int, val payload: ByteArray) {
        val text: String get() = String(payload, Charsets.UTF_8)
    }

    /** Reassembles fragmented data messages; control frames pass straight through. */
    class Assembler(private val maxMessageBytes: Int) {
        private var opcode = -1
        private val parts = ArrayList<ByteArray>()
        private var size = 0

        /** @return a complete message, or null when more fragments are needed. */
        fun add(frame: Frame): Message? {
            if (frame.isControl) return Message(frame.opcode, frame.payload)
            when (frame.opcode) {
                OP_TEXT, OP_BINARY -> {
                    if (opcode != -1) throw ProtocolException("new data frame while a message is in progress")
                    if (frame.fin) return finish(frame.opcode, frame.payload)
                    opcode = frame.opcode
                }
                OP_CONTINUATION -> if (opcode == -1) throw ProtocolException("continuation without a start frame")
                else -> throw ProtocolException("unknown opcode ${frame.opcode}")
            }
            size += frame.payload.size
            if (size > maxMessageBytes) throw ProtocolException("message too large")
            parts.add(frame.payload)
            if (!frame.fin) return null
            val whole = ByteArray(size)
            var off = 0
            for (p in parts) { System.arraycopy(p, 0, whole, off, p.size); off += p.size }
            val op = opcode
            opcode = -1; parts.clear(); size = 0
            return finish(op, whole)
        }

        private fun finish(op: Int, payload: ByteArray): Message {
            if (op == OP_TEXT && !isValidUtf8(payload)) throw ProtocolException("invalid UTF-8 in text message")
            return Message(op, payload)
        }
    }

    /** Strict UTF-8 validation (no overlongs, surrogates or > U+10FFFF). */
    fun isValidUtf8(b: ByteArray): Boolean {
        var i = 0
        val n = b.size
        while (i < n) {
            val c = b[i].toInt() and 0xFF
            when {
                c < 0x80 -> i++
                c in 0xC2..0xDF -> { if (i + 1 >= n || !cont(b[i + 1])) return false; i += 2 }
                c in 0xE0..0xEF -> {
                    if (i + 2 >= n || !cont(b[i + 1]) || !cont(b[i + 2])) return false
                    val c1 = b[i + 1].toInt() and 0xFF
                    if (c == 0xE0 && c1 < 0xA0) return false           // overlong
                    if (c == 0xED && c1 >= 0xA0) return false          // surrogates
                    i += 3
                }
                c in 0xF0..0xF4 -> {
                    if (i + 3 >= n || !cont(b[i + 1]) || !cont(b[i + 2]) || !cont(b[i + 3])) return false
                    val c1 = b[i + 1].toInt() and 0xFF
                    if (c == 0xF0 && c1 < 0x90) return false           // overlong
                    if (c == 0xF4 && c1 >= 0x90) return false          // > U+10FFFF
                    i += 4
                }
                else -> return false
            }
        }
        return true
    }

    private fun cont(x: Byte) = (x.toInt() and 0xC0) == 0x80

    /** Close frame payload: 2-byte status code + optional UTF-8 reason. */
    fun closeCode(payload: ByteArray): Int = if (payload.size >= 2) ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF) else 1005
    fun closeReason(payload: ByteArray): String = if (payload.size > 2) String(payload, 2, payload.size - 2, Charsets.UTF_8) else ""
    fun closePayload(code: Int, reason: String): ByteArray {
        val r = reason.toByteArray(Charsets.UTF_8).let { if (it.size > 123) it.copyOf(123) else it }
        val out = ByteArray(2 + r.size)
        out[0] = (code shr 8).toByte(); out[1] = code.toByte()
        System.arraycopy(r, 0, out, 2, r.size)
        return out
    }

    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    /** Base64 without java.util.Base64 (API 26) or android.util (not on the JVM). */
    fun base64(data: ByteArray): String {
        val sb = StringBuilder((data.size + 2) / 3 * 4)
        var i = 0
        while (i < data.size) {
            val b0 = data[i].toInt() and 0xFF
            val b1 = if (i + 1 < data.size) data[i + 1].toInt() and 0xFF else -1
            val b2 = if (i + 2 < data.size) data[i + 2].toInt() and 0xFF else -1
            sb.append(B64[b0 shr 2])
            sb.append(B64[((b0 and 3) shl 4) or (if (b1 >= 0) b1 shr 4 else 0)])
            sb.append(if (b1 >= 0) B64[((b1 and 15) shl 2) or (if (b2 >= 0) b2 shr 6 else 0)] else '=')
            sb.append(if (b2 >= 0) B64[b2 and 63] else '=')
            i += 3
        }
        return sb.toString()
    }

    /** Expected Sec-WebSocket-Accept for a handshake key. */
    fun acceptFor(key: String): String {
        val sha1 = MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.US_ASCII))
        return base64(sha1)
    }
}
