'use strict';

/*
 * System metrics have to answer on Windows and on Linux, and say nothing
 * rather than guess when a platform cannot. The collector is injected with a
 * fake `os` / `fs` so both platforms can be exercised from either one.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const { Metrics, cpuTicks, meminfo, defaultDiskPath } = require('../lib/metrics');

/** Two cores whose ticks can be advanced by hand. */
function fakeCpus(idle, busy) {
  return [
    { times: { user: busy, nice: 0, sys: 0, irq: 0, idle } },
    { times: { user: busy, nice: 0, sys: 0, irq: 0, idle } },
  ];
}

function fakeOs({ cpus, total = 8 * 1024 ** 3, free = 2 * 1024 ** 3, uptime = 3600 }) {
  return { cpus: () => cpus(), totalmem: () => total, freemem: () => free, uptime: () => uptime };
}

const fakeStatfs = (over) => ({ statfsSync: () => Object.assign({ bsize: 4096, blocks: 1000, bfree: 250, bavail: 250 }, over) });

test('cpu load is the busy share between two samples', () => {
  let idle = 1000;
  let busy = 1000;
  let clock = 0;
  const m = new Metrics({
    platform: 'linux',
    osImpl: fakeOs({ cpus: () => fakeCpus(idle, busy) }),
    fsImpl: fakeStatfs(),
    readMeminfo: () => { throw new Error('no /proc here'); },
    now: () => clock,
  });
  // 300 idle ticks against 100 busy ticks per core: 25% busy.
  clock += 1000;
  idle += 300;
  busy += 100;
  assert.strictEqual(m.cpuLoad(), 0.25);
});

test('cpu load says nothing until the window is wide enough', () => {
  let clock = 0;
  // An idle machine: only the idle counter moves, one tick per millisecond.
  const m = new Metrics({
    platform: 'win32',
    osImpl: fakeOs({ cpus: () => fakeCpus(1000 + clock, 1000) }),
    fsImpl: fakeStatfs(),
    now: () => clock,
  });
  clock += 10;
  assert.strictEqual(m.cpuLoad(), null, 'a 10ms window is noise, not load');
  clock += 5000;
  assert.strictEqual(m.cpuLoad(), 0, 'idle ticks only: nothing ran');
});

test('a stopped clock reports no load rather than a fabricated 0% or 100%', () => {
  let clock = 0;
  const m = new Metrics({
    platform: 'win32',
    osImpl: fakeOs({ cpus: () => fakeCpus(1000, 1000) }),
    fsImpl: fakeStatfs(),
    now: () => clock,
  });
  clock += 5000;
  assert.strictEqual(m.cpuLoad(), null, 'no ticks passed at all');
});

test('a suspended machine (ticks that went backwards) reports no load', () => {
  let ticks = 5000;
  let clock = 0;
  const m = new Metrics({
    platform: 'linux',
    osImpl: fakeOs({ cpus: () => fakeCpus(ticks, ticks) }),
    fsImpl: fakeStatfs(),
    readMeminfo: () => { throw new Error('none'); },
    now: () => clock,
  });
  clock += 1000;
  ticks = 10; // counters reset
  assert.strictEqual(m.cpuLoad(), null);
});

test('linux memory counts the page cache as available, not used', () => {
  const m = new Metrics({
    platform: 'linux',
    osImpl: fakeOs({ cpus: () => fakeCpus(1, 1), total: 8 * 1024 ** 3, free: 1024 ** 3 }),
    fsImpl: fakeStatfs(),
    readMeminfo: () => 'MemTotal:        4000000 kB\nMemFree:          100000 kB\nMemAvailable:    3000000 kB\n',
  });
  assert.deepStrictEqual(m.memory(), { total: 4000000 * 1024, used: 1000000 * 1024 });
});

test('linux falls back to os.freemem when /proc/meminfo cannot be read', () => {
  const m = new Metrics({
    platform: 'linux',
    osImpl: fakeOs({ cpus: () => fakeCpus(1, 1), total: 8 * 1024 ** 3, free: 2 * 1024 ** 3 }),
    fsImpl: fakeStatfs(),
    readMeminfo: () => { throw new Error('ENOENT'); },
  });
  assert.deepStrictEqual(m.memory(), { total: 8 * 1024 ** 3, used: 6 * 1024 ** 3 });
});

test('windows memory is total minus free (there is no MemAvailable)', () => {
  const m = new Metrics({
    platform: 'win32',
    osImpl: fakeOs({ cpus: () => fakeCpus(1, 1), total: 16 * 1024 ** 3, free: 4 * 1024 ** 3 }),
    fsImpl: fakeStatfs(),
    readMeminfo: () => { throw new Error('should not be read on win32'); },
  });
  assert.deepStrictEqual(m.memory(), { total: 16 * 1024 ** 3, used: 12 * 1024 ** 3 });
});

test('storage is used-of-total on the agent filesystem', () => {
  const m = new Metrics({ platform: 'linux', osImpl: fakeOs({ cpus: () => fakeCpus(1, 1) }), fsImpl: fakeStatfs(), readMeminfo: () => { throw new Error('none'); } });
  assert.deepStrictEqual(m.storage(), { total: 4096 * 1000, used: 4096 * 750 });
});

test('an unreadable disk is reported once and then left out', () => {
  const warnings = [];
  const m = new Metrics({
    platform: 'win32',
    osImpl: fakeOs({ cpus: () => fakeCpus(1, 1) }),
    fsImpl: { statfsSync: () => { throw new Error('EPERM'); } },
    log: { warn: (msg, f) => warnings.push([msg, f]) },
  });
  assert.strictEqual(m.storage(), null);
  assert.strictEqual(m.storage(), null);
  assert.strictEqual(warnings.length, 1, 'one warning, not one per sample');
  assert.ok(!('storageTotal' in m.sample()));
});

test('a sample omits what it cannot answer instead of sending nulls', () => {
  let clock = 0;
  const m = new Metrics({
    platform: 'win32',
    osImpl: fakeOs({ cpus: () => fakeCpus(1000 + clock, 1000), uptime: 7200 }),
    fsImpl: { /* no statfsSync at all */ },
    now: () => clock,
  });
  const first = m.sample();
  assert.deepStrictEqual(Object.keys(first).sort(), ['memoryTotal', 'memoryUsed', 'uptimeSec']);
  assert.strictEqual(first.uptimeSec, 7200);
  clock += 5000;
  assert.strictEqual(m.sample().cpuLoad, 0, 'the second sample has a window to measure');
});

test('the disk path is the root of the drive the agent runs from', () => {
  assert.strictEqual(defaultDiskPath('linux', '/opt/remote-terminal'), '/');
  assert.strictEqual(defaultDiskPath('darwin', '/Users/x'), '/');
  if (process.platform === 'win32') {
    assert.strictEqual(defaultDiskPath('win32', 'D:\\apps\\agent'), 'D:\\');
  }
});

test('meminfo ignores a truncated or foreign /proc/meminfo', () => {
  assert.strictEqual(meminfo(() => 'MemTotal:        4000000 kB\n'), null, 'no MemAvailable');
  assert.strictEqual(meminfo(() => 'nonsense'), null);
  assert.strictEqual(meminfo(() => { throw new Error('ENOENT'); }), null);
});

test('this machine reports real numbers, whichever platform it is', () => {
  const m = new Metrics({});
  const ticks = cpuTicks(os.cpus());
  assert.ok(ticks.total > 0 && ticks.idle >= 0);

  const sample = m.sample();
  assert.ok(sample.memoryTotal > 0 && sample.memoryUsed >= 0 && sample.memoryUsed <= sample.memoryTotal);
  assert.ok(sample.uptimeSec >= 0);
  // statfs has covered Windows since Node 18.15, so a supported agent host
  // answers here whether it is Ubuntu or Windows.
  if (typeof fs.statfsSync === 'function') {
    assert.ok(sample.storageTotal > 0, 'the agent filesystem should report a size');
    assert.ok(sample.storageUsed <= sample.storageTotal);
  }
});
