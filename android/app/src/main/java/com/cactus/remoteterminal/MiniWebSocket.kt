package com.cactus.remoteterminal

import android.util.Base64
import java.io.DataInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.net.URI
import java.security.SecureRandom

/**
 * A minimal RFC 6455 WebSocket client (text frames), supporting both `ws://`
 * and `wss://` (TLS via the platform SSL factory).
 *
 * Hand-rolled so the networking path stays dependency-free. This covers exactly
 * what the relay needs: an HTTP Upgrade handshake, masked client text frames,
 * decoding server text/ping/close frames, and a periodic client ping to keep
 * idle NAT paths open.
 */
class MiniWebSocket(private val url: String, private val listener: Listener) {

    interface Listener {
        fun onOpen()
        fun onText(text: String)
        fun onClose(reason: String)
        fun onError(t: Throwable)
    }

    private var socket: Socket? = null
    private var out: OutputStream? = null
    @Volatile private var closed = false
    private val rnd = SecureRandom()

    // All socket writes go through this single background thread. Android's
    // StrictMode throws NetworkOnMainThreadException if we write from the UI
    // thread (e.g. a button tap), and it also serialises concurrent sends.
    private val sender = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "mini-ws-tx").apply { isDaemon = true }
    }

    // Periodic client ping (opcode 0x9) so idle NAT mappings don't get reaped.
    private val heartbeat = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "mini-ws-hb").apply { isDaemon = true }
    }

    private fun startHeartbeat() {
        heartbeat.scheduleWithFixedDelay({
            if (!closed) enqueue(0x9, ByteArray(0))
        }, 25, 25, java.util.concurrent.TimeUnit.SECONDS)
    }

    fun connect() {
        Thread({ runLoop() }, "mini-ws").apply { isDaemon = true }.start()
    }

    private fun runLoop() {
        try {
            val uri = URI(url)
            val secure = uri.scheme == "wss"
            require(uri.scheme == "ws" || secure) { "only ws:// and wss:// are supported" }
            val host = uri.host
            val port = if (uri.port > 0) uri.port else if (secure) 443 else 80
            val path = buildString {
                append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
                if (!uri.rawQuery.isNullOrEmpty()) append("?").append(uri.rawQuery)
            }

            val sock = if (secure) {
                (javax.net.ssl.SSLSocketFactory.getDefault().createSocket(host, port)
                    as javax.net.ssl.SSLSocket).also { it.startHandshake() }
            } else {
                Socket(host, port)
            }
            socket = sock
            val input = sock.getInputStream()
            val output = sock.getOutputStream()
            out = output

            handshake(output, input, host, port, path)
            listener.onOpen()
            startHeartbeat()

            val din = DataInputStream(input)
            readFrames(din)
        } catch (t: Throwable) {
            if (!closed) listener.onError(t)
        } finally {
            heartbeat.shutdownNow()
            closeQuietly()
            if (!closed) listener.onClose("connection ended")
        }
    }

    /* ------------------------------ handshake ----------------------------- */

    private fun handshake(output: OutputStream, input: InputStream, host: String, port: Int, path: String) {
        val keyBytes = ByteArray(16).also { rnd.nextBytes(it) }
        val key = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
        val req = buildString {
            append("GET ").append(path).append(" HTTP/1.1\r\n")
            append("Host: ").append(host).append(":").append(port).append("\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ").append(key).append("\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("\r\n")
        }
        output.write(req.toByteArray(Charsets.ISO_8859_1))
        output.flush()

        // Read status line + headers up to the blank line, one byte at a time
        // so we do not swallow any frame bytes that follow the handshake.
        val sb = StringBuilder()
        while (!sb.endsWith("\r\n\r\n")) {
            val bch = input.read()
            if (bch == -1) throw IllegalStateException("server closed during handshake")
            sb.append(bch.toChar())
        }
        val statusLine = sb.lineSequence().firstOrNull() ?: ""
        if (!statusLine.contains(" 101")) {
            throw IllegalStateException("handshake failed: $statusLine")
        }
    }

    /* -------------------------------- frames ------------------------------ */

    private fun readFrames(din: DataInputStream) {
        while (!closed) {
            val b0 = din.read()
            if (b0 == -1) break
            val opcode = b0 and 0x0F
            val b1 = din.readUnsignedByte()
            val masked = (b1 and 0x80) != 0
            var len = (b1 and 0x7F).toLong()
            if (len == 126L) {
                len = din.readUnsignedShort().toLong()
            } else if (len == 127L) {
                len = din.readLong()
            }
            val mask = if (masked) ByteArray(4).also { din.readFully(it) } else null
            val payload = ByteArray(len.toInt())
            din.readFully(payload)
            if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()

            when (opcode) {
                0x1 -> listener.onText(String(payload, Charsets.UTF_8)) // text
                0x8 -> { // close
                    closed = true
                    listener.onClose("server closed")
                    return
                }
                0x9 -> enqueue(0xA, payload) // ping -> pong
                else -> { /* pong / continuation / binary: ignored */ }
            }
        }
    }

    fun send(text: String) {
        enqueue(0x1, text.toByteArray(Charsets.UTF_8))
    }

    private fun enqueue(opcode: Int, payload: ByteArray) {
        try {
            sender.execute {
                try { sendFrame(opcode, payload) } catch (t: Throwable) { if (!closed) listener.onError(t) }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { /* already closing */ }
    }

    @Synchronized
    private fun sendFrame(opcode: Int, payload: ByteArray) {
        val o = out ?: return
        val header = ArrayList<Byte>(14)
        header.add((0x80 or opcode).toByte()) // FIN + opcode
        val len = payload.size
        val maskBit = 0x80 // client frames MUST be masked
        when {
            len < 126 -> header.add((maskBit or len).toByte())
            len < 65536 -> {
                header.add((maskBit or 126).toByte())
                header.add(((len shr 8) and 0xFF).toByte())
                header.add((len and 0xFF).toByte())
            }
            else -> {
                header.add((maskBit or 127).toByte())
                for (s in 7 downTo 0) header.add(((len.toLong() shr (8 * s)) and 0xFF).toByte())
            }
        }
        val mask = ByteArray(4).also { rnd.nextBytes(it) }
        val masked = ByteArray(len)
        for (i in 0 until len) masked[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()

        val o2 = o
        synchronized(o2) {
            o2.write(header.toByteArray())
            o2.write(mask)
            o2.write(masked)
            o2.flush()
        }
    }

    fun close() {
        if (closed) return
        closed = true
        heartbeat.shutdownNow()
        try {
            sender.execute {
                try { sendFrame(0x8, ByteArray(0)) } catch (_: Throwable) {}
                closeQuietly()
            }
            sender.shutdown()
        } catch (_: Throwable) {
            closeQuietly()
        }
    }

    private fun closeQuietly() {
        try { socket?.close() } catch (_: Throwable) {}
    }
}
