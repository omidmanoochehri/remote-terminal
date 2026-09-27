'use strict';

/*
 * The machine's processes, for the app's process manager (`proc.*` requests).
 *
 * Linux reads /proc directly — no `ps`, no parsing of human output. Windows
 * asks PowerShell's Get-Process once per sample, which is the one place in the
 * agent that spawns a helper for information; it only happens while someone
 * has the Processes screen open.
 *
 * CPU is a delta, like the machine-wide figure in metrics.js: each process's
 * cumulative CPU time now minus a moment ago, over the wall time between, over
 * the number of cores — so 1.0 means the whole machine. The previous sample is
 * kept, so a screen refreshing every few seconds costs one sample per refresh;
 * a cold start takes two samples a short moment apart.
 *
 * Killing is where the agent's own identity matters. On Linux the kernel
 * already confines us to the processes of the account terminals run as. On
 * Windows under the service the agent is LocalSystem and could end anything,
 * so a kill is allowed only for processes of the person the terminals belong
 * to — never more than they could end from their own terminal.
 */

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const MAX_PROCESSES = 1000;
const MAX_CMD = 512;
/** A previous sample older than this is too stale to take a delta against. */
const STALE_MS = 60_000;
/** Gap between the two samples of a cold start. */
const COLD_GAP_MS = 400;

class ProcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------------------------------- Linux --------------------------------- */

/** Parse /proc/<pid>/stat: the name is in parentheses and may itself contain them. */
function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(' ');
  // rest[0] is field 3 (state); utime/stime are fields 14/15, rss field 24.
  return {
    name: text.slice(open + 1, close),
    ppid: Number(rest[1]),
    cpuTicks: Number(rest[11]) + Number(rest[12]),
    rssPages: Number(rest[21]),
  };
}

function passwdNames(read = () => fs.readFileSync('/etc/passwd', 'utf8')) {
  const names = new Map();
  try {
    for (const line of read().split('\n')) {
      const f = line.split(':');
      if (f.length > 2) names.set(Number(f[2]), f[0]);
    }
  } catch (_) { /* no passwd: uids it is */ }
  return names;
}

function sampleLinux({ procDir = '/proc', clockTicks = 100, pageSize = 4096, fsImpl = fs } = {}) {
  const users = passwdNames(() => fsImpl.readFileSync('/etc/passwd', 'utf8'));
  const out = new Map();
  let pids;
  try { pids = fsImpl.readdirSync(procDir).filter((d) => /^\d+$/.test(d)); } catch (_) { return out; }
  for (const d of pids) {
    try {
      const st = parseStat(fsImpl.readFileSync(`${procDir}/${d}/stat`, 'utf8'));
      if (!st) continue;
      let uid = null;
      try {
        const m = fsImpl.readFileSync(`${procDir}/${d}/status`, 'utf8').match(/^Uid:\s+(\d+)/m);
        if (m) uid = Number(m[1]);
      } catch (_) { /* gone */ }
      let cmd = '';
      try { cmd = fsImpl.readFileSync(`${procDir}/${d}/cmdline`, 'utf8').replace(/\0+$/, '').replace(/\0/g, ' '); } catch (_) { /* kernel thread */ }
      const pid = Number(d);
      out.set(pid, {
        pid,
        ppid: st.ppid,
        name: st.name,
        user: uid === null ? '' : (users.get(uid) || String(uid)),
        cpuSec: st.cpuTicks / clockTicks,
        mem: st.rssPages * pageSize,
        cmd: cmd.slice(0, MAX_CMD),
      });
    } catch (_) { /* exited while we looked */ }
  }
  return out;
}

/* --------------------------------- Windows -------------------------------- */

// Tab-separated so names with spaces or commas survive; -IncludeUserName
// needs elevation, which the service has — a console agent falls back.
const PS_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$p = try { Get-Process -IncludeUserName -ErrorAction Stop } catch { Get-Process }',
  'foreach ($x in $p) { "{0}`t{1}`t{2}`t{3}`t{4}" -f $x.Id, $x.ProcessName, $x.CPU, $x.WorkingSet64, $x.UserName }',
].join('; ');

function parseWindows(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.split('\t');
    if (f.length < 4 || !/^\d+$/.test(f[0])) continue;
    const pid = Number(f[0]);
    out.set(pid, {
      pid,
      ppid: null,
      name: f[1],
      user: (f[4] || '').trim(),
      cpuSec: f[2] === '' ? 0 : Number(String(f[2]).replace(',', '.')) || 0,
      mem: Number(f[3]) || 0,
      cmd: '',
    });
  }
  return out;
}

function sampleWindows({ run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return reject(new ProcError('io_error', `cannot list processes: ${err.message}`));
        return resolve(parseWindows(stdout));
      });
  });
}

/* --------------------------------- service -------------------------------- */

/** `OFFICE\ann` and `ann` are the same person; case never matters on Windows. */
function sameWindowsUser(a, b) {
  if (!a || !b) return false;
  const short = (s) => String(s).toLowerCase().split('\\').pop();
  return String(a).toLowerCase() === String(b).toLowerCase() || short(a) === short(b);
}

class ProcessService {
  /**
   * @param {{
   *   platform?: string,
   *   sample?: () => Promise<Map>|Map,
   *   owner?: () => Promise<string|null>|string|null,   Windows under the service: whose processes may be ended
   *   restricted?: boolean,                             true when the agent is more privileged than its terminals
   *   allowKill?: boolean,
   *   kill?: (pid:number, signal:string) => void,
   *   now?: () => number, sleep?: (ms:number) => Promise<void>, cpus?: number, selfPids?: number[],
   * }} opts
   */
  constructor({
    platform = process.platform, sample, owner = () => null, restricted = false, allowKill = true,
    kill = (pid, sig) => process.kill(pid, sig), now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), cpus = Math.max(1, os.cpus().length),
    selfPids = [process.pid, process.ppid],
  } = {}) {
    this.platform = platform;
    this.sampleFn = sample || (platform === 'win32' ? () => sampleWindows() : () => sampleLinux());
    this.owner = owner;
    this.restricted = restricted;
    this.allowKill = allowKill;
    this.killFn = kill;
    this.now = now;
    this.sleep = sleep;
    this.cpus = cpus;
    this.selfPids = new Set(selfPids.filter((p) => Number.isInteger(p) && p > 0));
    this.prev = null; // { at, procs }
    this.inflight = null;
  }

  async take() {
    const procs = await this.sampleFn();
    return { at: this.now(), procs };
  }

  /** Two samples to take a delta between: the kept one if fresh, else a cold pair. */
  async pair() {
    let before = this.prev;
    if (!before || this.now() - before.at > STALE_MS) {
      before = await this.take();
      await this.sleep(COLD_GAP_MS);
    }
    const after = await this.take();
    this.prev = after;
    return { before, after };
  }

  async list() {
    // Two screens refreshing at once share one sample.
    if (!this.inflight) this.inflight = this.pair().finally(() => { this.inflight = null; });
    const { before, after } = await this.inflight;
    const wall = Math.max(1, after.at - before.at) / 1000;
    const rows = [];
    for (const p of after.procs.values()) {
      const old = before.procs.get(p.pid);
      let cpu = null;
      if (old && old.name === p.name && before !== after) {
        cpu = Math.max(0, Math.min(1, (p.cpuSec - old.cpuSec) / wall / this.cpus));
      }
      const row = { pid: p.pid, name: p.name, user: p.user || '', cpu, mem: p.mem };
      if (p.ppid !== null && p.ppid !== undefined) row.ppid = p.ppid;
      if (p.cmd) row.cmd = p.cmd;
      rows.push(row);
    }
    rows.sort((a, b) => (b.cpu || 0) - (a.cpu || 0) || b.mem - a.mem);
    return {
      processes: rows.slice(0, MAX_PROCESSES),
      total: rows.length,
      cpus: this.cpus,
      sampledAt: after.at,
      killable: !this.allowKill ? 'none' : this.restricted ? 'own' : 'all',
      owner: this.restricted ? (await this.owner()) || null : undefined,
    };
  }

  async kill({ pid, force = false } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) throw new ProcError('bad_request', 'invalid pid');
    if (!this.allowKill) throw new ProcError('forbidden', 'ending processes is turned off on this machine');
    if (this.selfPids.has(pid)) throw new ProcError('forbidden', 'that is the Remote Terminal agent itself');
    if (this.platform === 'win32' && pid <= 4) throw new ProcError('forbidden', 'that is part of Windows itself');
    if (this.restricted) {
      const owner = await this.owner();
      if (!owner) throw new ProcError('forbidden', 'nobody is signed in, so no process is yours to end');
      const fresh = await this.take();
      const target = fresh.procs.get(pid);
      if (!target) throw new ProcError('not_found', 'no such process');
      if (!sameWindowsUser(target.user, owner)) {
        throw new ProcError('forbidden', `that process belongs to ${target.user || 'the system'}, not ${owner}`);
      }
    }
    try {
      this.killFn(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (err) {
      if (err.code === 'ESRCH') throw new ProcError('not_found', 'no such process');
      if (err.code === 'EPERM') throw new ProcError('forbidden', 'not allowed to end that process');
      throw new ProcError('io_error', err.message);
    }
    return { pid, signal: force ? 'SIGKILL' : 'SIGTERM' };
  }

  async handle(method, params) {
    switch (method) {
      case 'proc.list': return this.list(params);
      case 'proc.kill': return this.kill(params);
      default: throw new ProcError('bad_request', `unknown method "${method}"`);
    }
  }
}

module.exports = { ProcessService, ProcError, parseStat, parseWindows, sampleLinux, sameWindowsUser, PS_SCRIPT };
