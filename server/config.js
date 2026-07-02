'use strict';

/*
 * Configuration for the relay: environment variables take precedence, then an
 * optional config.json next to this file, then built-in defaults.
 */

const fs = require('fs');
const path = require('path');

function loadConfig() {
  let file = {};
  const p = process.env.CONFIG || path.join(__dirname, 'config.json');
  try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* optional */ }

  const num = (env, val, def) => {
    const v = env != null ? env : (val != null ? val : def);
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const str = (env, val, def) => (env != null ? env : (val != null ? val : def));

  const tls = file.tls || {};
  return {
    host: str(process.env.HOST, file.host, '0.0.0.0'),
    port: num(process.env.PORT, file.port, 8080),
    maxFrameBytes: num(process.env.MAX_FRAME_BYTES, file.maxFrameBytes, 1024 * 1024),
    maxConns: num(process.env.MAX_CONNS, file.maxConns, 1000),
    maxConnsPerIp: num(process.env.MAX_CONNS_PER_IP, file.maxConnsPerIp, 20),
    msgPerSec: num(process.env.MSG_PER_SEC, file.msgPerSec, 200),
    heartbeatMs: num(process.env.HEARTBEAT_MS, file.heartbeatMs, 30000),
    logLevel: str(process.env.LOG_LEVEL, file.logLevel, 'info'),
    // Auth (Phase 4): a shared secret required on connect, and pairing options.
    authToken: str(process.env.AUTH_TOKEN, file.authToken, ''),
    pairing: file.pairing || { enabled: false, ttlSec: 300 },
    tls: {
      cert: str(process.env.TLS_CERT, tls.cert, ''),
      key: str(process.env.TLS_KEY, tls.key, ''),
    },
  };
}

module.exports = { loadConfig };
