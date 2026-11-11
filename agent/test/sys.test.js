'use strict';

/*
 * sys.info: interfaces as the protocol describes them, fields that cannot be
 * read left out rather than failing the request, and the config toggles.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { SystemService, buildInterfaces, normalizeMac } = require('../lib/sys');
const { loadConfig } = require('../lib/config');

const code = (c) => (err) => { assert.strictEqual(err.code, c, err.message); return true; };

const IFACES = {
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
  eth0: [
    { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: 'AA:BB:CC:DD:EE:FF', internal: false, cidr: '192.168.1.20/24' },
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 6, mac: 'AA:BB:CC:DD:EE:FF', internal: false, cidr: 'fe80::1/64', scopeid: 2 },
  ],
  tun0: [{ address: '10.8.0.2', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null }],
};

test('MACs are lowercase and colon separated; all-zero and junk are dropped', () => {
  assert.strictEqual(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
  assert.strictEqual(normalizeMac('00:00:00:00:00:00'), null);
  assert.strictEqual(normalizeMac('xx'), null);
  assert.strictEqual(normalizeMac(undefined), null);
});

test('interfaces: non-internal only, MAC omitted when all zeros, families normalised', () => {
  assert.deepStrictEqual(buildInterfaces(IFACES), [
    { name: 'eth0', mac: 'aa:bb:cc:dd:ee:ff', addresses: [
      { family: 'IPv4', address: '192.168.1.20', cidr: '192.168.1.20/24' },
      { family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64' },
    ] },
    { name: 'tun0', addresses: [{ family: 'IPv4', address: '10.8.0.2' }] },
  ]);
  const many = {};
  for (let i = 0; i < 40; i++) many[`e${i}`] = [{ address: `10.0.0.${i}`, family: 'IPv4', internal: false }];
  assert.strictEqual(buildInterfaces(many).length, 32);
  assert.deepStrictEqual(buildInterfaces(null), []);
});

test('sys.info reports the machine, and who terminals run as', async () => {
  const osImpl = {
    hostname: () => 'prod-01', release: () => '6.8.0-45-generic', totalmem: () => 16687661056, uptime: () => 279484.7,
    cpus: () => [{ model: '  AMD Ryzen 7 5800X   8-Core ' }, { model: 'AMD Ryzen 7 5800X' }], networkInterfaces: () => IFACES,
  };
  const svc = new SystemService({
    version: '0.13.0', user: async () => 'omid', osImpl, platform: 'linux', arch: 'x64', osName: () => 'Ubuntu 24.04',
    agentUptime: () => 3600.4, nodeVersion: 'v24.1.0', tz: () => 'Europe/Berlin',
  });
  const r = await svc.handle('sys.info', {});
  assert.deepStrictEqual(Object.assign({}, r, { interfaces: r.interfaces.length }), {
    hostname: 'prod-01', platform: 'linux', os: 'Ubuntu 24.04', release: '6.8.0-45-generic', arch: 'x64',
    cpuModel: 'AMD Ryzen 7 5800X 8-Core', cpus: 2, memoryTotal: 16687661056, uptimeSec: 279484, agentUptimeSec: 3600,
    nodeVersion: 'v24.1.0', agentVersion: '0.13.0', user: 'omid', timezone: 'Europe/Berlin', interfaces: 2,
  });
});

test('a field that cannot be read is left out; nobody signed in is user null', async () => {
  const boom = () => { throw new Error('no'); };
  const svc = new SystemService({
    version: '0.13.0', user: async () => null, platform: 'win32', arch: 'x64', osName: boom, tz: () => undefined,
    osImpl: { hostname: () => 'box', release: boom, totalmem: boom, uptime: boom, cpus: boom, networkInterfaces: boom },
  });
  const r = await svc.info();
  assert.strictEqual(r.hostname, 'box');
  assert.strictEqual(r.user, null);
  assert.deepStrictEqual(r.interfaces, []);
  for (const k of ['os', 'release', 'cpuModel', 'cpus', 'memoryTotal', 'uptimeSec', 'timezone']) assert.ok(!(k in r), `${k} omitted`);
  await assert.rejects(svc.handle('sys.nope', {}), code('unsupported'));
});

test('sys.info on this machine has the required fields (smoke)', async () => {
  const r = await new SystemService({ version: 'x' }).info();
  assert.strictEqual(typeof r.hostname, 'string');
  assert.strictEqual(r.platform, process.platform);
  assert.ok(Array.isArray(r.interfaces));
  assert.ok(r.interfaces.every((i) => !i.mac || /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(i.mac)));
});

test('systemInfo and portList default on and follow the environment', () => {
  const configPath = path.join(__dirname, 'no-such-config.json');
  const on = loadConfig({}, { configPath });
  assert.strictEqual(on.systemInfo, true);
  assert.strictEqual(on.portList, true);
  const off = loadConfig({ SYSTEM_INFO: '0', PORT_LIST: 'false' }, { configPath });
  assert.strictEqual(off.systemInfo, false);
  assert.strictEqual(off.portList, false);
});
