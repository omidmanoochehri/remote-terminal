package com.cactus.remoteterminal.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cactus.remoteterminal.BuildConfig
import com.cactus.remoteterminal.data.CredentialStore
import com.cactus.remoteterminal.protocol.Incoming
import com.cactus.remoteterminal.protocol.PROTOCOL_VERSION
import com.cactus.remoteterminal.protocol.RelayEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min
import kotlin.random.Random

/**
 * The phone's single relay connection: authenticates with the stored device
 * token, keeps the socket alive with automatic exponential-backoff reconnects
 * (and an immediate retry when the network comes back), parses incoming
 * messages off the main thread, and delivers them **in order on the main
 * thread** to registered listeners. Requests carrying a `reqId` can be
 * awaited with [request].
 *
 * Sessions live on the agents, so a dropped socket loses nothing: listeners
 * (SessionRepository) re-attach with `since` after [ConnectionState.Connected].
 */
class RelayClient(context: Context, private val credentials: CredentialStore) : MiniWebSocket.Listener {

    sealed class ConnectionState {
        /** No device token stored: show the pairing screen. */
        object Unpaired : ConnectionState()
        object Disconnected : ConnectionState()
        data class Connecting(val attempt: Int) : ConnectionState()
        object Connected : ConnectionState()
        data class Reconnecting(val attempt: Int, val nextAtMs: Long, val reason: String) : ConnectionState()
        /** Not retrying: the relay refused us permanently (protocol mismatch). */
        data class Failed(val reason: String) : ConnectionState()
    }

    interface Listener {
        fun onRelayEvent(event: RelayEvent)
        fun onConnectionState(state: ConnectionState) {}
    }

    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val listeners = ArrayList<Listener>()
    private val pending = HashMap<String, CompletableDeferred<RelayEvent>>()
    private val reqCounter = AtomicInteger(0)

    private val _state = MutableStateFlow<ConnectionState>(if (credentials.isPaired) ConnectionState.Disconnected else ConnectionState.Unpaired)
    val state: StateFlow<ConnectionState> = _state

    private val _errors = MutableSharedFlow<RelayEvent.Error>(extraBufferCapacity = 16)
    /** Errors not consumed by a pending request (for snackbars). */
    val errors: SharedFlow<RelayEvent.Error> = _errors

    /** The last welcome, for limits/ids. */
    var deviceId: String? = credentials.deviceId; private set
    var accountId: String? = credentials.accountId; private set
    var connId: String? = null; private set

    private var ws: MiniWebSocket? = null
    private var wanted = false
    private var attempt = 0
    private var reconnectRunnable: Runnable? = null
    private var foreground = true
    private var backgroundClose: Runnable? = null
    @Volatile private var generation = 0

    private val connectivity = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { main.post { if (wanted && ws == null) reconnectNow("network available") } }
    }

    init {
        try { connectivity?.registerDefaultNetworkCallback(networkCallback) } catch (t: Throwable) { Log.w(TAG, "no network callback", t) }
    }

    fun addListener(l: Listener) { listeners.add(l) }
    fun removeListener(l: Listener) { listeners.remove(l) }

    val isConnected: Boolean get() = _state.value is ConnectionState.Connected

    /* ------------------------------ lifecycle ----------------------------- */

    /** Connect (if paired) and keep connected until [stop]. Main thread. */
    fun start() {
        if (!credentials.isPaired) { setState(ConnectionState.Unpaired); return }
        wanted = true
        cancelBackgroundClose()
        if (ws == null) connect()
    }

    fun stop() {
        wanted = false
        cancelReconnect()
        val g = ++generation
        ws?.close(1000, "app closed")
        ws = null
        if (g == generation) setState(if (credentials.isPaired) ConnectionState.Disconnected else ConnectionState.Unpaired)
    }

    /** Call after pairing: connect with the freshly stored token. */
    fun onPaired() {
        deviceId = credentials.deviceId
        accountId = credentials.accountId
        attempt = 0
        start()
    }

    /** Forget credentials locally (the relay may also have revoked them). */
    fun unpair() {
        stop()
        credentials.clear()
        deviceId = null
        setState(ConnectionState.Unpaired)
    }

    /**
     * Foreground/background hint from the UI. In the background the socket is
     * kept for a grace period, then closed to save battery; sessions keep
     * running on the agents and are re-attached on return.
     */
    fun setForeground(fg: Boolean) {
        foreground = fg
        if (fg) {
            cancelBackgroundClose()
            if (wanted && ws == null) reconnectNow("foreground")
            else if (!wanted && credentials.isPaired) start()
        } else if (wanted) {
            cancelBackgroundClose()
            backgroundClose = Runnable {
                backgroundClose = null
                if (!foreground) {
                    Log.i(TAG, "background grace period over; closing socket")
                    cancelReconnect()
                    ws?.close(1000, "background")
                }
            }.also { main.postDelayed(it, BACKGROUND_GRACE_MS) }
        }
    }

    private fun cancelBackgroundClose() { backgroundClose?.let { main.removeCallbacks(it) }; backgroundClose = null }

    fun reconnectNow(reason: String) {
        if (!wanted) return
        cancelReconnect()
        if (ws != null) return
        attempt = 0
        Log.i(TAG, "reconnect now: $reason")
        connect()
    }

    private fun connect() {
        val creds = credentials.load()
        if (creds == null) { wanted = false; setState(ConnectionState.Unpaired); return }
        val url = "${creds.relayUrl.trimEnd('/')}/?v=$PROTOCOL_VERSION&role=phone"
        setState(ConnectionState.Connecting(attempt))
        val socket = MiniWebSocket(url, mapOf("Authorization" to "Bearer ${creds.deviceToken}"), this)
        ws = socket
        generation++
        socket.connect()
    }

    private fun scheduleReconnect(reason: String) {
        if (!wanted) { setState(ConnectionState.Disconnected); return }
        cancelReconnect()
        val delay = min(30_000L, 500L * (1L shl min(attempt, 6))) + Random.nextLong(400)
        attempt++
        setState(ConnectionState.Reconnecting(attempt, System.currentTimeMillis() + delay, reason))
        reconnectRunnable = Runnable { reconnectRunnable = null; if (wanted && ws == null) connect() }.also { main.postDelayed(it, delay) }
    }

    private fun cancelReconnect() { reconnectRunnable?.let { main.removeCallbacks(it) }; reconnectRunnable = null }

    private fun setState(s: ConnectionState) {
        if (_state.value == s) return
        _state.value = s
        for (l in listeners.toList()) l.onConnectionState(s)
    }

    /* ------------------------------- sending ------------------------------ */

    /** Send raw JSON text. Returns false when not connected (the caller decides whether that matters). */
    fun send(json: String): Boolean {
        val s = ws ?: return false
        if (!isConnected) return false
        s.send(json)
        return true
    }

    fun nextReqId(): String = "r${reqCounter.incrementAndGet()}"

    /**
     * Send a request built with a fresh reqId and await the correlated reply
     * (`session.created`, `session.attached` or `error`). Main thread.
     */
    suspend fun request(timeoutMs: Long = 15_000, build: (reqId: String) -> String): RelayEvent {
        val reqId = nextReqId()
        val deferred = CompletableDeferred<RelayEvent>()
        pending[reqId] = deferred
        if (!send(build(reqId))) {
            pending.remove(reqId)
            return RelayEvent.Error("disconnected", "Not connected to the relay.", reqId, null, null)
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (t: Throwable) {
            pending.remove(reqId)
            RelayEvent.Error("timeout", "The relay did not answer in time.", reqId, null, null)
        }
    }

    /**
     * Like [request], but the caller sends several messages under one reqId
     * (a file transfer: begin, chunks, end) and awaits the single reply.
     */
    suspend fun requestMulti(timeoutMs: Long = 120_000, send: suspend (reqId: String) -> Boolean): RelayEvent {
        val reqId = nextReqId()
        val deferred = CompletableDeferred<RelayEvent>()
        pending[reqId] = deferred
        return try {
            if (!send(reqId)) {
                pending.remove(reqId)
                RelayEvent.Error("disconnected", "Not connected to the relay.", reqId, null, null)
            } else withTimeout(timeoutMs) { deferred.await() }
        } catch (t: Throwable) {
            pending.remove(reqId)
            RelayEvent.Error("timeout", "The machine did not answer in time.", reqId, null, null)
        }
    }

    /* ------------------------------ receiving ----------------------------- */

    override fun onOpen() {
        // Wait for `welcome` before declaring Connected (the relay may still refuse us).
    }

    override fun onText(text: String) {
        // Parse here (socket thread) so JSON work never blocks the UI; deliver in order on main.
        val event = try { Incoming.parse(text) } catch (t: Throwable) { Log.w(TAG, "bad message: ${t.message}"); return }
        main.post { dispatch(event) }
    }

    private fun dispatch(event: RelayEvent) {
        when (event) {
            is RelayEvent.Welcome -> {
                attempt = 0
                connId = event.connId
                deviceId = event.deviceId
                accountId = event.accountId
                setState(ConnectionState.Connected)
            }
            is RelayEvent.Error -> {
                val d = event.reqId?.let { pending.remove(it) }
                if (d != null) { d.complete(event); return }
                _errors.tryEmit(event)
            }
            is RelayEvent.SessionCreated -> event.reqId?.let { pending.remove(it) }?.complete(event)
            is RelayEvent.SessionAttached -> event.reqId?.let { pending.remove(it) }?.complete(event)
            is RelayEvent.FileStored -> event.reqId?.let { pending.remove(it) }?.complete(event)
            else -> {}
        }
        for (l in listeners.toList()) l.onRelayEvent(event)
    }

    override fun onClose(code: Int, reason: String, remote: Boolean) {
        main.post {
            ws = null
            for (d in pending.values) d.complete(RelayEvent.Error("disconnected", "Connection lost.", null, null, null))
            pending.clear()
            when (code) {
                4401 -> {
                    Log.w(TAG, "relay revoked this device")
                    wanted = false
                    credentials.clear()
                    deviceId = null
                    setState(ConnectionState.Unpaired)
                    for (l in listeners.toList()) l.onRelayEvent(RelayEvent.Error("unauthorized", "This phone was unpaired.", null, null, null))
                }
                4426 -> { wanted = false; setState(ConnectionState.Failed("This app is too old for the relay (protocol v$PROTOCOL_VERSION required).")) }
                else -> {
                    val why = if (reason.isNotBlank()) reason else if (remote) "closed by relay ($code)" else "connection lost"
                    if (!wanted || (!foreground && backgroundClose == null && code == 1000)) setState(ConnectionState.Disconnected)
                    else scheduleReconnect(why)
                }
            }
        }
    }

    override fun onError(t: Throwable) {
        Log.w(TAG, "socket error: ${t.message}")
    }

    companion object {
        private const val TAG = "RelayClient"
        const val BACKGROUND_GRACE_MS = 90_000L
        val APP_VERSION: String = BuildConfig.VERSION_NAME
    }
}
