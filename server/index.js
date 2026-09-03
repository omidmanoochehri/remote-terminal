'use strict';

/*
 * Remote Terminal — relay server (protocol v3).
 *
 * Accounts own agents (machines) and devices (phones); agents host terminal
 * sessions. The relay authenticates bearer tokens, authorizes every routed
 * message, tracks presence and attachments, enforces limits, and forwards
 * opaque terminal traffic. It never executes anything. See ../PROTOCOL.md.
 *
 * Module map: config.js (settings) · logger.js · state.js (persisted identity)
 * · registry.js (in-memory world) · auth.js · http.js (identity endpoints)
 * · protocol.js (validation) · router.js (authz + routing) · legacy.js (v2).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('./config');
const { makeLogger } = require('./logger');
const { State } = require('./state');
const { Registry } = require('./registry');
const { PairingStore } = require('./pairing');
const { Router } = require('./router');
const { createHttpHandler } = require('./http');
const { createLegacy } = require('./legacy');
const { bearerFromReq, clientIp, authenticate } = require('./auth');
const { PROTOCOL_VERSION, CLOSE, ERR } = require('./protocol');
const { newId } = require('./tokens');
const { MessageBudget } = require('./limits');

const cfg = loadConfig();
const log = makeLogger(cfg.logLevel);
const state = new State(cfg.stateFile, log).load();
const registry = new Registry(state, cfg, log);
const pairing = new PairingStore(cfg.pairing);
const router = new Router({ cfg, log, registry });
const legacy = cfg.legacyV2 ? createLegacy({ cfg, log }) : null;

const startedAt = Date.now();
const ipCounts = new Map();
let totalConns = 0;

function stats() {
  let phonesOnline = 0;
  for (const set of registry.phonesByAccount.values()) phonesOnline += set.size;
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    connections: totalConns,
    agentsOnline: registry.countOnlineAgents(),
    phonesOnline,
    sessions: registry.countOnlineSessions(),
    protocol: PROTOCOL_VERSION,
    caps: router.caps(),
    legacyRooms: legacy ? legacy.rooms.size : undefined,
  };
}

/* ------------------------------- HTTP server ------------------------------ */

const httpHandler = createHttpHandler({ cfg, log, registry, pairing, router, stats });

let server;
let scheme = 'ws';
if (cfg.tls && cfg.tls.cert && cfg.tls.key) {
  server = https.createServer({ cert: fs.readFileSync(cfg.tls.cert), key: fs.readFileSync(cfg.tls.key) }, httpHandler);
  scheme = 'wss';
} else {
  server = http.createServer(httpHandler);
}

const wss = new WebSocketServer({ server, maxPayload: cfg.maxFrameBytes });

/* ------------------------------- connections ------------------------------ */

function refuse(ws, code, closeCode, message) {
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', code, message })); } catch (_) { /* ignore */ }
  try { ws.close(closeCode, message.slice(0, 120)); } catch (_) { /* ignore */ }
}

wss.on('connection', (ws, req) => {
  const connId = newId('c');
  const ip = clientIp(req, cfg);

  // Global + per-IP connection caps to blunt connection-storm abuse.
  const perIp = ipCounts.get(ip) || 0;
  if (totalConns >= cfg.maxConns || perIp >= cfg.maxConnsPerIp) {
    log.warn('connection rejected: limit', { connId, ip, perIp, totalConns });
    return refuse(ws, ERR.LIMIT, CLOSE.LIMIT, 'connection limit reached');
  }

  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'relay'}`); } catch (_) {
    return refuse(ws, ERR.BAD_REQUEST, 1008, 'bad url');
  }
  const token = bearerFromReq(req, url);
  const v = url.searchParams.get('v');
  const role = url.searchParams.get('role');

  const account = () => { totalConns++; ipCounts.set(ip, perIp + 1); };
  const unaccount = () => {
    totalConns--;
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
  };

  // Protocol negotiation: v3 only, unless legacy room mode is enabled.
  if (v !== String(PROTOCOL_VERSION)) {
    if (legacy && url.searchParams.get('room')) {
      account();
      ws._isAlive = true;
      ws.on('pong', () => { ws._isAlive = true; });
      ws.on('close', unaccount);
      ws.on('error', (err) => log.warn('legacy: socket error', { connId, err: err.message }));
      if (!legacy.handleConnection(ws, url, token, connId)) { /* refused: close handler unaccounts */ }
      return;
    }
    log.warn('connection rejected: unsupported protocol version', { connId, ip, v });
    return refuse(ws, ERR.UNSUPPORTED_VERSION, CLOSE.UPGRADE_REQUIRED, `protocol v${PROTOCOL_VERSION} required`);
  }
  if (role !== 'agent' && role !== 'phone') return refuse(ws, ERR.BAD_REQUEST, 1008, 'role must be "agent" or "phone"');

  const principal = authenticate(registry, token);
  if (!principal || (role === 'agent' && principal.kind !== 'agent') || (role === 'phone' && principal.kind !== 'device')) {
    log.warn('unauthorized', { connId, ip, role, reason: principal ? 'token/role mismatch' : 'invalid token' });
    return refuse(ws, ERR.UNAUTHORIZED, CLOSE.UNAUTHORIZED, 'unauthorized');
  }

  const conn = {
    id: connId, ws, role, ip, v: PROTOCOL_VERSION,
    accountId: principal.record.accountId,
    agentId: principal.kind === 'agent' ? principal.record.agentId : null,
    deviceId: principal.kind === 'device' ? principal.record.deviceId : null,
    attachments: new Set(),   // "agentId|sessionId" keys this phone is attached to
    agentsTouched: new Set(), // agents that know this phone as a client
    lagging: new Set(),
    lagTimer: null,
    log: null,
  };
  conn.log = log.child({ connId, role, v: PROTOCOL_VERSION, agentId: conn.agentId || undefined, deviceId: conn.deviceId || undefined });

  // One live connection per agent: a newer one replaces the older.
  if (role === 'agent') {
    const rt = registry.rt(conn.agentId);
    if (rt.conn && rt.conn.ws.readyState === rt.conn.ws.OPEN) {
      conn.log.info('replacing existing agent connection', { oldConnId: rt.conn.id });
      const old = rt.conn;
      rt.conn = null;
      router.forceClose(old, CLOSE.REPLACED, 'replaced');
    }
  }

  account();
  registry.addConn(conn);
  ws._isAlive = true;
  ws.on('pong', () => { ws._isAlive = true; });
  conn.log.info('connected', { ip });

  const budget = new MessageBudget(role === 'agent' ? cfg.agentMsgPerSec : cfg.msgPerSec);

  ws.on('message', (raw) => {
    if (!budget.allow()) {
      conn.log.warn('rate limit exceeded; closing');
      return refuse(ws, ERR.RATE_LIMITED, CLOSE.RATE_LIMITED, 'rate limit exceeded');
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) {
      return router.error(conn, ERR.BAD_REQUEST, 'invalid JSON');
    }
    try {
      if (role === 'phone') router.handlePhone(conn, msg);
      else router.handleAgent(conn, msg);
    } catch (err) {
      conn.log.error('routing failure', { err: err.message, type: msg && msg.type });
      router.error(conn, ERR.INTERNAL, 'internal error');
    }
  });

  ws.on('close', (code) => {
    unaccount();
    registry.removeConn(conn);
    if (role === 'phone') router.onPhoneClosed(conn); else router.onAgentClosed(conn);
    conn.log.info('disconnected', { code });
  });

  ws.on('error', (err) => conn.log.warn('socket error', { err: err.message }));

  if (role === 'phone') router.onPhoneConnected(conn); else router.onAgentConnected(conn);
});

/* ------------------------------- heartbeat -------------------------------- */

// WebSocket-level ping/pong reaps half-open sockets (NAT drops, crashed peers).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._isAlive === false) { try { ws.terminate(); } catch (_) { /* ignore */ } continue; }
    ws._isAlive = false;
    try { ws.ping(); } catch (_) { /* ignore */ }
  }
}, cfg.heartbeatMs);

/* ---------------------------- graceful shutdown --------------------------- */

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { sig });
  clearInterval(heartbeat);
  state.flush();
  for (const ws of wss.clients) {
    try { ws.send(JSON.stringify({ type: 'error', code: ERR.LIMIT, message: 'server shutting down' })); } catch (_) { /* ignore */ }
    try { ws.close(CLOSE.LIMIT, 'server shutting down'); } catch (_) { /* ignore */ }
  }
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(cfg.port, cfg.host, () => {
  log.info('relay listening', {
    url: `${scheme}://${cfg.host}:${cfg.port}`, protocol: PROTOCOL_VERSION,
    enrollment: cfg.authToken ? 'token' : 'OPEN (dev only)', legacyV2: cfg.legacyV2,
    stateFile: cfg.stateFile,
  });
  if (!cfg.authToken) log.warn('no ENROLL_TOKEN configured: enrolment is open to anyone who can reach this relay');
});

module.exports = { server, wss, registry, router, stats }; // exported for tests
