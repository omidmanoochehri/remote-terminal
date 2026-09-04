'use strict';

/*
 * Agent configuration and persisted identity.
 *
 * Config precedence: environment > config.json (CONFIG=path, else the file
 * next to index.js) > defaults. Identity (agentId + agentToken, issued once
 * by the relay at enrolment) lives in a separate state file that is written
 * with mode 0600 and never printed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT_DIR = path.join(__dirname, '..');
const STATE_VERSION = 1;

function loadConfig(env = process.env, overrides = {}) {
  const configPath = overrides.configPath || env.CONFIG || path.join(AGENT_DIR, 'config.json');
  let file = {};
  let fileError = null;
  try { file = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (err) {
    if (err.code !== 'ENOENT') fileError = err.message;
  }
  const s = (e, v, d) => (e != null ? e : (v != null ? v : d));
  const n = (e, v, d) => { const x = parseInt(e != null ? e : v, 10); return Number.isFinite(x) ? x : d; };
  const b = (e, v, d) => {
    if (e != null) return e === '1' || e === 'true';
    if (v != null) return v === true || v === '1' || v === 'true';
    return d;
  };

  const dataDir = s(env.DATA_DIR, file.dataDir, AGENT_DIR);
  return {
    configPath,
    fileError,
    server: String(s(env.SERVER, file.server, 'ws://127.0.0.1:8080')).replace(/\/+$/, ''),
    // ENROLL_TOKEN is the account's enrolment secret. TOKEN / "token" remain as v2 aliases.
    enrollToken: s(env.ENROLL_TOKEN, s(env.TOKEN, s(file.enrollToken, file.token, '')), ''),
    name: s(env.AGENT_NAME, file.name, ''),
    stateFile: s(env.AGENT_STATE, file.stateFile, path.join(dataDir, 'state.json')),
    shells: Array.isArray(file.shells) ? file.shells : null,
    defaultShell: s(env.DEFAULT_SHELL, file.defaultShell, ''),
    cwd: s(env.SHELL_CWD, file.cwd, ''),
    replayBytes: n(env.REPLAY_BYTES_PER_SESSION, s(env.REPLAY_BYTES, file.replayBytes, null), 256 * 1024),
    maxInputBytes: n(env.MAX_INPUT_BYTES, file.maxInputBytes, 1024 * 1024),
    maxSessions: n(env.MAX_SESSIONS_PER_AGENT, s(env.MAX_SESSIONS, file.maxSessions, null), 16),
    idleTimeoutSec: n(env.SESSION_IDLE_TIMEOUT, file.sessionIdleTimeoutSec, 6 * 3600),
    exitedRetentionSec: n(env.EXITED_RETENTION_SEC, file.exitedRetentionSec, 300),
    sweepIntervalMs: n(env.SWEEP_INTERVAL_MS, file.sweepIntervalMs, 30000),
    // CPU/memory/disk/uptime for the phone's machine screen; 0 turns reporting
    // off. Anything faster than 2s is pointless (CPU load is a delta) and is
    // clamped up, so a typo cannot flood the relay.
    metricsIntervalMs: metricsInterval(n(env.METRICS_INTERVAL_MS, file.metricsIntervalMs, 20000)),
    // Files pasted from a phone (images, mostly) land here.
    uploadsDir: s(env.UPLOADS_DIR, file.uploadsDir, ''),
    maxUploadBytes: n(env.MAX_UPLOAD_BYTES, file.maxUploadBytes, 16 * 1024 * 1024),
    maxUploads: n(env.MAX_UPLOADS, file.maxUploads, 3),
    uploadTimeoutSec: n(env.UPLOAD_TIMEOUT_SEC, file.uploadTimeoutSec, 120),
    inheritEnv: b(env.INHERIT_ENV, file.inheritEnv, false),
    allowRoot: b(env.ALLOW_ROOT, file.allowRoot, false),
    logLevel: s(env.LOG_LEVEL, file.logLevel, 'info'),
    baseBackoffMs: n(env.BASE_BACKOFF_MS, file.baseBackoffMs, 1000),
    maxBackoffMs: n(env.MAX_BACKOFF_MS, file.maxBackoffMs, 30000),
    coalesceMs: n(env.COALESCE_MS, file.coalesceMs, 16),
    maxChunk: n(env.MAX_CHUNK, file.maxChunk, 32 * 1024),
    backpressureHighBytes: n(env.BACKPRESSURE_HIGH_BYTES, file.backpressureHighBytes, 2 * 1024 * 1024),
    backpressureLowBytes: n(env.BACKPRESSURE_LOW_BYTES, file.backpressureLowBytes, 256 * 1024),
  };
}

function metricsInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(2000, ms);
}

/* --------------------------------- state ---------------------------------- */

function emptyState() {
  return { version: STATE_VERSION, agentId: null, agentToken: null, accountId: null, name: '', server: '', enrolledAt: null, invalid: false, invalidReason: null };
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign(emptyState(), parsed && typeof parsed === 'object' ? parsed : {});
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read state file ${file}: ${err.message}`);
    return emptyState();
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ version: STATE_VERSION }, state), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ } }
}

function deleteState(file) {
  try { fs.unlinkSync(file); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

/* ------------------------------ machine facts ----------------------------- */

function osDescription(platform = process.platform) {
  try {
    if (platform === 'linux') {
      const rel = fs.readFileSync('/etc/os-release', 'utf8');
      const m = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      if (m) return m[1];
      return `Linux ${os.release()}`;
    }
    if (platform === 'win32') {
      const v = typeof os.version === 'function' ? os.version() : '';
      return v ? `${v} (${os.release()})` : `Windows ${os.release()}`;
    }
    if (platform === 'darwin') return `macOS ${os.release()}`;
  } catch (_) { /* fall through */ }
  return `${platform} ${os.release()}`;
}

function machineMeta(version) {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    os: osDescription().slice(0, 128),
    arch: process.arch,
    agentVersion: version,
    protocol: 3,
  };
}

module.exports = { loadConfig, loadState, saveState, deleteState, machineMeta, osDescription, AGENT_DIR, STATE_VERSION };
