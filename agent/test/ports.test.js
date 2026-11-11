'use strict';

/*
 * Listening ports: the /proc/net and netstat parsers, socket → pid mapping,
 * and the service's ordering, de-duplication and cap.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  PortService, parseProcNet, decodeProcAddress, formatIPv6, sampleLinux, parseNetstat, parseTasklist, sampleWindows, finish,
} = require('../lib/ports');

const code = (c) => (err) => { assert.strictEqual(err.code, c, err.message); return true; };

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const row = (sl, local, remote, st, inode) =>
  `   ${sl}: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

test('decodes /proc/net addresses in kernel byte order', () => {
  assert.deepStrictEqual(decodeProcAddress('0100007F'), { family: 'IPv4', address: '127.0.0.1' });
  assert.deepStrictEqual(decodeProcAddress('00000000'), { family: 'IPv4', address: '0.0.0.0' });
  assert.deepStrictEqual(decodeProcAddress('1401A8C0'), { family: 'IPv4', address: '192.168.1.20' });
  assert.deepStrictEqual(decodeProcAddress('0'.repeat(32)), { family: 'IPv6', address: '::' });
  assert.deepStrictEqual(decodeProcAddress('00000000000000000000000001000000'), { family: 'IPv6', address: '::1' });
  assert.deepStrictEqual(decodeProcAddress('000080FE000000000000000001000000'), { family: 'IPv6', address: 'fe80::1' });
  assert.deepStrictEqual(decodeProcAddress('0000000000000000FFFF00000100007F'), { family: 'IPv6', address: '::ffff:127.0.0.1' });
  assert.strictEqual(decodeProcAddress('xyz'), null);
});

test('formats IPv6 per RFC 5952', () => {
  assert.strictEqual(formatIPv6([0x2001, 0xdb8, 0, 0, 1, 0, 0, 1]), '2001:db8::1:0:0:1');
  assert.strictEqual(formatIPv6([0x2001, 0xdb8, 0, 1, 1, 1, 1, 1]), '2001:db8:0:1:1:1:1:1', 'a single zero group is not compressed');
  assert.strictEqual(formatIPv6([1, 0, 0, 0, 0, 0, 0, 0]), '1::');
});

test('parses /proc/net/tcp: only LISTEN, with the inode', () => {
  const text = HEADER
    + row(0, '0100007F:0CEA', '00000000:0000', '0A', '23456')      // 127.0.0.1:3306 LISTEN
    + row(1, '00000000:0016', '00000000:0000', '0A', '111')        // 0.0.0.0:22 LISTEN
    + row(2, '1401A8C0:0016', '0201A8C0:C350', '01', '222');       // established: skipped
  assert.deepStrictEqual(parseProcNet(text, 'tcp'), [
    { proto: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 3306, inode: '23456' },
    { proto: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 22, inode: '111' },
  ]);
});

test('parses /proc/net/udp6: every bound socket, whatever its state', () => {
  const text = HEADER
    + row(0, '0'.repeat(32) + ':14E9', '0'.repeat(32) + ':0000', '07', '333')
    + row(1, '00000000000000000000000001000000:0035', '0'.repeat(32) + ':0000', '01', '444');
  assert.deepStrictEqual(parseProcNet(text, 'udp').map((r) => [r.address, r.port, r.family]), [['::', 5353, 'IPv6'], ['::1', 53, 'IPv6']]);
});

test('maps socket inodes to readable processes on a fake /proc', () => {
  const files = {
    '/proc/net/tcp': HEADER + row(0, '00000000:0016', '00000000:0000', '0A', '111') + row(1, '0100007F:1F90', '00000000:0000', '0A', '999'),
    '/proc/net/udp': HEADER + row(0, '00000000:0044', '00000000:0000', '07', '555'),
    '/proc/42/comm': 'sshd\n',
    '/proc/77/comm': 'dhclient\n',
  };
  const dirs = { '/proc': ['42', '77', '88', 'self', 'net'], '/proc/42/fd': ['0', '3'], '/proc/77/fd': ['5'] };
  const links = { '/proc/42/fd/0': '/dev/null', '/proc/42/fd/3': 'socket:[111]', '/proc/77/fd/5': 'socket:[555]' };
  const nope = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  const fsImpl = {
    readFileSync: (p) => (p in files ? files[p] : nope()),
    readdirSync: (p) => (p in dirs ? dirs[p] : nope()),
    readlinkSync: (p) => (p in links ? links[p] : nope()),
  };
  const rows = sampleLinux({ fsImpl });
  assert.deepStrictEqual(rows, [
    { proto: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 22, pid: 42, process: 'sshd' },
    { proto: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 8080, pid: null, process: null },
    { proto: 'udp', family: 'IPv4', address: '0.0.0.0', port: 68, pid: 77, process: 'dhclient' },
  ]);
});

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1924',
  '  TCP    0.0.0.0:445            0.0.0.0:0              ABHÖREN         4',
  '  TCP    192.168.1.20:52000     140.82.112.4:443       ESTABLISHED     8800',
  '  TCP    [::]:135               [::]:0                 LISTENING       1924',
  '  TCP    [::1]:49664            [::1]:50000            ESTABLISHED     700',
  '  UDP    0.0.0.0:53             *:*                                    3868',
  '  UDP    0.0.0.0:53             *:*                                    3868',
  '  UDP    [fe80::1%12]:1900      *:*                                    4567',
  '',
].join('\r\n');

test('parses netstat -ano: listening TCP whatever the language, and every UDP row', () => {
  const rows = parseNetstat(NETSTAT);
  assert.deepStrictEqual(rows.map((r) => [r.proto, r.family, r.address, r.port, r.pid]), [
    ['tcp', 'IPv4', '0.0.0.0', 135, 1924],
    ['tcp', 'IPv4', '0.0.0.0', 445, 4],
    ['tcp', 'IPv6', '::', 135, 1924],
    ['udp', 'IPv4', '0.0.0.0', 53, 3868],
    ['udp', 'IPv4', '0.0.0.0', 53, 3868],
    ['udp', 'IPv6', 'fe80::1', 1900, 4567],
  ]);
  assert.ok(rows.every((r) => r.process === null));
});

test('parses tasklist CSV, quotes included', () => {
  const m = parseTasklist('"System","4","Services","0","144 K"\r\n"svchost.exe","1924","Services","0","12,340 K"\r\n"odd ""name"".exe","7","Console","1","1 K"\r\nINFO: nothing\r\n');
  assert.deepStrictEqual([...m.entries()], [[4, 'System'], [1924, 'svchost.exe'], [7, 'odd "name".exe']]);
});

test('Windows sampling names pids and survives a failing tasklist', async () => {
  const calls = [];
  const execImpl = (cmd, args, opts, cb) => {
    calls.push([cmd, opts.windowsHide]);
    if (cmd === 'netstat.exe') return cb(null, NETSTAT);
    return cb(null, '"svchost.exe","1924","Services","0","1 K"\r\n"System","4","Services","0","1 K"\r\n');
  };
  const rows = await sampleWindows({ execImpl });
  assert.deepStrictEqual(calls, [['netstat.exe', true], ['tasklist.exe', true]]);
  assert.strictEqual(rows[0].process, 'svchost.exe');
  assert.strictEqual(rows[1].process, 'System');
  assert.strictEqual(rows[5].process, null, 'unknown pid stays null');

  const noNames = await sampleWindows({ execImpl: (cmd, a, o, cb) => (cmd === 'netstat.exe' ? cb(null, NETSTAT) : cb(new Error('denied'), '')) });
  assert.strictEqual(noNames[0].pid, 1924);
  assert.strictEqual(noNames[0].process, null);
  await assert.rejects(sampleWindows({ execImpl: (c, a, o, cb) => cb(new Error('no netstat'), '') }), code('io_error'));
});

test('the answer is sorted by port then proto, de-duplicated, and capped', async () => {
  const r = (proto, port, address = '0.0.0.0', pid = 1) => ({ proto, family: 'IPv4', address, port, pid, process: null });
  const { ports, truncated } = finish([r('udp', 53), r('tcp', 80), r('tcp', 53), r('udp', 53), r('tcp', 22, '127.0.0.1'), r('tcp', 22)]);
  assert.deepStrictEqual(ports.map((p) => `${p.port}/${p.proto} ${p.address}`), ['22/tcp 0.0.0.0', '22/tcp 127.0.0.1', '53/tcp 0.0.0.0', '53/udp 0.0.0.0', '80/tcp 0.0.0.0']);
  assert.strictEqual(truncated, false);

  const many = Array.from({ length: 12 }, (_, i) => r('tcp', 1000 + i));
  const svc = new PortService({ platform: 'linux', sample: () => many, now: () => 1234, max: 10 });
  const out = await svc.handle('net.ports', {});
  assert.strictEqual(out.ports.length, 10);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(out.sampledAt, 1234);
  assert.deepStrictEqual(Object.keys(out).sort(), ['ports', 'sampledAt', 'truncated']);
});

test('two requests at once share one sample; other platforms and methods are unsupported', async () => {
  let calls = 0;
  const svc = new PortService({ platform: 'linux', sample: async () => { calls++; return []; } });
  await Promise.all([svc.list(), svc.list()]);
  assert.strictEqual(calls, 1);
  await assert.rejects(svc.handle('net.nope', {}), code('unsupported'));
  assert.ok(!PortService.supported('darwin'));
  assert.ok(PortService.supported('linux') && PortService.supported('win32'));
  await assert.rejects(new PortService({ platform: 'darwin' }).handle('net.ports', {}), code('unsupported'));
});

test('really lists this machine\'s ports (smoke)', { skip: !PortService.supported() }, async () => {
  const r = await new PortService().list();
  assert.ok(Array.isArray(r.ports));
  for (const p of r.ports) {
    assert.ok(p.proto === 'tcp' || p.proto === 'udp');
    assert.ok(p.family === 'IPv4' || p.family === 'IPv6');
    assert.ok(Number.isInteger(p.port) && p.port > 0);
    assert.ok(p.pid === null || Number.isInteger(p.pid));
  }
});
