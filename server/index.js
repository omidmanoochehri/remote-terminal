'use strict';

/*
 * Remote Terminal — relay server.
 *
 * Pairs one `agent` (Windows machine) with one `phone` (Android app) inside a
 * "room" identified by a shared token, and forwards messages between them.
 * See ../PROTOCOL.md for the wire format.
 */

const http = require('http');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

/** @type {Map<string, {agent: import('ws').WebSocket|null, phone: import('ws').WebSocket|null}>} */
const rooms = new Map();

function getRoom(token) {
  let room = rooms.get(token);
  if (!room) {
    room = { agent: null, phone: null };
    rooms.set(token, room);
  }
  return room;
}

function peerRole(role) {
  return role === 'agent' ? 'phone' : 'agent';
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const server = http.createServer((req, res) => {
  // Simple health check so you can curl the server to confirm it is up.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Upgrade Required: connect with a WebSocket');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let role, token;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    role = url.searchParams.get('role');
    token = url.searchParams.get('room');
  } catch (_) {
    /* fall through to validation below */
  }

  if (role !== 'agent' && role !== 'phone') {
    send(ws, { type: 'error', message: 'role must be "agent" or "phone"' });
    ws.close();
    return;
  }
  if (!token) {
    send(ws, { type: 'error', message: 'missing room token' });
    ws.close();
    return;
  }

  const room = getRoom(token);
  if (room[role] && room[role].readyState === room[role].OPEN) {
    // Replace the previous occupant of this role (e.g. agent reconnecting).
    log(`room ${token}: replacing existing ${role}`);
    try { room[role].close(); } catch (_) {}
  }
  room[role] = ws;
  ws._role = role;
  ws._token = token;

  log(`room ${token}: ${role} connected`);
  send(ws, { type: 'welcome', role, room: token });

  // Tell each side about the other's presence.
  const peer = room[peerRole(role)];
  if (peer && peer.readyState === peer.OPEN) {
    send(ws, { type: 'status', peer: 'connected' });
    send(peer, { type: 'status', peer: 'connected' });
  }

  ws.on('message', (raw) => {
    const current = getRoom(token);
    const target = current[peerRole(role)];
    // The relay does not parse payloads; it forwards raw frames verbatim.
    if (target && target.readyState === target.OPEN) {
      target.send(raw.toString());
    }
  });

  ws.on('close', () => {
    const current = rooms.get(token);
    if (!current) return;
    if (current[role] === ws) current[role] = null;
    log(`room ${token}: ${role} disconnected`);
    const other = current[peerRole(role)];
    if (other && other.readyState === other.OPEN) {
      send(other, { type: 'status', peer: 'disconnected' });
    }
    if (!current.agent && !current.phone) rooms.delete(token);
  });

  ws.on('error', (err) => log(`room ${token}: ${role} socket error:`, err.message));
});

server.listen(PORT, HOST, () => {
  log(`relay listening on ws://${HOST}:${PORT}  (health: http://${HOST}:${PORT}/health)`);
});
