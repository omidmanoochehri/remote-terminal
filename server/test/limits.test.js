'use strict';

/*
 * Limits and legacy behaviour need their own relay instances with tight
 * settings: message rate limits, session caps, pairing lockouts, and v2 room
 * compatibility mode.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, open, relayClient, fakeSessionId } = require('./helpers');

const PORT = 18302;
const LEGACY_PORT = 18303;
const ENROLL = 'limits-secret';
let server;
let legacyServer;
let rc;

before(async () => {
  server = await startServer({
    PORT: String(PORT), ENROLL_TOKEN: ENROLL,
    MSG_PER_SEC: '25', MAX_SESSIONS_PER_AGENT: '2', SESSION_CREATE_PER_MIN: '3',
    PAIR_PER_IP_PER_MIN: '3', PAIR_LOCKOUT_SEC: '2', PAIRING_TTL_SEC: '1', MAX_DEVICES_PER_ACCOUNT: '3',
    ENROLL_PER_IP_PER_MIN: '6',
  });
  rc = relayClient(PORT);
  legacyServer = await startServer({ PORT: String(LEGACY_PORT), LEGACY_V2: '1', AUTH_TOKEN: 'shared', LEGACY_PAIRING: '1' });
});
after(() => { if (server) server.kill(); if (legacyServer) legacyServer.kill(); });

test('per-connection message rate limit closes the socket with 4429', async () => {
  const enrolled = await rc.enroll(ENROLL, { name: 'Flood' });
  const agent = await rc.connectAgent(enrolled.body.agentToken);
  const dev = await rc.pairDevice(enrolled.body.agentToken);
  const phone = await rc.connectPhone(dev.deviceToken);
  for (let i = 0; i < 40; i++) phone.sendJson({ type: 'ping' });
  const closed = await phone.closed;
  assert.strictEqual(closed.code, 4429);
  agent.close();
});

test('session caps and session-create rate limit answer limit_reached / rate_limited', async () => {
  const enrolled = await rc.enroll(ENROLL, { name: 'Caps' });
  const agent = await rc.connectAgent(enrolled.body.agentToken);
  const dev = await rc.pairDevice(enrolled.body.agentToken);
  const phone = await rc.connectPhone(dev.deviceToken);
  const agentId = enrolled.body.agentId;

  for (let i = 0; i < 2; i++) {
    phone.sendJson({ type: 'session.create', reqId: 'c' + i, agent: agentId, cols: 80, rows: 24 });
    const req = await agent.next((m) => m.type === 'session.create');
    agent.sendJson({ type: 'session.created', reqId: req.reqId, client: req.client, session: { sessionId: fakeSessionId(), shell: 'bash' } });
    await phone.next((m) => m.type === 'session.created' && m.reqId === 'c' + i);
  }
  phone.sendJson({ type: 'session.create', reqId: 'c2', agent: agentId, cols: 80, rows: 24 });
  const cap = await phone.next((m) => m.type === 'error' && m.reqId === 'c2');
  assert.strictEqual(cap.code, 'limit_reached');
  assert.ok(await agent.none((m) => m.type === 'session.create'));

  // Third create counted against the per-minute budget (3) even though it hit the cap
  // before the limiter; one more attempt trips the rate limiter on a fresh agent.
  const enrolled2 = await rc.enroll(ENROLL, { name: 'Caps2' });
  const agent2 = await rc.connectAgent(enrolled2.body.agentToken);
  phone.sendJson({ type: 'session.create', reqId: 'd0', agent: enrolled2.body.agentId, cols: 80, rows: 24 });
  await agent2.next((m) => m.type === 'session.create');
  phone.sendJson({ type: 'session.create', reqId: 'd1', agent: enrolled2.body.agentId, cols: 80, rows: 24 });
  const rl = await phone.next((m) => m.type === 'error' && m.reqId === 'd1');
  assert.strictEqual(rl.code, 'rate_limited');
  agent.close(); agent2.close(); phone.close();
});

test('pairing: expiry, per-IP lockout and device cap', async () => {
  const enrolled = await rc.enroll(ENROLL, { name: 'PairLimits' });
  const code = await rc.pairCode(enrolled.body.agentToken);
  await new Promise((r) => setTimeout(r, 1200));
  const expired = await rc.redeem(code.body.code);
  assert.strictEqual(expired.status, 401, 'expired code is refused');

  // Three failed attempts exhaust the per-IP budget; the fourth is locked out.
  for (let i = 0; i < 2; i++) assert.strictEqual((await rc.redeem('123456')).status, 401);
  const locked = await rc.redeem('123456');
  assert.strictEqual(locked.status, 429);
  await new Promise((r) => setTimeout(r, 2100)); // lockout expires (PAIR_LOCKOUT_SEC=2)

  const fresh = await rc.pairCode(enrolled.body.agentToken);
  const ok = await rc.redeem(fresh.body.code, 'p1');
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));

  // Device cap (3 per account, this account already has 1 + earlier tests' devices? no: separate accounts share 'default').
  // Pair until the cap answers limit_reached.
  let last;
  for (let i = 0; i < 4; i++) {
    const c = await rc.pairCode(enrolled.body.agentToken);
    last = await rc.redeem(c.body.code, 'p' + i);
    if (last.status !== 201) break;
  }
  assert.strictEqual(last.status, 403);
  assert.strictEqual(last.body.error, 'limit_reached');
});

test('enrolment is rate limited per IP', async () => {
  let limited = null;
  for (let i = 0; i < 6 && !limited; i++) {
    const r = await rc.enroll(ENROLL, { name: 'Burst ' + i });
    if (r.status === 429) limited = r;
    else assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  }
  assert.ok(limited, 'enrolment budget exhausted');
  assert.strictEqual(limited.body.error, 'rate_limited');
});

test('legacy v2 room mode is isolated from v3 and off by default', async () => {
  // On the v3-only relay a v2 client is refused with 4426.
  const v2OnV3 = open(`${rc.wsBase}/?role=agent&room=r1`);
  await v2OnV3.ready;
  const err = await v2OnV3.next((m) => m.type === 'error');
  assert.strictEqual(err.code, 'unsupported_version');
  assert.strictEqual((await v2OnV3.closed).code, 4426);

  // On the legacy-enabled relay the v2 flow works as before.
  const base = `ws://127.0.0.1:${LEGACY_PORT}`;
  const agent = open(`${base}/?role=agent&room=r2&token=shared`);
  await agent.ready;
  const w = await agent.next((m) => m.type === 'welcome');
  assert.strictEqual(w.v, 2);
  const paired = await agent.next((m) => m.type === 'paired');
  assert.match(paired.code, /^[0-9]{6}$/);

  const badPhone = open(`${base}/?role=phone&room=r2&token=shared&pair=000000`);
  await badPhone.ready;
  await badPhone.next((m) => m.type === 'error');
  assert.strictEqual((await badPhone.closed).code, 4401);

  const phone = open(`${base}/?role=phone&room=r2&token=shared&pair=${paired.code}`);
  await phone.ready;
  await phone.next((m) => m.type === 'welcome');
  await agent.next((m) => m.type === 'status' && m.peer === 'connected');
  phone.sendJson({ type: 'input', data: 'whoami\r' });
  const got = await agent.next((m) => m.type === 'input');
  assert.strictEqual(got.data, 'whoami\r');
  agent.sendJson({ type: 'output', data: 'user\r\n' });
  const out = await phone.next((m) => m.type === 'output');
  assert.strictEqual(out.data, 'user\r\n');

  // A v3 phone on the same relay sees no legacy rooms.
  const lrc = relayClient(LEGACY_PORT);
  const enrolled = await lrc.enroll('shared', { name: 'v3 on legacy relay' });
  assert.strictEqual(enrolled.status, 201);
  const dev = await lrc.pairDevice(enrolled.body.agentToken);
  const v3phone = await lrc.connectPhone(dev.deviceToken);
  assert.ok(v3phone.welcome.caps.includes('legacy'));
  assert.ok(v3phone.welcome.agents.every((a) => a.agentId === enrolled.body.agentId));
  agent.close(); phone.close(); v3phone.close();
});
