'use strict';

/*
 * HTTPS calls to the relay's identity endpoints (PROTOCOL.md §2): enrolment,
 * pairing codes and agent metadata. Used by the CLI (--enroll, --pair,
 * --status, --name) and by the first-run auto-enrolment.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** ws(s):// relay URL -> http(s):// base for the REST endpoints. */
function httpBase(serverUrl) {
  const u = new URL(serverUrl);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported relay URL scheme: ${u.protocol}`);
  u.pathname = u.pathname.replace(/\/+$/, '');
  u.search = '';
  u.hash = '';
  return u;
}

function request(serverUrl, method, pathname, body, token, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = httpBase(serverUrl); } catch (err) { return reject(err); }
    const url = new URL(base.href.replace(/\/+$/, '') + pathname);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers.Authorization = `Bearer ${token}`;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { error: 'bad_response', message: text.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fail(res, what) {
  const msg = res.body && (res.body.message || res.body.error) ? `${res.body.error || ''} ${res.body.message || ''}`.trim() : `HTTP ${res.status}`;
  const err = new Error(`${what} failed: ${msg}`);
  err.status = res.status;
  err.code = res.body && res.body.error;
  return err;
}

async function enroll(serverUrl, enrollToken, meta) {
  const res = await request(serverUrl, 'POST', '/v3/enroll', meta, enrollToken || undefined);
  if (res.status !== 201) throw fail(res, 'enrolment');
  return res.body;
}

async function pairCode(serverUrl, agentToken) {
  const res = await request(serverUrl, 'POST', '/v3/pair/code', {}, agentToken);
  if (res.status !== 201) throw fail(res, 'pairing code request');
  return res.body;
}

async function agentInfo(serverUrl, agentToken) {
  const res = await request(serverUrl, 'GET', '/v3/agents/me', undefined, agentToken);
  if (res.status !== 200) throw fail(res, 'status request');
  return res.body;
}

async function setName(serverUrl, agentToken, name) {
  const res = await request(serverUrl, 'PATCH', '/v3/agents/me', { name }, agentToken);
  if (res.status !== 200) throw fail(res, 'rename');
  return res.body;
}

module.exports = { httpBase, request, enroll, pairCode, agentInfo, setName };
