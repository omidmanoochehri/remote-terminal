#!/usr/bin/env node
'use strict';

/*
 * Remote Terminal — agent (Windows / Linux / macOS), protocol v3.
 *
 * Run without arguments to host terminal sessions for the relay. On first run
 * the agent enrols itself (needs the account's ENROLL_TOKEN) and stores its
 * identity in the state file. Then pair a phone:
 *
 *   node index.js --pair          print a pairing code for the phone
 *   node index.js --status        show identity and relay status
 *   node index.js --doctor        check PTY support, shells and configuration
 *   node index.js --logs          show the log file (--follow to tail it)
 *   node index.js --name "Prod"   rename this machine
 *   node index.js --enroll        (re-)enrol explicitly, replacing the identity
 *   node index.js --reset         forget the local identity
 *
 * Normally it is not run by hand at all: on Linux systemd runs it (see the
 * .deb built by packaging/build-deb.sh), on Windows the service supervisor
 * does (see windows/). Either way exactly one agent per machine may run — two
 * would fight over the same identity — which the control socket enforces.
 *
 * Configuration: environment variables or config.json (see config.example.json).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, loadState, saveState, deleteState, machineMeta } = require('./lib/config');
const { makeLogger, createFileSink, tee } = require('./lib/log');
const { createWatchdog, underSystemd, supervised } = require('./lib/watchdog');
const control = require('./lib/control');
const { discoverShells, advertise } = require('./lib/shells');
const { Metrics } = require('./lib/metrics');
const { spawnPty, ptyAvailable } = require('./lib/pty');
const { SessionManager } = require('./lib/sessions');
const { chooseSpawner } = require('./lib/win-user-pty');
const { UploadManager } = require('./lib/uploads');
const { RelayClient } = require('./lib/relay-client');
const relayHttp = require('./lib/http');

const VERSION = require('./package.json').version;

/* Exit codes, so a supervisor can tell "restart me" from "stop restarting me". */
const EXIT = { config: 1, identity: 2, root: 3, fatal: 4, running: 5, wedged: 9 };

/* ---------------------------------- CLI ----------------------------------- */

const VALUE_ARGS = new Set(['name', 'config', 'server', 'enroll-token', 'token', 'lines', 'wait-online', 'data-dir']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && VALUE_ARGS.has(a.slice(2))) { out[a.slice(2)] = argv[++i]; continue; }
    if (a.startsWith('--')) { out[a.slice(2)] = true; continue; }
    out._.push(a);
  }
  return out;
}

function usage() {
  console.log(`Remote Terminal agent ${VERSION}

  node index.js                 run the agent (enrols on first run)
  node index.js --pair          print a pairing code for a phone
  node index.js --status        show local identity and relay-side status
  node index.js --doctor        check PTY support, shells and configuration
  node index.js --logs          print the log file path and its last lines
       --lines <n>              how many lines (default 40)
       --follow                 keep printing new lines
  node index.js --name "Name"   rename this machine (relay + local)
  node index.js --configure --server wss://relay --enroll-token <token> [--name "Name"]
       --data-dir <dir>         where state, logs and the control socket live
                                write config.json without starting the agent
  node index.js --wait-online <sec>
                                wait until the running agent is registered
  node index.js --enroll        enrol explicitly (replaces the current identity)
  node index.js --reset         delete the local identity file
  --config <path>               use this config.json (default: CONFIG env or ./config.json)
  --json                        machine-readable output for --status / --pair
  --allow-root                  allow running as root on Linux (not recommended)
`);
}

function requireIdentity(cfg, state) {
  if (!state.agentId || !state.agentToken) {
    console.error(`This agent is not enrolled yet. Run the agent once (with ENROLL_TOKEN set) or use --enroll.\n  state file: ${cfg.stateFile}`);
    process.exit(EXIT.identity);
  }
  if (state.invalid) {
    console.error(`This agent's credentials were revoked by the relay (${state.invalidReason || 'unknown reason'}).\nRun "node index.js --enroll" with a valid ENROLL_TOKEN to enrol again.`);
    process.exit(EXIT.identity);
  }
}

async function doEnroll(cfg, state, log, { explicit }) {
  if (!cfg.enrollToken) log.warn('no ENROLL_TOKEN configured; attempting open enrolment (only works on a development relay)');
  const meta = machineMeta(VERSION);
  if (cfg.name) meta.name = cfg.name;
  const res = await relayHttp.enroll(cfg.server, cfg.enrollToken, meta);
  Object.assign(state, {
    agentId: res.agentId, agentToken: res.agentToken, accountId: res.accountId, name: res.name || cfg.name || '',
    server: cfg.server, enrolledAt: Date.now(), invalid: false, invalidReason: null,
  });
  saveState(cfg.stateFile, state);
  log.info(explicit ? 'enrolled (explicit)' : 'enrolled', { agentId: state.agentId, accountId: state.accountId, name: state.name, stateFile: cfg.stateFile });
  return state;
}

/* ------------------------------- commands --------------------------------- */

/**
 * A pairing code is minted with the agent's token, and while the service is
 * running that token is already in use by it — so ask the running agent
 * first, and only mint one ourselves when nothing is running.
 */
async function cmdPair(cfg, state, args) {
  const live = await control.ping(cfg.dataDir);
  let r;
  if (live) {
    const key = control.readKey(cfg.dataDir);
    if (!key) {
      console.error(`The agent is running under another account, and only that account (or an administrator) may create a pairing code.
  ${process.platform === 'win32' ? 'Run this again from an elevated PowerShell.' : `Try: sudo ${process.argv[1]} --pair`}`);
      process.exit(EXIT.identity);
    }
    const res = await control.request(cfg.dataDir, 'pair', { key });
    if (!res.ok) { console.error(`The running agent refused: ${res.error}`); process.exit(EXIT.identity); }
    r = res;
  } else {
    requireIdentity(cfg, state);
    r = await relayHttp.pairCode(cfg.server, state.agentToken);
  }
  if (args.json) return console.log(JSON.stringify({ code: r.code, ttlSec: r.ttlSec || 300, relayUrl: r.relayUrl || cfg.server }));
  const mins = Math.round((r.ttlSec || 300) / 60);
  console.log(`\nRemote Terminal — pair a phone with "${r.name || state.name || state.agentId}"\n`);
  console.log(`  Relay URL:     ${r.relayUrl || cfg.server}`);
  console.log(`  Pairing code:  ${r.code}`);
  console.log(`  Valid for:     ${mins} minute${mins === 1 ? '' : 's'} (single use)\n`);
  console.log('In the app: Machines → Pair → enter the relay URL and this code.\n');
  return undefined;
}

async function cmdStatus(cfg, state, args = {}) {
  const live = await control.request(cfg.dataDir, 'status').then((r) => (r.ok ? r : null)).catch(() => null);
  if (args.json) {
    let relay = null;
    if (!live && state.agentToken && !state.invalid) relay = await relayHttp.agentInfo(cfg.server, state.agentToken).catch(() => null);
    return console.log(JSON.stringify({
      version: VERSION, server: cfg.server, stateFile: cfg.stateFile, logFile: logFileFor(cfg),
      agentId: state.agentId, accountId: state.accountId, name: (live && live.name) || state.name,
      enrolled: !!state.agentId, revoked: !!state.invalid,
      running: !!live, connected: live ? live.connected : (relay ? relay.online : null),
      registered: live ? live.registered : null,
      sessions: live ? live.sessions : null, pid: live ? live.pid : null, uptimeSec: live ? live.uptimeSec : null,
    }, null, 2));
  }
  console.log(`Remote Terminal agent ${VERSION}`);
  console.log(`  Relay:        ${cfg.server}`);
  console.log(`  State file:   ${cfg.stateFile}`);
  console.log(`  Log file:     ${logFileFor(cfg)}`);
  if (!state.agentId) { console.log('  Identity:     not enrolled'); return undefined; }
  console.log(`  Agent ID:     ${state.agentId}`);
  console.log(`  Account:      ${state.accountId || '-'}`);
  console.log(`  Name:         ${(live && live.name) || state.name || '-'}`);
  if (live) {
    console.log(`  Process:      running (pid ${live.pid}, up ${formatDuration(live.uptimeSec)})`);
    console.log(`  Relay status: ${live.connected ? (live.registered ? 'registered' : 'connecting') : `offline${live.lastError ? ` (${live.lastError})` : ''}`}`);
    console.log(`  Sessions:     ${live.sessions}`);
    return undefined;
  }
  console.log('  Process:      not running');
  if (state.invalid) { console.log(`  Credentials:  REVOKED (${state.invalidReason || '-'}); run --enroll`); return undefined; }
  try {
    const info = await relayHttp.agentInfo(cfg.server, state.agentToken);
    console.log(`  Relay status: ${info.online ? 'connected' : 'not connected'}${info.lastSeen ? ` (last seen ${new Date(info.lastSeen).toISOString()})` : ''}`);
    console.log(`  Relay name:   ${info.name}`);
  } catch (err) {
    console.log(`  Relay status: unreachable (${err.message})`);
  }
  return undefined;
}

async function cmdDoctor(cfg, state, log) {
  const pty = ptyAvailable();
  const live = await control.ping(cfg.dataDir);
  console.log(`Remote Terminal agent ${VERSION} — doctor`);
  console.log(`  Node:         ${process.version} (${process.platform}/${process.arch})`);
  console.log(`  OS:           ${machineMeta(VERSION).os}`);
  console.log(`  Config file:  ${cfg.configPath}${cfg.fileError ? `  (ERROR: ${cfg.fileError})` : ''}`);
  console.log(`  Relay:        ${cfg.server}`);
  console.log(`  Enrol token:  ${cfg.enrollToken ? 'configured' : 'NOT configured'}`);
  console.log(`  Identity:     ${state.agentId ? state.agentId + (state.invalid ? ' (REVOKED)' : '') : 'not enrolled'}`);
  console.log(`  Running:      ${live ? `yes (pid ${live.pid}, agent ${live.version})` : 'no'}`);
  console.log(`  PTY backend:  ${pty.available ? 'node-pty (real PTY)' : `pipe fallback (node-pty unavailable: ${pty.error})`}`);
  console.log(`  Env policy:   ${cfg.inheritEnv ? 'INHERIT_ENV=1 (full environment passed to shells!)' : 'minimal allowlist'}`);
  console.log(`  Terminals as: ${await describeShellOwner(cfg, log)}`);
  console.log(`  Uploads:      ${cfg.uploadsDir || path.join(os.homedir(), 'RemoteTerminal')} (max ${Math.round(cfg.maxUploadBytes / (1024 * 1024))} MiB)`);
  console.log(`  Data dir:     ${cfg.dataDir}${writable(cfg.dataDir) ? '' : '  (NOT WRITABLE)'}`);
  console.log(`  Log file:     ${cfg.logToFile ? logFileFor(cfg) : '(file logging disabled)'}${underSystemd() ? '  — under systemd; use journalctl' : ''}`);
  console.log(`  Limits:       maxSessions=${cfg.maxSessions} replayBytes=${cfg.replayBytes} idleTimeoutSec=${cfg.idleTimeoutSec}`);
  console.log(`  Metrics:      ${describeMetrics(cfg, log)}`);
  const shells = await discoverShells({ configured: cfg.shells, defaultShell: cfg.defaultShell, warn: (m, f) => log.warn(m, f) });
  console.log(`  Shells (${cfg.shells ? 'from config' : 'discovered'}):`);
  for (const s of shells) console.log(`    ${s.default ? '*' : ' '} ${s.id.padEnd(14)} ${s.label.padEnd(22)} ${s.cmd}${s.args && s.args.length ? ' ' + s.args.join(' ') : ''}`);
  if (!shells.length) console.log('    (none found — configure "shells" in config.json)');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log(`  Warning:      running as root${cfg.allowRoot ? ' (allowed by config)' : ' — refused unless --allow-root / ALLOW_ROOT=1'}`);
  }
}

/** Show the log an unattended agent has been writing, optionally tailing it. */
function cmdLogs(cfg, args) {
  const file = logFileFor(cfg);
  const lines = Math.max(1, parseInt(args.lines, 10) || 40);
  console.log(`# ${file}`);
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines)) console.log(l);
  } else if (underSystemd()) {
    console.log('# (no file — under systemd the log goes to the journal: journalctl -u remote-terminal-agent -f)');
  } else {
    console.log('# (no log file yet — the agent has not run with file logging enabled)');
  }
  if (!args.follow) return undefined;
  let pos = fs.existsSync(file) ? fs.statSync(file).size : 0;
  setInterval(() => {
    let size;
    try { size = fs.statSync(file).size; } catch (_) { return; }
    if (size < pos) pos = 0;                       // rotated under us
    if (size === pos) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = size;
    process.stdout.write(buf.toString('utf8'));
  }, 500);
  return undefined;
}

/** Write server/token/name into config.json — what the installers call. */
function cmdConfigure(cfg, args) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(cfg.configPath, 'utf8')); } catch (err) {
    if (err.code !== 'ENOENT') { console.error(`cannot read ${cfg.configPath}: ${err.message}`); process.exit(EXIT.config); }
  }
  if (args.server) file.server = String(args.server).replace(/\/+$/, '');
  const token = args['enroll-token'] || args.token;
  if (token) file.enrollToken = String(token);
  if (args.name) file.name = String(args.name);
  // Recording the data directory in the config, rather than relying on the
  // service manager's environment, is what makes a plain `--status` from a
  // shell find the same identity and control socket the service uses.
  if (args['data-dir']) {
    file.dataDir = path.resolve(String(args['data-dir']));
    file.stateFile = path.join(file.dataDir, 'state.json');
    file.logDir = path.join(file.dataDir, 'logs');
  }
  if (args['allow-root']) file.allowRoot = true;
  if (!file.server) { console.error('--configure needs --server <wss://relay> (at least once)'); process.exit(EXIT.config); }
  if (!file.logLevel) file.logLevel = 'info';
  fs.mkdirSync(path.dirname(cfg.configPath), { recursive: true });
  fs.writeFileSync(cfg.configPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') { try { fs.chmodSync(cfg.configPath, 0o640); } catch (_) { /* best effort */ } }
  console.log(`Wrote ${cfg.configPath} (server ${file.server}${file.name ? `, name "${file.name}"` : ''}).`);
  return undefined;
}

/** Block until the running agent says it is registered — used by the installers. */
async function cmdWaitOnline(cfg, seconds) {
  const deadline = Date.now() + Math.max(1, seconds) * 1000;
  for (;;) {
    const r = await control.request(cfg.dataDir, 'status').catch(() => null);
    if (r && r.ok && r.registered) return true;
    if (Date.now() >= deadline) {
      console.error(r && r.ok ? `Still not registered with ${cfg.server}${r.lastError ? ` (${r.lastError})` : ''}.` : 'The agent is not running.');
      process.exit(EXIT.fatal);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/* -------------------------------- helpers --------------------------------- */

function logFileFor(cfg) { return path.join(cfg.logDir, 'agent.log'); }

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (_) { return false; }
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '?';
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Who a terminal opened from a phone would belong to. Under the Windows
 * service that is the difference between the operator's own shell and a
 * SYSTEM one, so it is worth saying before a phone finds out.
 */
async function describeShellOwner(cfg, log) {
  if (process.platform !== 'win32') return `this account (${os.userInfo().username})`;
  let spawner;
  try {
    spawner = await chooseSpawner({ cfg, log: null, fallback: null });
  } catch (err) {
    return `NOT POSSIBLE — ${err.message} (runAsUser=${cfg.runAsUser})`;
  }
  const detail = spawner.detail;
  if (!spawner.launcher) return `this account (${os.userInfo().username}), runAsUser=${cfg.runAsUser}`;
  if (detail && detail.ok) return `${detail.user} — session ${detail.session}, home ${detail.cwd}`;
  return `this account for now: ${detail ? detail.error : 'the launcher did not answer'}`;
}

/**
 * What the phone's machine screen will show, sampled twice so the CPU figure
 * (a delta between two readings) is real. This is the quickest way to see
 * whether a platform can answer every field.
 */
function describeMetrics(cfg, log) {
  if (cfg.metricsIntervalMs <= 0) return 'disabled (metricsIntervalMs=0)';
  const metrics = new Metrics({ log });
  const wait = Date.now() + 400;
  while (Date.now() < wait) { /* busy on purpose: a sleeping CPU still has to show load */ }
  const s = metrics.sample();
  const pct = (used, total) => (total ? `${Math.round((used / total) * 100)}%` : '?');
  const gib = (b) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
  const parts = [
    `every ${Math.round(cfg.metricsIntervalMs / 1000)}s`,
    `cpu ${s.cpuLoad === undefined ? 'not reported' : `${Math.round(s.cpuLoad * 100)}%`}`,
    `memory ${s.memoryTotal === undefined ? 'not reported' : `${pct(s.memoryUsed, s.memoryTotal)} of ${gib(s.memoryTotal)}`}`,
    `disk ${s.storageTotal === undefined ? `not reported (${metrics.diskPath})` : `${pct(s.storageUsed, s.storageTotal)} of ${gib(s.storageTotal)} on ${metrics.diskPath}`}`,
    `uptime ${s.uptimeSec === undefined ? 'not reported' : `${Math.round(s.uptimeSec / 3600)}h`}`,
  ];
  return parts.join(', ');
}

/* --------------------------------- agent ---------------------------------- */

async function runAgent(cfg, state, log, fileSink) {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0 && !cfg.allowRoot) {
    log.error('refusing to run as root: shells would have full system access. Use a dedicated user (see packaging/) or ALLOW_ROOT=1 / --allow-root.');
    process.exit(EXIT.root);
  }
  if (state.invalid) {
    log.error('credentials were revoked by the relay; run "node index.js --enroll" to enrol again', { reason: state.invalidReason });
    process.exit(EXIT.identity);
  }

  // Handlers are filled in below, once the objects they report on exist; the
  // server reads this map per request, so late assignment is fine.
  const handlers = {};
  const ctl = control.createControlServer({ dataDir: cfg.dataDir, log, handlers });

  // One agent per machine: two would race for the same identity and the relay
  // evicts whichever registered first, forever.
  try {
    await ctl.start();
  } catch (err) {
    if (err.code === 'ERUNNING') {
      log.error('another agent is already running on this machine; exiting', { pid: err.pid, socket: ctl.path });
      process.exit(EXIT.running);
    }
    log.warn('control channel unavailable; the tray and the CLI cannot query this agent', { err: err.message, socket: ctl.path });
  }

  if (!state.agentId || !state.agentToken) await doEnroll(cfg, state, log, { explicit: false });
  if (state.server && state.server !== cfg.server) log.warn('relay URL changed since enrolment; the identity belongs to the old relay', { enrolledAt: state.server, now: cfg.server });

  const shells = await discoverShells({ configured: cfg.shells, defaultShell: cfg.defaultShell, warn: (m, f) => log.warn(m, f) });
  if (!shells.length) log.error('no shells available; configure "shells" in config.json');
  log.info('shells', { shells: advertise(shells).map((s) => s.id), pty: ptyAvailable().available ? 'node-pty' : 'pipe' });

  // Who the shells belong to. On Windows under the service this routes them
  // through remote-terminal-shell.exe so they get the signed-in user's profile
  // instead of LocalSystem's; everywhere else it is plain node-pty.
  let spawner;
  try {
    spawner = await chooseSpawner({ cfg, log, fallback: spawnPty });
  } catch (err) {
    log.error(err.message, { runAsUser: cfg.runAsUser });
    process.exit(EXIT.config);
  }
  log.info('terminals', { runAs: spawner.how, runAsUser: cfg.runAsUser, launcher: spawner.launcher || null });

  // With the launcher in play the shell's directory is the *user's* home, not
  // the agent's, and only the launcher knows which user that is; it reports
  // back and the session corrects itself.
  const cwd = cfg.cwd || (spawner.launcher ? '' : os.homedir());
  const sessions = new SessionManager({ cfg, log, shells, spawn: spawner.spawn, cwd });
  sessions.startSweeper(cfg.sweepIntervalMs);

  // Pasted files have to land where the shell can read them. Under the
  // service that is not the agent's home — SYSTEM's profile is readable only
  // by administrators — but the home of whoever the terminals belong to.
  if (!cfg.uploadsDir) {
    const home = (spawner.detail && spawner.detail.ok && spawner.detail.cwd) || os.homedir();
    cfg.uploadsDir = path.join(home, 'RemoteTerminal');
  }
  const uploads = new UploadManager({ cfg, log });
  uploads.startSweeper();
  log.info('uploads', { dir: cfg.uploadsDir, maxBytes: cfg.maxUploadBytes });

  const client = new RelayClient({ cfg, state, log, sessions, uploads, meta: machineMeta(VERSION), shells });
  let registered = false;
  let lastError = null;

  Object.assign(handlers, {
    ping: () => ({ pid: process.pid, version: VERSION }),
    status: () => ({
      version: VERSION, pid: process.pid, name: state.name || '', agentId: state.agentId || null,
      accountId: state.accountId || null, server: cfg.server, connected: client.connected, registered,
      sessions: sessions.sessions.size, uptimeSec: Math.round(process.uptime()),
      // Worth a line of its own: "as SYSTEM" and "as the person at the
      // keyboard" are very different machines to hand a phone.
      runAs: spawner.how,
      stateFile: cfg.stateFile, logFile: logFileFor(cfg), lastError,
    }),
    pair: async () => {
      if (!state.agentToken || state.invalid) throw new Error('this agent is not enrolled');
      const r = await relayHttp.pairCode(cfg.server, state.agentToken);
      log.info('pairing code issued over the control channel', { ttlSec: r.ttlSec });
      return { code: r.code, ttlSec: r.ttlSec, relayUrl: r.relayUrl || cfg.server, name: state.name || '' };
    },
    reconnect: () => { log.info('reconnect requested over the control channel'); return { reconnecting: client.reconnectNow() }; },
    // A service manager stopping us this way, rather than by killing the
    // process, is what lets each terminal be closed properly first.
    shutdown: () => {
      log.info('shutdown requested over the control channel');
      setTimeout(() => shutdown('control'), 10).unref();
      return { stopping: true };
    },
  });

  client.on('state', () => { try { saveState(cfg.stateFile, state); } catch (err) { log.warn('cannot save state', { err: err.message }); } });
  client.on('connected', () => { lastError = null; });
  client.on('disconnected', (code) => { registered = false; lastError = `disconnected (${code})`; });
  client.on('fatal', (why) => {
    if (why === 'revoked') {
      state.invalid = true; state.invalidReason = 'revoked';
      try { saveState(cfg.stateFile, state); } catch (_) { /* ignore */ }
      log.error('this agent was removed from the account; sessions are being closed. Re-enrol with --enroll.');
    } else if (why === 'replaced') {
      log.error('another instance of this agent connected with the same identity; exiting so the newer one wins.');
    } else {
      log.error('the relay requires a newer protocol; upgrade this agent.');
    }
    registered = false;
    lastError = why;
    shutdown('fatal', why === 'revoked' ? EXIT.identity : EXIT.fatal);
  });
  client.on('registered', () => {
    registered = true; lastError = null;
    if (!state.pairedHint) {
      log.info('to pair a phone run: node index.js --pair');
      state.pairedHint = true;
    }
  });

  const watchdog = createWatchdog({
    log,
    intervalMs: cfg.watchdogIntervalMs > 0 ? cfg.watchdogIntervalMs : 50000,
    snapshot: () => ({ connected: client.connected, registered, sessions: sessions.sessions.size }),
    onStall: () => { if (supervised()) process.exit(EXIT.wedged); },
  });
  if (cfg.watchdogIntervalMs > 0) watchdog.start();

  log.info('agent starting', {
    version: VERSION, pid: process.pid, node: process.version, platform: `${process.platform}/${process.arch}`,
    server: cfg.server, dataDir: cfg.dataDir, logFile: fileSink ? fileSink.path : null,
    supervisor: underSystemd() ? 'systemd' : (process.env.RT_SUPERVISED === '1' ? 'windows-service' : 'none'),
  });
  client.start();

  let stopping = false;
  function shutdown(sig, code = 0) {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { sig, sessions: sessions.sessions.size });
    watchdog.stop();
    ctl.stop();
    sessions.stopSweeper();
    uploads.stopSweeper();
    uploads.closeAll();
    sessions.closeAll('shutdown');
    client.stop();
    process.exitCode = code; // also correct if the loop drains before the timer fires
    setTimeout(() => { if (fileSink) fileSink.close(); process.exit(code); }, 700).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  process.on('uncaughtException', (err) => { log.error('uncaught exception', { err: err.stack || err.message }); shutdown('crash', 1); });
  process.on('unhandledRejection', (err) => { log.error('unhandled rejection', { err: (err && err.stack) || String(err) }); });
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();
  if (args.version) return console.log(VERSION);
  const cfg = loadConfig(process.env, { configPath: args.config });
  if (args['allow-root']) cfg.allowRoot = true;

  // A run in the foreground is being watched by a human; a run under a service
  // manager is not, and needs a log that can still be read tomorrow. journald
  // already keeps stdout, so a systemd unit does not get a second copy.
  const oneShot = !!(args.status || args.pair || args.doctor || args.logs || args.configure
    || args.reset || args.enroll || args.name !== undefined || args['wait-online'] !== undefined);
  let fileSink = null;
  if (cfg.logToFile && !oneShot && !underSystemd()) {
    fileSink = createFileSink({
      dir: cfg.logDir,
      maxBytes: cfg.logMaxBytes,
      maxFiles: cfg.logMaxFiles,
      onError: (err) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'warn', comp: 'agent', msg: 'file logging disabled', err: err.message })),
    });
  }
  const log = makeLogger(cfg.logLevel, null, fileSink ? tee((line) => console.log(line), fileSink.sink) : undefined);
  if (cfg.fileError) log.warn('config file could not be parsed; using env/defaults', { file: cfg.configPath, err: cfg.fileError });

  if (args.configure) return cmdConfigure(cfg, args);
  if (args.logs) return cmdLogs(cfg, args);
  if (args['wait-online'] !== undefined) return cmdWaitOnline(cfg, parseInt(args['wait-online'], 10) || 30);

  let state;
  try { state = loadState(cfg.stateFile); } catch (err) { log.error(err.message); process.exit(EXIT.config); }

  if (args.reset) {
    const had = deleteState(cfg.stateFile);
    console.log(had ? `Deleted ${cfg.stateFile}. The relay still lists agent ${state.agentId}; remove it from the app.` : 'No identity to delete.');
    return undefined;
  }
  if (args.enroll) { await doEnroll(cfg, state, log, { explicit: true }); return cmdStatus(cfg, state, args); }
  if (args.pair) return cmdPair(cfg, state, args);
  if (args.status) return cmdStatus(cfg, state, args);
  if (args.doctor) return cmdDoctor(cfg, state, log);
  if (args.name !== undefined) {
    const name = String(args.name || '').trim();
    if (!name) { console.error('--name needs a value'); process.exit(EXIT.config); }
    state.name = name;
    if (state.agentId && !state.invalid) {
      const info = await relayHttp.setName(cfg.server, state.agentToken, name);
      state.name = info.name;
    }
    saveState(cfg.stateFile, state);
    console.log(`Name set to "${state.name}"${state.agentId ? '' : ' (will be used at enrolment)'}.`);
    return undefined;
  }
  return runAgent(cfg, state, log, fileSink);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});

module.exports = { parseArgs, VERSION, EXIT, AGENT_DIR: path.join(__dirname) };
