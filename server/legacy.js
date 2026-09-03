'use strict';

/*
 * Legacy protocol v2 ("room") mode — enabled only with LEGACY_V2=1.
 *
 * This is the pre-0.3 relay behaviour kept in an isolated module: one agent
 * plus one phone per room, verbatim forwarding, optional shared token and
 * per-room pairing codes. Legacy rooms live in their own table and never
 * touch v3 accounts, agents or sessions, so an old client cannot reach a v3
 * machine (or vice versa). Deprecated; see PROTOCOL.md "Compatibility".
 */

const { safeEqual, numericCode } = require('./tokens');
const { MessageBudget } = require('./limits');

const LEGACY_PROTOCOL_VERSION = 2;

class LegacyPairingStore {
  constructor(digits = 6) { this.digits = digits; this.byRoom = new Map(); }
  mint(room, ttlSec) {
    const code = numericCode(this.digits);
    const expires = Date.now() + ttlSec * 1000;
    this.byRoom.set(room, { code, expires });
    return { code, expires: Math.round(expires / 1000) };
  }
  redeem(room, code) {
    const e = this.byRoom.get(room);
    if (!e) return false;
    if (Date.now() > e.expires) { this.byRoom.delete(room); return false; }
    if (!safeEqual(String(code), e.code)) return false;
    this.byRoom.delete(room);
    return true;
  }
}

function createLegacy({ cfg, log }) {
  const rooms = new Map();
  const pairing = new LegacyPairingStore();
  const caps = ['ping'].concat(cfg.authToken ? ['auth'] : []);

  const getRoom = (room) => { let r = rooms.get(room); if (!r) { r = { agent: null, phone: null }; rooms.set(room, r); } return r; };
  const peerRole = (role) => (role === 'agent' ? 'phone' : 'agent');
  const send = (ws, obj) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  function authorize({ role, room, token, pair }) {
    if (cfg.authToken && (!token || !safeEqual(token, cfg.authToken))) return { ok: false, reason: 'unauthorized' };
    if (cfg.legacyPairing) {
      if (role === 'agent') {
        const c = pairing.mint(room, cfg.pairing.ttlSec);
        return { ok: true, paired: { type: 'paired', code: c.code, expires: c.expires } };
      }
      if (!pair || !pairing.redeem(room, pair)) return { ok: false, reason: 'invalid or expired pairing code' };
    }
    return { ok: true };
  }

  /** Handle an accepted v2 socket. Returns false when it was refused. */
  function handleConnection(ws, url, token, connId) {
    const role = url.searchParams.get('role');
    const room = url.searchParams.get('room');
    const pair = url.searchParams.get('pair');
    if (role !== 'agent' && role !== 'phone') { send(ws, { type: 'error', message: 'role must be "agent" or "phone"' }); ws.close(1008, 'bad role'); return false; }
    if (!room) { send(ws, { type: 'error', message: 'missing room' }); ws.close(1008, 'missing room'); return false; }
    const auth = authorize({ role, room, token, pair });
    if (!auth.ok) {
      log.warn('legacy: unauthorized', { connId, role, room, reason: auth.reason });
      send(ws, { type: 'error', message: auth.reason });
      ws.close(4401, auth.reason);
      return false;
    }

    const r = getRoom(room);
    if (r[role] && r[role].readyState === r[role].OPEN) {
      log.info('legacy: replacing existing role', { room, role });
      try { r[role].close(4409, 'replaced'); } catch (_) { /* ignore */ }
    }
    r[role] = ws;
    const budget = new MessageBudget(role === 'agent' ? cfg.agentMsgPerSec : cfg.msgPerSec);

    log.info('legacy: connected', { connId, role, room, v: LEGACY_PROTOCOL_VERSION });
    send(ws, { type: 'welcome', role, room, v: LEGACY_PROTOCOL_VERSION, caps });
    if (auth.paired) send(ws, auth.paired);

    const peer = r[peerRole(role)];
    if (peer && peer.readyState === peer.OPEN) {
      send(ws, { type: 'status', peer: 'connected' });
      send(peer, { type: 'status', peer: 'connected' });
    }

    ws.on('message', (raw) => {
      if (!budget.allow()) {
        log.warn('legacy: rate limit exceeded; closing', { connId, room, role });
        send(ws, { type: 'error', message: 'rate limit exceeded' });
        ws.close(4429, 'rate limited');
        return;
      }
      const s = raw.toString();
      if (s.length < 32 && s.indexOf('"ping"') !== -1) {
        try { if (JSON.parse(s).type === 'ping') { send(ws, { type: 'pong' }); return; } } catch (_) { /* fallthrough */ }
      }
      const target = getRoom(room)[peerRole(role)];
      if (target && target.readyState === target.OPEN) target.send(s);
    });

    ws.on('close', () => {
      const current = rooms.get(room);
      if (!current) return;
      if (current[role] === ws) current[role] = null;
      log.info('legacy: disconnected', { connId, role, room });
      const other = current[peerRole(role)];
      if (other && other.readyState === other.OPEN) send(other, { type: 'status', peer: 'disconnected' });
      if (!current.agent && !current.phone) rooms.delete(room);
    });
    return true;
  }

  return { handleConnection, rooms, LEGACY_PROTOCOL_VERSION };
}

module.exports = { createLegacy, LegacyPairingStore, LEGACY_PROTOCOL_VERSION };
