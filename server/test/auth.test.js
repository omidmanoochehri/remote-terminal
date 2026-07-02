'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { authorize, safeEqual } = require('../auth');

test('open relay (no token, no pairing) authorizes anyone', () => {
  const cfg = { authToken: '', pairing: { enabled: false } };
  assert.strictEqual(authorize({ cfg, role: 'phone', room: 'r' }).ok, true);
});

test('shared token gate rejects missing/wrong and accepts correct', () => {
  const cfg = { authToken: 'sekret', pairing: { enabled: false } };
  assert.strictEqual(authorize({ cfg, role: 'agent', room: 'r' }).ok, false);
  assert.strictEqual(authorize({ cfg, role: 'agent', room: 'r', token: 'nope' }).ok, false);
  assert.strictEqual(authorize({ cfg, role: 'agent', room: 'r', token: 'sekret' }).ok, true);
});

test('pairing: agent mints a code that the phone must present', () => {
  const cfg = { authToken: '', pairing: { enabled: true, ttlSec: 300 } };
  const agent = authorize({ cfg, role: 'agent', room: 'pairRoom' });
  assert.strictEqual(agent.ok, true);
  assert.ok(agent.paired && agent.paired.type === 'paired');
  const code = agent.paired.code;

  assert.strictEqual(authorize({ cfg, role: 'phone', room: 'pairRoom', pair: 'bad' }).ok, false);
  assert.strictEqual(authorize({ cfg, role: 'phone', room: 'pairRoom', pair: code }).ok, true);
});

test('safeEqual compares by value', () => {
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
  assert.strictEqual(safeEqual('abc', 'abcd'), false);
});
