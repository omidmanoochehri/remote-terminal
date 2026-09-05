/**
 * What `platform.js` becomes inside the end-to-end harness: the same exported
 * surface, backed by Node instead of Rust.
 *
 * The relay socket is the `ws` client the server's own tests use — the point of
 * the harness is to prove the *client protocol code* against a real relay, not
 * to re-test the socket. Storage is in memory: a harness that wrote to the real
 * app's configuration directory could clobber a running install.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// `ws` lives in the server's dependencies; the desktop app itself has none.
const WebSocket = require(path.join(here, '..', '..', 'server', 'node_modules', 'ws'));

export const inShell = true;

/* ------------------------------- listeners ------------------------------- */

const listeners = new Map();

function emit(event, payload) {
  for (const handler of listeners.get(event) ?? []) handler({ payload });
}

export function listen(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return Promise.resolve(() => listeners.get(event).delete(handler));
}

export function invoke(command) {
  return Promise.reject(new Error(`no test implementation for ${command}`));
}

/* -------------------------------- storage -------------------------------- */

const files = new Map();

export const store = {
  read: (name) => Promise.resolve(files.get(name) ?? null),
  write: (name, contents) => { files.set(name, contents); return Promise.resolve(); },
  remove: (name) => { files.delete(name); return Promise.resolve(); },
  configDirectory: () => Promise.resolve('(in memory)'),
};

export const credentialStore = {
  load: () => Promise.resolve(globalThis.__rtTestCredentials ?? null),
  save: (credentials) => { globalThis.__rtTestCredentials = credentials; return Promise.resolve(); },
  clear: () => { globalThis.__rtTestCredentials = null; return Promise.resolve(); },
};

/* --------------------------------- socket -------------------------------- */

let nextId = 0;
const sockets = new Map();

export const socket = {
  connect(url, token) {
    const id = ++nextId;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    sockets.set(id, ws);
    ws.on('open', () => emit('ws:open', { id }));
    ws.on('message', (data) => emit('ws:text', { id, data: String(data) }));
    ws.on('error', (err) => emit('ws:error', { id, message: String(err && err.message) }));
    ws.on('close', (code, reason) => {
      sockets.delete(id);
      emit('ws:close', { id, code: code || 1006, reason: String(reason ?? ''), remote: true });
    });
    return Promise.resolve(id);
  },
  send(id, text) {
    const ws = sockets.get(id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('socket closed'));
    ws.send(text);
    return Promise.resolve();
  },
  close(id, code, reason) {
    const ws = sockets.get(id);
    if (ws) {
      sockets.delete(id);
      try { ws.close(code, reason); } catch { /* already closing */ }
      // `ws` does not always deliver 'close' for a locally requested close in
      // time for the harness, so report it the way Rust does.
      emit('ws:close', { id, code, reason: reason ?? '', remote: false });
    }
    return Promise.resolve();
  },
};

export const relayHttp = {
  async redeem(relayUrl, code, deviceName, appVersion) {
    const base = relayUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
    const res = await fetch(`${base}/v3/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, platform: 'windows', appVersion }),
    });
    const body = await res.json();
    if (res.status !== 201) throw new Error(body.message || body.error || `HTTP ${res.status}`);
    return body;
  },
  async pairCode(relayUrl, deviceToken) {
    const base = relayUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
    const res = await fetch(`${base}/v3/pair/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
      body: '{}',
    });
    const body = await res.json();
    if (res.status !== 201) throw new Error(body.message || body.error || `HTTP ${res.status}`);
    return body;
  },
};

/* -------------------------------- platform ------------------------------- */

export const system = {
  readFileForUpload: () => Promise.reject(new Error('not available in the harness')),
  clipboardRead: () => Promise.resolve({ text: '', files: [], hasImage: false }),
  clipboardReadImage: () => Promise.resolve(null),
  clipboardWriteText: () => Promise.resolve(),
  setKeepAwake: () => Promise.resolve(),
  appLockAvailable: () => Promise.resolve(false),
  appLockPrompt: () => Promise.resolve(true),
};

export function pickFile() { return Promise.resolve(null); }
export function notify() { return Promise.resolve(); }
export function currentWindow() { return null; }
export function setWindowTitle() { return Promise.resolve(); }
