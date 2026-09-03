'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { checkEnrollToken, clientIp, bearerFromReq, authenticate } = require('../auth');
const { safeEqual, newId, newToken, hashToken, isId } = require('../tokens');
const { Registry } = require('../registry');
const { State } = require('../state');
const { makeLogger } = require('../logger');
const { tmpDir } = require('./helpers');
const path = require('node:path');

const quiet = makeLogger('silent');

test('safeEqual compares by value', () => {
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
  assert.strictEqual(safeEqual('abc', 'abcd'), false);
});

test('ids and tokens have the documented shape', () => {
  assert.match(newId('a'), /^a_[a-z2-7]{20}$/);
  assert.ok(isId(newId('s'), 's'));
  assert.ok(!isId(newId('s'), 'a'));
  assert.ok(!isId('a_short'));
  const t = newToken();
  assert.ok(t.length >= 40 && /^[A-Za-z0-9_-]+$/.test(t));
  assert.notStrictEqual(newToken(), t);
  assert.strictEqual(hashToken('x'), hashToken('x'));
  assert.notStrictEqual(hashToken('x'), 'x');
});

test('enrolment token resolves to an account; open enrolment only without any token', () => {
  assert.strictEqual(checkEnrollToken({ authToken: '', accounts: [] }, undefined), 'default');
  assert.strictEqual(checkEnrollToken({ authToken: 'sekret', accounts: [] }, undefined), null);
  assert.strictEqual(checkEnrollToken({ authToken: 'sekret', accounts: [] }, 'nope'), null);
  assert.strictEqual(checkEnrollToken({ authToken: 'sekret', accounts: [] }, 'sekret'), 'default');
  const cfg = { authToken: '', accounts: [{ accountId: 'b', enrollToken: 'tb' }] };
  assert.strictEqual(checkEnrollToken(cfg, undefined), null, 'accounts configured: not open');
  assert.strictEqual(checkEnrollToken(cfg, 'tb'), 'b');
});

test('clientIp trusts X-Forwarded-For only behind a declared proxy, and then the last hop', () => {
  const req = { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, socket: { remoteAddress: '9.9.9.9' } };
  assert.strictEqual(clientIp(req, { trustProxy: false }), '9.9.9.9');
  assert.strictEqual(clientIp(req, { trustProxy: true }), '2.2.2.2');
});

test('bearer token comes from the header first, then token= query', () => {
  const url = new URL('http://x/?token=q');
  assert.strictEqual(bearerFromReq({ headers: { authorization: 'Bearer h' } }, url), 'h');
  assert.strictEqual(bearerFromReq({ headers: {} }, url), 'q');
  assert.strictEqual(bearerFromReq({ headers: {} }, new URL('http://x/')), null);
});

test('authenticate resolves agent and device tokens by hash only', () => {
  const state = new State(path.join(tmpDir('rt-auth-'), 'state.json'), quiet).load();
  const reg = new Registry(state, {}, quiet);
  const a = reg.createAgent({ accountId: 'default', name: 'A' });
  const d = reg.createDevice({ accountId: 'default', name: 'D' });
  assert.strictEqual(authenticate(reg, a.token).kind, 'agent');
  assert.strictEqual(authenticate(reg, d.token).kind, 'device');
  assert.strictEqual(authenticate(reg, a.record.agentId), null, 'ids are not credentials');
  assert.strictEqual(authenticate(reg, a.record.tokenHash), null, 'the stored hash is not a credential');
  assert.strictEqual(authenticate(reg, ''), null);
  reg.removeAgent(a.record.agentId);
  assert.strictEqual(authenticate(reg, a.token), null, 'revoked');
});
