'use strict';

/*
 * Remote Terminal — Windows agent.
 *
 * Connects out to the relay server as role=agent, spawns a real terminal
 * (ConPTY via node-pty when available, otherwise a piped child process), and
 * bridges the phone's input to the shell and the shell's output back.
 *
 * Config via env or CLI flags:
 *   SERVER   ws://host:port          (default ws://127.0.0.1:8080)
 *   ROOM     pairing token           (default "demo")
 *   SHELL    shell to launch         (default powershell.exe)
 *
 * See ../PROTOCOL.md for the wire format.
 */

const WebSocket = require('ws');

const SERVER = process.env.SERVER || 'ws://127.0.0.1:8080';
const ROOM = process.env.ROOM || 'demo';
const SHELL = process.env.SHELL_CMD || (process.platform === 'win32' ? 'powershell.exe' : 'bash');

function log(...a) { console.log(new Date().toISOString(), '[agent]', ...a); }

/* -------------------------------------------------------------------------- */
/* Terminal abstraction: prefer a true PTY, fall back to piped child process. */
/* -------------------------------------------------------------------------- */

function createTerminal({ onData, onExit }) {
  // 1) Try node-pty (real ConPTY: interactive apps, colors, resize all work).
  try {
    const pty = require('@homebridge/node-pty-prebuilt-multiarch');
    const term = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.env.HOME || process.env.USERPROFILE || process.cwd(),
      env: process.env,
    });
    log(`spawned PTY: ${SHELL} (pid ${term.pid})`);
    term.onData(onData);
    term.onExit(({ exitCode }) => onExit(exitCode));
    return {
      mode: 'pty',
      write: (d) => term.write(d),
      resize: (cols, rows) => { try { term.resize(cols, rows); } catch (_) {} },
      kill: () => { try { term.kill(); } catch (_) {} },
    };
  } catch (err) {
    log('node-pty unavailable, falling back to piped child process:', err.message);
  }

  // 2) Fallback: plain piped process. No true TTY (some interactive programs
  //    won't behave), but proves the pipeline end to end.
  const { spawn } = require('child_process');
  const args = process.platform === 'win32' ? [] : ['-i'];
  const child = spawn(SHELL, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  log(`spawned child process: ${SHELL} (pid ${child.pid})`);
  child.stdout.on('data', (b) => onData(b.toString('utf8')));
  child.stderr.on('data', (b) => onData(b.toString('utf8')));
  child.on('exit', (code) => onExit(code == null ? 0 : code));
  return {
    mode: 'pipe',
    write: (d) => { try { child.stdin.write(d); } catch (_) {} },
    resize: () => {},
    kill: () => { try { child.kill(); } catch (_) {} },
  };
}

/* -------------------------------------------------------------------------- */
/* Relay connection with auto-reconnect.                                      */
/* -------------------------------------------------------------------------- */

function connect() {
  const url = `${SERVER}/?role=agent&room=${encodeURIComponent(ROOM)}`;
  log(`connecting to ${url}`);
  const ws = new WebSocket(url);
  let term = null;

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function ensureTerminal() {
    if (term) return;
    term = createTerminal({
      onData: (data) => send({ type: 'output', data }),
      onExit: (code) => {
        send({ type: 'exit', code });
        log(`shell exited (${code})`);
        term = null;
      },
    });
  }

  ws.on('open', () => {
    log('connected to relay, room =', ROOM);
    ensureTerminal();
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    switch (msg.type) {
      case 'welcome':
        log('welcome:', JSON.stringify(msg));
        break;
      case 'status':
        log('phone', msg.peer);
        if (msg.peer === 'connected') ensureTerminal();
        break;
      case 'input':
        ensureTerminal();
        if (typeof msg.data === 'string') term.write(msg.data);
        break;
      case 'resize':
        ensureTerminal();
        term.resize(msg.cols | 0, msg.rows | 0);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    log('relay connection closed; reconnecting in 3s');
    if (term) { term.kill(); term = null; }
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => log('socket error:', err.message));
}

connect();
