'use strict';

/*
 * Real terminal tests (Linux/macOS with bash). They exercise node-pty and the
 * pipe fallback end-to-end and are skipped where a PTY backend or bash is
 * unavailable.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { spawnPty, ptyAvailable } = require('../lib/pty');
const { buildEnv } = require('../lib/env');

const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
const posix = process.platform !== 'win32';

function collect(term) {
  const out = { text: '' };
  term.onData((d) => { out.text += d; });
  out.waitFor = (needle, ms = 5000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (out.text.includes(needle)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(out.text.slice(-300))}`));
      setTimeout(tick, 25);
    };
    tick();
  });
  return out;
}

test('real PTY: bash echoes, reports its size after resize, and exits on kill', { skip: !(posix && BASH && ptyAvailable().available) && 'needs bash + node-pty' }, async () => {
  const term = spawnPty({ cmd: BASH, args: ['--norc', '--noprofile'], cwd: os.tmpdir(), env: buildEnv(), cols: 80, rows: 24 });
  assert.strictEqual(term.mode, 'pty');
  const out = collect(term);
  const exited = new Promise((r) => term.onExit(r));
  term.write('echo RT_OK_$((20+3))\r');
  await out.waitFor('RT_OK_23');
  term.resize(100, 30);
  term.write('stty size\r');
  await out.waitFor('30 100');
  term.write('printf "\\033[31mred\\033[0m\\n"\r');
  await out.waitFor('\x1b[31mred\x1b[0m');
  term.kill();
  const code = await exited;
  assert.strictEqual(typeof code, 'number');
});

test('pipe fallback still runs commands (no resize, no TTY)', { skip: !(posix && fs.existsSync('/bin/sh')) && 'needs /bin/sh' }, async () => {
  const term = spawnPty({ cmd: '/bin/sh', args: [], cwd: os.tmpdir(), env: buildEnv(), forcePipe: true });
  assert.strictEqual(term.mode, 'pipe');
  const out = collect(term);
  const exited = new Promise((r) => term.onExit(r));
  term.write('echo pipe_$((1+1))\n');
  await out.waitFor('pipe_2');
  term.write('exit 7\n');
  assert.strictEqual(await exited, 7);
});
