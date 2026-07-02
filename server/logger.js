'use strict';

/*
 * A tiny structured (JSON-lines) logger. Kept dependency-free so the relay
 * needs only `ws`. Each record is one JSON object per line: easy to grep, ship
 * to a log collector, or pretty-print with `| npx pino-pretty`-style tools.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Fields whose values should never be logged verbatim.
const REDACT = new Set(['token', 'authToken', 'pair', 'password']);

function redact(fields) {
  if (!fields) return undefined;
  const out = {};
  for (const k of Object.keys(fields)) out[k] = REDACT.has(k) ? '[redacted]' : fields[k];
  return out;
}

function makeLogger(level) {
  const threshold = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] > threshold) return;
    const rec = Object.assign({ t: new Date().toISOString(), level: lvl, msg }, redact(fields));
    console.log(JSON.stringify(rec));
  };
  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
  };
}

module.exports = { makeLogger };
