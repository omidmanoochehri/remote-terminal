/**
 * Per-session bookkeeping of the output stream position and the attach
 * handshake (PROTOCOL.md §6). A port of `SessionStream.kt`; no DOM, no Tauri.
 *
 *  DETACHED ──beginAttach()──▶ ATTACHING ──onAttached(ack)──▶ ATTACHED
 *                                     │                          │ gap / lag / detach
 *                                     └──── stale ack ignored ◀──┘
 *
 * `lastSeq` is the stream position after the last applied chunk; live output is
 * only applied while ATTACHED, chunks at or before `lastSeq` are dropped as
 * duplicates, and a non-contiguous chunk signals a gap the host resolves by
 * re-attaching with `since`.
 */

export const State = Object.freeze({ DETACHED: 'DETACHED', ATTACHING: 'ATTACHING', ATTACHED: 'ATTACHED' });
export const Verdict = Object.freeze({ APPLY: 'APPLY', DUPLICATE: 'DUPLICATE', GAP: 'GAP', IGNORE: 'IGNORE' });

export class SessionStream {
  constructor() {
    this.state = State.DETACHED;
    this.lastSeq = 0;
    this.pendingReqId = null;
    this.pendingSince = null;
    this.geometryCols = 0;
    this.geometryRows = 0;
    this.reqCounter = 0;
  }

  /**
   * Start (re-)attaching. Returns `{ reqId, since }`: the recorded position
   * when we have one and the terminal geometry is unchanged, else null (full
   * replay — a delta rendered for another width would be garbage).
   */
  beginAttach(cols, rows) {
    const since = this.lastSeq > 0 && cols === this.geometryCols && rows === this.geometryRows ? this.lastSeq : null;
    const reqId = `at${++this.reqCounter}`;
    this.pendingReqId = reqId;
    this.pendingSince = since;
    this.state = State.ATTACHING;
    return { reqId, since };
  }

  /** Handle `session.attached`. Stale acknowledgements (older reqIds) are ignored. */
  onAttached(reqId, from, seq, cols, rows) {
    void seq;
    if (reqId !== this.pendingReqId) return { accepted: false, resetScreen: false, outputLost: false };
    const since = this.pendingSince;
    const lost = since != null && from > since;
    const reset = since == null || lost;
    // A full replay may start before our last position (we asked for everything);
    // a delta starts exactly at `since`. Either way the stream resumes at `from`.
    this.lastSeq = from;
    this.geometryCols = cols;
    this.geometryRows = rows;
    this.pendingReqId = null;
    this.pendingSince = null;
    this.state = State.ATTACHED;
    return { accepted: true, resetScreen: reset, outputLost: lost };
  }

  /** Classify an `output` chunk ending at [seq] with [length] code units. */
  onOutput(seq, length) {
    if (this.state !== State.ATTACHED) return Verdict.IGNORE;
    if (seq <= this.lastSeq) return Verdict.DUPLICATE;
    if (seq - length !== this.lastSeq) {
      this.state = State.DETACHED; // must re-attach with `since` to recover the missing range
      return Verdict.GAP;
    }
    this.lastSeq = seq;
    return Verdict.APPLY;
  }

  /** The relay dropped output for us (`session.lag`): re-attach with `since`. */
  onLag() {
    if (this.state === State.ATTACHED) this.state = State.DETACHED;
  }

  /** The connection dropped or the session was detached; keep `lastSeq` for resumption. */
  onDisconnected() {
    this.state = State.DETACHED;
    this.pendingReqId = null;
    this.pendingSince = null;
  }

  /** The agent restarted (new instanceId) or the session is gone: nothing to resume. */
  reset() {
    this.state = State.DETACHED;
    this.lastSeq = 0;
    this.pendingReqId = null;
    this.pendingSince = null;
    this.geometryCols = 0;
    this.geometryRows = 0;
  }

  /** Geometry the host now renders at; a later attach only sends `since` if it still matches. */
  noteGeometry(cols, rows) {
    if (this.state === State.ATTACHED) {
      this.geometryCols = cols;
      this.geometryRows = rows;
    }
  }
}
