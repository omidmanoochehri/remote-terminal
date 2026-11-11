'use strict';

/*
 * What the machine is, for the app's System screen (`sys.*` requests).
 *
 * Everything here comes from Node's `os` module — nothing is spawned and no
 * file is parsed — so a request costs next to nothing. Only non-internal
 * network interfaces are reported (loopback tells a phone nothing), with
 * their MAC addresses, which the app remembers for Wake-on-LAN.
 */

const os = require('os');
const { osDescription } = require('./config');

const MAX_INTERFACES = 32;
const MAX_ADDRESSES = 16;

class SysError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** `aa:bb:cc:dd:ee:ff`, lowercase — or null for a missing or all-zero MAC. */
function normalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

/** Node reported `family` as 4 / 6 for a few releases; the protocol says "IPv4" / "IPv6". */
function normalizeFamily(family) {
  if (family === 4 || family === 'IPv4') return 'IPv4';
  if (family === 6 || family === 'IPv6') return 'IPv6';
  return null;
}

/**
 * `os.networkInterfaces()` → the protocol's `interfaces`: non-internal only,
 * at most 32, each with its MAC (when it has a real one) and addresses.
 */
function buildInterfaces(ifaces) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (!Array.isArray(list)) continue;
    const external = list.filter((a) => a && !a.internal);
    if (!external.length) continue;
    const entry = { name };
    const mac = external.map((a) => normalizeMac(a.mac)).find(Boolean);
    if (mac) entry.mac = mac;
    entry.addresses = [];
    for (const a of external) {
      const family = normalizeFamily(a.family);
      if (!family || typeof a.address !== 'string') continue;
      const addr = { family, address: a.address };
      if (typeof a.cidr === 'string' && a.cidr) addr.cidr = a.cidr;
      entry.addresses.push(addr);
      if (entry.addresses.length >= MAX_ADDRESSES) break;
    }
    out.push(entry);
    if (out.length >= MAX_INTERFACES) break;
  }
  return out;
}

function timezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz ? tz : undefined;
  } catch (_) {
    return undefined;
  }
}

class SystemService {
  /**
   * @param {{
   *   version: string,                                  the agent's version
   *   user?: () => Promise<string|null>|string|null,    who terminals run as (under the Windows service: the signed-in user)
   *   osImpl?: object, platform?: string, arch?: string, osName?: () => string,
   *   agentUptime?: () => number, nodeVersion?: string, tz?: () => string|undefined,
   * }} opts
   */
  constructor({
    version, user = () => os.userInfo().username, osImpl = os, platform = process.platform, arch = process.arch,
    osName = osDescription, agentUptime = () => process.uptime(), nodeVersion = process.version, tz = timezone,
  } = {}) {
    this.version = version;
    this.user = user;
    this.os = osImpl;
    this.platform = platform;
    this.arch = arch;
    this.osName = osName;
    this.agentUptime = agentUptime;
    this.nodeVersion = nodeVersion;
    this.tz = tz;
  }

  /** Each field is asked for on its own: one that throws is simply not reported. */
  async info() {
    const tryGet = (fn) => { try { const v = fn(); return v === '' || v === null || Number.isNaN(v) ? undefined : v; } catch (_) { return undefined; } };
    const cpus = tryGet(() => this.os.cpus()) || [];
    let user;
    try { user = (await this.user()) || null; } catch (_) { user = null; }
    const out = {
      hostname: tryGet(() => this.os.hostname()) || '',
      platform: this.platform,
      os: tryGet(() => String(this.osName()).slice(0, 128)),
      release: tryGet(() => this.os.release()),
      arch: this.arch,
      cpuModel: cpus.length && cpus[0] && typeof cpus[0].model === 'string' ? (cpus[0].model.trim().replace(/\s+/g, ' ') || undefined) : undefined,
      cpus: cpus.length || undefined,
      memoryTotal: tryGet(() => this.os.totalmem()),
      uptimeSec: tryGet(() => Math.floor(this.os.uptime())),
      agentUptimeSec: tryGet(() => Math.floor(this.agentUptime())),
      nodeVersion: this.nodeVersion || undefined,
      agentVersion: this.version || undefined,
      user,
      timezone: tryGet(() => this.tz()),
      interfaces: buildInterfaces(tryGet(() => this.os.networkInterfaces())),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  async handle(method, params) {
    switch (method) {
      case 'sys.info': return this.info(params);
      default: throw new SysError('unsupported', `unknown method "${method}"`);
    }
  }
}

module.exports = { SystemService, SysError, buildInterfaces, normalizeMac, normalizeFamily };
