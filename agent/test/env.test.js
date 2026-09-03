'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildEnv } = require('../lib/env');

test('posix shells get the allowlist, locale family and TERM, never secrets', () => {
  const source = { PATH: '/usr/bin', HOME: '/home/u', USER: 'u', LC_ALL: 'en_US.UTF-8', AWS_SECRET_ACCESS_KEY: 'x', ENROLL_TOKEN: 'y', NPM_TOKEN: 'z' };
  const env = buildEnv({ platform: 'linux', source });
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.HOME, '/home/u');
  assert.strictEqual(env.LC_ALL, 'en_US.UTF-8');
  assert.strictEqual(env.TERM, 'xterm-256color');
  assert.strictEqual(env.COLORTERM, 'truecolor');
  assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.strictEqual(env.ENROLL_TOKEN, undefined);
  assert.strictEqual(env.NPM_TOKEN, undefined);
  assert.strictEqual(env.LANG, undefined, 'LC_ALL present: no synthetic LANG');
  const noLocale = buildEnv({ platform: 'linux', source: { PATH: '/bin' } });
  assert.strictEqual(noLocale.LANG, 'C.UTF-8');
});

test('windows shells get the case-insensitive allowlist only', () => {
  const source = { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 'x', ProgramFiles: 'C:\\Program Files' };
  const env = buildEnv({ platform: 'win32', source });
  assert.strictEqual(env.Path, 'C:\\Windows');
  assert.strictEqual(env.USERPROFILE, 'C:\\Users\\u');
  assert.strictEqual(env.SystemRoot, 'C:\\Windows');
  assert.strictEqual(env.GITHUB_TOKEN, undefined);
  assert.strictEqual(env.ProgramFiles, 'C:\\Program Files');
  assert.strictEqual(env.TERM, 'xterm-256color');
});

test('INHERIT_ENV passes everything through (documented opt-out)', () => {
  const env = buildEnv({ platform: 'linux', source: { SECRET: 's', TERM: 'dumb' }, inherit: true });
  assert.strictEqual(env.SECRET, 's');
  assert.strictEqual(env.TERM, 'xterm-256color', 'TERM is still normalised');
});
