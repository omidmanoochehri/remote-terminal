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
const fs = require('fs');
const { EventEmitter } = require('events');
const { OutputRing } = require('./ring');
const { findShell } = require('./shells');

/** How often a session may re-read where its shell is (ms). */
const CWD_SAMPLE_MS = 750;

/** The longest command line a session remembers (and reports). */
const MAX_COMMAND = 256;

/**
 * How long a restored terminal has to stay up before its restart counts as
 * settled rather than as part of a crash loop (see restore.js).
 */
const RESTORE_SETTLE_MS = 60000;
/** How much recent output is searched for the echo of a typed line. */
const ECHO_WINDOW = 4096;
/** Input larger than this is a paste, not something being typed. */
const BULK_INPUT = 8192;
/** How long a line sent whole has to be echoed back before it is forgotten. */
const ECHO_WAIT_MS = 400;

/**
 * A shell that supports directory reporting announces where it is with
 * OSC 7 (`ESC ] 7 ; file://host/path BEL`), and Windows Terminal's shell
 * integration with OSC 9;9. Both are how a Windows or macOS agent — where
 * the working directory is otherwise unreadable — can still say where a
 * terminal is, and so bring it back in the same place after a restart.
 */
const OSC_CWD_RE = /\x1b]((?:7;(?:file:\/\/[^\x07\x1b]*))|(?:9;9;[^\x07\x1b]*))(?:\x07|\x1b\\)/g;

/**
 * The working directory of a live process. Linux publishes it; Windows keeps
 * it behind APIs Node cannot reach, and macOS behind `lsof`, so both keep the
 * directory the shell was started in rather than guessing.
 */
function defaultReadCwd(pid) {
  if (process.platform !== 'linux' || !pid) return '';
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { return ''; }
}

/**
 * The last directory a chunk of output announced, or '' when it announced
 * none. `file://host/path` keeps only the path (the only machine that could
 * have written it is this one) and percent escapes are decoded; a Windows
 * shell sends `/C:/Users/...`, which is that path with a stray slash.
 */
function parseOscCwd(chunk) {
  if (!chunk || chunk.indexOf('\x1b]') === -1) return '';
  let found = '';
  OSC_CWD_RE.lastIndex = 0;
  for (let m = OSC_CWD_RE.exec(chunk); m; m = OSC_CWD_RE.exec(chunk)) {
    const body = m[1];
    let raw = body.startsWith('9;9;') ? body.slice(4).replace(/^"|"$/g, '') : body.slice(2);
    if (raw.startsWith('file://')) {
      const slash = raw.indexOf('/', 7);
      if (slash === -1) continue;
      try { raw = decodeURIComponent(raw.slice(slash)); } catch (_) { continue; } // a malformed escape is not a path
    }
    if (raw.length > 2 && raw[0] === '/' && raw[2] === ':') raw = raw.slice(1);
    // eslint-disable-next-line no-control-regex
    if (!raw || /[\x00-\x1f]/.test(raw)) continue;
    found = raw;
  }
  return found;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function newSessionId() {
  const bytes = crypto.randomBytes(20);
  let s = 's_';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

class Session extends EventEmitter {
  constructor({ id, shell, title, cols, rows, term, replayBytes, coalesceMs, maxChunk, now, cwd = '', readCwd = defaultReadCwd, command = '', restored = false }) {
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
    /**
     * Where the shell is. It starts as the directory it was spawned in and is
     * re-read when output settles, which is when a command has just finished
     * and a `cd` would have taken effect. Platforms that cannot answer keep
     * the directory the shell started in.
     */
    this.cwd = cwd || '';
    this.readCwd = readCwd;
    this.cwdCheckedAt = 0;
    /**
     * The last command line run here, as the recovery of this terminal would
     * re-run it (see restore.js). It is only ever set from a line the shell
     * **echoed**, so what is typed at a password prompt — where the terminal
     * echoes nothing — is never recorded, stored or sent anywhere.
     */
    this.command = String(command || '').slice(0, MAX_COMMAND);
    /** True when this session is a previous one brought back after a restart. */
    this.restored = !!restored;
    /** How many quick restarts in a row produced this session (restore.js). */
    this.restoreCount = 0;
    /** What has been typed since the last Enter, for `command`. */
    this.typed = '';
    /** A submitted line waiting for the shell to echo it back. */
    this.candidate = null;
    /** Where in an escape sequence the input scanner is: '', esc, csi, osc, ss3. */
    this.esc = '';

    term.onData((data) => this.onData(data));
    term.onExit((code) => this.onExit(code));
    // A shell started through the Windows launcher only learns where it is
    // once the launcher has borrowed the signed-in user's token, which is
    // after this constructor has run.
    if (typeof term.onReady === 'function') term.onReady((info) => this.started(info));
  }

  get seq() { return this.ring.head; }

  /**
   * The shell is up and the terminal host has said where it actually landed —
   * the signed-in user's home rather than the agent's, on Windows.
   */
  started(info) {
    if (!info || !info.cwd || info.cwd === this.cwd) return false;
    this.cwd = info.cwd;
    this.emit('updated', { cwd: info.cwd });
    return true;
  }

  onData(data) {
    if (this.state !== 'running') return;
    this.ring.append(data);
    this.pending += data;
    this.lastActiveAt = this.now();
    this.noteReportedCwd(data);
    this.checkCandidate();
    if (this.pending.length >= this.maxChunk) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.coalesceMs);
    }
  }

  /**
   * Write [text] into this session's own output: a note from the agent rather
   * than from the shell. It joins the stream like any other output, so it is
   * replayed, recorded and seen by every client without a protocol message of
   * its own. Used for the line a restored terminal opens with.
   */
  inject(text) {
    if (!text || this.state !== 'running') return false;
    this.onData(text);
    return true;
  }

  /**
   * A shell that reports its directory (OSC 7, OSC 9;9) is believed: it is the
   * only way Windows and macOS can follow a `cd`, and on Linux it simply
   * arrives sooner than the next /proc sample.
   */
  noteReportedCwd(data) {
    const next = parseOscCwd(data);
    if (!next || next === this.cwd) return false;
    this.cwd = next;
    this.cwdCheckedAt = this.now();
    this.emit('updated', { cwd: next });
    return true;
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
    this.refreshCwd();
  }

  /**
   * Re-read the shell's directory, at most once every CWD_SAMPLE_MS, and tell
   * the relay when it moved. Cheap enough to do on every burst of output on
   * the platforms that support it, and a no-op everywhere else.
   */
  refreshCwd() {
    if (this.state !== 'running') return false;
    const at = this.now();
    if (at - this.cwdCheckedAt < CWD_SAMPLE_MS) return false;
    this.cwdCheckedAt = at;
    const next = this.readCwd(this.term.pid);
    if (!next || next === this.cwd) return false;
    this.cwd = next;
    this.emit('updated', { cwd: next });
    return true;
  }

  write(data) {
    if (this.state !== 'running') return false;
    this.term.write(data);
    this.lastActiveAt = this.now();
    this.noteTyped(data);
    return true;
  }

  /**
   * Follow what is being typed so the session knows the command it is running.
   *
   * This is a reader of keystrokes, not a shell: it tracks the line being
   * composed, honours backspace and the "kill line" controls, and skips escape
   * sequences (arrow keys, bracketed paste) rather than pretending to
   * understand them. Tab completion happens inside the shell, so a completed
   * line is remembered as far as it was typed — a prefix, never a wrong
   * command.
   */
  noteTyped(data) {
    // A bulk paste (a file, a key, a certificate) is not a command line; it is
    // also the only input big enough to be worth not walking character by
    // character. Whatever was being composed is abandoned, as the shell will
    // have made something else of it.
    if (data.length > BULK_INPUT) { this.typed = ''; this.esc = ''; return; }
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = data.charCodeAt(i);
      if (this.esc) {
        // ESC [ … final  (arrow keys, bracketed paste markers)
        // ESC ] … BEL/ST (a program answering a query)
        // ESC O x        (the keypad), ESC x (anything else)
        if (this.esc === 'esc') this.esc = ch === '[' ? 'csi' : ch === ']' ? 'osc' : ch === 'O' ? 'ss3' : '';
        else if (this.esc === 'csi') { if (code >= 0x40 && code <= 0x7e) this.esc = ''; }
        else if (this.esc === 'ss3') this.esc = '';
        else if (ch === '\x07' || ch === '\\') this.esc = '';
        continue;
      }
      if (ch === '\x1b') { this.esc = 'esc'; continue; }
      if (ch === '\r' || ch === '\n') { this.commitTyped(); continue; }
      if (ch === '\x7f' || ch === '\b') { this.typed = this.typed.slice(0, -1); continue; }
      // ^C ^U ^D ^W and the rest abandon the line rather than run it.
      if (code < 0x20) { this.typed = ''; continue; }
      if (this.typed.length < MAX_COMMAND) this.typed += ch;
    }
  }

  /**
   * Enter was pressed: keep the line as this session's command — but only when
   * the shell echoed it. At a password prompt the terminal echoes nothing, so
   * nothing is kept.
   *
   * A line typed key by key is already on screen by now. A line that arrives
   * whole — a snippet, a preset, the command bar, a paste — is echoed a moment
   * *after* we hand it over, so it waits to be confirmed by the output that
   * follows and is forgotten if none of it comes back.
   */
  commitTyped() {
    const line = this.typed.trim();
    this.typed = '';
    if (!line) return false;
    if (this.wasEchoed(line)) return this.setCommand(line);
    this.candidate = { line, at: this.now() };
    return false;
  }

  /** A line waiting to be confirmed by its echo; dropped when none arrives. */
  checkCandidate() {
    const pending = this.candidate;
    if (!pending) return false;
    if (this.now() - pending.at > ECHO_WAIT_MS) { this.candidate = null; return false; }
    if (!this.wasEchoed(pending.line)) return false;
    this.candidate = null;
    return this.setCommand(pending.line);
  }

  setCommand(line) {
    if (line === this.command) return false;
    this.command = line;
    this.emit('updated', { command: line });
    return true;
  }

  /** Did the shell show [line] back? A few characters are enough to tell. */
  wasEchoed(line) {
    const tail = this.ring.tail(ECHO_WINDOW);
    if (!tail) return false;
    return tail.includes(line.slice(0, Math.min(line.length, 12)));
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
      cwd: this.cwd,
      command: this.command,
      restored: this.restored,
    };
  }

  /** What this terminal has to be brought back after a restart (restore.js). */
  record() {
    return {
      id: this.id,
      title: this.title,
      shell: this.shell.id,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      command: this.command,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      // A terminal that has been up a while has proved the restart worked, so
      // the next one starts from a clean slate; one that is about to be
      // described again seconds after coming back carries its strikes.
      restoreCount: this.now() - this.createdAt >= RESTORE_SETTLE_MS ? 0 : this.restoreCount,
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
  constructor({ cfg, log, shells, spawn, now = Date.now, cwd = '', readCwd = defaultReadCwd }) {
    super();
    this.cfg = cfg;
    this.readCwd = readCwd;
    this.log = log;
    this.shells = shells;
    this.spawn = spawn;
    this.now = now;
    this.cwd = cwd;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.sweeper = null;
  }

  /**
   * Start a terminal. `id`, `cwd`, `command` and `restored` are how a previous
   * terminal comes back after a restart (restore.js): the same id so open tabs
   * re-attach, the same directory so it is where it was, and the command it
   * was running so the caller can run it again.
   */
  create({ shell: shellId, cols, rows, title, env, id: wantedId, cwd: wantedCwd, command = '', restored = false }) {
    // A restored terminal whose shell is no longer installed falls back to the
    // default one rather than being lost.
    const shell = findShell(this.shells, shellId) || (restored ? findShell(this.shells, null) : null);
    if (!shell) throw new SessionError('bad_request', `unknown shell "${shellId}"`);
    if (this.sessions.size >= this.cfg.maxSessions) throw new SessionError('limit_reached', `session limit (${this.cfg.maxSessions}) reached`);
    const id = wantedId && !this.sessions.has(wantedId) ? wantedId : newSessionId();
    const startCwd = wantedCwd || shell.cwd || this.cwd || process.cwd();
    let term;
    try {
      term = this.spawn({ cmd: shell.cmd, args: shell.args || [], cwd: wantedCwd || shell.cwd || this.cwd || undefined, env, cols, rows });
    } catch (err) {
      this.log.error('failed to spawn shell', { shell: shell.id, err: err.message });
      throw new SessionError('internal', `cannot start ${shell.label}: ${err.message}`);
    }
    const session = new Session({
      id, shell, title: title || this.defaultTitle(shell), cols, rows, term,
      replayBytes: this.cfg.replayBytes, coalesceMs: this.cfg.coalesceMs, maxChunk: this.cfg.maxChunk, now: this.now,
      cwd: startCwd, readCwd: this.readCwd, command, restored,
    });
    this.sessions.set(id, session);
    this.log.info(restored ? 'session restored' : 'session created', { sessionId: id, shell: shell.id, pid: term.pid, mode: term.mode, cols, rows, cwd: startCwd });
    this.changed();

    session.on('output', (o) => this.emit('output', session, o));
    session.on('updated', (patch) => { this.emit('session.updated', session, patch); this.changed(); });
    session.on('exit', (code) => {
      this.log.info('session exited', { sessionId: id, code });
      this.emit('exit', session, code);
      this.emit('session.updated', session, { state: 'exited', exitCode: code });
    });
    session.on('closed', (reason) => {
      this.sessions.delete(id);
      this.log.info('session closed', { sessionId: id, reason });
      this.emit('session.closed', session, reason);
      this.changed();
    });
    return session;
  }

  /**
   * Something worth remembering changed (a terminal opened or closed, moved,
   * was renamed, or ran a command). The recovery file listens for this.
   */
  changed() { this.emit('session.changed', this.snapshot()); }

  /** Every running terminal, as the records that would bring them back. */
  snapshot() { return [...this.sessions.values()].filter((s) => s.state === 'running').map((s) => s.record()); }

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

module.exports = { Session, SessionManager, SessionError, newSessionId, defaultReadCwd, parseOscCwd, MAX_COMMAND, RESTORE_SETTLE_MS };
