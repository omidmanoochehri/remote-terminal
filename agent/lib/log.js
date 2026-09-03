'use strict';

/*
 * JSON-lines logger for the agent. Secrets (tokens, pairing codes) and
 * terminal payloads never reach the log: redacted fields are replaced and
 * `data` is reduced to its length.
 */

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

module.exports = { makeLogger, LEVELS };
