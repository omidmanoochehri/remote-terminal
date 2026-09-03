'use strict';

/*
 * Shared helpers for relay integration tests: start a relay in a child
 * process, open WebSocket clients with a message inbox, and call the HTTP
 * identity endpoints.
 */

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const WebSocket = require('ws');

const INDEX = path.join(__dirname, '..', 'index.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Start a relay in a child process and resolve once /health responds. */
function startServer(env) {
  const dir = tmpDir('rt-relay-');
  const full = Object.assign({ LOG_LEVEL: 'error', STATE_FILE: path.join(dir, 'state.json') }, env);
  const child = fork(INDEX, [], { env: Object.assign({}, process.env, full), stdio: 'ignore' });
  child.stateDir = dir;
  const port = full.PORT;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(child); else retry();
      }).on('error', retry);
    };
    const retry = () => (Date.now() > deadline ? reject(new Error('server did not start')) : setTimeout(poll, 100));
    poll();
  });
}

/** Minimal JSON HTTP client. Resolves {status, body}. */
function httpJson(base, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + pathname, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Open a WebSocket with an inbox and `next(pred)` / `closed` helpers. */
function open(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((x) => x.pred(msg));
    if (i >= 0) { const w = waiters[i]; waiters.splice(i, 1); w.resolve(msg); } else inbox.push(msg);
  });
  ws.next = (pred, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const hit = inbox.find(pred);
    if (hit) { inbox.splice(inbox.indexOf(hit), 1); return resolve(hit); }
    const t = setTimeout(() => {
      const i = waiters.findIndex((w) => w.resolve === done);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error(`timeout waiting for message; inbox=${JSON.stringify(inbox).slice(0, 300)}`));
    }, timeoutMs);
    const done = (m) => { clearTimeout(t); resolve(m); };
    waiters.push({ pred, resolve: done });
  });
  /** Resolve true if no message matching pred arrives within ms. */
  ws.none = (pred, ms = 300) => new Promise((resolve) => {
    setTimeout(() => resolve(!inbox.some(pred)), ms);
  });
  ws.inbox = inbox;
  ws.sendJson = (obj) => ws.send(JSON.stringify(obj));
  ws.ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.closed = new Promise((res) => { ws.on('close', (code, reason) => res({ code, reason: reason.toString() })); });
  ws.on('error', () => { /* surfaced via ready/closed */ });
  return ws;
}

const A_ID = /^a_[a-z2-7]{20}$/;
const D_ID = /^d_[a-z2-7]{20}$/;
const S_ID = /^s_[a-z2-7]{20}$/;
const C_ID = /^c_[a-z2-7]{20}$/;

/** Random session id in the relay's format (for fake agents). */
function fakeSessionId() {
  const alpha = 'abcdefghijklmnopqrstuvwxyz234567';
  let s = 's_';
  for (let i = 0; i < 20; i++) s += alpha[Math.floor(Math.random() * 32)];
  return s;
}

/**
 * A relay client bundle bound to one running relay: enrol agents, connect
 * them, pair phones, connect phones.
 */
function relayClient(port) {
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  return {
    base,
    wsBase,
    enroll: (enrollToken, body) => httpJson(base, 'POST', '/v3/enroll', Object.assign({ hostname: 'host', platform: 'linux', os: 'Ubuntu 24.04', arch: 'x64', agentVersion: '0.3.0', protocol: 3 }, body), enrollToken ? { Authorization: `Bearer ${enrollToken}` } : {}),
    pairCode: (token) => httpJson(base, 'POST', '/v3/pair/code', {}, { Authorization: `Bearer ${token}` }),
    redeem: (code, deviceName = 'Test Phone') => httpJson(base, 'POST', '/v3/pair/redeem', { code, deviceName, platform: 'android', appVersion: '0.3.0' }),
    /** Connect an agent socket and complete registration. */
    connectAgent: async (agentToken, reg) => {
      const ws = open(`${wsBase}/?v=3&role=agent`, { Authorization: `Bearer ${agentToken}` });
      await ws.ready;
      ws.welcome = await ws.next((m) => m.type === 'welcome');
      ws.sendJson(Object.assign({
        type: 'agent.register', instanceId: 'inst-' + Math.random().toString(36).slice(2, 10),
        hostname: 'host', platform: 'linux', os: 'Ubuntu 24.04', arch: 'x64', agentVersion: '0.3.0', protocol: 3,
        shells: [{ id: 'bash', label: 'bash', default: true }, { id: 'sh', label: 'sh' }],
        caps: ['sessions', 'replay', 'resize', 'ping'], sessions: [],
      }, reg));
      ws.registered = await ws.next((m) => m.type === 'agent.registered');
      return ws;
    },
    /** Pair a new device via an issuer token and return its credentials. */
    pairDevice: async (issuerToken, deviceName) => {
      const c = await httpJson(base, 'POST', '/v3/pair/code', {}, { Authorization: `Bearer ${issuerToken}` });
      if (c.status !== 201) throw new Error('pair/code failed: ' + JSON.stringify(c.body));
      const r = await httpJson(base, 'POST', '/v3/pair/redeem', { code: c.body.code, deviceName: deviceName || 'Phone', platform: 'android' });
      if (r.status !== 201) throw new Error('pair/redeem failed: ' + JSON.stringify(r.body));
      return r.body;
    },
    connectPhone: async (deviceToken) => {
      const ws = open(`${wsBase}/?v=3&role=phone`, { Authorization: `Bearer ${deviceToken}` });
      await ws.ready;
      ws.welcome = await ws.next((m) => m.type === 'welcome');
      return ws;
    },
  };
}

module.exports = { startServer, httpJson, open, relayClient, tmpDir, fakeSessionId, A_ID, D_ID, S_ID, C_ID };
