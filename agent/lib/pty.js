'use strict';

/*
 * Terminal process abstraction: a real PTY via node-pty (ConPTY on Windows,
 * forkpty on Linux/macOS) when available, else a piped child process so the
 * agent still works — without resize or full-screen programs.
 *
 * Both flavours expose the same small interface:
 *   { mode, pid, write(data), resize(cols, rows), kill(), pause(), resume(),
 *     onData(cb), onExit(cb) }
 */

const { StringDecoder } = require('string_decoder');

let ptyModule;
let ptyError = null;
function loadPty() {
  if (ptyModule !== undefined) return ptyModule;
  try { ptyModule = require('@homebridge/node-pty-prebuilt-multiarch'); } catch (err) { ptyModule = null; ptyError = err; }
  return ptyModule;
}

/** Whether a real PTY backend is available (used by --doctor). */
function ptyAvailable() {
  return { available: !!loadPty(), error: ptyError ? ptyError.message : null };
}

function spawnPty({ cmd, args = [], cwd, env, cols = 80, rows = 24, forcePipe = false }) {
  const pty = forcePipe ? null : loadPty();
  if (pty) {
    const term = pty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, cwd, env });
    let exited = false;
    return {
      mode: 'pty',
      pid: term.pid,
      write: (d) => { if (!exited) term.write(d); },
      resize: (c, r) => { if (!exited) term.resize(c, r); },
      kill: () => {
        if (exited) return;
        try { term.kill(); } catch (_) { /* already gone */ }
        if (process.platform !== 'win32') {
          setTimeout(() => { if (!exited) { try { process.kill(term.pid, 'SIGKILL'); } catch (_) { /* gone */ } } }, 3000).unref();
        }
      },
      pause: () => { try { term.pause(); } catch (_) { /* older node-pty */ } },
      resume: () => { try { term.resume(); } catch (_) { /* older node-pty */ } },
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(({ exitCode }) => { exited = true; cb(exitCode == null ? 0 : exitCode); }),
    };
  }

  // Fallback: plain pipes. Multi-byte characters may straddle reads, so decode statefully.
  const { spawn } = require('child_process');
  const child = spawn(cmd, args.concat(process.platform === 'win32' ? [] : ['-i']), {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd, env,
  });
  const outDec = new StringDecoder('utf8');
  const errDec = new StringDecoder('utf8');
  const dataCbs = [];
  const exitCbs = [];
  let exited = false;
  child.stdout.on('data', (b) => { const s = outDec.write(b); if (s) for (const cb of dataCbs) cb(s); });
  child.stderr.on('data', (b) => { const s = errDec.write(b); if (s) for (const cb of dataCbs) cb(s); });
  child.on('exit', (code) => { exited = true; for (const cb of exitCbs) cb(code == null ? 0 : code); });
  child.on('error', () => { if (!exited) { exited = true; for (const cb of exitCbs) cb(127); } });
  return {
    mode: 'pipe',
    pid: child.pid,
    write: (d) => { if (!exited) { try { child.stdin.write(d); } catch (_) { /* closed */ } } },
    resize: () => {},
    kill: () => { if (!exited) { try { child.kill(); } catch (_) { /* gone */ } } },
    pause: () => { try { child.stdout.pause(); child.stderr.pause(); } catch (_) { /* ignore */ } },
    resume: () => { try { child.stdout.resume(); child.stderr.resume(); } catch (_) { /* ignore */ } },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
}

module.exports = { spawnPty, ptyAvailable };
