'use strict';

/*
 * Sessions: one shell process each, with a bounded output history, attached
 * clients, and a lifecycle that is independent of any network connection.
 *
 *   running ──(process exits)──▶ exited ──(retention)──▶ closed
 *      └────────── close() ─────────┴──────────────────▶ closed
 *
 * Output is coalesced per session (a short timer, capped chunk size) so a
 * busy shell produces tens of messages per second rather than thousands.
 * Every emitted chunk carries the stream position after it (`seq`).
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { OutputRing } = require('./ring');
const { findShell } = require('./shells');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function newSessionId() {
  const bytes = crypto.randomBytes(20);
  let s = 's_';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

class Session extends EventEmitter {
  constructor({ id, shell, title, cols, rows, term, replayBytes, coalesceMs, maxChunk, now }) {
    super();
    this.id = id;
    this.shell = shell;          // shell definition {id,label,cmd,args}
    this.title = title;
    this.cols = cols;
    this.rows = rows;
    this.term = term;            // pty handle (see pty.js)
    this.now = now;
    this.state = 'running';
    this.exitCode = null;
    this.createdAt = now();
    this.lastActiveAt = this.createdAt;
    this.exitedAt = null;
    this.clients = new Set();
    this.ring = new OutputRing(replayBytes);
    this.coalesceMs = coalesceMs;
    this.maxChunk = Math.max(1024, maxChunk | 0);
    this.pending = '';
    this.flushTimer = null;
    this.paused = false;

    term.onData((data) => this.onData(data));
    term.onExit((code) => this.onExit(code));
  }

  get seq() { return this.ring.head; }

  onData(data) {
    if (this.state !== 'running') return;
    this.ring.append(data);
    this.pending += data;
    this.lastActiveAt = this.now();
    if (this.pending.length >= this.maxChunk) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.coalesceMs);
    }
  }

  /** Emit everything buffered as one or more `output` chunks with correct seqs. */
  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.pending) return;
    const data = this.pending;
    this.pending = '';
    const start = this.ring.head - data.length;
    for (let off = 0; off < data.length; off += this.maxChunk) {
      const chunk = data.slice(off, off + this.maxChunk);
      this.emit('output', { seq: start + off + chunk.length, data: chunk });
    }
  }

  write(data) {
    if (this.state !== 'running') return false;
    this.term.write(data);
    this.lastActiveAt = this.now();
    return true;
  }

  /** Resize the PTY; returns true when the geometry changed. */
  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols; this.rows = rows;
    if (this.state === 'running') { try { this.term.resize(cols, rows); } catch (_) { /* dead pty */ } }
    this.emit('updated', { cols, rows });
    return true;
  }

  /**
   * Attach a client. Flushes pending output first so the returned range is
   * complete up to `seq`, then returns the replay chunks for [from, seq).
   */
  attach(clientId, since) {
    this.flush();
    this.clients.add(clientId);
    const { from, data } = this.ring.rangeFrom(since);
    const chunks = [];
    for (let off = 0; off < data.length; off += this.maxChunk) {
      const chunk = data.slice(off, off + this.maxChunk);
      chunks.push({ seq: from + off + chunk.length, data: chunk });
    }
    return { from, seq: this.ring.head, chunks };
  }

  detach(clientId) { return this.clients.delete(clientId); }

  onExit(code) {
    if (this.state !== 'running') return;
    this.flush();
    this.state = 'exited';
    this.exitCode = code;
    this.exitedAt = this.now();
    this.emit('exit', code);
  }

  close(reason) {
    if (this.state === 'closed') return;
    const wasRunning = this.state === 'running';
    this.flush();
    this.state = 'closed';
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (wasRunning) { try { this.term.kill(); } catch (_) { /* gone */ } }
    this.emit('closed', reason);
    this.removeAllListeners();
  }

  pause() { if (!this.paused) { this.paused = true; this.term.pause(); } }
  resume() { if (this.paused) { this.paused = false; this.term.resume(); } }

  rename(title) { this.title = title; this.emit('updated', { title }); }

  info() {
    return {
      sessionId: this.id,
      title: this.title,
      shell: this.shell.id,
      state: this.state === 'closed' ? 'exited' : this.state,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      cols: this.cols,
      rows: this.rows,
      seq: this.ring.head,
      attached: this.clients.size,
      exitCode: this.exitCode,
    };
  }
}

class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class SessionManager extends EventEmitter {
  /**
   * @param {{cfg:object, log:object, shells:Array, spawn:Function, now?:Function, cwd?:string}} opts
   *   `spawn(opts)` must return a pty handle (see pty.js); injected for tests.
   */
  constructor({ cfg, log, shells, spawn, now = Date.now, cwd = '' }) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.shells = shells;
    this.spawn = spawn;
    this.now = now;
    this.cwd = cwd;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.sweeper = null;
  }

  create({ shell: shellId, cols, rows, title, env }) {
    const shell = findShell(this.shells, shellId);
    if (!shell) throw new SessionError('bad_request', `unknown shell "${shellId}"`);
    if (this.sessions.size >= this.cfg.maxSessions) throw new SessionError('limit_reached', `session limit (${this.cfg.maxSessions}) reached`);
    const id = newSessionId();
    let term;
    try {
      term = this.spawn({ cmd: shell.cmd, args: shell.args || [], cwd: shell.cwd || this.cwd || undefined, env, cols, rows });
    } catch (err) {
      this.log.error('failed to spawn shell', { shell: shell.id, err: err.message });
      throw new SessionError('internal', `cannot start ${shell.label}: ${err.message}`);
    }
    const session = new Session({
      id, shell, title: title || this.defaultTitle(shell), cols, rows, term,
      replayBytes: this.cfg.replayBytes, coalesceMs: this.cfg.coalesceMs, maxChunk: this.cfg.maxChunk, now: this.now,
    });
    this.sessions.set(id, session);
    this.log.info('session created', { sessionId: id, shell: shell.id, pid: term.pid, mode: term.mode, cols, rows });

    session.on('output', (o) => this.emit('output', session, o));
    session.on('updated', (patch) => this.emit('session.updated', session, patch));
    session.on('exit', (code) => {
      this.log.info('session exited', { sessionId: id, code });
      this.emit('exit', session, code);
      this.emit('session.updated', session, { state: 'exited', exitCode: code });
    });
    session.on('closed', (reason) => {
      this.sessions.delete(id);
      this.log.info('session closed', { sessionId: id, reason });
      this.emit('session.closed', session, reason);
    });
    return session;
  }

  defaultTitle(shell) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.shell.id === shell.id) n++;
    return n === 0 ? shell.label : `${shell.label} ${n + 1}`;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new SessionError('unknown_session', 'no such session');
    return s;
  }

  has(id) { return this.sessions.has(id); }

  list() { return [...this.sessions.values()].map((s) => s.info()); }

  attach(id, clientId, since) { return this.get(id).attach(clientId, since); }

  detach(id, clientId) { const s = this.sessions.get(id); if (s) s.detach(clientId); }

  clientGone(clientId) { for (const s of this.sessions.values()) s.detach(clientId); }

  /** The relay connection dropped: relay-side attachments are gone, phones will re-attach. */
  detachAll() { for (const s of this.sessions.values()) s.clients.clear(); }

  close(id, reason = 'closed') { this.get(id).close(reason); }

  closeAll(reason) { for (const s of [...this.sessions.values()]) s.close(reason); }

  rename(id, title) { this.get(id).rename(title); }

  pauseAll() { for (const s of this.sessions.values()) s.pause(); }
  resumeAll() { for (const s of this.sessions.values()) s.resume(); }

  /** Close detached-idle running sessions and expired exited sessions. */
  sweep() {
    const now = this.now();
    const idleMs = this.cfg.idleTimeoutSec * 1000;
    const retentionMs = this.cfg.exitedRetentionSec * 1000;
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'running' && s.clients.size === 0 && idleMs > 0 && now - s.lastActiveAt >= idleMs) s.close('idle');
      else if (s.state === 'exited' && now - s.exitedAt >= retentionMs) s.close('exited');
    }
  }

  startSweeper(intervalMs = 30_000) {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  stopSweeper() { if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; } }
}

module.exports = { Session, SessionManager, SessionError, newSessionId };
