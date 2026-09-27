'use strict';

/*
 * The process manager: parsing each platform's answer, CPU as a delta, and
 * the rule that matters — a LocalSystem agent ends only its user's processes.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { ProcessService, parseStat, parseWindows, sameWindowsUser, sampleLinux } = require('../lib/procs');

const code = (c) => (err) => { assert.strictEqual(err.code, c, err.message); return true; };

function fakeSamples(list) {
  let i = 0;
  return () => new Map(list[Math.min(i++, list.length - 1)].map((p) => [p.pid, p]));
}

test('parses /proc/<pid>/stat even when the name has spaces and parentheses', () => {
  const s = parseStat('1234 (my (weird) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0 100 1000000 321 18446744073709551615');
  assert.strictEqual(s.name, 'my (weird) proc');
  assert.strictEqual(s.ppid, 1);
  assert.strictEqual(s.cpuTicks, 300);
  assert.strictEqual(s.rssPages, 321);
});

test('parses the Windows listing, tolerating blanks and decimal commas', () => {
  const m = parseWindows('4\tSystem\t\t4096\t\r\n1200\tnode\t12,5\t104857600\tOFFICE\\ann\r\ngarbage\r\n');
  assert.deepStrictEqual([...m.keys()], [4, 1200]);
  assert.strictEqual(m.get(4).cpuSec, 0);
  assert.strictEqual(m.get(1200).cpuSec, 12.5);
  assert.strictEqual(m.get(1200).user, 'OFFICE\\ann');
  assert.strictEqual(m.get(1200).mem, 104857600);
});

test('reads a fake /proc tree', () => {
  const files = {
    '/etc/passwd': 'root:x:0:0::/root:/bin/bash\nann:x:1000:1000::/home/ann:/bin/bash\n',
    '/proc/7/stat': '7 (bash) S 1 7 7 0 -1 0 0 0 0 0 100 100 0 0 20 0 1 0 1 1 10 0',
    '/proc/7/status': 'Name:\tbash\nUid:\t1000\t1000\t1000\t1000\n',
    '/proc/7/cmdline': 'bash\0-l\0',
  };
  const fsImpl = {
    readdirSync: () => ['7', 'self', 'meminfo'],
    readFileSync: (p) => { if (p in files) return files[p]; const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
  };
  const m = sampleLinux({ fsImpl });
  assert.deepStrictEqual(m.get(7), { pid: 7, ppid: 1, name: 'bash', user: 'ann', cpuSec: 2, mem: 40960, cmd: 'bash -l' });
});

test('CPU is the share of the whole machine between two samples, busiest first', async () => {
  let t = 0;
  const svc = new ProcessService({
    platform: 'linux', cpus: 2, now: () => t, sleep: async (ms) => { t += ms; },
    sample: fakeSamples([
      [{ pid: 1, name: 'a', cpuSec: 10, mem: 5 }, { pid: 2, name: 'b', cpuSec: 0, mem: 50 }],
      [{ pid: 1, name: 'a', cpuSec: 10.2, mem: 5 }, { pid: 2, name: 'b', cpuSec: 0.8, mem: 50 }, { pid: 3, name: 'new', cpuSec: 1, mem: 1 }],
    ]),
  });
  const r = await svc.list();
  assert.deepStrictEqual(r.processes.map((p) => p.pid), [2, 1, 3]);
  assert.strictEqual(r.processes[0].cpu, 1); // 0.8 s of CPU in 0.4 s on 2 cores
  assert.ok(Math.abs(r.processes[1].cpu - 0.25) < 1e-9);
  assert.strictEqual(r.processes[2].cpu, null, 'no baseline for a process that just started');
  assert.strictEqual(r.killable, 'all');
  assert.strictEqual(r.total, 3);
});

test('a warm sample is reused as the baseline; a stale one is not', async () => {
  let t = 0;
  let calls = 0;
  const svc = new ProcessService({ platform: 'linux', cpus: 1, now: () => t, sleep: async (ms) => { t += ms; }, sample: () => { calls++; return new Map(); } });
  await svc.list();
  assert.strictEqual(calls, 2, 'cold start: two samples');
  t += 5000; await svc.list();
  assert.strictEqual(calls, 3, 'warm: one sample');
  t += 120_000; await svc.list();
  assert.strictEqual(calls, 5, 'stale: two again');
});

test('kill maps errors, refuses the agent itself, and can be turned off', async () => {
  const killed = [];
  const fail = (c) => { const e = new Error('x'); e.code = c; throw e; };
  const svc = new ProcessService({
    platform: 'linux', selfPids: [99], sample: () => new Map(),
    kill: (pid, sig) => { if (pid === 404) fail('ESRCH'); if (pid === 403) fail('EPERM'); killed.push([pid, sig]); },
  });
  assert.deepStrictEqual(await svc.kill({ pid: 10 }), { pid: 10, signal: 'SIGTERM' });
  await svc.kill({ pid: 11, force: true });
  assert.deepStrictEqual(killed, [[10, 'SIGTERM'], [11, 'SIGKILL']]);
  await assert.rejects(svc.kill({ pid: 404 }), code('not_found'));
  await assert.rejects(svc.kill({ pid: 403 }), code('forbidden'));
  await assert.rejects(svc.kill({ pid: 99 }), code('forbidden'));
  await assert.rejects(svc.kill({ pid: 'x' }), code('bad_request'));
  const off = new ProcessService({ platform: 'linux', allowKill: false, sample: () => new Map(), sleep: async () => {} });
  await assert.rejects(off.kill({ pid: 10 }), code('forbidden'));
  assert.strictEqual((await off.list()).killable, 'none');
});

test('a LocalSystem agent ends only the signed-in user\'s processes', async () => {
  const killed = [];
  let owner = 'OFFICE\\ann';
  const svc = new ProcessService({
    platform: 'win32', restricted: true, owner: () => owner, selfPids: [],
    sample: fakeSamples([[
      { pid: 100, name: 'code', user: 'OFFICE\\Ann', cpuSec: 0, mem: 1 },
      { pid: 200, name: 'lsass', user: 'NT AUTHORITY\\SYSTEM', cpuSec: 0, mem: 1 },
      { pid: 300, name: 'x', user: '', cpuSec: 0, mem: 1 },
    ]]),
    kill: (pid) => killed.push(pid), sleep: async () => {},
  });
  await svc.kill({ pid: 100 });
  await assert.rejects(svc.kill({ pid: 200 }), code('forbidden'));
  await assert.rejects(svc.kill({ pid: 300 }), code('forbidden'));
  await assert.rejects(svc.kill({ pid: 4 }), code('forbidden'));
  await assert.rejects(svc.kill({ pid: 555 }), code('not_found'));
  owner = null;
  await assert.rejects(svc.kill({ pid: 100 }), code('forbidden'));
  assert.deepStrictEqual(killed, [100]);
  assert.strictEqual((await svc.list()).killable, 'own');
});

test('Windows user names match with or without the domain, in any case', () => {
  assert.ok(sameWindowsUser('OFFICE\\ann', 'office\\ANN'));
  assert.ok(sameWindowsUser('OFFICE\\ann', 'ann'));
  assert.ok(!sameWindowsUser('OFFICE\\ann', 'OFFICE\\annabel'));
  assert.ok(!sameWindowsUser('', 'ann'));
});
