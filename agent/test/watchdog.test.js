'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createWatchdog, underSystemd, underWindowsService, supervised } = require('../lib/watchdog');

function recorder() {
  const lines = [];
  const push = (level) => (msg, fields) => lines.push(Object.assign({ level, msg }, fields));
  return { lines, error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') };
}

/** Drive the clock by hand: the watchdog only ever asks `now()` for the time. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a healthy loop logs a heartbeat and never fires the stall handler', () => {
  const log = recorder();
  const time = clock();
  let stalls = 0;
  const wd = createWatchdog({
    log, intervalMs: 1000, now: time.now, onStall: () => { stalls++; },
    snapshot: () => ({ connected: true, sessions: 3 }),
  });
  for (let i = 0; i < 12; i++) { time.advance(1010); wd.tick(); }

  assert.strictEqual(stalls, 0);
  assert.strictEqual(log.lines.filter((l) => l.level === 'warn').length, 0, 'a 10ms jitter is not a stall');
  const beats = log.lines.filter((l) => l.msg === 'heartbeat');
  assert.strictEqual(beats.length, 2, 'one heartbeat per six checks');
  assert.strictEqual(beats[0].connected, true);
  assert.strictEqual(beats[0].sessions, 3);
  assert.ok(Number.isFinite(beats[0].rssMb) && Number.isFinite(beats[0].uptimeSec));
});

test('the stall handler fires only after consecutive bad checks', () => {
  const log = recorder();
  const time = clock();
  const stalls = [];
  const wd = createWatchdog({ log, intervalMs: 1000, failures: 3, now: time.now, onStall: (lag) => stalls.push(lag) });

  time.advance(60000); wd.tick();                     // strike 1
  time.advance(60000); wd.tick();                     // strike 2
  assert.strictEqual(stalls.length, 0, 'transient lag alone must not restart a working agent');
  time.advance(60000); wd.tick();                     // strike 3
  assert.strictEqual(stalls.length, 1);
  assert.ok(stalls[0] > 50000);

  time.advance(60000); wd.tick();
  assert.strictEqual(stalls.length, 1, 'the handler fires once, not once per late tick');
  assert.strictEqual(log.lines.filter((l) => l.level === 'error').length, 1);
});

test('a recovered loop resets the strike count', () => {
  const log = recorder();
  const time = clock();
  let stalls = 0;
  const wd = createWatchdog({ log, intervalMs: 1000, failures: 3, now: time.now, onStall: () => { stalls++; } });

  time.advance(60000); wd.tick();
  time.advance(60000); wd.tick();
  time.advance(1000); wd.tick();                      // recovered
  time.advance(60000); wd.tick();
  time.advance(60000); wd.tick();
  assert.strictEqual(stalls, 0, 'two strikes, a recovery, two strikes is not a wedge');
});

test('start/stop are idempotent and the timer does not hold the process open', () => {
  const wd = createWatchdog({ log: recorder(), intervalMs: 50000 });
  wd.start();
  wd.start();
  wd.stop();
  wd.stop();
});

test('supervisor detection reads the environment the supervisors actually set', () => {
  const linux = process.platform === 'linux';
  const windows = process.platform === 'win32';
  assert.strictEqual(underSystemd({ INVOCATION_ID: 'abc' }), linux);
  assert.strictEqual(underSystemd({ JOURNAL_STREAM: '8:123' }), linux);
  assert.strictEqual(underSystemd({}), false);
  assert.strictEqual(underWindowsService({ RT_SUPERVISED: '1' }), windows);
  assert.strictEqual(underWindowsService({}), false);
  assert.strictEqual(supervised({}), false, 'a hand-started agent must not exit itself: nothing would restart it');
});
