'use strict';

/*
 * Protocol v3 constants and message validation.
 *
 * The relay validates only what security or routing requires: types, ids,
 * dimensions and sizes. Terminal payloads (`data`) are opaque beyond their
 * type and length. See ../PROTOCOL.md.
 */

const { isId } = require('./tokens');

const PROTOCOL_VERSION = 3;

const CLOSE = {
  UNAUTHORIZED: 4401,
  REPLACED: 4409,
  UPGRADE_REQUIRED: 4426,
  RATE_LIMITED: 4429,
  LIMIT: 4503,
};

const ERR = {
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  AGENT_OFFLINE: 'agent_offline',
  UNKNOWN_SESSION: 'unknown_session',
  RATE_LIMITED: 'rate_limited',
  LIMIT: 'limit_reached',
  UNSUPPORTED_VERSION: 'unsupported_version',
  INTERNAL: 'internal',
};

const REQ_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SHELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const CONTROL_RE = /[\x00-\x1F\x7F]/;
const MAX_COLS = 500;
const MAX_ROWS = 300;
const MAX_NAME = 64;
const PLATFORMS = new Set(['win32', 'linux', 'darwin']);
const SESSION_STATES = new Set(['running', 'exited']);
const CLOSE_REASONS = new Set(['closed', 'exited', 'idle', 'shutdown', 'limit']);
// File transfer (phone -> agent): a pasted image or other small file.
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]{1,32}\/[A-Za-z0-9!#$&^_.+-]{1,32}$/;
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]*$/;
// Anything that could escape the upload directory or confuse a shell.
const FILENAME_BAD_RE = /[\/\\]|^\.\.?$/;

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isDims = (m) => isInt(m.cols, 1, MAX_COLS) && isInt(m.rows, 1, MAX_ROWS);
const isReqId = (v) => v === undefined || (typeof v === 'string' && REQ_ID_RE.test(v));
const isShort = (v, max = MAX_NAME) => typeof v === 'string' && v.length >= 1 && v.length <= max && !CONTROL_RE.test(v);
const optShort = (v, max = MAX_NAME) => v === undefined || isShort(v, max);

/** Trim and bound a display name; returns null when unusable. */
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || s.length > MAX_NAME || CONTROL_RE.test(s)) return null;
  return s;
}

function bad(message) { return { ok: false, message }; }
const OK = { ok: true };

/** Validate a SessionInfo object announced by an agent. */
function validSessionInfo(s) {
  return !!s && typeof s === 'object' && isId(s.sessionId, 's') && optShort(s.title)
    && (s.shell === undefined || (typeof s.shell === 'string' && SHELL_ID_RE.test(s.shell)))
    && (s.state === undefined || SESSION_STATES.has(s.state))
    && (s.cols === undefined || isInt(s.cols, 1, MAX_COLS)) && (s.rows === undefined || isInt(s.rows, 1, MAX_ROWS))
    && (s.seq === undefined || isInt(s.seq, 0, Number.MAX_SAFE_INTEGER));
}

/** @returns {{ok:boolean, message?:string}} */
function validatePhoneMessage(m, limits) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('message must be an object');
  if (typeof m.type !== 'string') return bad('missing type');
  if (!isReqId(m.reqId)) return bad('invalid reqId');
  switch (m.type) {
    case 'ping':
    case 'agent.list':
    case 'device.list':
      return OK;
    case 'agent.rename':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!cleanName(m.name)) return bad('invalid name');
      return OK;
    case 'agent.remove':
      return isId(m.agent, 'a') ? OK : bad('invalid agent');
    case 'device.rename':
      if (m.device !== undefined && !isId(m.device, 'd')) return bad('invalid device');
      if (!cleanName(m.name)) return bad('invalid name');
      return OK;
    case 'device.revoke':
      return isId(m.device, 'd') ? OK : bad('invalid device');
    case 'session.create':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (m.shell !== undefined && !(typeof m.shell === 'string' && SHELL_ID_RE.test(m.shell))) return bad('invalid shell');
      if (!isDims(m)) return bad('invalid cols/rows');
      if (m.title !== undefined && !cleanName(m.title)) return bad('invalid title');
      return OK;
    case 'session.attach':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (m.since !== undefined && !isInt(m.since, 0, Number.MAX_SAFE_INTEGER)) return bad('invalid since');
      if (!isDims(m)) return bad('invalid cols/rows');
      return OK;
    case 'session.detach':
    case 'session.close':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      return OK;
    case 'session.rename':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (!cleanName(m.title)) return bad('invalid title');
      return OK;
    case 'input':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (typeof m.data !== 'string') return bad('data must be a string');
      if (m.data.length > limits.maxInputBytes) return bad('input too large');
      return OK;
    case 'resize':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (!isDims(m)) return bad('invalid cols/rows');
      return OK;
    case 'file.begin':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (!isReqId(m.reqId) || m.reqId === undefined) return bad('reqId is required');
      if (!isShort(m.name, 128) || FILENAME_BAD_RE.test(m.name)) return bad('invalid name');
      if (!isShort(m.mime, 64) || !MIME_RE.test(m.mime)) return bad('invalid mime');
      if (!isInt(m.size, 1, MAX_UPLOAD_BYTES)) return bad('invalid size');
      return OK;
    case 'file.chunk':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (m.reqId === undefined) return bad('reqId is required');
      if (!isInt(m.seq, 0, 1e6)) return bad('invalid seq');
      if (typeof m.data !== 'string' || !BASE64_RE.test(m.data)) return bad('data must be base64');
      if (m.data.length > limits.maxInputBytes) return bad('chunk too large');
      return OK;
    case 'file.end':
    case 'file.abort':
      if (!isId(m.agent, 'a')) return bad('invalid agent');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (m.reqId === undefined) return bad('reqId is required');
      return OK;
    default:
      return bad(`unknown type "${m.type}"`);
  }
}

/** @returns {{ok:boolean, message?:string}} */
function validateAgentMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('message must be an object');
  if (typeof m.type !== 'string') return bad('missing type');
  if (!isReqId(m.reqId)) return bad('invalid reqId');
  if (m.client !== undefined && !isId(m.client, 'c')) return bad('invalid client');
  switch (m.type) {
    case 'ping':
      return OK;
    case 'agent.register':
      if (!isShort(m.instanceId, 64)) return bad('invalid instanceId');
      if (m.name !== undefined && !cleanName(m.name)) return bad('invalid name');
      if (!optShort(m.hostname, 255)) return bad('invalid hostname');
      if (m.platform !== undefined && !PLATFORMS.has(m.platform)) return bad('invalid platform');
      if (!optShort(m.os, 128) || !optShort(m.arch, 32) || !optShort(m.agentVersion, 32)) return bad('invalid metadata');
      if (m.protocol !== undefined && m.protocol !== PROTOCOL_VERSION) return bad('unsupported protocol');
      if (m.shells !== undefined) {
        if (!Array.isArray(m.shells) || m.shells.length > 32) return bad('invalid shells');
        for (const s of m.shells) {
          if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !SHELL_ID_RE.test(s.id) || !optShort(s.label)) return bad('invalid shell entry');
        }
      }
      if (m.caps !== undefined && !(Array.isArray(m.caps) && m.caps.length <= 32 && m.caps.every((c) => isShort(c, 32)))) return bad('invalid caps');
      if (m.sessions !== undefined) {
        if (!Array.isArray(m.sessions) || m.sessions.length > 256) return bad('invalid sessions');
        for (const s of m.sessions) if (!validSessionInfo(s)) return bad('invalid session entry');
      }
      return OK;
    case 'agent.update':
      return cleanName(m.name) ? OK : bad('invalid name');
    case 'session.created':
      return validSessionInfo(m.session) ? OK : bad('invalid session');
    case 'session.attached':
      if (!isId(m.client, 'c')) return bad('missing client');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (!isInt(m.from, 0, Number.MAX_SAFE_INTEGER) || !isInt(m.seq, 0, Number.MAX_SAFE_INTEGER)) return bad('invalid from/seq');
      if (!isDims(m)) return bad('invalid cols/rows');
      return OK;
    case 'session.updated':
      if (!isId(m.session, 's')) return bad('invalid session');
      if (m.title !== undefined && !cleanName(m.title)) return bad('invalid title');
      if (m.state !== undefined && !SESSION_STATES.has(m.state)) return bad('invalid state');
      if ((m.cols !== undefined || m.rows !== undefined) && !isDims(m)) return bad('invalid cols/rows');
      if (m.exitCode !== undefined && m.exitCode !== null && !Number.isInteger(m.exitCode)) return bad('invalid exitCode');
      return OK;
    case 'exit':
      if (!isId(m.session, 's')) return bad('invalid session');
      if (m.code !== undefined && m.code !== null && !Number.isInteger(m.code)) return bad('invalid code');
      return OK;
    case 'session.closed':
      if (!isId(m.session, 's')) return bad('invalid session');
      if (m.reason !== undefined && !CLOSE_REASONS.has(m.reason)) return bad('invalid reason');
      return OK;
    case 'output':
      if (!isId(m.session, 's')) return bad('invalid session');
      if (!isInt(m.seq, 0, Number.MAX_SAFE_INTEGER)) return bad('invalid seq');
      if (typeof m.data !== 'string') return bad('data must be a string');
      return OK;
    case 'file.stored':
      if (!isId(m.client, 'c')) return bad('missing client');
      if (!isId(m.session, 's')) return bad('invalid session');
      if (m.reqId === undefined) return bad('reqId is required');
      if (!isShort(m.path, 4096)) return bad('invalid path');
      if (!isInt(m.size, 0, MAX_UPLOAD_BYTES)) return bad('invalid size');
      return OK;
    case 'error':
      if (!isShort(m.code, 32)) return bad('invalid code');
      if (!optShort(m.message, 256)) return bad('invalid message');
      return OK;
    default:
      return bad(`unknown type "${m.type}"`);
  }
}

module.exports = {
  PROTOCOL_VERSION, CLOSE, ERR, MAX_COLS, MAX_ROWS, MAX_NAME, MAX_UPLOAD_BYTES,
  validatePhoneMessage, validateAgentMessage, cleanName, isShort, SHELL_ID_RE,
};
