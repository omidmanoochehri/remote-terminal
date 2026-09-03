'use strict';

/*
 * Configuration for the relay: environment variables take precedence, then an
 * optional config.json (CONFIG=path or ./config.json), then built-in defaults.
 */

const fs = require('fs');
const path = require('path');

function loadConfig(env = process.env) {
  let file = {};
  const p = env.CONFIG || path.join(__dirname, 'config.json');
  try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* optional */ }

  const num = (e, val, def) => {
    const v = e != null ? e : (val != null ? val : def);
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const str = (e, val, def) => (e != null ? e : (val != null ? val : def));
  const bool = (e, val, def) => {
    if (e != null) return e === '1' || e === 'true';
    if (val != null) return val === true || val === '1' || val === 'true';
    return def;
  };

  const tls = file.tls || {};
  const pairing = file.pairing || {};
  const limits = file.limits || {};

  return {
    host: str(env.HOST, file.host, '0.0.0.0'),
    port: num(env.PORT, file.port, 8080),
    publicUrl: str(env.PUBLIC_URL, file.publicUrl, ''),
    logLevel: str(env.LOG_LEVEL, file.logLevel, 'info'),
    stateFile: str(env.STATE_FILE, file.stateFile, path.join(__dirname, 'data', 'state.json')),
    trustProxy: bool(env.TRUST_PROXY, file.trustProxy, false),
    legacyV2: bool(env.LEGACY_V2, file.legacyV2, false),
    legacyPairing: bool(env.LEGACY_PAIRING, pairing.enabled, false),

    // Transport limits.
    maxFrameBytes: num(env.MAX_FRAME_BYTES, file.maxFrameBytes, 1024 * 1024),
    maxConns: num(env.MAX_CONNS, file.maxConns, 1000),
    maxConnsPerIp: num(env.MAX_CONNS_PER_IP, file.maxConnsPerIp, 20),
    msgPerSec: num(env.MSG_PER_SEC, file.msgPerSec, 200),
    agentMsgPerSec: num(env.AGENT_MSG_PER_SEC, file.agentMsgPerSec, 2000),
    heartbeatMs: num(env.HEARTBEAT_MS, file.heartbeatMs, 30000),
    backpressureHighBytes: num(env.BACKPRESSURE_HIGH_BYTES, file.backpressureHighBytes, 4 * 1024 * 1024),
    backpressureLowBytes: num(env.BACKPRESSURE_LOW_BYTES, file.backpressureLowBytes, 512 * 1024),

    // Identity. The enrolment token is the account's root secret: agents present
    // it once to enrol. ENROLL_TOKEN is an alias of the v2 AUTH_TOKEN name.
    authToken: str(env.ENROLL_TOKEN, str(env.AUTH_TOKEN, str(file.enrollToken, file.authToken, '')), ''),
    // Optional additional accounts, config file only: [{ "id": "team-b", "enrollToken": "..." }]
    accounts: (Array.isArray(file.accounts) ? file.accounts : [])
      .filter((a) => a && typeof a === 'object' && (a.id || a.accountId) && typeof a.enrollToken === 'string' && a.enrollToken)
      .map((a) => ({ accountId: String(a.id || a.accountId), name: a.name ? String(a.name) : String(a.id || a.accountId), enrollToken: a.enrollToken })),
    pairing: {
      ttlSec: num(env.PAIRING_TTL_SEC, pairing.ttlSec, 300),
      digits: num(env.PAIRING_DIGITS, pairing.digits, 6),
      maxWrongGuesses: num(env.PAIRING_MAX_WRONG_GUESSES, pairing.maxWrongGuesses, 25),
      perIpPerMin: num(env.PAIR_PER_IP_PER_MIN, pairing.perIpPerMin, 5),
      lockoutSec: num(env.PAIR_LOCKOUT_SEC, pairing.lockoutSec, 900),
      globalPerMin: num(env.PAIR_GLOBAL_PER_MIN, pairing.globalPerMin, 100),
      globalLockoutSec: num(env.PAIR_GLOBAL_LOCKOUT_SEC, pairing.globalLockoutSec, 60),
      enrollPerIpPerMin: num(env.ENROLL_PER_IP_PER_MIN, pairing.enrollPerIpPerMin, 10),
    },

    // Account / session caps.
    limits: {
      maxSessionsPerAgent: num(env.MAX_SESSIONS_PER_AGENT, limits.maxSessionsPerAgent, 16),
      maxSessionsPerAccount: num(env.MAX_SESSIONS_PER_ACCOUNT, limits.maxSessionsPerAccount, 64),
      maxAgentsPerAccount: num(env.MAX_AGENTS_PER_ACCOUNT, limits.maxAgentsPerAccount, 50),
      maxDevicesPerAccount: num(env.MAX_DEVICES_PER_ACCOUNT, limits.maxDevicesPerAccount, 20),
      sessionCreatePerMin: num(env.SESSION_CREATE_PER_MIN, limits.sessionCreatePerMin, 30),
      maxInputBytes: num(env.MAX_INPUT_BYTES, limits.maxInputBytes, 1024 * 1024),
    },

    tls: {
      cert: str(env.TLS_CERT, tls.cert, ''),
      key: str(env.TLS_KEY, tls.key, ''),
    },
  };
}

module.exports = { loadConfig };
