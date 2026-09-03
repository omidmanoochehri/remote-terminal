'use strict';

/*
 * A tiny structured (JSON-lines) logger. Kept dependency-free so the relay
 * needs only `ws`. Each record is one JSON object per line: easy to grep, ship
 * to a log collector, or pretty-print with `| npx pino-pretty`-style tools.
 *
 * Secrets never reach the log: any field in REDACT is replaced by "[redacted]"
 * and terminal payloads (`data`) are replaced by their length.
 */

const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };

// Fields whose values must never be logged verbatim.
const REDACT = new Set([
  'token', 'authToken', 'enrollToken', 'agentToken', 'deviceToken',
  'pair', 'code', 'password', 'authorization', 'secret',
]);

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

function makeLogger(level, bound) {
  const threshold = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;
  const base = bound ? sanitize(bound) : {};
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] > threshold) return;
    const rec = Object.assign({ t: new Date().toISOString(), level: lvl, msg }, base, sanitize(fields));
    console.log(JSON.stringify(rec));
  };
  return {
    level,
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    /** A logger that always includes `fields` (e.g. connId, agentId). */
    child: (fields) => makeLogger(level, Object.assign({}, bound, fields)),
  };
}

module.exports = { makeLogger, REDACT, sanitize };
