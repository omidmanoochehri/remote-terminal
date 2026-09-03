'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { SessionManager, SessionError } = require('../lib/sessions');
const { makeLogger } = require('../lib/log');
const { makeFakeSpawn, SHELLS, testConfig, sleep } = require('./fake-pty');

const log = makeLogger('silent');

function setup(over, clock) {
  const { spawn, spawned } = makeFakeSpawn();
  const now = clock || { t: 1_000_000 };
  const mgr = new SessionManager({ cfg: testConfig(over), log, shells: SHELLS, spawn, now: () => now.t, cwd: '/home/u' });
  const events = [];
  for (const ev of ['output', 'session.updated', 'exit', 'session.closed']) mgr.on(ev, (s, x) => events.push({ ev, id: s.id, x }));
  return { mgr, spawned, now, events };
}

test('create assigns ids, titles, geometry and enforces the session cap', () => {
  const { mgr, spawned } = setup();
  const a = mgr.create({ shell: 'bash', cols: 100, rows: 30 });
  assert.match(a.id, /^s_[a-z2-7]{20}$/);
  assert.strictEqual(a.title, 'bash');
  assert.deepStrictEqual([spawned[0].opts.cmd, spawned[0].cols, spawned[0].rows, spawned[0].opts.cwd], ['/bin/bash', 100, 30, '/home/u']);
  const b = mgr.create({ shell: undefined, cols: 80, rows: 24 });
  assert.strictEqual(b.title, 'bash 2', 'default shell, numbered title');
  const c = mgr.create({ shell: 'sh', cols: 80, rows: 24, title: 'Deploy' });
  assert.strictEqual(c.title, 'Deploy');
  assert.throws(() => mgr.create({ shell: 'bash', cols: 80, rows: 24 }), (e) => e instanceof SessionError && e.code === 'limit_reached');
  assert.throws(() => mgr.create({ shell: 'fish', cols: 80, rows: 24 }), (e) => e.code === 'bad_request');
  assert.strictEqual(mgr.list().length, 3);
  assert.strictEqual(mgr.list()[0].sessionId, a.id);
  assert.strictEqual(mgr.list()[0].state, 'running');
});

test('spawn failures surface as internal errors without leaking a session', () => {
  const mgr = new SessionManager({ cfg: testConfig(), log, shells: SHELLS, spawn: () => { throw new Error('ENOENT'); } });
  assert.throws(() => mgr.create({ shell: 'bash', cols: 80, rows: 24 }), (e) => e.code === 'internal' && /ENOENT/.test(e.message));
  assert.strictEqual(mgr.sessions.size, 0);
});

test('output is coalesced with correct stream positions and chunked by maxChunk', async () => {
  const { mgr, spawned, events } = setup({ maxChunk: 1024, coalesceMs: 5 });
  const s = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  spawned[0].emitData('ab');
  spawned[0].emitData('cd');
  await sleep(20);
  const outs = events.filter((e) => e.ev === 'output');
  assert.strictEqual(outs.length, 1, 'two pty reads became one message');
  assert.deepStrictEqual(outs[0].x, { seq: 4, data: 'abcd' });
  assert.strictEqual(s.seq, 4);

  events.length = 0;
  spawned[0].emitData('x'.repeat(2500)); // >= maxChunk: flushed synchronously in 1024-unit chunks
  const big = events.filter((e) => e.ev === 'output');
  assert.deepStrictEqual(big.map((e) => e.x.seq), [4 + 1024, 4 + 2048, 4 + 2500]);
  assert.strictEqual(big.map((e) => e.x.data).join('').length, 2500);
});

test('attach replays the buffered range (delta or full) after flushing pending output', async () => {
  const { mgr, spawned, events } = setup({ replayBytes: 1024, maxChunk: 1024 });
  const s = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  spawned[0].emitData('hello\n');
  await sleep(15);
  spawned[0].emitData('x'); // still pending when we attach
  const r1 = mgr.attach(s.id, 'c_1', undefined);
  assert.deepStrictEqual(r1, { from: 0, seq: 7, chunks: [{ seq: 7, data: 'hello\nx' }] });
  assert.ok(events.some((e) => e.ev === 'output' && e.x.data === 'x'), 'pending output was flushed live before the ack');
  assert.strictEqual(s.clients.size, 1);

  const r2 = mgr.attach(s.id, 'c_2', 3);
  assert.deepStrictEqual(r2, { from: 3, seq: 7, chunks: [{ seq: 7, data: 'lo\nx' }] });
  const r3 = mgr.attach(s.id, 'c_3', 7);
  assert.deepStrictEqual(r3, { from: 7, seq: 7, chunks: [] });

  // Push the ring past its capacity: an old `since` now yields a full replay from base.
  for (let i = 0; i < 20; i++) spawned[0].emitData(`line ${i} ${'y'.repeat(100)}\n`);
  await sleep(15);
  const r4 = mgr.attach(s.id, 'c_4', 3);
  assert.ok(r4.from > 3, 'since is older than the buffer');
  assert.strictEqual(r4.from, s.ring.base);
  assert.strictEqual(r4.chunks.map((c) => c.data).join('').length, s.ring.size);
  assert.throws(() => mgr.attach('s_nope', 'c', 0), (e) => e.code === 'unknown_session');
});

test('input, resize, rename and detach', () => {
  const { mgr, spawned, events } = setup();
  const s = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  assert.strictEqual(s.write('ls\r'), true);
  assert.deepStrictEqual(spawned[0].written, ['ls\r']);
  assert.strictEqual(s.resize(80, 24), false);
  assert.strictEqual(s.resize(120, 40), true);
  assert.deepStrictEqual([spawned[0].cols, spawned[0].rows], [120, 40]);
  assert.deepStrictEqual(events.pop(), { ev: 'session.updated', id: s.id, x: { cols: 120, rows: 40 } });
  mgr.rename(s.id, 'Logs');
  assert.deepStrictEqual(events.pop(), { ev: 'session.updated', id: s.id, x: { title: 'Logs' } });
  mgr.attach(s.id, 'c_1'); mgr.attach(s.id, 'c_2');
  mgr.detach(s.id, 'c_1');
  assert.strictEqual(s.clients.size, 1);
  mgr.clientGone('c_2');
  assert.strictEqual(s.clients.size, 0);
});

test('exit keeps the session (with its output) until the retention sweep closes it', async () => {
  const { mgr, spawned, events, now } = setup({ exitedRetentionSec: 60 });
  const s = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  spawned[0].emitData('bye\n');
  spawned[0].emitExit(3);
  assert.strictEqual(s.state, 'exited');
  assert.strictEqual(s.exitCode, 3);
  assert.ok(events.some((e) => e.ev === 'output' && e.x.data === 'bye\n'), 'pending output flushed before exit');
  assert.ok(events.some((e) => e.ev === 'exit' && e.x === 3));
  assert.ok(events.some((e) => e.ev === 'session.updated' && e.x.state === 'exited' && e.x.exitCode === 3));
  assert.strictEqual(s.write('x'), false, 'no input after exit');
  assert.deepStrictEqual(mgr.attach(s.id, 'c_1').chunks[0].data, 'bye\n', 'output still readable');
  assert.strictEqual(mgr.list()[0].state, 'exited');

  now.t += 30_000; mgr.sweep();
  assert.strictEqual(mgr.sessions.size, 1, 'within retention');
  now.t += 31_000; mgr.sweep();
  assert.strictEqual(mgr.sessions.size, 0);
  assert.deepStrictEqual(events.pop(), { ev: 'session.closed', id: s.id, x: 'exited' });
});

test('detached idle sessions expire; attached or active ones do not', () => {
  const { mgr, spawned, events, now } = setup({ idleTimeoutSec: 100 });
  const idle = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  const attached = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  const busy = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  mgr.attach(attached.id, 'c_1');
  now.t += 99_000; mgr.sweep();
  assert.strictEqual(mgr.sessions.size, 3);
  now.t += 1_000;
  spawned[2].emitData('still working\n'); // activity resets the idle clock
  mgr.sweep();
  assert.strictEqual(mgr.sessions.size, 2);
  assert.ok(!mgr.has(idle.id));
  assert.ok(spawned[0].killed);
  assert.deepStrictEqual(events.filter((e) => e.ev === 'session.closed').map((e) => e.x), ['idle']);
  assert.ok(mgr.has(attached.id) && mgr.has(busy.id));
});

test('close kills the process once and ignores its late exit; closeAll on shutdown', () => {
  const { mgr, spawned, events } = setup();
  const a = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  mgr.create({ shell: 'sh', cols: 80, rows: 24 });
  mgr.close(a.id, 'closed');
  assert.ok(spawned[0].killed);
  assert.deepStrictEqual(events.filter((e) => e.ev === 'session.closed').map((e) => e.x), ['closed']);
  assert.ok(!events.some((e) => e.ev === 'exit'), 'exit after close is not reported as an exit');
  assert.throws(() => mgr.close(a.id), (e) => e.code === 'unknown_session');
  mgr.closeAll('shutdown');
  assert.strictEqual(mgr.sessions.size, 0);
  assert.ok(spawned[1].killed);
  mgr.pauseAll(); mgr.resumeAll(); // no sessions: no-ops
});
