'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore, restoreSessions, runWhenReady, banner, MAX_RERUNS } = require('../lib/restore');
const { SessionManager, RESTORE_SETTLE_MS } = require('../lib/sessions');
const { makeLogger } = require('../lib/log');
const { makeFakeSpawn, SHELLS, testConfig, sleep } = require('./fake-pty');

const log = makeLogger('silent');

function tempFile(name = 'sessions.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-restore-'));
  return { dir, file: path.join(dir, name) };
}

function setup(over, records, clock) {
  const { dir, file } = tempFile();
  const { spawn, spawned } = makeFakeSpawn();
  const now = clock || { t: 1_760_000_000_000 };
  const cfg = testConfig(Object.assign({ restoreSessions: true, restoreCommands: true, restoreMaxAgeSec: 3600, sessionsFile: file }, over));
  const mgr = new SessionManager({ cfg, log, shells: SHELLS, spawn, now: () => now.t, cwd: '/home/u' });
  const store = new SessionStore({ file, log, now: () => now.t, debounceMs: 5 });
  if (records) store.write(records);
  const started = [];
  const result = restoreSessions({
    sessions: mgr, store, cfg, log, env: {}, now: () => now.t,
    ready: (session, command) => started.push({ id: session.id, command }),
  });
  return { mgr, spawned, store, cfg, file, dir, result, started, now };
}

/* --------------------------------- store ---------------------------------- */

test('the store survives a round trip, and shrugs off a file that is not JSON', () => {
  const { file, dir } = tempFile();
  const store = new SessionStore({ file, log });
  assert.deepStrictEqual(store.load(), { savedAt: 0, sessions: [] }, 'no file yet');

  store.write([{ id: 's_one', title: 'API', cwd: '/srv' }]);
  const back = store.load();
  assert.strictEqual(back.sessions.length, 1);
  assert.strictEqual(back.sessions[0].cwd, '/srv');
  assert.ok(back.savedAt > 0);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp file left behind');

  fs.writeFileSync(file, '{ this is not json');
  assert.deepStrictEqual(store.load().sessions, [], 'unreadable is treated as empty');
});

test('writes are debounced, flushed on demand, and stop when the agent is shutting down', async () => {
  const { file } = tempFile();
  const store = new SessionStore({ file, log, debounceMs: 10 });
  store.schedule([{ id: 's_a' }]);
  store.schedule([{ id: 's_a' }, { id: 's_b' }]);
  assert.deepStrictEqual(store.load().sessions, [], 'nothing written yet');
  await sleep(30);
  assert.strictEqual(store.load().sessions.length, 2, 'the last snapshot won');

  store.flush([{ id: 's_c' }]);
  assert.strictEqual(store.load().sessions[0].id, 's_c');

  store.stop();
  store.write([{ id: 's_d' }]);
  store.schedule([{ id: 's_d' }]);
  await sleep(20);
  assert.strictEqual(store.load().sessions[0].id, 's_c', 'a stopped store writes nothing');
});

/* -------------------------------- restoring -------------------------------- */

test('restored terminals keep their id, name, shell and directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cwd-'));
  const { mgr, spawned, result, started } = setup({}, [
    { id: 's_keepthisidplease', title: 'API logs', shell: 'sh', cwd: dir, cols: 120, rows: 35, command: 'tail -f log' },
  ]);
  assert.deepStrictEqual(result, { restored: 1, rerun: 1, skipped: 0 });
  const s = mgr.get('s_keepthisidplease');
  assert.strictEqual(s.title, 'API logs');
  assert.strictEqual(s.shell.id, 'sh');
  assert.strictEqual(s.cwd, dir);
  assert.strictEqual(s.restored, true);
  assert.strictEqual(s.command, 'tail -f log');
  assert.deepStrictEqual([spawned[0].opts.cwd, spawned[0].cols, spawned[0].rows], [dir, 120, 35]);
  assert.deepStrictEqual(started, [{ id: 's_keepthisidplease', command: 'tail -f log' }]);
  assert.strictEqual(s.info().restored, true);
  assert.match(s.ring.buf, /terminal restored/, 'the scrollback says what happened');
  assert.match(s.ring.buf, /re-running: tail -f log/);
});

test('a directory that is gone starts the shell at home and says so', () => {
  const { mgr, spawned, result } = setup({}, [
    { id: 's_goneplaceaaaaaaaaaa', title: 'Deploy', shell: 'bash', cwd: '/definitely/not/here', cols: 80, rows: 24, command: '' },
  ]);
  assert.strictEqual(result.restored, 1);
  assert.strictEqual(spawned[0].opts.cwd, '/home/u');
  assert.match(mgr.get('s_goneplaceaaaaaaaaaa').ring.buf, /folder is gone/);
});

test('an unknown shell falls back to the default one rather than losing the terminal', () => {
  const { mgr, result } = setup({}, [
    { id: 's_oldshellaaaaaaaaaaa', title: 'Zsh', shell: 'zsh', cwd: '', cols: 80, rows: 24 },
  ]);
  assert.strictEqual(result.restored, 1);
  assert.strictEqual(mgr.get('s_oldshellaaaaaaaaaaa').shell.id, 'bash');
});

test('records that are too old, or past the session cap, are left alone', () => {
  const now = { t: 1_760_000_000_000 };
  const store = (() => {
    const { file } = tempFile();
    const s = new SessionStore({ file, log, now: () => now.t - 10 * 3600 * 1000 });
    s.write([{ id: 's_staleaaaaaaaaaaaaaa', title: 'Old', shell: 'bash' }]);
    return s;
  })();
  const cfg = testConfig({ restoreSessions: true, restoreCommands: true, restoreMaxAgeSec: 3600 });
  const { spawn } = makeFakeSpawn();
  const mgr = new SessionManager({ cfg, log, shells: SHELLS, spawn, now: () => now.t });
  const stale = restoreSessions({ sessions: mgr, store, cfg, log, env: {}, now: () => now.t });
  assert.deepStrictEqual(stale, { restored: 0, rerun: 0, skipped: 1 });
  assert.strictEqual(mgr.sessions.size, 0);

  const many = setup({ maxSessions: 2 }, [
    { id: 's_oneaaaaaaaaaaaaaaaa', shell: 'bash' },
    { id: 's_twoaaaaaaaaaaaaaaaa', shell: 'bash' },
    { id: 's_threeaaaaaaaaaaaaaa', shell: 'bash' },
  ]);
  assert.deepStrictEqual(many.result, { restored: 2, rerun: 0, skipped: 1 });
});

test('a crash loop stops re-running the command, but still brings the terminal back', () => {
  // Two restarts have already failed to settle: the third does not try again.
  const { mgr, result, started } = setup({}, [
    { id: 's_loopingaaaaaaaaaaaa', title: 'Boom', shell: 'bash', command: 'make crash', restoreCount: MAX_RERUNS },
  ]);
  assert.deepStrictEqual(result, { restored: 1, rerun: 0, skipped: 0 });
  assert.deepStrictEqual(started, []);
  assert.strictEqual(mgr.get('s_loopingaaaaaaaaaaaa').restoreCount, MAX_RERUNS + 1);
  assert.match(mgr.get('s_loopingaaaaaaaaaaaa').ring.buf, /not re-running/);

  // One failed restart is not a loop yet.
  const once = setup({}, [{ id: 's_onceaaaaaaaaaaaaaaa', shell: 'bash', command: 'npm start', restoreCount: 1 }]);
  assert.deepStrictEqual(once.started, [{ id: 's_onceaaaaaaaaaaaaaaa', command: 'npm start' }]);
});

test('a terminal that stayed up clears its strikes, so an ordinary restart re-runs again', () => {
  const now = { t: 1_760_000_000_000 };
  const { spawn } = makeFakeSpawn();
  const cfg = testConfig({ restoreSessions: true, restoreCommands: true, restoreMaxAgeSec: 3600 });
  const mgr = new SessionManager({ cfg, log, shells: SHELLS, spawn, now: () => now.t, cwd: '/home/u' });
  const s = mgr.create({ shell: 'bash', cols: 80, rows: 24, restored: true, command: 'npm start' });
  s.restoreCount = 3;
  assert.strictEqual(mgr.snapshot()[0].restoreCount, 3, 'still fresh: the strikes stand');
  now.t += RESTORE_SETTLE_MS;
  assert.strictEqual(mgr.snapshot()[0].restoreCount, 0, 'it settled: the next restart starts clean');
});

test('recovery can be switched off entirely, and so can re-running commands', () => {
  const off = setup({ restoreSessions: false }, [{ id: 's_offaaaaaaaaaaaaaaaa', shell: 'bash', command: 'ls' }]);
  assert.deepStrictEqual(off.result, { restored: 0, rerun: 0, skipped: 0 });
  assert.strictEqual(off.mgr.sessions.size, 0);
  assert.strictEqual(fs.existsSync(off.file), false, 'the file is forgotten too');

  const quiet = setup({ restoreCommands: false }, [{ id: 's_quietaaaaaaaaaaaaaa', shell: 'bash', command: 'ls' }]);
  assert.deepStrictEqual(quiet.result, { restored: 1, rerun: 0, skipped: 0 });
  assert.deepStrictEqual(quiet.started, []);
  assert.strictEqual(quiet.mgr.get('s_quietaaaaaaaaaaaaaa').command, 'ls', 'still remembered, just not run');
});

/* ------------------------------ run when ready ----------------------------- */

test('the command waits for the shell to say something, then goes in once', async () => {
  const { spawn, spawned } = makeFakeSpawn();
  const mgr = new SessionManager({ cfg: testConfig(), log, shells: SHELLS, spawn });
  const s = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  runWhenReady(s, 'npm start', { delayMs: 5, maxWaitMs: 500 });
  assert.deepStrictEqual(spawned[0].written, [], 'nothing before the prompt');
  spawned[0].emitData('$ ');
  await sleep(40);
  assert.deepStrictEqual(spawned[0].written, ['npm start\r']);
  spawned[0].emitData('more output');
  await sleep(20);
  assert.strictEqual(spawned[0].written.length, 1, 'only ever once');
});

test('a silent shell gets the command anyway, and a dead one never does', async () => {
  const { spawn, spawned } = makeFakeSpawn();
  const mgr = new SessionManager({ cfg: testConfig(), log, shells: SHELLS, spawn });
  const quiet = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  runWhenReady(quiet, 'echo hi', { delayMs: 5, maxWaitMs: 20 });
  await sleep(50);
  assert.deepStrictEqual(spawned[0].written, ['echo hi\r']);

  const dead = mgr.create({ shell: 'bash', cols: 80, rows: 24 });
  runWhenReady(dead, 'echo hi', { delayMs: 5, maxWaitMs: 20 });
  dead.close('closed');
  await sleep(50);
  assert.deepStrictEqual(spawned[1].written, [], 'a closed session is not typed into');
});

test('the banner explains each case in one line', () => {
  assert.match(banner({ cwd: '/srv/api', command: 'tail -f x', rerun: true }), /\[terminal restored · \/srv\/api · re-running: tail -f x\]/);
  assert.match(banner({ cwd: '', missing: true }), /folder is gone/);
  assert.match(banner({ cwd: '/srv', command: 'x', looping: true }), /not re-running "x"/);
});
