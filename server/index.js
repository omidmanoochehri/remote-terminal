'use strict';

/*
 * Remote Terminal — relay server.
 *
 * Pairs one `agent` (Windows machine) with one `phone` (Android app) inside a
 * "room" and forwards messages between them. See ../PROTOCOL.md for the wire
 * format. The relay is a transparent pipe for terminal traffic; it only
 * originates control/keepalive messages and enforces connection limits.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('./config');
const { makeLogger } = require('./logger');
const { authorize } = require('./auth');

const cfg = loadConfig();
const log = makeLogger(cfg.logLevel);

// Wire-protocol version and the optional features this relay implements itself.
const PROTOCOL_VERSION = 2;
const SERVER_CAPS = ['ping'].concat(cfg.authToken ? ['auth'] : []);

/** @type {Map<string, {agent: import('ws').WebSocket|null, phone: import('ws').WebSocket|null}>} */
const rooms = new Map();
const ipCounts = new Map();
let totalConns = 0;
let connSeq = 0;
const startedAt = Date.now();

function getRoom(room) {
  let r = rooms.get(room);
  if (!r) { r = { agent: null, phone: null }; rooms.set(room, r); }
  return r;
}

function peerRole(role) { return role === 'agent' ? 'phone' : 'agent'; }

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ------------------------------- HTTP server ------------------------------ */

function httpHandler(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rooms: rooms.size,
      connections: totalConns,
      protocol: PROTOCOL_VERSION,
      caps: SERVER_CAPS,
    }));
    return;
  }
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Upgrade Required: connect with a WebSocket');
}

// TLS (wss://) when a cert/key pair is configured, else plain ws://.
let server;
let scheme = 'ws';
if (cfg.tls && cfg.tls.cert && cfg.tls.key) {
  server = https.createServer(
    { cert: fs.readFileSync(cfg.tls.cert), key: fs.readFileSync(cfg.tls.key) },
    httpHandler,
  );
  scheme = 'wss';
} else {
  server = http.createServer(httpHandler);
}

const wss = new WebSocketServer({ server, maxPayload: cfg.maxFrameBytes });

/* ------------------------------- connections ------------------------------ */

wss.on('connection', (ws, req) => {
  const id = ++connSeq;
  const ip = clientIp(req);

  // Global + per-IP connection caps to blunt connection-storm abuse.
  const perIp = (ipCounts.get(ip) || 0);
  if (totalConns >= cfg.maxConns || perIp >= cfg.maxConnsPerIp) {
    log.warn('connection rejected: limit', { id, ip, perIp, totalConns });
    send(ws, { type: 'error', message: 'connection limit reached' });
    ws.close();
    return;
  }

  let role, room, token, pair;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    role = url.searchParams.get('role');
    room = url.searchParams.get('room');
    token = url.searchParams.get('token') || bearer(req);
    pair = url.searchParams.get('pair');
  } catch (_) { /* validated below */ }

  if (role !== 'agent' && role !== 'phone') {
    send(ws, { type: 'error', message: 'role must be "agent" or "phone"' });
    ws.close();
    return;
  }
  if (!room) {
    send(ws, { type: 'error', message: 'missing room' });
    ws.close();
    return;
  }
  const auth = authorize({ cfg, role, room, token, pair });
  if (!auth.ok) {
    log.warn('unauthorized', { id, ip, role, room, reason: auth.reason });
    send(ws, { type: 'error', message: auth.reason || 'unauthorized' });
    ws.close();
    return;
  }

  // Accepted: account for it.
  totalConns++;
  ipCounts.set(ip, perIp + 1);
  ws._isAlive = true;
  ws._winStart = Date.now();
  ws._winCount = 0;
  ws.on('pong', () => { ws._isAlive = true; });

  const r = getRoom(room);
  if (r[role] && r[role].readyState === r[role].OPEN) {
    log.info('replacing existing role', { room, role });
    try { r[role].close(); } catch (_) {}
  }
  r[role] = ws;

  log.info('connected', { id, ip, role, room });
  send(ws, { type: 'welcome', role, room, v: PROTOCOL_VERSION, caps: SERVER_CAPS });
  if (auth.paired) send(ws, auth.paired); // e.g. a freshly minted pairing code

  const peer = r[peerRole(role)];
  if (peer && peer.readyState === peer.OPEN) {
    send(ws, { type: 'status', peer: 'connected' });
    send(peer, { type: 'status', peer: 'connected' });
  }

  ws.on('message', (raw) => {
    // Per-connection message rate limit (rolling 1s window).
    const now = Date.now();
    if (now - ws._winStart >= 1000) { ws._winStart = now; ws._winCount = 0; }
    if (++ws._winCount > cfg.msgPerSec) {
      log.warn('rate limit exceeded; closing', { id, room, role });
      send(ws, { type: 'error', message: 'rate limit exceeded' });
      ws.close();
      return;
    }

    // Intercept tiny app-level keepalive pings without disturbing the pipe.
    const s = raw.toString();
    if (s.length < 32 && s.indexOf('"ping"') !== -1) {
      try { if (JSON.parse(s).type === 'ping') { send(ws, { type: 'pong' }); return; } } catch (_) {}
    }

    const current = getRoom(room);
    const target = current[peerRole(role)];
    if (target && target.readyState === target.OPEN) target.send(s);
  });

  ws.on('close', () => {
    totalConns--;
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);

    const current = rooms.get(room);
    if (!current) return;
    if (current[role] === ws) current[role] = null;
    log.info('disconnected', { id, role, room });
    const other = current[peerRole(role)];
    if (other && other.readyState === other.OPEN) send(other, { type: 'status', peer: 'disconnected' });
    if (!current.agent && !current.phone) rooms.delete(room);
  });

  ws.on('error', (err) => log.warn('socket error', { id, room, role, err: err.message }));
});

function bearer(req) {
  const h = req.headers['authorization'];
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/* ------------------------------- heartbeat -------------------------------- */

// WebSocket-level ping/pong reaps half-open sockets (NAT drops, crashed peers).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
    ws._isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, cfg.heartbeatMs);

/* ---------------------------- graceful shutdown --------------------------- */

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { sig });
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    send(ws, { type: 'error', message: 'server shutting down' });
    try { ws.close(); } catch (_) {}
  }
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(cfg.port, cfg.host, () => {
  log.info('relay listening', {
    url: `${scheme}://${cfg.host}:${cfg.port}`,
    health: `/health`, stats: `/stats`, auth: !!cfg.authToken,
  });
});

module.exports = { server, wss, rooms }; // exported for tests
