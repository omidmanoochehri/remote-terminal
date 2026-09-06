'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const control = require('../lib/control');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * On Windows the control channel is a named pipe, so two test servers would
 * collide on one machine; give each test its own pipe/socket name.
 */
let seq = 0;
function fixture() {
  return {
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ctl-')),
    pipeName: `remote-terminal-test-${process.pid}-${seq++}`,
  };
}

test('status is public, privileged commands need the key', async () => {
  const { dir, pipeName } = fixture();
  const server = control.createControlServer({
    dataDir: dir,
    pipeName,
    log: quiet,
    handlers: {
      ping: () => ({ pid: 42 }),
      status: () => ({ connected: true, sessions: 2 }),
      pair: () => ({ code: '123456' }),
    },
  });
  await server.start();
  try {
    const status = await control.request(dir, 'status', {}, { pipeName });
    assert.deepStrictEqual(status, { ok: true, connected: true, sessions: 2 });

    const denied = await control.request(dir, 'pair', {}, { pipeName });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.needsKey, true, 'a pairing code is a credential, so it is gated');

    const wrong = await control.request(dir, 'pair', { key: 'x'.repeat(48) }, { pipeName });
    assert.strictEqual(wrong.ok, false, 'a wrong key of the right length is still refused');

    const allowed = await control.request(dir, 'pair', { key: control.readKey(dir) }, { pipeName });
    assert.deepStrictEqual(allowed, { ok: true, code: '123456' });

    const unknown = await control.request(dir, 'sudo-make-me-a-sandwich', {}, { pipeName });
    assert.match(unknown.error, /unknown command/);
  } finally {
    server.stop();
  }
});

test('shutdown is gated but reconnect is not', async () => {
  const { dir, pipeName } = fixture();
  const called = [];
  const server = control.createControlServer({
    dataDir: dir,
    pipeName,
    log: quiet,
    handlers: {
      shutdown: () => { called.push('shutdown'); return { stopping: true }; },
      reconnect: () => { called.push('reconnect'); return { reconnecting: true }; },
    },
  });
  await server.start();
  try {
    // Anyone on the machine could otherwise take it off the air.
    const denied = await control.request(dir, 'shutdown', {}, { pipeName });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.needsKey, true);
    assert.deepStrictEqual(called, [], 'a refused command must not reach its handler');

    const allowed = await control.request(dir, 'shutdown', { key: control.readKey(dir) }, { pipeName });
    assert.deepStrictEqual(allowed, { ok: true, stopping: true });

    // Open on purpose: idempotent, and what a non-administrator's tray needs.
    const reconnect = await control.request(dir, 'reconnect', {}, { pipeName });
    assert.deepStrictEqual(reconnect, { ok: true, reconnecting: true });
    assert.deepStrictEqual(called, ['shutdown', 'reconnect']);
  } finally {
    server.stop();
  }
});

test('the key file is created once, is 0600, and survives a restart', () => {
  const { dir } = fixture();
  const first = control.ensureKey(dir);
  assert.ok(first.length >= 32);
  assert.strictEqual(control.ensureKey(dir), first, 'a restart keeps the key so the tray stays paired');
  assert.strictEqual(control.readKey(dir), first);
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(control.keyPath(dir)).mode & 0o777, 0o600);
  }
});

test('readKey returns null when the caller may not read it', () => {
  const { dir } = fixture();
  assert.strictEqual(control.readKey(dir), null, 'no key file yet -> no key, not a crash');
});

test('ping resolves to null when no agent is listening', async () => {
  const { dir, pipeName } = fixture();
  assert.strictEqual(await control.ping(dir, { pipeName }), null);
});

test('a second agent is refused while the first is alive', async () => {
  const { dir, pipeName } = fixture();
  const first = control.createControlServer({ dataDir: dir, pipeName, log: quiet, handlers: { ping: () => ({ pid: 7 }) } });
  await first.start();
  const second = control.createControlServer({ dataDir: dir, pipeName, log: quiet, handlers: { ping: () => ({ pid: 8 }) } });
  try {
    await assert.rejects(() => second.start(), (err) => err.code === 'ERUNNING' && err.pid === 7);
  } finally {
    second.stop();
    first.stop();
  }
});

test('an address held by something that will not answer fails fast', async () => {
  const { dir, pipeName } = fixture();
  // A server on the address that never replies — which is what a live agent
  // under another account looks like on Windows, where the pipe cannot be
  // opened at all. The old code retried listen() forever and the agent hung
  // silently, holding the process open with nothing running in it.
  const accepted = [];
  const squatter = net.createServer((conn) => accepted.push(conn)); // accept, say nothing
  await new Promise((resolve) => squatter.listen(control.controlPath(dir, pipeName), resolve));

  const server = control.createControlServer({ dataDir: dir, pipeName, log: quiet, handlers: {} });
  try {
    const started = Date.now();
    await assert.rejects(() => server.start(), (err) => err.code === 'ERUNNING');
    assert.ok(Date.now() - started < 8000, 'it gives up rather than retrying for ever');
  } finally {
    server.stop();
    for (const conn of accepted) conn.destroy(); // close() waits for these
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test('a stale socket left by a killed agent is taken over', { skip: process.platform === 'win32' }, async () => {
  const { dir, pipeName } = fixture();
  fs.mkdirSync(dir, { recursive: true });
  // What a `kill -9` leaves behind: a socket file with nothing behind it.
  fs.writeFileSync(path.join(dir, 'agent.sock'), '');
  const server = control.createControlServer({ dataDir: dir, pipeName, log: quiet, handlers: { ping: () => ({ pid: 9 }) } });
  try {
    await server.start();
    assert.deepStrictEqual(await control.ping(dir, { pipeName }), { ok: true, pid: 9 });
  } finally {
    server.stop();
  }
});

test('a handler that throws answers with the error instead of dying', async () => {
  const { dir, pipeName } = fixture();
  const server = control.createControlServer({
    dataDir: dir, pipeName, log: quiet,
    handlers: { status: () => { throw new Error('relay is unreachable'); } },
  });
  await server.start();
  try {
    const r = await control.request(dir, 'status', {}, { pipeName });
    assert.deepStrictEqual(r, { ok: false, error: 'relay is unreachable' });
    assert.strictEqual((await control.request(dir, 'status', {}, { pipeName })).ok, false, 'the server is still up afterwards');
  } finally {
    server.stop();
  }
});
