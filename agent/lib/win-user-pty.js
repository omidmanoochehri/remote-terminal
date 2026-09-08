'use strict';

/*
 * Windows terminals that belong to the person signed in, not to the service.
 *
 * The agent runs as a Windows service so a phone can reach the machine before
 * anyone signs in. A service is LocalSystem, so node-pty — which builds the
 * pseudoconsole inside this process — hands every terminal SYSTEM's profile:
 * %USERPROFILE% is C:\Windows\system32\config\systemprofile, PATH is the
 * machine's, and none of the user's PowerShell profile, git config, npm, ssh
 * keys or Documents is in reach.
 *
 * `remote-terminal-shell.exe` fixes that: it borrows the signed-in user's
 * token and builds the pseudoconsole in *their* session, then talks to us over
 * ordinary pipes. Its stdout is the terminal's output, raw. Its stdin is
 * framed, because it has to carry resizes as well as keystrokes:
 *
 *     0x01  len:u32le  payload      bytes for the shell
 *     0x02  cols:u16le rows:u16le   the window changed size
 *
 * The decoder is agent/windows/src/frame.rs; keep the two in step.
 *
 * Everything here is a no-op off Windows, and the agent falls back to node-pty
 * whenever the launcher is missing or says it cannot reach a user.
 */

const fs = require('fs');
const path = require('path');
const { spawn: spawnChild, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const FRAME_DATA = 1;
const FRAME_RESIZE = 2;

/** Variables the launcher must set for us; the rest of the environment is the user's own. */
const PASSED_THROUGH = ['TERM', 'COLORTERM'];

/** How long to wait for `--probe` before deciding the launcher is not usable. */
const PROBE_TIMEOUT_MS = 10_000;

/* --------------------------------- framing -------------------------------- */

function frameData(data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = FRAME_DATA;
  frame.writeUInt32LE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function frameResize(cols, rows) {
  const frame = Buffer.allocUnsafe(5);
  frame[0] = FRAME_RESIZE;
  frame.writeUInt16LE(Math.max(1, Math.min(65535, cols | 0)), 1);
  frame.writeUInt16LE(Math.max(1, Math.min(65535, rows | 0)), 3);
  return frame;
}

/* -------------------------------- discovery ------------------------------- */

/**
 * Is this process running under the LocalSystem profile? That — not "am I a
 * service" — is the thing worth reacting to: it is exactly the case where a
 * shell would get the wrong home directory.
 */
function underSystemProfile(env = process.env) {
  const profile = String(env.USERPROFILE || '');
  if (/[\\/]config[\\/]systemprofile$/i.test(profile)) return true;
  return String(env.USERNAME || '').toUpperCase() === 'SYSTEM';
}

/**
 * Where the launcher is. The installer puts it next to index.js; a checkout
 * has it wherever cargo left it.
 * @param {{configured?:string, agentDir?:string, exists?:Function}} opts
 */
function findLauncher({ configured = '', agentDir = path.join(__dirname, '..'), exists = fs.existsSync } = {}) {
  const candidates = configured ? [configured] : [
    path.join(agentDir, 'remote-terminal-shell.exe'),
    path.join(agentDir, 'windows', 'target', 'release', 'remote-terminal-shell.exe'),
    path.join(agentDir, 'windows', 'target', 'debug', 'remote-terminal-shell.exe'),
  ];
  return candidates.find((p) => exists(p)) || null;
}

/**
 * Ask the launcher what it can do, without starting a terminal. Never throws:
 * anything that goes wrong is an answer of `{ ok: false }`.
 * @returns {Promise<{ok:boolean, as?:string, user?:string, cwd?:string, session?:number, error?:string}>}
 */
function probe(launcher, { run = execFile, timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      run(launcher, ['--probe'], { timeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err && !stderr) return finish({ ok: false, error: err.message });
        const line = statusLine(String(stderr || ''));
        if (!line) return finish({ ok: false, error: 'the launcher said nothing' });
        finish(line);
      });
    } catch (err) {
      finish({ ok: false, error: err.message });
    }
  });
}

/** The launcher's own JSON line out of whatever else is on stderr. */
function statusLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('"launch"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.launch === 'remote-terminal-shell') return parsed;
    } catch (_) { /* not ours, or half a line */ }
  }
  return null;
}

/* --------------------------------- spawning ------------------------------- */

/**
 * Start one shell through the launcher. Returns the same handle shape as
 * pty.js, plus `onReady(cb)` for the line the launcher sends once it knows
 * whose terminal this turned out to be.
 */
function spawnUserPty({ launcher, runAs = 'auto', cmd, args = [], cwd, env = {}, cols = 80, rows = 24, log = null }) {
  const argv = ['--run-as', runAs, '--cols', String(cols), '--rows', String(rows)];
  if (cwd) argv.push('--cwd', cwd);
  for (const name of PASSED_THROUGH) {
    if (env[name] != null) argv.push('--env', `${name}=${env[name]}`);
  }
  argv.push('--', cmd, ...args.map(String));

  const child = spawnChild(launcher, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  const decoder = new StringDecoder('utf8');
  const dataCbs = [];
  const exitCbs = [];
  const readyCbs = [];
  let exited = false;
  let ready = null;
  let notices = '';

  child.stdout.on('data', (b) => { const s = decoder.write(b); if (s) for (const cb of dataCbs) cb(s); });

  // stderr is the launcher's, never the shell's: one status line, then
  // anything that went wrong. A shell's own stderr goes through the console.
  child.stderr.on('data', (b) => {
    notices += b.toString('utf8');
    const lines = notices.split(/\r?\n/);
    notices = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = !ready && statusLine(line);
      if (parsed) {
        ready = parsed;
        // A refusal is the launcher's only way to say "runAsUser is 'always'
        // and nobody is signed in"; without this the session just vanishes.
        if (!parsed.ok && log) log.error('cannot start this terminal', { err: parsed.error, cmd });
        for (const cb of readyCbs) cb(parsed);
      } else if (log) {
        log.warn('shell launcher', { line: line.slice(0, 400) });
      }
    }
  });

  const finish = (code) => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(code == null ? 0 : code);
  };
  child.on('exit', (code) => finish(code));
  child.on('error', (err) => {
    if (log) log.error('cannot start the shell launcher', { launcher, err: err.message });
    finish(127);
  });

  const send = (buf) => {
    if (exited) return;
    try { child.stdin.write(buf); } catch (_) { /* closed under us */ }
  };

  return {
    mode: 'pty',
    /** How this terminal ended up running; filled in by the launcher's first line. */
    get launched() { return ready; },
    pid: child.pid,
    write: (d) => send(frameData(d)),
    resize: (c, r) => send(frameResize(c, r)),
    kill: () => { if (!exited) { try { child.kill(); } catch (_) { /* gone */ } } },
    pause: () => { try { child.stdout.pause(); } catch (_) { /* ignore */ } },
    resume: () => { try { child.stdout.resume(); } catch (_) { /* ignore */ } },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    onReady: (cb) => { readyCbs.push(cb); if (ready) cb(ready); },
  };
}

/* ------------------------------- the decision ----------------------------- */

/**
 * Decide, once at startup, how this machine will start shells.
 *
 * `runAsUser` is "auto" (use the signed-in user when the agent would otherwise
 * hand out SYSTEM's profile), "always" (insist on it — sessions fail when
 * nobody is signed in) or "never" (the old behaviour).
 *
 * @returns {Promise<{spawn:Function, how:string, launcher:string|null, detail:object|null}>}
 */
async function chooseSpawner({
  cfg, log = null, fallback, platform = process.platform, env = process.env,
  probeWith = probe, findWith = findLauncher,
} = {}) {
  const mode = cfg.runAsUser === 'always' || cfg.runAsUser === 'never' ? cfg.runAsUser : 'auto';
  const plain = { spawn: fallback, how: 'this account', launcher: null, detail: null };

  if (platform !== 'win32' || mode === 'never') return plain;
  if (mode === 'auto' && !underSystemProfile(env)) {
    // The agent already has a profile of its own; going through the launcher
    // would add a process per terminal and change nothing.
    return plain;
  }

  const launcher = findWith({ configured: cfg.shellLauncher });
  if (!launcher) {
    const message = 'terminals will run as this account: remote-terminal-shell.exe was not found next to the agent';
    if (mode === 'always') throw new Error(message);
    if (log) log.warn(message, { runAsUser: mode });
    return plain;
  }

  const answer = await probeWith(launcher);
  if (!answer.ok && mode === 'always') {
    throw new Error(`terminals cannot run as the signed-in user: ${answer.error || 'unknown reason'}`);
  }
  if (!answer.ok && log) {
    // Worth saying out loud: with nobody signed in, "auto" still gives out
    // SYSTEM shells, which is not what the operator asked for.
    log.warn('no signed-in user to run terminals as; they will run as this account until someone signs in', { reason: answer.error });
  }

  const runAs = mode === 'always' ? 'user' : 'auto';
  return {
    spawn: (opts) => spawnUserPty(Object.assign({ launcher, runAs, log }, opts)),
    how: answer.ok ? `the signed-in user (${answer.user})` : 'the signed-in user when there is one',
    launcher,
    detail: answer,
  };
}

module.exports = {
  chooseSpawner, spawnUserPty, probe, findLauncher, underSystemProfile, statusLine, frameData, frameResize,
};
