'use strict';

/*
 * Local control channel: a Windows named pipe or a unix socket that a running
 * agent listens on, so something outside the process can ask it what it is
 * doing without starting a second agent.
 *
 * Three callers use it:
 *   - the Windows tray icon (status every few seconds, "Pair…", "Reconnect");
 *   - the CLI, so `--status` / `--pair` talk to the live agent instead of
 *     opening a second relay connection with the same identity;
 *   - the installers, to wait for "registered" instead of polling state.json.
 *
 * Wire format is newline-delimited JSON, one request and one response per
 * connection: {"cmd":"status"} -> {"ok":true,...}.
 *
 * SECURITY. On Windows a named pipe is reachable by every local user, so
 * anything that grants access to the machine is gated on a token that lives
 * in a file only the agent's account and Administrators can read (control.key,
 * mode 0600). `status` and `ping` are free — they carry no credential — while
 * `pair`, which mints a code that would hand a stranger a shell, is not.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_REQUEST = 8 * 1024;
const CONNECT_TIMEOUT_MS = 4000;

/** Where the agent listens, given the directory its state file lives in. */
function controlPath(dataDir, name) {
  name = name || 'remote-terminal-agent';
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(dataDir, 'agent.sock');
}

function keyPath(dataDir) { return path.join(dataDir, 'control.key'); }

/** Read the control token, or null when this user is not allowed to have it. */
function readKey(dataDir) {
  try { return fs.readFileSync(keyPath(dataDir), 'utf8').trim() || null; } catch (_) { return null; }
}

function ensureKey(dataDir) {
  const file = keyPath(dataDir);
  const existing = readKey(dataDir);
  if (existing && existing.length >= 32) return existing;
  const key = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ } }
  return key;
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/* -------------------------------- server ---------------------------------- */

/**
 * @param handlers    { [cmd]: async (req) => object }
 * @param privileged  the commands that require the control token.
 *
 * `pair` mints a code that would hand a stranger a shell; `shutdown` would let
 * any local user take this machine off the air. `status` and `ping` carry no
 * credential and change nothing. `reconnect` is deliberately open: it is
 * idempotent, the agent would reconnect on its own anyway, and it is the one
 * thing a signed-in non-administrator has a real reason to do from the tray.
 */
function createControlServer({ dataDir, log, handlers, pipeName, privileged = new Set(['pair', 'shutdown']) }) {
  const socket = controlPath(dataDir, pipeName);
  const key = ensureKey(dataDir);
  let server = null;

  const respond = (conn, obj) => {
    try { conn.end(JSON.stringify(obj) + '\n'); } catch (_) { /* client vanished */ }
  };

  const onConnection = (conn) => {
    conn.setTimeout(CONNECT_TIMEOUT_MS, () => conn.destroy());
    let buf = '';
    conn.on('error', () => conn.destroy());
    conn.on('data', async (chunk) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST) return conn.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return undefined;
      const line = buf.slice(0, nl);
      buf = '';
      let req;
      try { req = JSON.parse(line); } catch (_) { return respond(conn, { ok: false, error: 'bad request' }); }
      const cmd = req && typeof req.cmd === 'string' ? req.cmd : '';
      const handler = Object.prototype.hasOwnProperty.call(handlers, cmd) ? handlers[cmd] : null;
      if (!handler) return respond(conn, { ok: false, error: `unknown command: ${cmd || '(none)'}` });
      if (privileged.has(cmd) && !timingSafeEqual(req.key, key)) {
        log.warn('control request denied', { cmd });
        return respond(conn, { ok: false, error: 'not authorised', needsKey: true });
      }
      try {
        respond(conn, Object.assign({ ok: true }, await handler(req)));
      } catch (err) {
        log.warn('control command failed', { cmd, err: err.message });
        respond(conn, { ok: false, error: err.message });
      }
      return undefined;
    });
  };

  return {
    path: socket,
    key,
    /** Resolves once listening; rejects if another live agent already holds it. */
    start() {
      return new Promise((resolve, reject) => {
        server = net.createServer(onConnection);

        // Every listen() attempt registers its own 'listening' callback, and a
        // rejected promise does not stop a server that is still retrying — so
        // settle exactly once, and attempt at most twice.
        let settled = false;
        const succeed = () => {
          if (settled) return;
          settled = true;
          if (process.platform !== 'win32') { try { fs.chmodSync(socket, 0o600); } catch (_) { /* best effort */ } }
          resolve(socket);
        };
        const failWith = (err) => {
          if (settled) return;
          settled = true;
          try { server.close(); } catch (_) { /* ignore */ }
          reject(err);
        };
        const inUse = (pid) => Object.assign(
          new Error(pid
            ? `another agent is already running (pid ${pid})`
            : `another process is already listening on ${socket}`),
          { code: 'ERUNNING', pid },
        );

        server.once('error', async (err) => {
          if (err.code !== 'EADDRINUSE') return failWith(err);

          // Someone holds the address. Asking who is only a courtesy for the
          // message: on Windows the answer may be "access denied" because the
          // holder is the service account and we are not, and a pipe cannot be
          // unlinked from under it either way. Taking over is a POSIX-only
          // move, and only for a socket file with nothing behind it.
          const alive = await ping(dataDir, { pipeName }).catch(() => null);
          if (alive || process.platform === 'win32') return failWith(inUse(alive && alive.pid));

          try { fs.unlinkSync(socket); } catch (e) { if (e.code !== 'ENOENT') return failWith(inUse(null)); }
          server.once('error', () => failWith(inUse(null)));
          server.listen(socket, succeed);
          return undefined;
        });
        server.listen(socket, succeed);
      });
    },
    stop() {
      if (!server) return;
      try { server.close(); } catch (_) { /* ignore */ }
      server = null;
      if (process.platform !== 'win32') { try { fs.unlinkSync(socket); } catch (_) { /* ignore */ } }
    },
  };
}

/* -------------------------------- client ---------------------------------- */

/** One request to a running agent. Rejects with ENOENT/ECONNREFUSED if none. */
function request(dataDir, cmd, extra = {}, { timeoutMs = CONNECT_TIMEOUT_MS, pipeName } = {}) {
  const socket = controlPath(dataDir, pipeName);
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = '';
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      conn.destroy();
      if (err) reject(err); else resolve(value);
    };
    conn.setTimeout(timeoutMs, () => finish(new Error('control channel timed out')));
    conn.on('error', (err) => finish(err));
    conn.on('connect', () => conn.write(JSON.stringify(Object.assign({ cmd }, extra)) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try { finish(null, JSON.parse(buf.slice(0, nl))); } catch (err) { finish(new Error('bad response from agent')); }
    });
    conn.on('close', () => finish(new Error('agent closed the control channel')));
  });
}

/** Is an agent live on this socket? Resolves to its {pid, version} or null. */
async function ping(dataDir, { pipeName } = {}) {
  try {
    const r = await request(dataDir, 'ping', {}, { timeoutMs: 1500, pipeName });
    return r && r.ok ? r : null;
  } catch (_) { return null; }
}

module.exports = { createControlServer, request, ping, controlPath, keyPath, readKey, ensureKey };
