'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { State } = require('../state');
const { Registry } = require('../registry');
const { Router } = require('../router');
const { makeLogger } = require('../logger');
const { loadConfig } = require('../config');
const { tmpDir } = require('./helpers');
const { newId } = require('../tokens');

const quiet = makeLogger('silent');

test('state persists identity records atomically with restrictive permissions', () => {
  const file = path.join(tmpDir('rt-state-'), 'nested', 'state.json');
  const st = new State(file, quiet, { debounceMs: 10 }).load();
  const reg = new Registry(st, {}, quiet);
  const a = reg.createAgent({ accountId: 'default', name: 'PC', hostname: 'pc' });
  const d = reg.createDevice({ accountId: 'default', name: 'Phone', pairedVia: a.record.agentId });
  st.flush();
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.version, 1);
  assert.ok(!JSON.stringify(raw).includes(a.token), 'plaintext token never persisted');
  assert.ok(!JSON.stringify(raw).includes(d.token));

  const st2 = new State(file, quiet).load();
  const reg2 = new Registry(st2, {}, quiet);
  assert.strictEqual(reg2.findAgentByToken(a.token).agentId, a.record.agentId);
  assert.strictEqual(reg2.findDeviceByToken(d.token).deviceId, d.record.deviceId);
  assert.strictEqual(reg2.listAgents('default')[0].name, 'PC');
  assert.strictEqual(reg2.listDevices('default', d.record.deviceId)[0].isSelf, true);
});

test('a corrupt state file is not fatal', () => {
  const file = path.join(tmpDir('rt-state-'), 'state.json');
  fs.writeFileSync(file, '{ nope');
  const st = new State(file, quiet).load();
  assert.deepStrictEqual(Object.keys(st.data.agents), []);
});

/** A fake connection good enough for the router. */
function fakeConn(role, accountId, extra) {
  const sent = [];
  const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close: () => { ws.readyState = 3; } };
  return Object.assign({
    id: newId('c'), ws, role, accountId, sent, attachments: new Set(), agentsTouched: new Set(), lagging: new Set(), lagTimer: null,
    log: quiet,
  }, extra);
}

test('router fan-out honours backpressure and signals session.lag after the buffer drains', async () => {
  const cfg = loadConfig({ BACKPRESSURE_HIGH_BYTES: '100', BACKPRESSURE_LOW_BYTES: '10' });
  const st = new State(path.join(tmpDir('rt-router-'), 'state.json'), quiet).load();
  const reg = new Registry(st, cfg, quiet);
  const router = new Router({ cfg, log: quiet, registry: reg });
  const a = reg.createAgent({ accountId: 'default', name: 'A' });
  const agentConn = fakeConn('agent', 'default', { agentId: a.record.agentId });
  reg.addConn(agentConn);
  const fast = fakeConn('phone', 'default', { deviceId: newId('d') });
  const slow = fakeConn('phone', 'default', { deviceId: newId('d') });
  reg.addConn(fast); reg.addConn(slow);
  const sid = newId('s');

  router.handleAgent(agentConn, { type: 'agent.register', instanceId: 'i1', sessions: [{ sessionId: sid }] });
  for (const c of [fast, slow]) {
    router.handleAgent(agentConn, { type: 'session.attached', client: c.id, session: sid, from: 0, seq: 0, cols: 80, rows: 24 });
  }
  assert.ok(fast.attachments.has(`${a.record.agentId}|${sid}`));

  slow.ws.bufferedAmount = 1000;
  router.handleAgent(agentConn, { type: 'output', session: sid, seq: 3, data: 'abc' });
  assert.strictEqual(fast.sent.filter((m) => m.type === 'output').length, 1);
  assert.strictEqual(slow.sent.filter((m) => m.type === 'output').length, 0, 'slow phone skipped');
  router.handleAgent(agentConn, { type: 'output', session: sid, seq: 6, data: 'def' });
  assert.strictEqual(fast.sent.filter((m) => m.type === 'output').length, 2);

  slow.ws.bufferedAmount = 0;
  await new Promise((r) => setTimeout(r, 600));
  const lag = slow.sent.find((m) => m.type === 'session.lag');
  assert.ok(lag, 'session.lag delivered once drained');
  assert.strictEqual(lag.session, sid);
  assert.strictEqual(slow.lagging.size, 0);
  router.handleAgent(agentConn, { type: 'output', session: sid, seq: 9, data: 'ghi' });
  assert.strictEqual(slow.sent.filter((m) => m.type === 'output').length, 1, 'forwarding resumes');

  // Unicast output goes only to the named client.
  router.handleAgent(agentConn, { type: 'output', session: sid, seq: 9, data: 'replay', client: fast.id });
  assert.strictEqual(fast.sent.filter((m) => m.data === 'replay').length, 1);
  assert.strictEqual(slow.sent.filter((m) => m.data === 'replay').length, 0);
  router.onPhoneClosed(slow);
});

test('router refuses routing for agents outside the account and for unattached input', () => {
  const cfg = loadConfig({});
  const st = new State(path.join(tmpDir('rt-router-'), 'state.json'), quiet).load();
  const reg = new Registry(st, cfg, quiet);
  const router = new Router({ cfg, log: quiet, registry: reg });
  const a = reg.createAgent({ accountId: 'default', name: 'A' });
  const b = reg.createAgent({ accountId: 'other', name: 'B' });
  const agentConn = fakeConn('agent', 'default', { agentId: a.record.agentId });
  const agentB = fakeConn('agent', 'other', { agentId: b.record.agentId });
  reg.addConn(agentConn); reg.addConn(agentB);
  const phone = fakeConn('phone', 'default', { deviceId: newId('d') });
  reg.addConn(phone);
  const sid = newId('s');

  router.handlePhone(phone, { type: 'input', agent: b.record.agentId, session: sid, data: 'x' });
  assert.strictEqual(phone.sent.pop().code, 'forbidden');
  router.handlePhone(phone, { type: 'input', agent: newId('a'), session: sid, data: 'x' });
  assert.strictEqual(phone.sent.pop().code, 'not_found');
  router.handlePhone(phone, { type: 'input', agent: a.record.agentId, session: sid, data: 'x' });
  assert.strictEqual(phone.sent.pop().code, 'forbidden');
  assert.strictEqual(agentConn.sent.length, 0);
  assert.strictEqual(agentB.sent.length, 0);

  // An agent cannot ack an attach for a client of another account.
  const phoneB = fakeConn('phone', 'other', { deviceId: newId('d') });
  reg.addConn(phoneB);
  router.handleAgent(agentConn, { type: 'session.attached', client: phoneB.id, session: sid, from: 0, seq: 0, cols: 80, rows: 24 });
  assert.strictEqual(phoneB.sent.length, 0);
  assert.strictEqual(agentConn.sent.pop().type, 'client.gone');
});
