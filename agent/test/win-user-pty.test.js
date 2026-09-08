'use strict';

/*
 * The Windows shell launcher: framing, discovery, the decision, and — where
 * remote-terminal-shell.exe has actually been built — a real pseudoconsole.
 *
 * The live tests run the launcher with `--run-as self`, which is the hop it
 * takes when there is nobody to impersonate. Borrowing a signed-in user's
 * token needs LocalSystem, so that half is exercised by installing the
 * service, not by this file.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  chooseSpawner, spawnUserPty, findLauncher, underSystemProfile, statusLine, frameData, frameResize,
} = require('../lib/win-user-pty');

const WINDOWS = process.platform === 'win32';
const LAUNCHER = WINDOWS ? findLauncher() : null;
const CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

/* --------------------------------- framing -------------------------------- */

test('a data frame is a type byte, a little-endian length and the payload', () => {
  const frame = frameData('ls\r');
  assert.strictEqual(frame[0], 1);
  assert.strictEqual(frame.readUInt32LE(1), 3);
  assert.strictEqual(frame.subarray(5).toString('utf8'), 'ls\r');

  // A paste is measured in bytes, not characters — the Rust side reads bytes.
  const wide = frameData('héllo');
  assert.strictEqual(wide.readUInt32LE(1), Buffer.byteLength('héllo', 'utf8'));
  assert.strictEqual(wide.length, 5 + 6);

  assert.strictEqual(frameData('').readUInt32LE(1), 0);
});

test('a resize frame carries the geometry and clamps nonsense', () => {
  const frame = frameResize(120, 40);
  assert.strictEqual(frame[0], 2);
  assert.strictEqual(frame.readUInt16LE(1), 120);
  assert.strictEqual(frame.readUInt16LE(3), 40);
  assert.strictEqual(frame.length, 5);

  assert.strictEqual(frameResize(0, 0).readUInt16LE(1), 1);
  assert.strictEqual(frameResize(1e9, 1e9).readUInt16LE(1), 65535);
});

/* -------------------------------- discovery ------------------------------- */

test('the SYSTEM profile is recognised however Windows spells it', () => {
  assert.ok(underSystemProfile({ USERPROFILE: 'C:\\Windows\\system32\\config\\systemprofile' }));
  assert.ok(underSystemProfile({ USERPROFILE: 'C:\\WINDOWS\\SysWOW64\\config\\systemprofile' }));
  assert.ok(underSystemProfile({ USERNAME: 'SYSTEM' }));
  assert.ok(!underSystemProfile({ USERPROFILE: 'C:\\Users\\ann', USERNAME: 'ann' }));
  // A user who happens to have "systemprofile" inside their home is not SYSTEM.
  assert.ok(!underSystemProfile({ USERPROFILE: 'C:\\Users\\ann\\systemprofile\\docs' }));
  assert.ok(!underSystemProfile({}));
});

test('the launcher is looked for beside the agent, then in the cargo tree', () => {
  const seen = [];
  const found = findLauncher({ agentDir: 'C:\\agent', exists: (p) => { seen.push(p); return p.includes('target'); } });
  assert.strictEqual(found, path.join('C:\\agent', 'windows', 'target', 'release', 'remote-terminal-shell.exe'));
  assert.strictEqual(seen[0], path.join('C:\\agent', 'remote-terminal-shell.exe'));

  assert.strictEqual(findLauncher({ agentDir: 'C:\\agent', exists: () => false }), null);
  // An explicit path is the only one tried.
  assert.strictEqual(findLauncher({ configured: 'D:\\x.exe', exists: () => true }), 'D:\\x.exe');
});

test('a status line is picked out of whatever else is on stderr', () => {
  const text = 'npm notice\n{"launch":"remote-terminal-shell","ok":true,"user":"OFFICE\\\\ann"}\nlater noise\n';
  assert.strictEqual(statusLine(text).user, 'OFFICE\\ann');
  assert.strictEqual(statusLine('nothing here'), null);
  assert.strictEqual(statusLine('{"launch":"something-else","ok":true}'), null);
  assert.strictEqual(statusLine('{"launch":"remote-terminal-shell"'), null); // half a line
});

/* ------------------------------- the decision ------------------------------ */

const LAUNCHER_PATH = 'C:\\Program Files\\Remote Terminal Agent\\remote-terminal-shell.exe';
const fallback = () => ({ mode: 'pty' });
/** Pretend the launcher is (or is not) on disk, without needing one there. */
const finds = (found) => () => found;
const asSystem = { USERNAME: 'SYSTEM' };
const quietLog = () => {
  const warned = [];
  return { warned, log: { warn: (m, f) => warned.push({ m, f }), error: () => {}, info: () => {} } };
};

test('off Windows, and when told never, nothing changes', async () => {
  const linux = await chooseSpawner({ cfg: { runAsUser: 'auto', shellLauncher: '' }, fallback, platform: 'linux' });
  assert.strictEqual(linux.spawn, fallback);
  assert.strictEqual(linux.launcher, null);

  const never = await chooseSpawner({
    cfg: { runAsUser: 'never', shellLauncher: LAUNCHER_PATH }, fallback, platform: 'win32', env: asSystem,
    findWith: finds(LAUNCHER_PATH), probeWith: () => assert.fail('must not probe'),
  });
  assert.strictEqual(never.spawn, fallback);
});

test('an agent with a profile of its own is left alone', async () => {
  // "auto" is about rescuing SYSTEM shells. An agent a person started has a
  // perfectly good profile already, and a launcher per terminal would buy
  // nothing but a process.
  const chosen = await chooseSpawner({
    cfg: { runAsUser: 'auto', shellLauncher: LAUNCHER_PATH }, fallback, platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\ann', USERNAME: 'ann' },
    findWith: finds(LAUNCHER_PATH), probeWith: () => assert.fail('must not probe'),
  });
  assert.strictEqual(chosen.spawn, fallback);
  assert.strictEqual(chosen.launcher, null);
});

test('under SYSTEM with a launcher, terminals go to the signed-in user', async () => {
  const answer = { ok: true, as: 'user', user: 'OFFICE\\ann', cwd: 'C:\\Users\\ann', session: 2 };
  const chosen = await chooseSpawner({
    cfg: { runAsUser: 'auto', shellLauncher: LAUNCHER_PATH }, fallback, platform: 'win32', env: asSystem,
    findWith: finds(LAUNCHER_PATH), probeWith: async () => answer,
  });
  assert.notStrictEqual(chosen.spawn, fallback);
  assert.strictEqual(chosen.launcher, LAUNCHER_PATH);
  assert.match(chosen.how, /OFFICE\\ann/);
});

test('with nobody signed in, "auto" warns and carries on but "always" refuses', async () => {
  const { warned, log } = quietLog();
  const nobody = async () => ({ ok: false, error: 'no one is signed in' });
  const chosen = await chooseSpawner({
    cfg: { runAsUser: 'auto', shellLauncher: LAUNCHER_PATH }, fallback, platform: 'win32', log, env: asSystem,
    findWith: finds(LAUNCHER_PATH), probeWith: nobody,
  });
  // Still routed through the launcher: someone may sign in a minute from now,
  // and the decision is taken per terminal, not once at startup.
  assert.strictEqual(chosen.launcher, LAUNCHER_PATH);
  assert.strictEqual(warned.length, 1);

  await assert.rejects(
    chooseSpawner({
      cfg: { runAsUser: 'always', shellLauncher: LAUNCHER_PATH }, fallback, platform: 'win32', env: asSystem,
      findWith: finds(LAUNCHER_PATH), probeWith: nobody,
    }),
    /no one is signed in/,
  );
});

test('a missing launcher is a warning under "auto" and fatal under "always"', async () => {
  const { warned, log } = quietLog();
  const chosen = await chooseSpawner({
    cfg: { runAsUser: 'auto', shellLauncher: '' }, fallback, platform: 'win32', log, env: asSystem,
    findWith: finds(null), probeWith: () => assert.fail('nothing to probe'),
  });
  assert.strictEqual(chosen.spawn, fallback);
  assert.match(warned[0].m, /was not found/);

  await assert.rejects(
    chooseSpawner({
      cfg: { runAsUser: 'always', shellLauncher: '' }, fallback, platform: 'win32', env: asSystem,
      findWith: finds(null),
    }),
    /was not found/,
  );
});

/* ------------------------- a real pseudoconsole ---------------------------- */

const skipLive = !LAUNCHER && 'needs a built remote-terminal-shell.exe (cargo build in agent/windows)';

function collect(term) {
  const out = { text: '' };
  term.onData((d) => { out.text += d; });
  out.waitFor = (needle, ms = 20000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (out.text.includes(needle)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(out.text.slice(-400))}`));
      setTimeout(tick, 25);
    };
    tick();
  });
  return out;
}

test('the launcher hosts a real console: cmd echoes, resizes and exits', { skip: skipLive }, async () => {
  const term = spawnUserPty({
    launcher: LAUNCHER, runAs: 'self', cmd: CMD, args: [], cwd: os.tmpdir(),
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, cols: 80, rows: 24,
  });
  const out = collect(term);
  const exited = new Promise((r) => term.onExit(r));

  const ready = await new Promise((r) => term.onReady(r));
  assert.strictEqual(ready.ok, true);
  assert.strictEqual(ready.as, 'self');

  term.write('echo RT_OK_%TERM%\r');
  await out.waitFor('RT_OK_xterm-256color');

  // A real pseudoconsole is the point: a piped child would not know its width.
  term.resize(132, 43);
  term.write('mode con\r');
  await out.waitFor('132');

  term.write('exit\r');
  assert.strictEqual(await exited, 0);
});

test('the launcher passes the shell its exit code, and kill takes the tree down', { skip: skipLive }, async () => {
  const bad = spawnUserPty({ launcher: LAUNCHER, runAs: 'self', cmd: CMD, args: ['/c', 'exit 7'], cols: 80, rows: 24 });
  assert.strictEqual(await new Promise((r) => bad.onExit(r)), 7);

  const live = spawnUserPty({ launcher: LAUNCHER, runAs: 'self', cmd: CMD, args: [], cols: 80, rows: 24 });
  const out = collect(live);
  live.write('echo RT_ALIVE\r');
  await out.waitFor('RT_ALIVE');
  const gone = new Promise((r) => live.onExit(r));
  live.kill();
  await gone;
});

test('the launcher starts the shell where it was told to', { skip: skipLive }, async () => {
  // Under the service this is the whole point: the shell has to start in the
  // signed-in user's home, not wherever the agent happens to be.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-launch-'));
  try {
    const term = spawnUserPty({ launcher: LAUNCHER, runAs: 'self', cwd: dir, cmd: CMD, args: ['/c', 'cd'], cols: 80, rows: 24 });
    const out = collect(term);
    assert.strictEqual(await new Promise((r) => term.onExit(r)), 0);
    assert.ok(out.text.includes(fs.realpathSync.native(dir)), `expected ${dir} in ${JSON.stringify(out.text)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
