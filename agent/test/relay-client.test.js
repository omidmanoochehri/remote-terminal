'use strict';

/*
 * RelayClient against an in-process fake relay: registration, session
 * commands, replay, reconnect without losing sessions, and fatal close codes.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const { RelayClient } = require('../lib/relay-client');
const { SessionManager } = require('../lib/sessions');
const { makeLogger } = require('../lib/log');
const { makeFakeSpawn, SHELLS, testConfig, sleep } = require('./fake-pty');

const log = makeLogger('silent');
const META = { hostname: 'h', platform: 'linux', os: 'Ubuntu', arch: 'x64', agentVersion: '0.3.0', protocol: 3 };

/** A fake relay that records connections and lets tests drive them. */
function fakeRelay() {
  const wss = new WebSocketServer({ port: 0 });
  const conns = [];
  const waiters = [];
  wss.on('connection', (ws, req) => {
    const c = { ws, auth: req.headers.authorization, url: req.url, inbox: [], waiters: [] };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = c.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = c.waiters[i]; c.waiters.splice(i, 1); w.resolve(m); } else c.inbox.push(m);
    });
    c.next = (pred, ms = 3000) => new Promise((resolve, reject) => {
      const hit = c.inbox.find(pred);
      if (hit) { c.inbox.splice(c.inbox.indexOf(hit), 1); return resolve(hit); }
      const t = setTimeout(() => reject(new Error('timeout; inbox=' + JSON.stringify(c.inbox).slice(0, 300))), ms);
      c.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
    c.send = (o) => ws.send(JSON.stringify(o));
    conns.push(c);
    ws.send(JSON.stringify({ type: 'welcome', v: 3, role: 'agent', connId: 'c_relay', agentId: 'a_x', name: 'Relay Name', caps: [], limits: {} }));
    const w = waiters.shift();
    if (w) w(c);
  });
  return {
    port: wss.address().port,
    conns,
    nextConn: (ms = 3000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no connection')), ms);
      waiters.push((c) => { clearTimeout(t); resolve(c); });
    }),
    close: () => new Promise((r) => wss.close(r)),
  };
}

function makeClient(relay, over) {
  const { spawn, spawned } = makeFakeSpawn();
  const cfg = testConfig(Object.assign({ server: `ws://127.0.0.1:${relay.port}` }, over));
  const sessions = new SessionManager({ cfg, log, shells: SHELLS, spawn });
  const state = { agentId: 'a_x', agentToken: 'tok-secret', name: '' };
  const client = new RelayClient({ cfg, state, log, sessions, meta: META, shells: SHELLS });
  return { client, sessions, spawned, state };
}

test('registers with bearer auth, serves create/attach/input/resize, survives reconnect, stops on 4401', async (t) => {
  const relay = fakeRelay();
  t.after(() => relay.close());
  const { client, sessions, spawned, state } = makeClient(relay);
  t.after(() => client.stop());
  const connP = relay.nextConn();
  client.start();
  const c1 = await connP;
  assert.strictEqual(c1.auth, 'Bearer tok-secret');
  assert.match(c1.url, /\?v=3&role=agent$/);

  const reg = await c1.next((m) => m.type === 'agent.register');
  assert.strictEqual(reg.protocol, 3);
  assert.strictEqual(reg.hostname, 'h');
  assert.deepStrictEqual(reg.shells, [{ id: 'bash', label: 'bash', default: true }, { id: 'sh', label: 'sh', default: false }]);
  assert.deepStrictEqual(reg.sessions, []);
  assert.ok(reg.instanceId.length >= 8);
  c1.send({ type: 'agent.registered', agentId: 'a_x', name: 'Relay Name' });
  await sleep(20);
  assert.strictEqual(state.name, 'Relay Name', 'relay-side name is adopted');

  // create
  c1.send({ type: 'session.create', reqId: 'r1', client: 'c_phone', shell: 'bash', cols: 90, rows: 25, title: 'Logs' });
  const created = await c1.next((m) => m.type === 'session.created');
  assert.strictEqual(created.reqId, 'r1');
  assert.strictEqual(created.client, 'c_phone');
  const sid = created.session.sessionId;
  assert.strictEqual(created.session.title, 'Logs');
  assert.strictEqual(spawned.length, 1);

  // unknown shell -> error routed back to the client
  c1.send({ type: 'session.create', reqId: 'r2', client: 'c_phone', shell: 'fish', cols: 80, rows: 24 });
  const err = await c1.next((m) => m.type === 'error' && m.reqId === 'r2');
  assert.strictEqual(err.code, 'bad_request');
  assert.strictEqual(err.client, 'c_phone');

  // output before attach: live fan-out message without client
  spawned[0].emitData('$ ');
  const live = await c1.next((m) => m.type === 'output');
  assert.deepStrictEqual(live, { type: 'output', session: sid, seq: 2, data: '$ ' });

  // attach with a different geometry -> ack, unicast replay, then resize broadcast
  c1.send({ type: 'session.attach', reqId: 'r3', client: 'c_phone', session: sid, cols: 120, rows: 40 });
  const ack = await c1.next((m) => m.type === 'session.attached');
  assert.deepStrictEqual(ack, { type: 'session.attached', reqId: 'r3', client: 'c_phone', session: sid, from: 0, seq: 2, cols: 90, rows: 25 });
  const replay = await c1.next((m) => m.type === 'output' && m.client === 'c_phone');
  assert.deepStrictEqual(replay, { type: 'output', session: sid, seq: 2, data: '$ ', client: 'c_phone' });
  const upd = await c1.next((m) => m.type === 'session.updated');
  assert.deepStrictEqual(upd, { type: 'session.updated', session: sid, cols: 120, rows: 40 });
  assert.deepStrictEqual([spawned[0].cols, spawned[0].rows], [120, 40]);

  // delta attach
  spawned[0].emitData('more\n');
  await c1.next((m) => m.type === 'output' && m.seq === 7);
  c1.send({ type: 'session.attach', reqId: 'r4', client: 'c_two', session: sid, since: 2, cols: 120, rows: 40 });
  const ack2 = await c1.next((m) => m.type === 'session.attached' && m.reqId === 'r4');
  assert.strictEqual(ack2.from, 2);
  const delta = await c1.next((m) => m.type === 'output' && m.client === 'c_two');
  assert.strictEqual(delta.data, 'more\n');
  assert.ok(!c1.inbox.some((m) => m.type === 'session.updated'), 'same geometry: no resize broadcast');

  // input / resize / rename / unknown session
  c1.send({ type: 'input', session: sid, data: 'ls\r' });
  c1.send({ type: 'resize', session: sid, cols: 100, rows: 30 });
  c1.send({ type: 'session.rename', session: sid, title: 'Renamed' });
  await c1.next((m) => m.type === 'session.updated' && m.title === 'Renamed');
  assert.deepStrictEqual(spawned[0].written, ['ls\r']);
  assert.deepStrictEqual([spawned[0].cols, spawned[0].rows], [100, 30]);
  c1.send({ type: 'input', session: 's_aaaaaaaaaaaaaaaaaaaa', data: 'x' });
  const unk = await c1.next((m) => m.type === 'error');
  assert.strictEqual(unk.code, 'unknown_session');
  c1.send({ type: 'input', session: sid, data: 'x'.repeat(2000) }); // over maxInputBytes: dropped
  await sleep(20);
  assert.strictEqual(spawned[0].written.length, 1);

  // detach / client.gone bookkeeping
  c1.send({ type: 'client.gone', client: 'c_phone' });
  await sleep(20);
  assert.deepStrictEqual([...sessions.get(sid).clients], ['c_two']);

  // The relay drops the connection: the session survives and is re-announced.
  const connP2 = relay.nextConn();
  c1.ws.close(1001, 'relay restart');
  const c2 = await connP2;
  const reg2 = await c2.next((m) => m.type === 'agent.register');
  assert.strictEqual(reg2.instanceId, reg.instanceId, 'same process, same instance id');
  assert.strictEqual(reg2.sessions.length, 1);
  assert.strictEqual(reg2.sessions[0].sessionId, sid);
  assert.strictEqual(reg2.sessions[0].seq, 7);
  assert.strictEqual(spawned[0].killed, false, 'the shell was never killed');
  assert.strictEqual(sessions.get(sid).clients.size, 0, 'attachments are relay-side; agent forgets clients on reconnect');

  // exit -> exit + session.updated; close -> session.closed
  spawned[0].emitExit(0);
  const exit = await c2.next((m) => m.type === 'exit');
  assert.deepStrictEqual(exit, { type: 'exit', session: sid, code: 0 });
  await c2.next((m) => m.type === 'session.updated' && m.state === 'exited');
  c2.send({ type: 'session.close', session: sid });
  const closed = await c2.next((m) => m.type === 'session.closed');
  assert.deepStrictEqual(closed, { type: 'session.closed', session: sid, reason: 'closed' });

  // Revocation: 4401 is fatal, no reconnect.
  let fatal = null;
  client.on('fatal', (why, code) => { fatal = { why, code }; });
  let extra = false;
  relay.nextConn(400).then(() => { extra = true; }).catch(() => {});
  c2.ws.close(4401, 'revoked');
  await sleep(500);
  assert.deepStrictEqual(fatal, { why: 'revoked', code: 4401 });
  assert.strictEqual(extra, false, 'no reconnect after revocation');
  assert.strictEqual(client.connected, false);
  client.stop();
  await relay.close();
});

test('4409 (replaced) and 4426 (upgrade required) are fatal too; normal errors back off', async (t) => {
  for (const [code, why] of [[4409, 'replaced'], [4426, 'upgrade_required']]) {
    const relay = fakeRelay();
    t.after(() => relay.close());
    const { client } = makeClient(relay);
    t.after(() => client.stop());
    const p = relay.nextConn();
    client.start();
    const c = await p;
    await c.next((m) => m.type === 'agent.register');
    const fatal = new Promise((r) => client.once('fatal', (w) => r(w)));
    c.ws.close(code, why);
    assert.strictEqual(await fatal, why);
    client.stop();
    await relay.close();
  }

  // Unreachable relay: keeps retrying with backoff until stopped.
  const { client } = makeClient({ port: 1 }, { baseBackoffMs: 5, maxBackoffMs: 20 });
  t.after(() => client.stop());
  client.start();
  await sleep(150);
  assert.ok(client.attempt >= 2, `attempts=${client.attempt}`);
  client.stop();
});

test('metrics ride along with register and then refresh on their own timer', async (t) => {
  const relay = fakeRelay();
  t.after(() => relay.close());
  const { client } = makeClient(relay, { metricsIntervalMs: 20 });
  t.after(() => client.stop());
  // A stand-in collector: real sampling is covered in metrics.test.js.
  let n = 0;
  client.metrics = { sample: () => ({ cpuLoad: 0.1 * ++n, memoryUsed: 1, memoryTotal: 2, uptimeSec: 5 }) };
  const p = relay.nextConn();
  client.start();
  const c = await p;

  const reg = await c.next((m) => m.type === 'agent.register');
  assert.strictEqual(reg.metrics.cpuLoad, 0.1, 'the first sample arrives with the registration');
  assert.ok(reg.caps.includes('metrics'));
  const tick = await c.next((m) => m.type === 'agent.metrics');
  assert.strictEqual(tick.metrics.memoryTotal, 2);
  assert.ok(tick.metrics.cpuLoad > 0.1, 'each tick is a fresh sample');

  client.stop();
  await relay.close();
});

test('a collector that throws is logged, not fatal, and metrics can be turned off', async (t) => {
  const relay = fakeRelay();
  t.after(() => relay.close());
  const { client } = makeClient(relay, { metricsIntervalMs: 20 });
  t.after(() => client.stop());
  client.metrics = { sample: () => { throw new Error('no /proc/stat here'); } };
  const p = relay.nextConn();
  client.start();
  const c = await p;
  const reg = await c.next((m) => m.type === 'agent.register');
  assert.strictEqual(reg.metrics, undefined, 'registration still goes out');
  await sleep(60);
  assert.ok(!c.inbox.some((m) => m.type === 'agent.metrics'), 'nothing is published');
  client.stop();
  await relay.close();

  // metricsIntervalMs=0 keeps the timer from ever starting.
  const relay2 = fakeRelay();
  t.after(() => relay2.close());
  const off = makeClient(relay2, { metricsIntervalMs: 0 }).client;
  t.after(() => off.stop());
  const p2 = relay2.nextConn();
  off.start();
  const c2 = await p2;
  await c2.next((m) => m.type === 'agent.register');
  assert.strictEqual(off.metricsTimer, null);
  off.stop();
  await relay2.close();
});

test('backpressure pauses shells while the socket buffer is high and resumes after drain', async (t) => {
  const relay = fakeRelay();
  t.after(() => relay.close());
  const { client, spawned } = makeClient(relay, { backpressureHighBytes: 10, backpressureLowBytes: 5 });
  t.after(() => client.stop());
  const p = relay.nextConn();
  client.start();
  const c = await p;
  await c.next((m) => m.type === 'agent.register');
  c.send({ type: 'session.create', client: 'c_p', shell: 'bash', cols: 80, rows: 24 });
  await c.next((m) => m.type === 'session.created');
  // Simulate a congested socket by faking bufferedAmount on the client's ws.
  let fake = 1000;
  Object.defineProperty(client.ws, 'bufferedAmount', { get: () => fake, configurable: true });
  spawned[0].emitData('x'.repeat(2000));
  await sleep(30);
  assert.strictEqual(spawned[0].paused, true, 'shell paused');
  fake = 0;
  await sleep(250);
  assert.strictEqual(spawned[0].paused, false, 'shell resumed after drain');
  client.stop();
  await relay.close();
});
