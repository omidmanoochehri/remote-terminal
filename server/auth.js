'use strict';

/*
 * Authentication helpers (protocol v3).
 *
 * There is exactly one way to authenticate a WebSocket: a bearer token that
 * is either an agent token or a device token (see PROTOCOL.md §3). Enrolment
 * and pairing — the flows that *mint* those tokens — live in http.js and use
 * the enrolment token / pairing codes checked here.
 */

const { safeEqual } = require('./tokens');

const DEFAULT_ACCOUNT = 'default';

/** Bearer token from the Authorization header, else `token=` in the query. */
function bearerFromReq(req, url) {
  const h = req.headers['authorization'];
  if (h && /^Bearer\s+/i.test(h)) {
    const t = h.replace(/^Bearer\s+/i, '').trim();
    if (t) return t;
  }
  if (url) {
    const q = url.searchParams.get('token');
    if (q) return q;
  }
  return null;
}

/**
 * The client address used for per-IP limits. `X-Forwarded-For` is only
 * trusted behind a proxy the operator has declared (TRUST_PROXY=1), and then
 * only the address appended by that proxy (the last hop) — never the first,
 * which is attacker-controlled.
 */
function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Resolve the account an enrolment token grants. With no configured token the
 * relay runs in open-enrolment (development) mode and every enrolment lands
 * in the default account.
 * @returns {string|null} accountId
 */
function checkEnrollToken(cfg, token) {
  const accounts = cfg.accounts || [];
  if (!cfg.authToken && accounts.length === 0) return DEFAULT_ACCOUNT; // open enrolment (dev)
  if (!token) return null;
  if (cfg.authToken && safeEqual(token, cfg.authToken)) return DEFAULT_ACCOUNT;
  for (const acc of accounts) if (safeEqual(token, acc.enrollToken)) return acc.accountId;
  return null;
}

/**
 * Resolve a bearer token to a principal.
 * @returns {{kind:'agent'|'device', record:object}|null}
 */
function authenticate(registry, token) {
  if (!token || typeof token !== 'string' || token.length > 256) return null;
  const agent = registry.findAgentByToken(token);
  if (agent) return { kind: 'agent', record: agent };
  const device = registry.findDeviceByToken(token);
  if (device) return { kind: 'device', record: device };
  return null;
}

module.exports = { bearerFromReq, clientIp, checkEnrollToken, authenticate, DEFAULT_ACCOUNT };
