'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PairingStore } = require('../pairing');
const { numericCode } = require('../tokens');

test('numericCode is zero-padded to the requested length', () => {
  for (let i = 0; i < 50; i++) assert.match(numericCode(6), /^[0-9]{6}$/);
});

test('a minted code redeems exactly once and returns its account', () => {
  const store = new PairingStore({ ttlSec: 300 });
  const { code } = store.mint({ accountId: 'acc', issuedBy: 'a_1' });
  const first = store.redeem(code);
  assert.deepStrictEqual(first, { ok: true, accountId: 'acc', issuedBy: 'a_1' });
  assert.strictEqual(store.redeem(code).ok, false, 'second redeem must fail');
});

test('wrong codes are rejected and do not disturb the right one', () => {
  const store = new PairingStore({ ttlSec: 300 });
  const { code } = store.mint({ accountId: 'acc', issuedBy: 'a_1' });
  assert.strictEqual(store.redeem(code === '000000' ? '111111' : '000000').ok, false);
  assert.strictEqual(store.redeem(code).ok, true);
});

test('expired codes do not redeem', () => {
  let now = 1000;
  const store = new PairingStore({ ttlSec: 1, now: () => now });
  const { code } = store.mint({ accountId: 'acc', issuedBy: 'a_1' });
  now += 1500;
  assert.strictEqual(store.redeem(code).ok, false);
  assert.strictEqual(store.size, 0);
});

test('minting again for the same issuer replaces the previous code', () => {
  const store = new PairingStore({ ttlSec: 300 });
  const a = store.mint({ accountId: 'acc', issuedBy: 'a_1' });
  const b = store.mint({ accountId: 'acc', issuedBy: 'a_1' });
  assert.notStrictEqual(a.code, b.code);
  assert.strictEqual(store.redeem(a.code).ok, false);
  assert.strictEqual(store.redeem(b.code).ok, true);
});

test('too many wrong guesses invalidate outstanding codes', () => {
  const store = new PairingStore({ ttlSec: 300, maxWrongGuesses: 3 });
  const { code } = store.mint({ accountId: 'acc', issuedBy: 'a_1' });
  for (let i = 0; i < 3; i++) store.redeem(code === '999999' ? '888888' : '999999');
  assert.strictEqual(store.redeem(code).ok, false, 'code was burned by guessing');
});
