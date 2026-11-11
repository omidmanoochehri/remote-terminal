'use strict';

/*
 * Recovering terminals across a restart.
 *
 * A session is a process, and a process dies with the agent that spawned it.
 * What survives a crash, a service restart or a machine reboot is therefore
 * not the shell but a *description* of it: where it was, what it was called,
 * which shell it ran and the last command the user actually ran in it. That
 * description is kept in a small file next to the agent's state, rewritten
 * (debounced) whenever one of those facts changes, and replayed on start-up.
 *
 *   running session ──▶ record {id,title,shell,cwd,cols,rows,command}
 *                        └─ file ─┐
 *   agent restarts ───────────────┴──▶ same id, same name, same directory,
 *                                      same command running again
 *
 * The session **id** is reused on purpose: a phone that still has the tab open
 * re-attaches to it without noticing anything beyond a new `instanceId`, which
 * the protocol already defines as "forget the stream position" (PROTOCOL.md
 * §6). Everything else is deliberately conservative:
 *
 * - only sessions that were *running* come back; one the user closed, or that
 *   exited or idled out, is dropped from the file when it goes;
 * - a record older than `restoreMaxAgeSec` is ignored — a machine that was off
 *   for a week should not reopen last week's terminals;
 * - a command is re-run at most MAX_RERUNS times in a row by restarts that did
 *   not settle (a crash loop must not keep re-running the command that is
 *   causing it). A terminal that stays up clears its strikes, so an ordinary
 *   restart tomorrow re-runs the command again.
 */

const fs = require('fs');
const path = require('path');

const FILE_VERSION = 1;
/** How many unsettled restarts in a row still re-run the command. */
const MAX_RERUNS = 2;

class SessionStore {
  /**
   * @param {{file:string, log:object, now?:Function, debounceMs?:number}} opts
   */
  constructor({ file, log, now = Date.now, debounceMs = 1000 }) {
    this.file = file;
    this.log = log;
    this.now = now;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.pending = null;
    this.stopped = false;
  }

  /** What the last run left behind; an empty list when there is nothing readable. */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn('cannot read the open-terminals file', { file: this.file, err: err.message });
      return { savedAt: 0, sessions: [] };
    }
    try {
      const parsed = JSON.parse(raw);
      const list = parsed && Array.isArray(parsed.sessions) ? parsed.sessions : [];
      const savedAt = Number(parsed && parsed.savedAt) || 0;
      return { savedAt, sessions: list.filter((s) => s && typeof s.id === 'string') };
    } catch (err) {
      this.log.warn('the open-terminals file is not readable JSON; ignoring it', { file: this.file, err: err.message });
      return { savedAt: 0, sessions: [] };
    }
  }

  /** Write now, atomically (temp file + rename), so a crash never leaves half a file. */
  write(sessions) {
    if (this.stopped) return false;
    const body = JSON.stringify({ version: FILE_VERSION, savedAt: this.now(), sessions }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      this.log.warn('cannot save the open terminals for recovery', { file: this.file, err: err.message });
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
      return false;
    }
  }

  /**
   * Remember [sessions] shortly. Terminals change constantly — every `cd`
   * moves one — so the file is written at most once per `debounceMs`: fresh
   * enough that a crash loses a second of bookkeeping at worst, cheap enough
   * to leave running on a busy machine.
   */
  schedule(sessions) {
    if (this.stopped) return;
    this.pending = sessions;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.pending;
      this.pending = null;
      if (next) this.write(next);
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Write anything outstanding right now (shutdown). */
  flush(sessions) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const next = sessions || this.pending;
    this.pending = null;
    return next ? this.write(next) : false;
  }

  /** Stop writing: the terminals are about to be closed deliberately. */
  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending = null;
    this.stopped = true;
  }

  /** Forget everything (recovery turned off, or an explicit reset). */
  clear() {
    this.stop();
    try { fs.unlinkSync(this.file); return true; } catch (_) { return false; }
  }
}

/**
 * Hand [command] to a freshly restored shell once it is ready for it.
 *
 * "Ready" is the shell's first output — its prompt — plus a short pause; a
 * shell that says nothing at all gets the command anyway after `maxWaitMs`,
 * because a PTY buffers input and nothing is lost by being early.
 */
function runWhenReady(session, command, { delayMs = 250, maxWaitMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let fired = false;
  let settle = null;
  const detach = () => {
    session.removeListener('output', onOutput);
    session.removeListener('closed', cancel);
    session.removeListener('exit', cancel);
  };
  const fire = () => {
    if (fired) return;
    fired = true;
    clearTimer(deadline);
    if (settle) clearTimer(settle);
    detach();
    if (session.state === 'running') session.write(`${command}\r`);
  };
  const cancel = () => {
    if (fired) return;
    fired = true;
    clearTimer(deadline);
    if (settle) clearTimer(settle);
    detach();
  };
  const onOutput = () => {
    if (settle || fired) return;
    settle = setTimer(fire, delayMs);
    if (settle && settle.unref) settle.unref();
  };
  const deadline = setTimer(fire, maxWaitMs);
  if (deadline && deadline.unref) deadline.unref();
  session.on('output', onOutput);
  session.once('closed', cancel);
  session.once('exit', cancel);
  return { fire, cancel };
}

/**
 * Bring back the terminals the previous run left open.
 *
 * Returns `{restored, rerun, skipped}` so the caller can log one line rather
 * than a story.
 */
function restoreSessions({ sessions, store, cfg, log, env, now = Date.now, ready = runWhenReady }) {
  const result = { restored: 0, rerun: 0, skipped: 0 };
  if (!cfg.restoreSessions) { store.clear(); return result; }
  const saved = store.load();
  if (!saved.sessions.length) return result;

  const maxAgeMs = Math.max(0, cfg.restoreMaxAgeSec | 0) * 1000;
  const at = now();
  for (const record of saved.sessions) {
    if (sessions.sessions.size >= cfg.maxSessions) { result.skipped++; continue; }
    const savedAt = saved.savedAt || Number(record.lastActiveAt) || 0;
    if (maxAgeMs > 0 && savedAt > 0 && at - savedAt > maxAgeMs) { result.skipped++; continue; }

    const cwd = usableDirectory(record.cwd);
    let session;
    try {
      session = sessions.create({
        id: record.id,
        shell: record.shell,
        cols: record.cols || 80,
        rows: record.rows || 24,
        title: record.title || undefined,
        cwd: cwd || undefined,
        command: typeof record.command === 'string' ? record.command : '',
        restored: true,
        env,
      });
    } catch (err) {
      log.warn('cannot restore a terminal', { sessionId: record.id, err: err.message });
      result.skipped++;
      continue;
    }
    result.restored++;

    // Strikes: restores that did not stay up long enough to settle (see
    // RESTORE_SETTLE_MS in sessions.js, which is what clears them). A command
    // that takes the machine down must not be re-run on every boot for ever.
    const strikes = Number(record.restoreCount) || 0;
    session.restoreCount = strikes + 1;

    const command = cfg.restoreCommands && record.command ? String(record.command) : '';
    const rerun = !!command && strikes < MAX_RERUNS;
    session.inject(banner({
      cwd: session.cwd,
      missing: !cwd && !!record.cwd,
      command,
      rerun,
      looping: !!command && !rerun,
    }));
    if (rerun) { ready(session, command); result.rerun++; }
  }

  if (result.restored || result.skipped) {
    log.info('terminals restored', result);
  }
  return result;
}

/** The directory to restore into, or '' when it is gone (the shell starts at home instead). */
function usableDirectory(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  try { return fs.statSync(cwd).isDirectory() ? cwd : ''; } catch (_) { return ''; }
}

/**
 * The line a restored terminal opens with. It is written into the session's
 * own output, so every client — a phone, a desktop, one that attaches
 * tomorrow — reads the same explanation in the scrollback, and the protocol
 * needs no message for it.
 */
function banner({ cwd, missing, command, rerun, looping }) {
  const parts = ['terminal restored'];
  if (missing) parts.push('its folder is gone; started at home');
  else if (cwd) parts.push(cwd);
  if (rerun) parts.push(`re-running: ${command}`);
  else if (looping) parts.push(`not re-running "${command}" after repeated restarts`);
  return `\r\n\x1b[2m[${parts.join(' · ')}]\x1b[0m\r\n`;
}

module.exports = { SessionStore, restoreSessions, runWhenReady, banner, FILE_VERSION, MAX_RERUNS };
