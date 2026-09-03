'use strict';

/*
 * Plain HTTP surface of the relay: health/stats plus the identity endpoints
 * that mint credentials (PROTOCOL.md §2). Keeping these as request/response
 * makes enrolment atomic and lets the WebSocket have a single auth path.
 */

const { RateLimiter } = require('./limits');
const { bearerFromReq, clientIp, checkEnrollToken, authenticate } = require('./auth');
const { ERR, cleanName, isShort, PROTOCOL_VERSION } = require('./protocol');

const MAX_BODY = 8 * 1024;

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

function fail(res, status, code, message) { json(res, status, { error: code, message }); }

/** Read a small JSON body. Resolves to an object, or null on any problem. */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { done = true; resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (size === 0) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
      } catch (_) { resolve(null); }
    });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

function createHttpHandler({ cfg, log, registry, pairing, router, stats }) {
  const enrollLimiter = new RateLimiter({ limit: cfg.pairing.enrollPerIpPerMin, windowMs: 60_000 });
  const pairIpLimiter = new RateLimiter({ limit: cfg.pairing.perIpPerMin, windowMs: 60_000, lockoutMs: cfg.pairing.lockoutSec * 1000 });
  const pairGlobal = new RateLimiter({ limit: cfg.pairing.globalPerMin, windowMs: 60_000, lockoutMs: cfg.pairing.globalLockoutSec * 1000 });
  const GLOBAL = 'global';
  let warnedOpenEnroll = false;

  async function enroll(req, res, ip) {
    if (!enrollLimiter.hit(ip).ok) return fail(res, 429, ERR.RATE_LIMITED, 'too many enrolment attempts');
    const accountId = checkEnrollToken(cfg, bearerFromReq(req));
    if (!accountId) {
      log.warn('enrolment rejected', { ip, reason: 'bad enrolment token' });
      return fail(res, 401, ERR.UNAUTHORIZED, 'invalid enrolment token');
    }
    if (!cfg.authToken && !warnedOpenEnroll) {
      warnedOpenEnroll = true;
      log.warn('OPEN ENROLMENT: no ENROLL_TOKEN configured — any host can register an agent. Set ENROLL_TOKEN before exposing this relay.');
    }
    const body = await readJson(req);
    if (!body) return fail(res, 400, ERR.BAD_REQUEST, 'invalid JSON body');
    if (registry.countAgents(accountId) >= cfg.limits.maxAgentsPerAccount) return fail(res, 403, ERR.LIMIT, 'too many agents in this account');
    const name = body.name === undefined ? undefined : cleanName(body.name);
    if (body.name !== undefined && !name) return fail(res, 400, ERR.BAD_REQUEST, 'invalid name');
    const meta = {};
    for (const [k, max] of [['hostname', 255], ['platform', 16], ['os', 128], ['arch', 32], ['agentVersion', 32]]) {
      if (body[k] !== undefined) {
        if (!isShort(body[k], max)) return fail(res, 400, ERR.BAD_REQUEST, `invalid ${k}`);
        meta[k] = body[k];
      }
    }
    if (body.protocol !== undefined && body.protocol !== PROTOCOL_VERSION) return fail(res, 400, ERR.UNSUPPORTED_VERSION, 'unsupported protocol version');
    const { record, token } = registry.createAgent(Object.assign({ accountId, name, protocol: PROTOCOL_VERSION }, meta));
    log.info('agent enrolled', { agentId: record.agentId, accountId, ip, hostname: record.hostname, platform: record.platform });
    return json(res, 201, { agentId: record.agentId, agentToken: token, accountId, name: record.name });
  }

  function principalFrom(req) {
    return authenticate(registry, bearerFromReq(req));
  }

  async function pairCode(req, res, ip) {
    const p = principalFrom(req);
    if (!p) return fail(res, 401, ERR.UNAUTHORIZED, 'invalid token');
    const issuedBy = p.kind === 'agent' ? p.record.agentId : p.record.deviceId;
    const minted = pairing.mint({ accountId: p.record.accountId, issuedBy });
    log.info('pairing code issued', { accountId: p.record.accountId, issuedBy, ip, ttlSec: minted.ttlSec });
    const out = { code: minted.code, expiresAt: minted.expiresAt, ttlSec: minted.ttlSec };
    if (cfg.publicUrl) out.relayUrl = cfg.publicUrl;
    return json(res, 201, out);
  }

  async function pairRedeem(req, res, ip) {
    if (pairGlobal.isLocked(GLOBAL)) return fail(res, 429, ERR.RATE_LIMITED, 'pairing temporarily disabled');
    const lim = pairIpLimiter.hit(ip);
    if (!lim.ok) {
      log.warn('pairing rate limited', { ip, retryAfterMs: lim.retryAfterMs });
      return fail(res, 429, ERR.RATE_LIMITED, 'too many pairing attempts');
    }
    const body = await readJson(req);
    if (!body || typeof body.code !== 'string') return fail(res, 400, ERR.BAD_REQUEST, 'code is required');
    const deviceName = body.deviceName === undefined ? undefined : cleanName(body.deviceName);
    if (body.deviceName !== undefined && !deviceName) return fail(res, 400, ERR.BAD_REQUEST, 'invalid deviceName');
    for (const k of ['platform', 'appVersion']) if (body[k] !== undefined && !isShort(body[k], 64)) return fail(res, 400, ERR.BAD_REQUEST, `invalid ${k}`);

    const r = pairing.redeem(body.code.trim());
    if (!r.ok) {
      pairGlobal.hit(GLOBAL);
      log.warn('pairing failed', { ip });
      return fail(res, 401, ERR.UNAUTHORIZED, 'invalid or expired pairing code');
    }
    if (registry.countDevices(r.accountId) >= cfg.limits.maxDevicesPerAccount) return fail(res, 403, ERR.LIMIT, 'too many devices in this account');
    const { record, token } = registry.createDevice({
      accountId: r.accountId, name: deviceName, platform: body.platform, appVersion: body.appVersion, pairedVia: r.issuedBy,
    });
    pairIpLimiter.reset(ip);
    log.info('device paired', { deviceId: record.deviceId, accountId: r.accountId, pairedVia: r.issuedBy, ip });
    return json(res, 201, { deviceId: record.deviceId, deviceToken: token, accountId: r.accountId });
  }

  async function agentsMe(req, res) {
    const p = principalFrom(req);
    if (!p || p.kind !== 'agent') return fail(res, 401, ERR.UNAUTHORIZED, 'invalid agent token');
    if (req.method === 'GET') return json(res, 200, registry.agentInfo(p.record.agentId, { withSessions: false }));
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (!body) return fail(res, 400, ERR.BAD_REQUEST, 'invalid JSON body');
      const name = cleanName(body.name);
      if (!name) return fail(res, 400, ERR.BAD_REQUEST, 'invalid name');
      registry.renameAgent(p.record.agentId, name);
      router.agentRenamed(p.record.agentId, name);
      return json(res, 200, registry.agentInfo(p.record.agentId, { withSessions: false }));
    }
    return fail(res, 405, ERR.BAD_REQUEST, 'method not allowed');
  }

  return async function handler(req, res) {
    const ip = clientIp(req, cfg);
    let pathname;
    try { pathname = new URL(req.url, 'http://relay').pathname; } catch (_) { pathname = '/'; }
    try {
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('ok');
      }
      if (pathname === '/stats') return json(res, 200, stats());
      if (pathname === '/v3/enroll' && req.method === 'POST') return await enroll(req, res, ip);
      if (pathname === '/v3/pair/code' && req.method === 'POST') return await pairCode(req, res, ip);
      if (pathname === '/v3/pair/redeem' && req.method === 'POST') return await pairRedeem(req, res, ip);
      if (pathname === '/v3/agents/me') return await agentsMe(req, res);
      if (pathname.startsWith('/v3/')) return fail(res, 404, ERR.NOT_FOUND, 'no such endpoint');
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      return res.end('Upgrade Required: connect with a WebSocket (protocol v3)');
    } catch (err) {
      log.error('http handler failure', { path: pathname, err: err.message });
      if (!res.headersSent) return fail(res, 500, ERR.INTERNAL, 'internal error');
      return res.end();
    }
  };
}

module.exports = { createHttpHandler, readJson };
