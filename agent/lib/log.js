'use strict';

/*
 * JSON-lines logger for the agent. Secrets (tokens, pairing codes) and
 * terminal payloads never reach the log: redacted fields are replaced and
 * `data` is reduced to its length.
 *
 * Two sinks exist. The console sink is always there — it is what journald,
 * the Windows service supervisor and a foreground run all read. The file
 * sink (createFileSink) adds a rotating agent.log next to the state file, so
 * a machine that has been running unattended for a month can still explain
 * what happened without a log daemon.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };
const REDACT = new Set(['token', 'enrollToken', 'agentToken', 'deviceToken', 'code', 'authorization', 'password', 'secret']);

function sanitize(fields) {
  if (!fields) return undefined;
  const out = {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (REDACT.has(k)) out[k] = '[redacted]';
    else if (k === 'data') out.dataLen = typeof v === 'string' ? v.length : undefined;
    else if (v instanceof Error) out[k] = v.message;
    else out[k] = v;
  }
  return out;
}

function makeLogger(level, bound, sink = (line) => console.log(line)) {
  const threshold = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;
  const base = bound ? sanitize(bound) : {};
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] > threshold) return;
    sink(JSON.stringify(Object.assign({ t: new Date().toISOString(), level: lvl, comp: 'agent', msg }, base, sanitize(fields))));
  };
  return {
    level,
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    child: (fields) => makeLogger(level, Object.assign({}, bound, fields), sink),
  };
}

/* ------------------------------ file sink -------------------------------- */

/**
 * A size-rotating file sink: agent.log, agent.log.1, ... agent.log.<maxFiles-1>.
 *
 * Writes are synchronous on purpose. The volume is a handful of lines per
 * minute, and a crash or a `kill -9` must not lose the lines that explain it —
 * which is exactly what a buffered stream would do.
 */
function createFileSink({ dir, name = 'agent.log', maxBytes = 5 * 1024 * 1024, maxFiles = 5, mode = 0o600, onError } = {}) {
  const file = path.join(dir, name);
  let fd = null;
  let size = 0;
  let broken = null;

  const fail = (err) => {
    if (broken) return;                 // complain once, then stay quiet
    broken = err;
    if (onError) onError(err); else console.error(`[log] file logging disabled: ${err.message}`);
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } fd = null; }
  };

  const open = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(file, 'a', mode);
    size = fs.fstatSync(fd).size;
    if (process.platform !== 'win32') { try { fs.chmodSync(file, mode); } catch (_) { /* best effort */ } }
  };

  const rotate = () => {
    fs.closeSync(fd); fd = null;
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      try { fs.renameSync(from, `${file}.${i}`); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    open();
  };

  try { open(); } catch (err) { fail(err); }

  return {
    path: file,
    sink(line) {
      if (broken) return;
      try {
        const buf = Buffer.from(line + '\n', 'utf8');
        if (maxBytes > 0 && size + buf.length > maxBytes && size > 0) rotate();
        fs.writeSync(fd, buf);
        size += buf.length;
      } catch (err) { fail(err); }
    },
    close() {
      if (fd === null) return;
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
      fd = null;
    },
  };
}

/** Console plus (optionally) a file, so a service logs to both journald and disk. */
function tee(...sinks) {
  const live = sinks.filter(Boolean);
  return (line) => { for (const s of live) s(line); };
}

module.exports = { makeLogger, createFileSink, tee, LEVELS };
