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
 *   node index.js --name "Prod"   rename this machine
 *   node index.js --enroll        (re-)enrol explicitly, replacing the identity
 *   node index.js --reset         forget the local identity
 *
 * Configuration: environment variables or config.json (see config.example.json).
 */

const os = require('os');
const path = require('path');
const { loadConfig, loadState, saveState, deleteState, machineMeta } = require('./lib/config');
const { makeLogger } = require('./lib/log');
const { discoverShells, advertise } = require('./lib/shells');
const { Metrics } = require('./lib/metrics');
const { spawnPty, ptyAvailable } = require('./lib/pty');
const { SessionManager } = require('./lib/sessions');
const { UploadManager } = require('./lib/uploads');
const { RelayClient } = require('./lib/relay-client');
const relayHttp = require('./lib/http');

const VERSION = require('./package.json').version;

/* ---------------------------------- CLI ----------------------------------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name' || a === '--config') { out[a.slice(2)] = argv[++i]; continue; }
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
  node index.js --name "Name"   rename this machine (relay + local)
  node index.js --enroll        enrol explicitly (replaces the current identity)
  node index.js --reset         delete the local identity file
  --config <path>               use this config.json (default: CONFIG env or ./config.json)
  --allow-root                  allow running as root on Linux (not recommended)
`);
}

function requireIdentity(cfg, state) {
  if (!state.agentId || !state.agentToken) {
    console.error(`This agent is not enrolled yet. Run the agent once (with ENROLL_TOKEN set) or use --enroll.\n  state file: ${cfg.stateFile}`);
    process.exit(2);
  }
  if (state.invalid) {
    console.error(`This agent's credentials were revoked by the relay (${state.invalidReason || 'unknown reason'}).\nRun "node index.js --enroll" with a valid ENROLL_TOKEN to enrol again.`);
    process.exit(2);
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

async function cmdPair(cfg, state) {
  requireIdentity(cfg, state);
  const r = await relayHttp.pairCode(cfg.server, state.agentToken);
  const mins = Math.round((r.ttlSec || 300) / 60);
  console.log(`\nRemote Terminal — pair a phone with "${state.name || state.agentId}"\n`);
  console.log(`  Relay URL:     ${r.relayUrl || cfg.server}`);
  console.log(`  Pairing code:  ${r.code}`);
  console.log(`  Valid for:     ${mins} minute${mins === 1 ? '' : 's'} (single use)\n`);
  console.log('In the app: Machines → Pair → enter the relay URL and this code.\n');
}

async function cmdStatus(cfg, state) {
  console.log(`Remote Terminal agent ${VERSION}`);
  console.log(`  Relay:        ${cfg.server}`);
  console.log(`  State file:   ${cfg.stateFile}`);
  if (!state.agentId) { console.log('  Identity:     not enrolled'); return; }
  console.log(`  Agent ID:     ${state.agentId}`);
  console.log(`  Account:      ${state.accountId || '-'}`);
  console.log(`  Name:         ${state.name || '-'}`);
  if (state.invalid) { console.log(`  Credentials:  REVOKED (${state.invalidReason || '-'}); run --enroll`); return; }
  try {
    const info = await relayHttp.agentInfo(cfg.server, state.agentToken);
    console.log(`  Relay status: ${info.online ? 'connected' : 'not connected'}${info.lastSeen ? ` (last seen ${new Date(info.lastSeen).toISOString()})` : ''}`);
    console.log(`  Relay name:   ${info.name}`);
  } catch (err) {
    console.log(`  Relay status: unreachable (${err.message})`);
  }
}

async function cmdDoctor(cfg, state, log) {
  const pty = ptyAvailable();
  console.log(`Remote Terminal agent ${VERSION} — doctor`);
  console.log(`  Node:         ${process.version} (${process.platform}/${process.arch})`);
  console.log(`  OS:           ${machineMeta(VERSION).os}`);
  console.log(`  Config file:  ${cfg.configPath}${cfg.fileError ? `  (ERROR: ${cfg.fileError})` : ''}`);
  console.log(`  Relay:        ${cfg.server}`);
  console.log(`  Enrol token:  ${cfg.enrollToken ? 'configured' : 'NOT configured'}`);
  console.log(`  Identity:     ${state.agentId ? state.agentId + (state.invalid ? ' (REVOKED)' : '') : 'not enrolled'}`);
  console.log(`  PTY backend:  ${pty.available ? 'node-pty (real PTY)' : `pipe fallback (node-pty unavailable: ${pty.error})`}`);
  console.log(`  Env policy:   ${cfg.inheritEnv ? 'INHERIT_ENV=1 (full environment passed to shells!)' : 'minimal allowlist'}`);
  console.log(`  Uploads:      ${cfg.uploadsDir || path.join(os.homedir(), 'RemoteTerminal')} (max ${Math.round(cfg.maxUploadBytes / (1024 * 1024))} MiB)`);
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

async function runAgent(cfg, state, log) {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0 && !cfg.allowRoot) {
    log.error('refusing to run as root: shells would have full system access. Use a dedicated user (see install-linux.sh) or ALLOW_ROOT=1 / --allow-root.');
    process.exit(3);
  }
  if (state.invalid) {
    log.error('credentials were revoked by the relay; run "node index.js --enroll" to enrol again', { reason: state.invalidReason });
    process.exit(2);
  }
  if (!state.agentId || !state.agentToken) await doEnroll(cfg, state, log, { explicit: false });
  if (state.server && state.server !== cfg.server) log.warn('relay URL changed since enrolment; the identity belongs to the old relay', { enrolledAt: state.server, now: cfg.server });

  const shells = await discoverShells({ configured: cfg.shells, defaultShell: cfg.defaultShell, warn: (m, f) => log.warn(m, f) });
  if (!shells.length) log.error('no shells available; configure "shells" in config.json');
  log.info('shells', { shells: advertise(shells).map((s) => s.id), pty: ptyAvailable().available ? 'node-pty' : 'pipe' });

  const cwd = cfg.cwd || os.homedir();
  const sessions = new SessionManager({ cfg, log, shells, spawn: spawnPty, cwd });
  sessions.startSweeper(cfg.sweepIntervalMs);

  if (!cfg.uploadsDir) cfg.uploadsDir = path.join(os.homedir(), 'RemoteTerminal');
  const uploads = new UploadManager({ cfg, log });
  uploads.startSweeper();
  log.info('uploads', { dir: cfg.uploadsDir, maxBytes: cfg.maxUploadBytes });

  const client = new RelayClient({ cfg, state, log, sessions, uploads, meta: machineMeta(VERSION), shells });
  client.on('state', () => { try { saveState(cfg.stateFile, state); } catch (err) { log.warn('cannot save state', { err: err.message }); } });
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
    shutdown('fatal', why === 'revoked' ? 2 : 4);
  });
  client.on('registered', () => {
    if (!state.pairedHint) {
      log.info('to pair a phone run: node index.js --pair');
      state.pairedHint = true;
    }
  });
  client.start();

  let stopping = false;
  function shutdown(sig, code = 0) {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { sig, sessions: sessions.sessions.size });
    sessions.stopSweeper();
    uploads.stopSweeper();
    uploads.closeAll();
    sessions.closeAll('shutdown');
    client.stop();
    process.exitCode = code; // also correct if the loop drains before the timer fires
    setTimeout(() => process.exit(code), 700).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => { log.error('uncaught exception', { err: err.stack || err.message }); shutdown('crash', 1); });
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();
  if (args.version) return console.log(VERSION);
  const cfg = loadConfig(process.env, { configPath: args.config });
  if (args['allow-root']) cfg.allowRoot = true;
  const log = makeLogger(cfg.logLevel);
  if (cfg.fileError) log.warn('config file could not be parsed; using env/defaults', { file: cfg.configPath, err: cfg.fileError });
  let state;
  try { state = loadState(cfg.stateFile); } catch (err) { log.error(err.message); process.exit(1); }

  if (args.reset) {
    const had = deleteState(cfg.stateFile);
    console.log(had ? `Deleted ${cfg.stateFile}. The relay still lists agent ${state.agentId}; remove it from the app.` : 'No identity to delete.');
    return undefined;
  }
  if (args.enroll) { await doEnroll(cfg, state, log, { explicit: true }); return cmdStatus(cfg, state); }
  if (args.pair) return cmdPair(cfg, state);
  if (args.status) return cmdStatus(cfg, state);
  if (args.doctor) return cmdDoctor(cfg, state, log);
  if (args.name !== undefined) {
    const name = String(args.name || '').trim();
    if (!name) { console.error('--name needs a value'); process.exit(2); }
    state.name = name;
    if (state.agentId && !state.invalid) {
      const info = await relayHttp.setName(cfg.server, state.agentToken, name);
      state.name = info.name;
    }
    saveState(cfg.stateFile, state);
    console.log(`Name set to "${state.name}"${state.agentId ? '' : ' (will be used at enrolment)'}.`);
    return undefined;
  }
  return runAgent(cfg, state, log);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});

module.exports = { parseArgs, VERSION, AGENT_DIR: path.join(__dirname) };
