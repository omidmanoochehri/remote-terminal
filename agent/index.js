'use strict';

/*
 * Remote Terminal — Windows agent.
 *
 * Connects out to the relay as role=agent, spawns a real terminal (ConPTY via
 * node-pty when available, else a piped child process), and bridges the phone's
 * input to the shell and the shell's output back. See ../PROTOCOL.md.
 *
 * Config: environment variables (or an optional agent config.json) —
 *   SERVER          relay URL              (default ws://127.0.0.1:8080)
 *   ROOM            room / session id      (default "demo")
 *   TOKEN           auth token             (optional; matches server AUTH_TOKEN)
 *   SHELL_CMD       shell to launch        (default powershell.exe on Windows)
 *   REPLAY_BYTES    scrollback for replay  (default 262144)
 *   MAX_INPUT_BYTES max single input frame (default 1048576)
 *   INHERIT_ENV     "1" to pass full env   (default: a minimal allowlist)
 *   LOG_LEVEL       error|warn|info|debug  (default info)
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

/* --------------------------------- config --------------------------------- */

function loadConfig() {
  let file = {};
  const p = process.env.CONFIG || path.join(__dirname, 'config.json');
  try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* optional */ }
  const s = (e, v, d) => (e != null ? e : (v != null ? v : d));
  const n = (e, v, d) => { const x = parseInt(e != null ? e : v, 10); return Number.isFinite(x) ? x : d; };
  return {
    server: s(process.env.SERVER, file.server, 'ws://127.0.0.1:8080'),
    room: s(process.env.ROOM, file.room, 'demo'),
    token: s(process.env.TOKEN, file.token, ''),
    shell: s(process.env.SHELL_CMD, file.shell, process.platform === 'win32' ? 'powershell.exe' : 'bash'),
    replayBytes: n(process.env.REPLAY_BYTES, file.replayBytes, 256 * 1024),
    maxInputBytes: n(process.env.MAX_INPUT_BYTES, file.maxInputBytes, 1024 * 1024),
    inheritEnv: s(process.env.INHERIT_ENV, file.inheritEnv, '') === '1' || file.inheritEnv === true,
    logLevel: s(process.env.LOG_LEVEL, file.logLevel, 'info'),
    baseBackoffMs: n(process.env.BASE_BACKOFF_MS, file.baseBackoffMs, 1000),
    maxBackoffMs: n(process.env.MAX_BACKOFF_MS, file.maxBackoffMs, 30000),
  };
}

const cfg = loadConfig();

/* --------------------------------- logging -------------------------------- */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[cfg.logLevel] != null ? LEVELS[cfg.logLevel] : LEVELS.info;
function emit(level, msg, fields) {
  if (LEVELS[level] > threshold) return;
  const safe = Object.assign({}, fields);
  if (safe.token) safe.token = '[redacted]';
  console.log(JSON.stringify(Object.assign({ t: new Date().toISOString(), level, comp: 'agent', msg }, safe)));
}
const log = {
  error: (m, f) => emit('error', m, f),
  warn: (m, f) => emit('warn', m, f),
  info: (m, f) => emit('info', m, f),
  debug: (m, f) => emit('debug', m, f),
};

/* ------------------------------ child env --------------------------------- */

// Only a minimal, non-sensitive set of environment variables is passed to the
// shell by default, so a remote user can't read the agent's full environment
// (which may hold secrets). Set INHERIT_ENV=1 to opt back into the full env.
const ENV_ALLOW = [
  'SystemRoot', 'windir', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'USERDOMAIN',
  'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'PSModulePath',
];

function childEnv() {
  if (cfg.inheritEnv) return Object.assign({}, process.env, { TERM: 'xterm-256color' });
  const env = { TERM: 'xterm-256color' };
  for (const k of ENV_ALLOW) if (process.env[k] != null) env[k] = process.env[k];
  return env;
}

/* -------------------------------------------------------------------------- */
/* Terminal abstraction: prefer a true PTY, fall back to piped child process. */
/* -------------------------------------------------------------------------- */

function createTerminal({ onData, onExit }) {
  const env = childEnv();
  const cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();

  // 1) Try node-pty (real ConPTY: interactive apps, colours, resize all work).
  try {
    const pty = require('@homebridge/node-pty-prebuilt-multiarch');
    const term = pty.spawn(cfg.shell, [], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env });
    log.info('spawned PTY', { shell: cfg.shell, pid: term.pid });
    term.onData(onData);
    term.onExit(({ exitCode }) => onExit(exitCode));
    return {
      mode: 'pty',
      write: (d) => term.write(d),
      resize: (cols, rows) => { try { term.resize(cols, rows); } catch (_) {} },
      kill: () => { try { term.kill(); } catch (_) {} },
    };
  } catch (err) {
    log.warn('node-pty unavailable, falling back to piped child', { err: err.message });
  }

  // 2) Fallback: plain piped process (no true TTY).
  const { spawn } = require('child_process');
  const args = process.platform === 'win32' ? [] : ['-i'];
  const child = spawn(cfg.shell, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd, env });
  log.info('spawned child process', { shell: cfg.shell, pid: child.pid });
  child.stdout.on('data', (b) => onData(b.toString('utf8')));
  child.stderr.on('data', (b) => onData(b.toString('utf8')));
  child.on('exit', (code) => onExit(code == null ? 0 : code));
  return {
    mode: 'pipe',
    write: (d) => { try { child.stdin.write(d); } catch (_) {} },
    resize: () => {},
    kill: () => { try { child.kill(); } catch (_) {} },
  };
}

/* -------------------------------------------------------------------------- */
/* Relay connection with exponential-backoff auto-reconnect.                  */
/* -------------------------------------------------------------------------- */

let attempt = 0;
let activeWs = null;
let activeTerm = null;
let stopping = false;

function connectUrl() {
  const q = [
    `role=agent`,
    `room=${encodeURIComponent(cfg.room)}`,
    `caps=replay,ping`,
  ];
  if (cfg.token) q.push(`token=${encodeURIComponent(cfg.token)}`);
  return `${cfg.server}/?${q.join('&')}`;
}

function connect() {
  if (stopping) return;
  const url = connectUrl();
  log.info('connecting', { server: cfg.server, room: cfg.room });
  const ws = new WebSocket(url);
  activeWs = ws;
  let term = null;
  let scrollback = '';

  function send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  function remember(data) {
    scrollback += data;
    if (scrollback.length > cfg.replayBytes) scrollback = scrollback.slice(scrollback.length - cfg.replayBytes);
  }

  function ensureTerminal() {
    if (term) return;
    scrollback = '';
    term = createTerminal({
      onData: (data) => { remember(data); send({ type: 'output', data }); },
      onExit: (code) => { send({ type: 'exit', code }); log.info('shell exited', { code }); term = null; activeTerm = null; },
    });
    activeTerm = term;
  }

  ws.on('open', () => {
    attempt = 0; // reset backoff on a good connection
    log.info('connected to relay', { room: cfg.room });
    ensureTerminal();
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    switch (msg.type) {
      case 'welcome':
        log.info('welcome', { v: msg.v, caps: msg.caps });
        break;
      case 'paired':
        // Pairing enabled on the server: surface the code so the operator can
        // read it to the phone user.
        log.info('PAIRING CODE (enter on phone)', { code: msg.code, expires: msg.expires });
        break;
      case 'status':
        log.info('phone', { peer: msg.peer });
        if (msg.peer === 'connected') {
          const had = !!term;
          ensureTerminal();
          if (had && scrollback) send({ type: 'replay', data: scrollback });
        }
        break;
      case 'input':
        ensureTerminal();
        if (typeof msg.data === 'string') {
          if (msg.data.length > cfg.maxInputBytes) { log.warn('input too large; dropped', { len: msg.data.length }); break; }
          term.write(msg.data);
        }
        break;
      case 'resize':
        ensureTerminal();
        term.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (term) { term.kill(); term = null; activeTerm = null; }
    if (stopping) return;
    const delay = Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** attempt) + Math.floor(Math.random() * 500);
    attempt++;
    log.warn('relay connection closed; reconnecting', { delayMs: delay, attempt });
    setTimeout(connect, delay);
  });

  ws.on('error', (err) => log.warn('socket error', { err: err.message }));
}

/* ---------------------------- graceful shutdown --------------------------- */

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { sig });
  if (activeTerm) { try { activeTerm.kill(); } catch (_) {} }
  if (activeWs) { try { activeWs.close(); } catch (_) {} }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

connect();
