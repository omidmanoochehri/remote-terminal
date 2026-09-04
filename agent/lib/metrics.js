'use strict';

/*
 * System metrics for the phone's Machine screen: CPU load, memory, disk and
 * uptime.
 *
 * Everything here comes from Node's own `os` and `fs` — no shelling out to
 * wmic/typeperf/free/df — so one code path serves Windows and Linux alike and
 * a metrics sample can never spawn a process or block the event loop. Two
 * platform details are worth naming:
 *
 *   - CPU load is a delta, not a snapshot: `os.cpus()` reports cumulative busy
 *     and idle time per core, so the first sample only establishes a baseline
 *     and the load is what happened between two of them. `os.loadavg()` is
 *     useless here — it is always [0,0,0] on Windows.
 *   - "Used" memory on Linux means total minus MemAvailable, not minus free:
 *     the page cache is free for the asking, and reporting it as used makes a
 *     healthy box look full. Windows has no such distinction, so os.freemem()
 *     is the right number there.
 *
 * Every field is optional. When a platform cannot answer, the field is left
 * out and the app shows "not reported" rather than a made-up number.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Below this the busy/idle delta is too small to mean anything. */
const MIN_CPU_WINDOW_MS = 250;

/** The filesystem whose free space the machine screen shows. */
function defaultDiskPath(platform = process.platform, cwd = process.cwd()) {
  if (platform !== 'win32') return '/';
  // The drive the agent lives on: C:\ for a default install, E:\ if it was
  // unpacked there. path.parse gives the root with its trailing separator.
  return path.parse(path.resolve(cwd)).root || 'C:\\';
}

/** Cumulative busy/total CPU ticks across every core. */
function cpuTicks(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const key of Object.keys(cpu.times)) total += cpu.times[key];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/** Linux only: total and available bytes as the kernel sees them. */
function meminfo(read = () => fs.readFileSync('/proc/meminfo', 'utf8')) {
  let raw;
  try { raw = read(); } catch (_) { return null; }
  const field = (name) => {
    const m = raw.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = field('MemTotal');
  const available = field('MemAvailable');
  if (!total || available == null) return null;
  return { total, available };
}

class Metrics {
  /**
   * @param {{platform?: string, diskPath?: string, log?: object, osImpl?: object, fsImpl?: object, readMeminfo?: function, now?: function}} opts
   */
  constructor({ platform = process.platform, diskPath = null, log = null, osImpl = os, fsImpl = fs, readMeminfo = undefined, now = Date.now } = {}) {
    this.platform = platform;
    this.os = osImpl;
    this.fs = fsImpl;
    this.readMeminfo = readMeminfo;
    this.log = log;
    this.now = now;
    this.diskPath = diskPath || defaultDiskPath(platform);
    this.last = { at: this.now(), ticks: cpuTicks(this.os.cpus()) };
    /** Disks are reported once when they cannot be read; retrying every tick would only repeat it. */
    this.diskWarned = false;
  }

  /** CPU busy fraction (0..1) since the previous sample, or null if too soon. */
  cpuLoad() {
    const at = this.now();
    const ticks = cpuTicks(this.os.cpus());
    const previous = this.last;
    this.last = { at, ticks };
    if (at - previous.at < MIN_CPU_WINDOW_MS) return null;
    const total = ticks.total - previous.ticks.total;
    const idle = ticks.idle - previous.ticks.idle;
    // A suspended machine (or a clock that went backwards) can hand back a
    // useless window; say nothing rather than report 0% or 100%.
    if (total <= 0 || idle < 0) return null;
    return Math.min(1, Math.max(0, 1 - idle / total));
  }

  memory() {
    const total = this.os.totalmem();
    if (!total) return null;
    if (this.platform === 'linux') {
      const info = this.readMeminfo ? meminfo(this.readMeminfo) : meminfo();
      if (info) return { total: info.total, used: Math.max(0, info.total - info.available) };
    }
    return { total, used: Math.max(0, total - this.os.freemem()) };
  }

  /** Bytes on the agent's own filesystem. `statfs` covers Windows too (Node 18.15+). */
  storage() {
    if (typeof this.fs.statfsSync !== 'function') return null;
    let s;
    try { s = this.fs.statfsSync(this.diskPath); } catch (err) {
      if (!this.diskWarned && this.log) {
        this.diskWarned = true;
        this.log.warn('cannot read disk usage', { path: this.diskPath, err: err.message });
      }
      return null;
    }
    const block = Number(s.bsize);
    const blocks = Number(s.blocks);
    const free = Number(s.bfree);
    if (!(block > 0) || !(blocks > 0) || !(free >= 0)) return null;
    const total = block * blocks;
    return { total, used: Math.max(0, total - block * free) };
  }

  /**
   * One sample, ready to send. Fields the platform could not answer are
   * omitted rather than sent as null, so the relay stores only real numbers.
   */
  sample() {
    const out = {};
    const cpu = this.cpuLoad();
    if (cpu !== null) out.cpuLoad = Math.round(cpu * 1000) / 1000;
    const mem = this.memory();
    if (mem) { out.memoryUsed = Math.round(mem.used); out.memoryTotal = Math.round(mem.total); }
    const disk = this.storage();
    if (disk) { out.storageUsed = Math.round(disk.used); out.storageTotal = Math.round(disk.total); }
    const uptime = this.os.uptime();
    if (Number.isFinite(uptime) && uptime >= 0) out.uptimeSec = Math.round(uptime);
    return out;
  }
}

module.exports = { Metrics, cpuTicks, meminfo, defaultDiskPath, MIN_CPU_WINDOW_MS };
