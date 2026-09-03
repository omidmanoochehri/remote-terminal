'use strict';

/*
 * Shell discovery. The phone only ever selects a shell *id*; the command line
 * behind an id comes from this module (controlled discovery) or from the
 * `shells` allowlist in config.json — never from the network.
 *
 *   Windows: Windows PowerShell, PowerShell 7 (pwsh), Command Prompt, and
 *            each installed WSL distribution.
 *   Linux/macOS: every entry of /etc/shells that exists, plus $SHELL.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SHELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'shell';
}

/** Locate an executable on PATH (with PATHEXT on Windows). */
function which(cmd, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (path.isAbsolute(cmd)) return exists(cmd) ? cmd : null;
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + (platform === 'win32' && !cmd.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ''));
      if (exists(p)) return p;
    }
  }
  return null;
}

function run(file, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, Object.assign({ timeout: 5000, windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 20 }, opts), (err, stdout) => {
        resolve(err ? null : stdout);
      });
    } catch (_) { resolve(null); }
  });
}

/** `wsl.exe -l -q` prints UTF-16LE; decode and split into distro names. */
function parseWslList(buf) {
  if (!buf || !buf.length) return [];
  // UTF-16LE text has a NUL high byte for every ASCII character; UTF-8 has none.
  let nuls = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) nuls++;
  const text = nuls * 4 >= buf.length ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.replace(/\u0000/g, '').trim()).filter(Boolean);
}

async function discoverWindows({ env, exists, exec }) {
  const out = [];
  const sysRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = path.join(sysRoot, 'System32', 'cmd.exe');
  const wsl = path.join(sysRoot, 'System32', 'wsl.exe');
  const pwshCandidates = [
    which('pwsh.exe', { platform: 'win32', env, exists }),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ].filter(Boolean);
  const pwsh = pwshCandidates.find((p) => exists(p));
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', cmd: pwsh, args: ['-NoLogo'] });
  if (exists(ps)) out.push({ id: 'powershell', label: 'Windows PowerShell', cmd: ps, args: ['-NoLogo'] });
  if (exists(cmd)) out.push({ id: 'cmd', label: 'Command Prompt', cmd, args: [] });
  if (exists(wsl)) {
    const distros = parseWslList(await exec(wsl, ['-l', '-q']));
    for (const d of distros) out.push({ id: `wsl-${slug(d)}`, label: `${d} (WSL)`, cmd: wsl, args: ['-d', d] });
  }
  return out;
}

function discoverPosix({ env, exists, readFile }) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || !p.startsWith('/') || !exists(p)) return;
    const base = path.basename(p);
    if (!SHELL_ID_RE.test(base) || seen.has(base)) return;
    seen.add(base);
    out.push({ id: base, label: base, cmd: p, args: [] });
  };
  let lines = [];
  try { lines = String(readFile('/etc/shells')).split(/\r?\n/); } catch (_) { /* no /etc/shells */ }
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#')) add(t);
  }
  if (env.SHELL) add(env.SHELL);
  for (const p of ['/bin/bash', '/bin/sh', '/usr/bin/zsh']) add(p);
  return out;
}

/** Validate a user-configured `shells` allowlist from config.json. */
function fromConfig(list, warn) {
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !SHELL_ID_RE.test(e.id) || typeof e.cmd !== 'string' || !e.cmd) {
      if (warn) warn('ignoring invalid shell entry in config', { entry: e && e.id });
      continue;
    }
    if (out.some((s) => s.id === e.id)) continue;
    out.push({
      id: e.id,
      label: typeof e.label === 'string' && e.label ? e.label.slice(0, 64) : e.id,
      cmd: e.cmd,
      args: Array.isArray(e.args) ? e.args.map(String) : [],
      cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
    });
  }
  return out;
}

/**
 * Discover shells for this machine.
 * @returns {Promise<Array<{id:string,label:string,cmd:string,args:string[],default:boolean}>>}
 */
async function discoverShells({
  platform = process.platform, env = process.env, configured = null, defaultShell = '',
  exists = fs.existsSync, readFile = (p) => fs.readFileSync(p, 'utf8'), exec = run, warn = null,
} = {}) {
  let shells = configured ? fromConfig(configured, warn) : (platform === 'win32'
    ? await discoverWindows({ env, exists, exec })
    : discoverPosix({ env, exists, readFile }));

  let def = null;
  if (defaultShell) def = shells.find((s) => s.id === defaultShell) || null;
  if (!def && platform !== 'win32' && env.SHELL) def = shells.find((s) => s.cmd === env.SHELL || s.id === path.basename(env.SHELL)) || null;
  if (!def) def = shells.find((s) => s.id === (platform === 'win32' ? 'pwsh' : 'bash')) || shells[0] || null;

  const defId = def ? def.id : null;
  const ordered = defId ? shells.filter((s) => s.id === defId).concat(shells.filter((s) => s.id !== defId)) : shells;
  return ordered.map((s) => Object.assign({}, s, { default: s.id === defId }));
}

function findShell(shells, id) {
  if (!id) return shells.find((s) => s.default) || shells[0] || null;
  return shells.find((s) => s.id === id) || null;
}

/** Public shape sent to the relay (no command lines). */
function advertise(shells) {
  return shells.map((s) => ({ id: s.id, label: s.label, default: !!s.default }));
}

module.exports = { discoverShells, findShell, advertise, which, parseWslList, fromConfig, SHELL_ID_RE };
