package com.cactus.remoteterminal.net

import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * A dependency-free RFC 6455 WebSocket client for `ws://` and `wss://`.
 *
 * Hardened for a credential-carrying, long-lived terminal connection:
 *  - TLS with SNI and **hostname verification** (endpoint identification),
 *  - custom request headers (bearer token), handshake accept-key check,
 *  - connect/handshake timeouts, bounded frame and message sizes,
 *  - continuation frames, ping/pong with pong timeout (half-open detection),
 *  - close handshake with status codes surfaced to the listener,
 *  - all writes serialised on one thread; safe to call from any thread.
 *
 * Framing itself lives in [FrameCodec] so it can be tested on the JVM.
 */
class MiniWebSocket(
    private val url: String,
    private val headers: Map<String, String>,
    private val listener: Listener,
    private val options: Options = Options(),
) {
    interface Listener {
        fun onOpen()
        fun onText(text: String)
        /** Called exactly once per connection attempt that got past connect(), after the socket is closed. */
        fun onClose(code: Int, reason: String, remote: Boolean)
        fun onError(t: Throwable)
    }

    data class Options(
        val connectTimeoutMs: Int = 10_000,
        val handshakeTimeoutMs: Int = 10_000,
        val pingIntervalMs: Long = 25_000,
        val pongTimeoutMs: Long = 10_000,
        val maxFrameBytes: Long = 4L * 1024 * 1024,
        val maxMessageBytes: Int = 8 * 1024 * 1024,
    )

    private val rnd = SecureRandom()
    private var socket: Socket? = null
    private var out: OutputStream? = null
    private val closed = AtomicBoolean(false)
    private val closeReported = AtomicBoolean(false)
    @Volatile private var closeSent = false
    @Volatile private var pendingPong: ScheduledFuture<*>? = null

    private val sender = Executors.newSingleThreadExecutor { r -> Thread(r, "ws-tx").apply { isDaemon = true } }
    private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ws-timer").apply { isDaemon = true } }

    val isOpen: Boolean get() = !closed.get() && out != null

    fun connect() {
        Thread({ runLoop() }, "ws-rx").apply { isDaemon = true }.start()
    }

    private fun runLoop() {
        var closeCode = 1006
        var closeReason = "connection lost"
        var remote = false
        try {
            val uri = URI(url)
            val secure = when (uri.scheme) { "wss" -> true; "ws" -> false; else -> throw IllegalArgumentException("only ws:// and wss:// are supported") }
            val host = uri.host ?: throw IllegalArgumentException("missing host")
            val port = if (uri.port > 0) uri.port else if (secure) 443 else 80
            val path = buildString {
                append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
                if (!uri.rawQuery.isNullOrEmpty()) append('?').append(uri.rawQuery)
            }

            val plain = Socket()
            plain.tcpNoDelay = true
            plain.connect(InetSocketAddress(host, port), options.connectTimeoutMs)
            val sock: Socket = if (secure) {
                val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(plain, host, port, true) as SSLSocket
                // SNI is derived from `host`; endpoint identification makes the platform verify
                // that the certificate matches the host we asked for (raw SSLSocket does not).
                val params = ssl.sslParameters
                params.endpointIdentificationAlgorithm = "HTTPS"
                ssl.sslParameters = params
                ssl.soTimeout = options.handshakeTimeoutMs
                ssl.startHandshake()
                ssl
            } else plain
            socket = sock
            sock.soTimeout = options.handshakeTimeoutMs
            val input = BufferedInputStream(sock.getInputStream(), 64 * 1024)
            val output = sock.getOutputStream()
            handshake(output, input, host, port, path)
            sock.soTimeout = 0 // reads block; liveness comes from ping/pong
            out = output
            listener.onOpen()
            startHeartbeat()

            val assembler = FrameCodec.Assembler(options.maxMessageBytes)
            while (!closed.get()) {
                val frame = FrameCodec.read(input, options.maxFrameBytes) ?: break
                val msg = assembler.add(frame) ?: continue
                when (msg.opcode) {
                    FrameCodec.OP_TEXT -> listener.onText(msg.text)
                    FrameCodec.OP_BINARY -> { /* the relay never sends binary; ignore */ }
                    FrameCodec.OP_PING -> enqueue(FrameCodec.OP_PONG, msg.payload)
                    FrameCodec.OP_PONG -> pendingPong?.cancel(false).also { pendingPong = null }
                    FrameCodec.OP_CLOSE -> {
                        closeCode = FrameCodec.closeCode(msg.payload)
                        closeReason = FrameCodec.closeReason(msg.payload)
                        remote = true
                        if (!closeSent) { closeSent = true; enqueue(FrameCodec.OP_CLOSE, FrameCodec.closePayload(1000, "")) }
                        closed.set(true)
                        break
                    }
                }
            }
            if (!remote && closed.get() && userClose != null) { closeCode = userClose!!.first; closeReason = userClose!!.second }
        } catch (t: Throwable) {
            if (!closed.get()) { listener.onError(t); closeReason = t.message ?: t.javaClass.simpleName }
            else if (userClose != null) { closeCode = userClose!!.first; closeReason = userClose!!.second }
        } finally {
            closed.set(true)
            shutdownExecutors()
            closeQuietly()
            if (closeReported.compareAndSet(false, true)) listener.onClose(closeCode, closeReason, remote)
        }
    }

    /* ------------------------------ handshake ----------------------------- */

    private fun handshake(output: OutputStream, input: InputStream, host: String, port: Int, path: String) {
        val keyBytes = ByteArray(16).also { rnd.nextBytes(it) }
        val key = FrameCodec.base64(keyBytes)
        val req = buildString {
            append("GET ").append(path).append(" HTTP/1.1\r\n")
            append("Host: ").append(host)
            if (port != 80 && port != 443) append(':').append(port)
            append("\r\n")
            append("Upgrade: websocket\r\nConnection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ").append(key).append("\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("User-Agent: RemoteTerminal-Android\r\n")
            for ((k, v) in headers) {
                require(!k.contains('\r') && !k.contains('\n') && !v.contains('\r') && !v.contains('\n')) { "invalid header" }
                append(k).append(": ").append(v).append("\r\n")
            }
            append("\r\n")
        }
        output.write(req.toByteArray(Charsets.ISO_8859_1))
        output.flush()

        // Read status line + headers byte by byte so no frame bytes are swallowed.
        val sb = StringBuilder()
        while (!sb.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b == -1) throw IllegalStateException("server closed during handshake")
            sb.append(b.toChar())
            if (sb.length > 16 * 1024) throw IllegalStateException("handshake response too large")
        }
        val lines = sb.split("\r\n")
        val status = lines.firstOrNull() ?: ""
        if (!status.startsWith("HTTP/1.1 101")) throw IllegalStateException("handshake failed: ${status.trim()}")
        val accept = lines.drop(1).firstOrNull { it.startsWith("sec-websocket-accept:", ignoreCase = true) }
            ?.substringAfter(':')?.trim() ?: throw IllegalStateException("missing Sec-WebSocket-Accept")
        if (accept != FrameCodec.acceptFor(key)) throw IllegalStateException("bad Sec-WebSocket-Accept")
    }

    /* ------------------------------ heartbeat ----------------------------- */

    private fun startHeartbeat() {
        if (options.pingIntervalMs <= 0) return
        try {
            timer.scheduleWithFixedDelay({
                if (closed.get()) return@scheduleWithFixedDelay
                enqueue(FrameCodec.OP_PING, ByteArray(0))
                if (pendingPong == null) {
                    pendingPong = timer.schedule({
                        if (!closed.get()) {
                            listener.onError(IllegalStateException("pong timeout"))
                            fail(1006, "pong timeout")
                        }
                    }, options.pongTimeoutMs, TimeUnit.MILLISECONDS)
                }
            }, options.pingIntervalMs, options.pingIntervalMs, TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) { /* closing */ }
    }

    /* --------------------------------- send ------------------------------- */

    fun send(text: String) { enqueue(FrameCodec.OP_TEXT, text.toByteArray(Charsets.UTF_8)) }

    private fun enqueue(opcode: Int, payload: ByteArray) {
        try {
            sender.execute {
                try { writeFrame(opcode, payload) } catch (t: Throwable) { if (!closed.get()) { listener.onError(t); fail(1006, t.message ?: "write failed") } }
            }
        } catch (_: RejectedExecutionException) { /* already closing */ }
    }

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        val o = out ?: return
        val mask = ByteArray(4).also { rnd.nextBytes(it) }
        val frame = FrameCodec.encode(opcode, payload, mask)
        synchronized(o) { o.write(frame); o.flush() }
    }

    /* -------------------------------- close ------------------------------- */

    @Volatile private var userClose: Pair<Int, String>? = null

    /** Initiate a clean close; the reader reports onClose once the socket is down. */
    fun close(code: Int = 1000, reason: String = "") {
        if (closed.get()) return
        userClose = code to reason
        try {
            sender.execute {
                try {
                    if (!closeSent) { closeSent = true; writeFrame(FrameCodec.OP_CLOSE, FrameCodec.closePayload(code, reason)) }
                } catch (_: Throwable) { /* ignore */ }
                // Give the server a moment to echo the close, then drop the socket.
                try { timer.schedule({ fail(code, reason) }, 1500, TimeUnit.MILLISECONDS) } catch (_: RejectedExecutionException) { fail(code, reason) }
            }
        } catch (_: RejectedExecutionException) { fail(code, reason) }
    }

    /** Tear the socket down immediately; the reader thread reports onClose. */
    private fun fail(code: Int, reason: String) {
        if (userClose == null) userClose = code to reason
        closed.set(true)
        closeQuietly()
    }

    private fun shutdownExecutors() {
        try { timer.shutdownNow() } catch (_: Throwable) { /* ignore */ }
        try { sender.shutdown() } catch (_: Throwable) { /* ignore */ }
    }

    private fun closeQuietly() {
        try { socket?.close() } catch (_: Throwable) { /* ignore */ }
    }
}
