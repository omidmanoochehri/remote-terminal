package com.cactus.remoteterminal.protocol

/**
 * Per-session bookkeeping of the output stream position and the attach
 * handshake (PROTOCOL.md §6). Pure Kotlin, no Android dependencies.
 *
 *  DETACHED ──beginAttach()──▶ ATTACHING ──onAttached(ack)──▶ ATTACHED
 *                                     │                          │ gap / lag / detach
 *                                     └──── stale ack ignored ◀──┘
 *
 * `lastSeq` is the stream position after the last applied chunk; live output
 * is only applied while ATTACHED, chunks at or before `lastSeq` are dropped
 * as duplicates, and a non-contiguous chunk signals a gap the host resolves
 * by re-attaching with `since`.
 */
class SessionStream {
    enum class State { DETACHED, ATTACHING, ATTACHED }
    enum class Verdict { APPLY, DUPLICATE, GAP, IGNORE }

    data class AttachResult(
        val accepted: Boolean,
        /** Clear the screen (keep local scrollback) before applying replayed output. */
        val resetScreen: Boolean,
        /** The agent could not resume exactly where we left off; show an "output lost" marker. */
        val outputLost: Boolean,
    )

    var state: State = State.DETACHED
        private set
    var lastSeq: Long = 0
        private set
    private var pendingReqId: String? = null
    private var pendingSince: Long? = null
    private var geometryCols = 0
    private var geometryRows = 0
    private var reqCounter = 0

    /**
     * Start (re-)attaching. Returns the `since` to send: the recorded position
     * when we have one and the terminal geometry is unchanged, else null (full
     * replay — a delta rendered for another width would be garbage).
     */
    fun beginAttach(cols: Int, rows: Int): Pair<String, Long?> {
        val since = if (lastSeq > 0 && cols == geometryCols && rows == geometryRows) lastSeq else null
        val reqId = "at${++reqCounter}"
        pendingReqId = reqId
        pendingSince = since
        state = State.ATTACHING
        return reqId to since
    }

    /** Handle `session.attached`. Stale acknowledgements (older reqIds) are ignored. */
    fun onAttached(reqId: String?, from: Long, seq: Long, cols: Int, rows: Int): AttachResult {
        if (reqId != pendingReqId) return AttachResult(accepted = false, resetScreen = false, outputLost = false)
        val since = pendingSince
        val lost = since != null && from > since
        val reset = since == null || lost
        // A full replay may start before our last position (we asked for everything);
        // a delta starts exactly at `since`. Either way the stream resumes at `from`.
        lastSeq = from
        geometryCols = cols
        geometryRows = rows
        pendingReqId = null
        pendingSince = null
        state = State.ATTACHED
        return AttachResult(accepted = true, resetScreen = reset, outputLost = lost)
    }

    /** Classify an `output` chunk ending at [seq] with [length] code units. */
    fun onOutput(seq: Long, length: Int): Verdict {
        if (state != State.ATTACHED) return Verdict.IGNORE
        if (seq <= lastSeq) return Verdict.DUPLICATE
        if (seq - length != lastSeq) {
            state = State.DETACHED // must re-attach with `since` to recover the missing range
            return Verdict.GAP
        }
        lastSeq = seq
        return Verdict.APPLY
    }

    /** The relay dropped output for us (`session.lag`): re-attach with `since`. */
    fun onLag() { if (state == State.ATTACHED) state = State.DETACHED }

    /** The connection dropped or the session was detached; keep `lastSeq` for resumption. */
    fun onDisconnected() { state = State.DETACHED; pendingReqId = null; pendingSince = null }

    /** The agent restarted (new instanceId) or the session is gone: nothing to resume. */
    fun reset() { state = State.DETACHED; lastSeq = 0; pendingReqId = null; pendingSince = null; geometryCols = 0; geometryRows = 0 }

    /** Geometry the host now renders at; a later attach only sends `since` if it still matches. */
    fun noteGeometry(cols: Int, rows: Int) {
        if (state == State.ATTACHED) { geometryCols = cols; geometryRows = rows }
    }
}
