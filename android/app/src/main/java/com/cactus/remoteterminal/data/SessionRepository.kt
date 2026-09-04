package com.cactus.remoteterminal.data

import android.util.Log
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.Outgoing
import com.cactus.remoteterminal.protocol.RelayEvent
import com.cactus.remoteterminal.protocol.SessionInfo
import com.cactus.remoteterminal.protocol.SessionStream
import com.cactus.remoteterminal.terminal.TerminalEmulator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * One open terminal tab: the emulator holding its screen, the stream state
 * that keeps replay and live output consistent, and the last known metadata.
 * All access is on the main thread.
 */
class TerminalSession(val agentId: String, val sessionId: String, scrollback: Int) {
    val emulator = TerminalEmulator(80, 24, scrollback)
    val stream = SessionStream()

    var title: String = ""
    var shell: String = ""
    /**
     * Where the shell is, as far as this phone can tell: the agent reports it
     * when the platform can resolve it, a shell that sends OSC 7 keeps it live,
     * and starting a terminal in a directory seeds it. Empty means unknown, and
     * everything that uses it treats that as "do not assume".
     */
    var cwd: String = ""
    var state: String = "running"          // "running" | "exited" | "closed"
    var exitCode: Int? = null
    var closedReason: String? = null
    var attachError: String? = null

    /** Rows of output that arrived while this tab was not the visible one (for the "N new lines" badge). */
    var unreadRows: Int = 0

    /**
     * Input queued before the shell was attached (the working directory and
     * the optional start-up command chosen on the New terminal screen). Sent
     * once, on the first successful attach.
     */
    var startupInput: String? = null

    /** When this tab was opened on this phone; used until the relay reports createdAt. */
    val openedAt: Long = System.currentTimeMillis()

    /** Bumped on every metadata/stream change so views can re-render cheaply. */
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version
    fun bump() { _version.value = _version.value + 1 }

    /** Bumped when the emulator content changed (the view redraws on the next frame). */
    var onOutput: (() -> Unit)? = null

    val key: String get() = "$agentId|$sessionId"
    val isRunning: Boolean get() = state == "running"
    val displayTitle: String get() = title.ifEmpty { shell.ifEmpty { "Terminal" } }

    fun applyInfo(info: SessionInfo) {
        title = info.title; shell = info.shell; state = info.state; exitCode = info.exitCode
        if (info.cwd.isNotEmpty()) cwd = info.cwd
        bump()
    }

    /** A new working directory from the shell itself or from the agent. */
    fun noteDirectory(dir: String) {
        if (dir.isEmpty() || dir == cwd) return
        cwd = dir
        bump()
    }
}

/**
 * Owns the open terminal tabs per machine and drives the attach/replay/
 * live-output protocol for each of them (PROTOCOL.md §6). Tabs survive
 * disconnects: on every reconnect (or when a machine comes back) they are
 * re-attached with `since`, so the shell process and its scrollback continue.
 */
class SessionRepository(
    private val client: RelayClient,
    private val agents: AgentRepository,
    private val settings: Settings,
) : RelayClient.Listener {

    private val sessions = LinkedHashMap<String, TerminalSession>()
    private val tabsByAgent = HashMap<String, MutableStateFlow<List<TerminalSession>>>()
    private val instanceIds = HashMap<String, String?>()

    /** Session ids whose exit/close should raise a notification (set by the notifier). */
    var onSessionExited: ((TerminalSession) -> Unit)? = null
    var onBell: ((TerminalSession) -> Unit)? = null
    /** A program set the clipboard via OSC 52 (the host decides whether to honour it). */
    var onClipboard: ((TerminalSession, String) -> Unit)? = null

    init {
        client.addListener(this)
        // Restore open tabs from the last run for every cached machine.
        for (a in agents.agents.value) for (sid in settings.openTabs(a.agentId)) get(a.agentId, sid)
    }

    fun tabs(agentId: String): StateFlow<List<TerminalSession>> =
        tabsByAgent.getOrPut(agentId) { MutableStateFlow(sessions.values.filter { it.agentId == agentId }) }

    fun find(agentId: String, sessionId: String): TerminalSession? = sessions["$agentId|$sessionId"]

    /** The tab for a session, creating (and opening) it if needed. */
    fun get(agentId: String, sessionId: String): TerminalSession {
        sessions["$agentId|$sessionId"]?.let { return it }
        val s = TerminalSession(agentId, sessionId, settings.scrollbackLines)
        agents.session(agentId, sessionId)?.let { s.applyInfo(it) }
        s.emulator.onBell = { onBell?.invoke(s) }
        s.emulator.onClipboard = { text -> onClipboard?.invoke(s, text) }
        // Wired on the session, not the view, so a tab learns where its shell
        // went even while another tab is the visible one.
        s.emulator.onWorkingDirectory = { dir -> s.noteDirectory(dir) }
        sessions[s.key] = s
        publish(agentId)
        return s
    }

    private fun publish(agentId: String) {
        val list = sessions.values.filter { it.agentId == agentId }
        tabs(agentId).let { (it as MutableStateFlow).value = list }
        settings.setOpenTabs(agentId, list.map { it.sessionId })
    }

    /* ------------------------------ commands ------------------------------ */

    /** Create a new terminal on a machine and open it as a tab. Returns the tab or an error message. */
    suspend fun create(agentId: String, shell: String?, cols: Int, rows: Int, title: String?): Result<TerminalSession> {
        val reply = client.request { reqId -> Outgoing.sessionCreate(reqId, agentId, shell, cols, rows, title) }
        return when (reply) {
            is RelayEvent.SessionCreated -> {
                val s = get(agentId, reply.session.sessionId)
                s.applyInfo(reply.session)
                if (shell != null) settings.setLastShell(agentId, shell)
                attach(s, cols, rows)
                Result.success(s)
            }
            is RelayEvent.Error -> Result.failure(IllegalStateException(reply.display))
            else -> Result.failure(IllegalStateException("Unexpected reply"))
        }
    }

    /** Attach (or re-attach) a tab at the given geometry; safe to call repeatedly. */
    fun attach(s: TerminalSession, cols: Int, rows: Int) {
        if (!client.isConnected) return
        if (s.state == "closed") return
        if (s.stream.state == SessionStream.State.ATTACHING) return
        val (reqId, since) = s.stream.beginAttach(cols, rows)
        s.attachError = null
        client.send(Outgoing.sessionAttach(reqId, s.agentId, s.sessionId, since, cols, rows))
        s.bump()
    }

    /** Keep the tab but stop receiving its output (the shell keeps running). */
    fun detach(s: TerminalSession) {
        if (s.stream.state != SessionStream.State.DETACHED) client.send(Outgoing.sessionDetach(s.agentId, s.sessionId))
        s.stream.onDisconnected()
        s.bump()
    }

    /** Close the tab; with [terminate] the shell process is killed too. */
    fun closeTab(s: TerminalSession, terminate: Boolean) {
        if (terminate) client.send(Outgoing.sessionClose(s.agentId, s.sessionId))
        else detach(s)
        sessions.remove(s.key)
        publish(s.agentId)
    }

    fun rename(s: TerminalSession, title: String) {
        client.send(Outgoing.sessionRename(s.agentId, s.sessionId, title))
        s.title = title; s.bump()
    }

    /**
     * Hold [data] until the freshly created session is attached, then send it
     * as ordinary input so the user sees it echoed in the scrollback.
     */
    fun queueStartupInput(s: TerminalSession, data: String) {
        if (data.isEmpty()) return
        if (s.stream.state == SessionStream.State.ATTACHED) input(s, data) else s.startupInput = data
    }

    fun input(s: TerminalSession, data: String): Boolean {
        if (s.stream.state != SessionStream.State.ATTACHED) return false
        return client.send(Outgoing.input(s.agentId, s.sessionId, data))
    }

    /** The view's grid changed size: resize the emulator and tell the agent. */
    fun resize(s: TerminalSession, cols: Int, rows: Int) {
        if (s.emulator.cols == cols && s.emulator.rows == rows) return
        s.emulator.resize(cols, rows)
        s.stream.noteGeometry(cols, rows)
        if (s.stream.state == SessionStream.State.ATTACHED) client.send(Outgoing.resize(s.agentId, s.sessionId, cols, rows))
        s.onOutput?.invoke()
    }

    /**
     * Send a file into a session (a pasted image). Chunks stay well under the
     * relay's frame limit; the agent answers with the path it stored.
     */
    suspend fun sendFile(s: TerminalSession, name: String, mime: String, bytes: ByteArray): Result<String> {
        if (s.stream.state != SessionStream.State.ATTACHED) return Result.failure(IllegalStateException("Terminal is not attached"))
        if (bytes.isEmpty()) return Result.failure(IllegalArgumentException("Empty file"))
        val reply = client.requestMulti { reqId ->
            if (!client.send(Outgoing.fileBegin(reqId, s.agentId, s.sessionId, name, mime, bytes.size))) return@requestMulti false
            var offset = 0
            var seq = 0
            while (offset < bytes.size) {
                val end = minOf(offset + CHUNK_BYTES, bytes.size)
                val encoded = android.util.Base64.encodeToString(bytes, offset, end - offset, android.util.Base64.NO_WRAP)
                if (!client.send(Outgoing.fileChunk(reqId, s.agentId, s.sessionId, seq++, encoded))) {
                    client.send(Outgoing.fileAbort(reqId, s.agentId, s.sessionId))
                    return@requestMulti false
                }
                offset = end
            }
            client.send(Outgoing.fileEnd(reqId, s.agentId, s.sessionId))
        }
        return when (reply) {
            is RelayEvent.FileStored -> Result.success(reply.path)
            is RelayEvent.Error -> Result.failure(IllegalStateException(reply.display))
            else -> Result.failure(IllegalStateException("Unexpected reply"))
        }
    }

    /** Re-attach every open tab of [agentId] (or all agents) — after connect / agent online. */
    fun reattachAll(agentId: String? = null) {
        for (s in sessions.values) {
            if (agentId != null && s.agentId != agentId) continue
            if (s.state != "running") continue
            if (agents.agent(s.agentId)?.online != true) continue
            // Machine settings can opt a machine out of automatic re-attachment,
            // and a single terminal can opt out of being restored.
            if (!settings.autoReconnect(s.agentId)) continue
            if (!settings.restoreOnReconnect(s.key)) continue
            attach(s, s.emulator.cols, s.emulator.rows)
        }
    }

    /**
     * True when at least one machine with open terminals asked to be kept
     * alive in the background; the relay client uses this to decide whether to
     * hold the socket during the background grace period.
     */
    fun wantsBackgroundKeepAlive(): Boolean =
        sessions.values.any { it.state == "running" && settings.keepAlive(it.agentId) }

    /* ------------------------------- events ------------------------------- */

    override fun onConnectionState(state: RelayClient.ConnectionState) {
        if (state is RelayClient.ConnectionState.Connected) return // welcome event handles re-attach (after agent list is known)
        for (s in sessions.values) { s.stream.onDisconnected(); s.bump() }
    }

    override fun onRelayEvent(event: RelayEvent) {
        when (event) {
            is RelayEvent.Welcome -> {
                for (a in event.agents) noteInstance(a.agentId, a.instanceId)
                refreshMetadata()
                pruneClosed(event.agents.associate { it.agentId to it.sessions.map { s -> s.sessionId }.toSet() })
                reattachAll()
            }
            // Tabs restored from the last run have no title until the relay
            // describes their sessions; take it as soon as a list arrives.
            is RelayEvent.AgentList -> refreshMetadata()
            is RelayEvent.AgentOnline -> {
                noteInstance(event.agent.agentId, event.agent.instanceId)
                refreshMetadata(event.agent.agentId)
                pruneClosed(mapOf(event.agent.agentId to event.agent.sessions.map { it.sessionId }.toSet()))
                reattachAll(event.agent.agentId)
            }
            is RelayEvent.AgentOffline -> for (s in sessions.values) if (s.agentId == event.agentId) { s.stream.onDisconnected(); s.bump() }
            is RelayEvent.AgentRemoved -> {
                for (s in sessions.values.filter { it.agentId == event.agentId }) { s.state = "closed"; s.closedReason = "removed"; sessions.remove(s.key) }
                publish(event.agentId)
            }
            is RelayEvent.SessionAttached -> find(event.agentId, event.sessionId)?.let { s ->
                val r = s.stream.onAttached(event.reqId, event.from, event.seq, event.cols, event.rows)
                if (!r.accepted) return
                s.emulator.muteResponses = true
                if (r.resetScreen) s.emulator.clearScreen()
                if (r.outputLost) s.emulator.feed("\r\n[2m[… earlier output not available …][0m\r\n")
                if (event.cols > 0 && event.rows > 0 && (event.cols != s.emulator.cols || event.rows != s.emulator.rows)) {
                    // The agent's PTY is a different size (another phone set it); follow it until our resize lands.
                    s.emulator.resize(event.cols, event.rows)
                }
                s.emulator.muteResponses = false
                s.bump(); s.onOutput?.invoke()
                s.startupInput?.let { queued -> s.startupInput = null; input(s, queued) }
            }
            is RelayEvent.Output -> find(event.agentId, event.sessionId)?.let { s ->
                when (s.stream.onOutput(event.seq, event.data.length)) {
                    SessionStream.Verdict.APPLY -> {
                        // Replayed output must not trigger terminal queries again.
                        val replaying = event.seq <= (agents.session(s.agentId, s.sessionId)?.seq ?: Long.MAX_VALUE) && false
                        s.emulator.muteResponses = replaying
                        s.emulator.feed(event.data)
                        s.emulator.muteResponses = false
                        s.onOutput?.invoke()
                    }
                    SessionStream.Verdict.GAP -> { Log.w(TAG, "gap in ${s.sessionId}; re-attaching"); attach(s, s.emulator.cols, s.emulator.rows) }
                    else -> {}
                }
            }
            is RelayEvent.SessionLag -> find(event.agentId, event.sessionId)?.let { s -> s.stream.onLag(); attach(s, s.emulator.cols, s.emulator.rows) }
            is RelayEvent.SessionUpdated -> find(event.agentId, event.sessionId)?.let { s ->
                event.title?.let { s.title = it }
                event.state?.let { s.state = it }
                event.exitCode?.let { s.exitCode = it }
                event.cwd?.let { s.noteDirectory(it) }
                if (event.cols != null && event.rows != null && event.cols > 0 && event.rows > 0 && s.stream.state == SessionStream.State.ATTACHED
                    && (event.cols != s.emulator.cols || event.rows != s.emulator.rows)) {
                    s.emulator.resize(event.cols, event.rows); s.onOutput?.invoke()
                }
                s.bump()
            }
            is RelayEvent.Exit -> find(event.agentId, event.sessionId)?.let { s ->
                s.state = "exited"; s.exitCode = event.code
                s.emulator.feed("\r\n[2m[process exited with code ${event.code ?: "?"}][0m\r\n")
                s.onOutput?.invoke(); s.bump()
                onSessionExited?.invoke(s)
            }
            is RelayEvent.SessionClosed -> find(event.agentId, event.sessionId)?.let { s ->
                s.state = "closed"; s.closedReason = event.reason
                s.stream.onDisconnected()
                if (event.reason != "closed" && event.reason != "exited") s.emulator.feed("\r\n[2m[terminal closed: ${event.reason}][0m\r\n")
                s.onOutput?.invoke(); s.bump()
            }
            is RelayEvent.Error -> if (event.sessionId != null && event.agentId != null) find(event.agentId, event.sessionId)?.let { s ->
                if (event.code == "unknown_session") { s.state = "closed"; s.closedReason = "gone"; s.stream.reset() }
                s.attachError = event.display
                s.bump()
            }
            else -> {}
        }
    }

    /** Copy the relay's view of each open tab onto it (title, shell, state). */
    private fun refreshMetadata(agentId: String? = null) {
        for (s in sessions.values) {
            if (agentId != null && s.agentId != agentId) continue
            agents.session(s.agentId, s.sessionId)?.let { s.applyInfo(it) }
        }
    }

    /** A restarted agent has none of its old sessions; forget what we knew about them. */
    private fun noteInstance(agentId: String, instanceId: String?) {
        val prev = instanceIds[agentId]
        instanceIds[agentId] = instanceId
        if (prev != null && instanceId != null && prev != instanceId) {
            for (s in sessions.values) if (s.agentId == agentId) s.stream.reset()
        }
    }

    /** Tabs whose sessions no longer exist on the agent are marked closed (kept for reading, not re-attached). */
    private fun pruneClosed(known: Map<String, Set<String>>) {
        for (s in sessions.values) {
            val ids = known[s.agentId] ?: continue
            if (s.sessionId !in ids && s.state != "closed") {
                s.state = "closed"; s.closedReason = "gone"
                s.stream.reset()
                s.emulator.feed("\r\n[2m[this terminal no longer exists on the machine][0m\r\n")
                s.onOutput?.invoke(); s.bump()
            }
        }
    }

    companion object {
        private const val TAG = "SessionRepository"
        /** 192 KiB raw → 256 KiB base64, comfortably inside the relay's 1 MiB frame limit. */
        private const val CHUNK_BYTES = 192 * 1024
    }
}
