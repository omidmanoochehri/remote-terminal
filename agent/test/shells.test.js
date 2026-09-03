'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { discoverShells, findShell, advertise, parseWslList, which } = require('../lib/shells');

test('linux discovery reads /etc/shells, keeps existing binaries, prefers $SHELL', async () => {
  const present = new Set(['/bin/bash', '/bin/sh', '/usr/bin/zsh', '/bin/rbash']);
  const shells = await discoverShells({
    platform: 'linux',
    env: { SHELL: '/usr/bin/zsh' },
    exists: (p) => present.has(p),
    readFile: () => '# /etc/shells\n/bin/sh\n/bin/bash\n/bin/rbash\n/usr/bin/zsh\n/usr/bin/fish\n/bin/bash\n',
  });
  assert.deepStrictEqual(shells.map((s) => s.id), ['zsh', 'sh', 'bash', 'rbash']);
  assert.strictEqual(shells[0].default, true);
  assert.strictEqual(shells.filter((s) => s.default).length, 1);
  assert.strictEqual(shells.find((s) => s.id === 'bash').cmd, '/bin/bash');
  assert.ok(!shells.some((s) => s.id === 'fish'), 'missing binaries are dropped');
  assert.deepStrictEqual(advertise(shells)[0], { id: 'zsh', label: 'zsh', default: true });
  assert.strictEqual(JSON.stringify(advertise(shells)).includes('/usr/bin'), false, 'no command lines are advertised');
});

test('linux discovery falls back to bash when $SHELL is absent, DEFAULT_SHELL wins when present', async () => {
  const present = new Set(['/bin/bash', '/bin/sh']);
  const a = await discoverShells({ platform: 'linux', env: {}, exists: (p) => present.has(p), readFile: () => '/bin/sh\n/bin/bash\n' });
  assert.strictEqual(a[0].id, 'bash');
  const b = await discoverShells({ platform: 'linux', env: {}, defaultShell: 'sh', exists: (p) => present.has(p), readFile: () => '/bin/sh\n/bin/bash\n' });
  assert.strictEqual(b[0].id, 'sh');
  assert.strictEqual(findShell(b, undefined).id, 'sh');
  assert.strictEqual(findShell(b, 'bash').id, 'bash');
  assert.strictEqual(findShell(b, 'fish'), null);
});

test('windows discovery finds PowerShell, pwsh, cmd and WSL distributions', async () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' };
  const present = new Set([
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\wsl.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ]);
  const path = require('path');
  const norm = (p) => p.split(path.sep).join('\\');
  const exec = async (file) => (norm(file).endsWith('wsl.exe') ? Buffer.from('\uFEFFUbuntu-24.04\r\nDebian\r\n', 'utf16le') : null);
  const shells = await discoverShells({ platform: 'win32', env, exists: (p) => present.has(norm(p)), exec });
  assert.deepStrictEqual(shells.map((s) => s.id), ['pwsh', 'powershell', 'cmd', 'wsl-ubuntu-24.04', 'wsl-debian']);
  assert.strictEqual(shells[0].default, true);
  assert.strictEqual(shells[0].label, 'PowerShell 7');
  const wsl = shells.find((s) => s.id === 'wsl-debian');
  assert.deepStrictEqual(wsl.args, ['-d', 'Debian']);
  assert.strictEqual(wsl.label, 'Debian (WSL)');
});

test('parseWslList decodes UTF-16LE and tolerates UTF-8', () => {
  assert.deepStrictEqual(parseWslList(Buffer.from('Ubuntu\r\nkali-linux\r\n', 'utf16le')), ['Ubuntu', 'kali-linux']);
  assert.deepStrictEqual(parseWslList(Buffer.from('Ubuntu\n', 'utf8')), ['Ubuntu']);
  assert.deepStrictEqual(parseWslList(null), []);
});

test('configured shells replace discovery and invalid entries are ignored', async () => {
  const warnings = [];
  const shells = await discoverShells({
    platform: 'linux', env: {},
    configured: [
      { id: 'py', label: 'Python REPL', cmd: '/usr/bin/python3', args: ['-q'] },
      { id: 'bad id', cmd: '/bin/x' },
      { id: 'nocmd' },
      { id: 'bash', cmd: '/bin/bash' },
      { id: 'bash', cmd: '/bin/other' },
    ],
    defaultShell: 'py',
    warn: (m, f) => warnings.push(f),
  });
  assert.deepStrictEqual(shells.map((s) => s.id), ['py', 'bash']);
  assert.deepStrictEqual(shells[0].args, ['-q']);
  assert.strictEqual(shells[1].label, 'bash');
  assert.strictEqual(shells[1].cmd, '/bin/bash', 'first definition wins');
  assert.strictEqual(warnings.length, 2);
});

test('which resolves through PATH and PATHEXT', () => {
  const present = new Set(['/usr/bin/node', 'C:\\Tools\\pwsh.EXE']);
  assert.strictEqual(which('node', { platform: 'linux', env: { PATH: '/bin:/usr/bin' }, exists: (p) => present.has(p) }), '/usr/bin/node');
  assert.strictEqual(which('nope', { platform: 'linux', env: { PATH: '/bin' }, exists: (p) => present.has(p) }), null);
  const path = require('path');
  const norm = (p) => p.split(path.sep).join('\\');
  assert.strictEqual(norm(which('pwsh', { platform: 'win32', env: { PATH: 'C:\\Tools', PATHEXT: '.COM;.EXE' }, exists: (p) => present.has(norm(p)) })), 'C:\\Tools\\pwsh.EXE');
});
