/**
 * Relay → client messages, parsed into typed events (PROTOCOL.md §5).
 * A port of `Incoming.kt`.
 *
 * Every event is `{ kind, ... }`; unknown types become `{ kind: 'unknown' }`
 * rather than an error, because the protocol says unknown fields and
 * capabilities are ignored.
 */

import { agentFromJson, deviceFromJson, sessionFromJson, metricsFromJson, limitsFromJson } from './messages.js';

const optStr = (o, key) => (o[key] == null ? null : String(o[key]));
const optNum = (o, key) => (typeof o[key] === 'number' && Number.isFinite(o[key]) ? o[key] : null);
const list = (v, map) => (Array.isArray(v) ? v.map(map) : []);

/** Human-readable text for the UI, mirroring `RelayEvent.Error.display`. */
export function errorDisplay(event) {
  switch (event.code) {
    case 'agent_offline': return 'The machine is offline.';
    case 'unknown_session': return 'That terminal no longer exists.';
    case 'limit_reached': return `Limit reached: ${event.message}`;
    case 'rate_limited': return 'Too many requests; try again in a moment.';
    case 'forbidden': return `Not allowed: ${event.message}`;
    case 'unauthorized': return 'Not authorized. Pair this device again.';
    case 'unsupported_version': return 'The relay speaks a different protocol version.';
    default: return event.message || event.code;
  }
}

export function makeError(code, message, reqId = null, agentId = null, sessionId = null) {
  return { kind: 'error', code, message, reqId, agentId, sessionId };
}

/** Parse one relay message. Throws on malformed JSON. */
export function parseIncoming(text) {
  const o = JSON.parse(text);
  if (!o || typeof o !== 'object') throw new Error('not an object');
  switch (o.type) {
    case 'output':
      return { kind: 'output', agentId: String(o.agent), sessionId: String(o.session), seq: Number(o.seq), data: o.data == null ? '' : String(o.data) };
    case 'welcome':
      return {
        kind: 'welcome',
        version: Number(o.v) || 0,
        connId: String(o.connId ?? ''),
        accountId: String(o.accountId ?? ''),
        deviceId: String(o.deviceId ?? ''),
        caps: list(o.caps, String),
        limits: limitsFromJson(o.limits),
        agents: list(o.agents, agentFromJson),
        devices: list(o.devices, deviceFromJson),
      };
    case 'agent.list':
      return { kind: 'agentList', agents: list(o.agents, agentFromJson) };
    case 'agent.online':
      return { kind: 'agentOnline', agent: agentFromJson(o.agent) };
    case 'agent.offline':
      return { kind: 'agentOffline', agentId: String(o.agent), lastSeen: optNum(o, 'lastSeen') };
    case 'agent.updated':
      return { kind: 'agentUpdated', agentId: String(o.agent), name: String(o.name ?? '') };
    case 'agent.metrics':
      return { kind: 'agentMetrics', agentId: String(o.agent), metrics: metricsFromJson(o.metrics) };
    case 'agent.removed':
      return { kind: 'agentRemoved', agentId: String(o.agent), by: optStr(o, 'by') };
    case 'device.list':
      return { kind: 'deviceList', devices: list(o.devices, deviceFromJson) };
    case 'device.updated':
      return { kind: 'deviceUpdated', deviceId: String(o.device), name: String(o.name ?? '') };
    case 'device.revoked':
      return { kind: 'deviceRevoked', deviceId: String(o.device), by: optStr(o, 'by') };
    case 'session.created':
      return { kind: 'sessionCreated', agentId: String(o.agent), session: sessionFromJson(o.session), reqId: optStr(o, 'reqId') };
    case 'session.attached':
      return {
        kind: 'sessionAttached',
        agentId: String(o.agent),
        sessionId: String(o.session),
        from: Number(o.from) || 0,
        seq: Number(o.seq) || 0,
        cols: Number(o.cols) || 0,
        rows: Number(o.rows) || 0,
        reqId: optStr(o, 'reqId'),
      };
    case 'session.updated':
      return {
        kind: 'sessionUpdated',
        agentId: String(o.agent),
        sessionId: String(o.session),
        title: optStr(o, 'title'),
        state: optStr(o, 'state'),
        cols: optNum(o, 'cols'),
        rows: optNum(o, 'rows'),
        exitCode: optNum(o, 'exitCode'),
        cwd: optStr(o, 'cwd'),
      };
    case 'exit':
      return { kind: 'exit', agentId: String(o.agent), sessionId: String(o.session), code: optNum(o, 'code') };
    case 'session.closed':
      return { kind: 'sessionClosed', agentId: String(o.agent), sessionId: String(o.session), reason: String(o.reason ?? 'closed') };
    case 'session.lag':
      return { kind: 'sessionLag', agentId: String(o.agent), sessionId: String(o.session) };
    case 'file.stored':
      return {
        kind: 'fileStored',
        agentId: String(o.agent),
        sessionId: String(o.session),
        path: String(o.path ?? ''),
        size: Number(o.size) || 0,
        reqId: optStr(o, 'reqId'),
      };
    case 'error':
      return makeError(String(o.code ?? 'internal'), String(o.message ?? ''), optStr(o, 'reqId'), optStr(o, 'agent'), optStr(o, 'session'));
    case 'pong':
      return { kind: 'pong' };
    default:
      return { kind: 'unknown', type: String(o.type ?? '') };
  }
}
