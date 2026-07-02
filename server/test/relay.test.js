'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fork } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const INDEX = path.join(__dirname, '..', 'index.js');

/** Start a relay in a child process and resolve once /health responds. */
function startServer(env) {
  const child = fork(INDEX, [], { env: Object.assign({}, process.env, env), stdio: 'ignore' });
  const port = env.PORT;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
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

function open(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.find((x) => x.pred(msg));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else inbox.push(msg);
  });
  ws.next = (pred) => new Promise((resolve, reject) => {
    const hit = inbox.find(pred);
    if (hit) { inbox.splice(inbox.indexOf(hit), 1); return resolve(hit); }
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), 3000);
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  ws.ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return ws;
}

const PORT = '8123';
let server;

before(async () => { server = await startServer({ PORT, LOG_LEVEL: 'error' }); });
after(() => { if (server) server.kill(); });

test('welcome advertises protocol v2', async () => {
  const agent = open(`ws://127.0.0.1:${PORT}/?role=agent&room=t1`);
  await agent.ready;
  const w = await agent.next((m) => m.type === 'welcome');
  assert.strictEqual(w.v, 2);
  agent.close();
});

test('phone and agent are paired and relay both directions', async () => {
  const agent = open(`ws://127.0.0.1:${PORT}/?role=agent&room=t2`);
  await agent.ready;
  const phone = open(`ws://127.0.0.1:${PORT}/?role=phone&room=t2`);
  await phone.ready;

  await agent.next((m) => m.type === 'status' && m.peer === 'connected');
  await phone.next((m) => m.type === 'status' && m.peer === 'connected');

  phone.send(JSON.stringify({ type: 'input', data: 'whoami\r' }));
  const got = await agent.next((m) => m.type === 'input');
  assert.strictEqual(got.data, 'whoami\r');

  agent.send(JSON.stringify({ type: 'output', data: 'user\r\n' }));
  const out = await phone.next((m) => m.type === 'output');
  assert.strictEqual(out.data, 'user\r\n');

  agent.close(); phone.close();
});

test('app-level ping is answered by the relay with pong', async () => {
  const phone = open(`ws://127.0.0.1:${PORT}/?role=phone&room=t3`);
  await phone.ready;
  await phone.next((m) => m.type === 'welcome');
  phone.send(JSON.stringify({ type: 'ping' }));
  const pong = await phone.next((m) => m.type === 'pong');
  assert.strictEqual(pong.type, 'pong');
  phone.close();
});

test('missing room is rejected', async () => {
  const bad = open(`ws://127.0.0.1:${PORT}/?role=phone`);
  await bad.ready;
  const err = await bad.next((m) => m.type === 'error');
  assert.match(err.message, /room/);
  bad.close();
});

test('auth token gate rejects connections without the token', async () => {
  const authed = await startServer({ PORT: '8124', AUTH_TOKEN: 'sekret', LOG_LEVEL: 'error' });
  try {
    const bad = open(`ws://127.0.0.1:8124/?role=agent&room=a`);
    await bad.ready;
    const err = await bad.next((m) => m.type === 'error');
    assert.match(err.message, /unauthorized/);
    bad.close();

    const ok = open(`ws://127.0.0.1:8124/?role=agent&room=a&token=sekret`);
    await ok.ready;
    const w = await ok.next((m) => m.type === 'welcome');
    assert.strictEqual(w.v, 2);
    ok.close();
  } finally {
    authed.kill();
  }
});
