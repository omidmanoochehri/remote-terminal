'use strict';

/*
 * Which ports the machine listens on, for the app's System screen
 * (`net.ports` requests): TCP sockets in LISTEN and bound UDP sockets.
 *
 * Linux reads /proc/net/{tcp,tcp6,udp,udp6} and finds the owning process by
 * matching each socket's inode against the /proc/<pid>/fd links it may read —
 * as an ordinary user that is only its own processes, so other rows carry a
 * null pid, exactly what `ss -p` would show that user.
 *
 * Windows runs `netstat -ano` once and names the pids with `tasklist`. A TCP
 * row listens when its foreign port is 0, which, unlike the "LISTENING" word,
 * does not change with the display language.
 *
 * The parsers are pure functions so they can be tested on any platform.
 */

const fs = require('fs');
const { execFile } = require('child_process');

const MAX_PORTS = 1000;

class PortError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------------------------------- Linux --------------------------------- */

/** RFC 5952 text for eight 16-bit groups: lowercase, the longest run of zeros as "::". */
function formatIPv6(groups) {
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  // An IPv4-mapped address reads best with its IPv4 tail.
  if (best === 0 && bestLen === 5 && groups[5] === 0xffff) {
    return `::ffff:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/**
 * A /proc/net address: IPv4 is one 32-bit word, IPv6 four, each in the
 * kernel's (little-endian) byte order.
 */
function decodeProcAddress(hex) {
  if (/^[0-9A-Fa-f]{8}$/.test(hex)) {
    const b = hex.match(/../g).map((x) => parseInt(x, 16)).reverse();
    return { family: 'IPv4', address: b.join('.') };
  }
  if (/^[0-9A-Fa-f]{32}$/.test(hex)) {
    const bytes = [];
    for (let w = 0; w < 4; w++) {
      const word = hex.slice(w * 8, w * 8 + 8).match(/../g).map((x) => parseInt(x, 16)).reverse();
      bytes.push(...word);
    }
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
    return { family: 'IPv6', address: formatIPv6(groups) };
  }
  return null;
}

/**
 * One /proc/net/{tcp,tcp6,udp,udp6} file → `{ proto, family, address, port, inode }`
 * rows: TCP only in LISTEN (state 0A), UDP whenever bound to a port.
 */
function parseProcNet(text, proto) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.trim().split(/\s+/);
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
    if (f.length < 10 || !/^\d+:$/.test(f[0])) continue;
    const [addrHex, portHex] = f[1].split(':');
    const local = decodeProcAddress(addrHex || '');
    const port = parseInt(portHex, 16);
    if (!local || !Number.isInteger(port) || port <= 0) continue;
    const state = f[3].toUpperCase();
    if (proto === 'tcp' && state !== '0A') continue;
    out.push({ proto, family: local.family, address: local.address, port, inode: f[9] });
  }
  return out;
}

/** socket inode → pid, from the /proc/<pid>/fd links this account may read. */
function socketOwners({ procDir = '/proc', fsImpl = fs, wanted } = {}) {
  const owners = new Map();
  let pids;
  try { pids = fsImpl.readdirSync(procDir).filter((d) => /^\d+$/.test(d)); } catch (_) { return owners; }
  for (const d of pids) {
    let fds;
    try { fds = fsImpl.readdirSync(`${procDir}/${d}/fd`); } catch (_) { continue; }
    for (const fd of fds) {
      let target;
      try { target = fsImpl.readlinkSync(`${procDir}/${d}/fd/${fd}`); } catch (_) { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && (!wanted || wanted.has(m[1])) && !owners.has(m[1])) owners.set(m[1], Number(d));
    }
    if (wanted && owners.size >= wanted.size) break;
  }
  return owners;
}

function processName(pid, { procDir = '/proc', fsImpl = fs } = {}) {
  try { return fsImpl.readFileSync(`${procDir}/${pid}/comm`, 'utf8').trim() || null; } catch (_) { return null; }
}

function sampleLinux({ procDir = '/proc', fsImpl = fs } = {}) {
  const rows = [];
  for (const [file, proto] of [['tcp', 'tcp'], ['tcp6', 'tcp'], ['udp', 'udp'], ['udp6', 'udp']]) {
    let text;
    try { text = fsImpl.readFileSync(`${procDir}/net/${file}`, 'utf8'); } catch (_) { continue; }
    rows.push(...parseProcNet(text, proto));
  }
  const wanted = new Set(rows.map((r) => r.inode).filter((i) => i && i !== '0'));
  const owners = wanted.size ? socketOwners({ procDir, fsImpl, wanted }) : new Map();
  const names = new Map();
  return rows.map((r) => {
    const pid = owners.has(r.inode) ? owners.get(r.inode) : null;
    if (pid !== null && !names.has(pid)) names.set(pid, processName(pid, { procDir, fsImpl }));
    return { proto: r.proto, family: r.family, address: r.address, port: r.port, pid, process: pid === null ? null : names.get(pid) };
  });
}

/* --------------------------------- Windows -------------------------------- */

/** `0.0.0.0:135`, `[::]:135`, `[fe80::1%12]:1900` → `{ address, port }` (the zone is dropped). */
function splitHostPort(text) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(text) || /^([^:\s]+):(\d+)$/.exec(text);
  if (!m) return null;
  return { address: m[1].replace(/%.*$/, ''), port: Number(m[2]) };
}

/**
 * `netstat -ano` → rows, pid included, process null. TCP rows listen when
 * their foreign port is 0 (the state word is translated on non-English
 * Windows); every UDP row is a bound socket.
 */
function parseNetstat(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    const proto = (f[0] || '').toUpperCase();
    if (proto !== 'TCP' && proto !== 'UDP') continue;
    const local = splitHostPort(f[1] || '');
    if (!local || local.port <= 0) continue;
    const pidText = f[f.length - 1];
    const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
    if (proto === 'TCP') {
      if (f.length < 5) continue;
      const foreign = splitHostPort(f[2] || '');
      if (!foreign || foreign.port !== 0) continue;
    }
    out.push({
      proto: proto.toLowerCase(),
      family: local.address.includes(':') ? 'IPv6' : 'IPv4',
      address: local.address,
      port: local.port,
      pid,
      process: null,
    });
  }
  return out;
}

/** `tasklist /fo csv /nh` → pid → image name. */
function parseTasklist(text) {
  const names = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^"((?:[^"]|"")*)","(\d+)"/.exec(line.trim());
    if (m) names.set(Number(m[2]), m[1].replace(/""/g, '"'));
  }
  return names;
}

function run(execImpl, cmd, args) {
  return new Promise((resolve, reject) => {
    execImpl(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      return resolve(String(stdout || ''));
    });
  });
}

async function sampleWindows({ execImpl = execFile } = {}) {
  let text;
  try {
    text = await run(execImpl, 'netstat.exe', ['-ano']);
  } catch (err) {
    throw new PortError('io_error', `cannot list ports: ${err.message}`);
  }
  const rows = parseNetstat(text);
  let names = new Map();
  try { names = parseTasklist(await run(execImpl, 'tasklist.exe', ['/fo', 'csv', '/nh'])); } catch (_) { /* pids only */ }
  for (const r of rows) {
    if (r.pid === 0) { r.process = 'System Idle Process'; continue; }
    if (r.pid !== null && names.has(r.pid)) r.process = names.get(r.pid);
  }
  return rows;
}

/* --------------------------------- service -------------------------------- */

/** Sorted by port, then proto, family and address; exact duplicates (SO_REUSEADDR) dropped. */
function finish(rows, max = MAX_PORTS) {
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    const key = `${r.proto}|${r.family}|${r.address}|${r.port}|${r.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  unique.sort((a, b) => a.port - b.port || cmp(a.proto, b.proto) || cmp(a.family, b.family) || cmp(a.address, b.address) || (a.pid || 0) - (b.pid || 0));
  return { ports: unique.slice(0, max), truncated: unique.length > max };
}

class PortService {
  static supported(platform = process.platform) { return platform === 'linux' || platform === 'win32'; }

  /**
   * @param {{ platform?: string, sample?: () => Promise<object[]>|object[], now?: () => number, max?: number }} opts
   */
  constructor({ platform = process.platform, sample, now = Date.now, max = MAX_PORTS } = {}) {
    this.platform = platform;
    this.sampleFn = sample || (platform === 'win32' ? () => sampleWindows() : platform === 'linux' ? () => sampleLinux() : null);
    this.now = now;
    this.max = max;
    this.inflight = null;
  }

  async list() {
    if (!this.sampleFn) throw new PortError('unsupported', `listing ports is not supported on ${this.platform}`);
    // Two screens refreshing at once share one sample.
    if (!this.inflight) this.inflight = Promise.resolve().then(() => this.sampleFn()).finally(() => { this.inflight = null; });
    const rows = await this.inflight;
    const { ports, truncated } = finish(rows, this.max);
    return { ports, sampledAt: this.now(), truncated };
  }

  async handle(method, params) {
    switch (method) {
      case 'net.ports': return this.list(params);
      default: throw new PortError('unsupported', `unknown method "${method}"`);
    }
  }
}

module.exports = {
  PortService, PortError, parseProcNet, decodeProcAddress, formatIPv6, socketOwners, sampleLinux,
  parseNetstat, parseTasklist, splitHostPort, sampleWindows, finish, MAX_PORTS,
};
