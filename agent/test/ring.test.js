'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { OutputRing } = require('../lib/ring');

test('positions advance with appended data and ranges follow `since`', () => {
  const r = new OutputRing(4096);
  r.append('hello\n');
  r.append('world\n');
  assert.strictEqual(r.head, 12);
  assert.strictEqual(r.base, 0);
  assert.deepStrictEqual(r.rangeFrom(undefined), { from: 0, data: 'hello\nworld\n' });
  assert.deepStrictEqual(r.rangeFrom(6), { from: 6, data: 'world\n' });
  assert.deepStrictEqual(r.rangeFrom(12), { from: 12, data: '' });
  assert.deepStrictEqual(r.rangeFrom(99), { from: 0, data: 'hello\nworld\n' }, 'ahead of head: full replay');
});

test('trimming cuts after a newline and reports the new base', () => {
  const r = new OutputRing(1024);
  for (let i = 0; i < 30; i++) r.append(`line ${String(i).padStart(3, '0')} ${'x'.repeat(90)}\n`);
  assert.ok(r.size <= 1024);
  assert.strictEqual(r.buf.indexOf('line'), 0, 'buffer starts at a line start');
  assert.strictEqual(r.base + r.size, r.head);
  const { from, data } = r.rangeFrom(0);
  assert.strictEqual(from, r.base, 'since older than the buffer falls back to base');
  assert.strictEqual(data, r.buf);
  const inside = r.rangeFrom(r.base + 5);
  assert.strictEqual(inside.from, r.base + 5);
  assert.strictEqual(inside.data, r.buf.slice(5));
});

test('without newlines the cut lands on an escape sequence, never inside a surrogate pair', () => {
  const r = new OutputRing(1024);
  let s = '';
  for (let i = 0; i < 40; i++) s += '\x1b[31m' + 'ab'.repeat(20) + '\x1b[0m';
  r.append(s);
  assert.strictEqual(r.buf.charCodeAt(0), 0x1b, 'starts at ESC');

  const e = new OutputRing(1024);
  e.append('😀'.repeat(700)); // 1400 UTF-16 units, no newline, no ESC
  const first = e.buf.charCodeAt(0);
  assert.ok(first >= 0xd800 && first <= 0xdbff, 'starts on a high surrogate');
  assert.strictEqual(e.buf.length % 2, 0);
});

test('clear drops history but keeps the stream position', () => {
  const r = new OutputRing(4096);
  r.append('abc');
  r.clear();
  assert.strictEqual(r.head, 3);
  assert.strictEqual(r.base, 3);
  assert.deepStrictEqual(r.rangeFrom(1), { from: 3, data: '' });
});
