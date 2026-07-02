'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PairingStore, numericCode } = require('../pairing');

test('numericCode is zero-padded to the requested length', () => {
  for (let i = 0; i < 50; i++) {
    const c = numericCode(6);
    assert.match(c, /^[0-9]{6}$/);
  }
});

test('a minted code redeems exactly once', () => {
  const store = new PairingStore();
  const { code } = store.mint('room1', 300);
  assert.strictEqual(store.redeem('room1', code), true);
  assert.strictEqual(store.redeem('room1', code), false, 'second redeem must fail');
});

test('wrong code and wrong room are rejected', () => {
  const store = new PairingStore();
  const { code } = store.mint('room1', 300);
  assert.strictEqual(store.redeem('room1', '000000' === code ? '111111' : '000000'), false);
  assert.strictEqual(store.redeem('other', code), false);
});

test('expired codes do not redeem', () => {
  const store = new PairingStore();
  const { code } = store.mint('room1', -1); // already expired
  assert.strictEqual(store.redeem('room1', code), false);
});
