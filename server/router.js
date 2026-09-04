'use strict';

/*
 * Message routing and authorization for protocol v3.
 *
 * Every phone message is checked against the caller's account before it is
 * forwarded; input/resize additionally require the phone to be attached to
 * the target session. Every agent message is scoped to that agent's own
 * runtime. Nothing is dropped silently: failures produce an `error` message
 * and a log line carrying connId/agentId/sessionId.
 *
 * Fan-out of terminal output goes only to attached phones and respects
 * per-socket backpressure (see fanOut).
 */

const { RateLimiter } = require('./limits');
const { PROTOCOL_VERSION, CLOSE, ERR, validatePhoneMessage, validateAgentMessage, cleanName } = require('./protocol');

const RELAY_CAPS = ['sessions', 'replay', 'ping', 'pairing'];

function key(agentId, sessionId) { return `${agentId}|${sessionId}`; }

class Router {
  constructor({ cfg, log, registry }) {
    this.cfg = cfg;
    this.log = log;
    this.registry = registry;
    this.createLimiter = new RateLimiter({ limit: cfg.limits.sessionCreatePerMin, windowMs: 60_000 });
  }

  /* ------------------------------ plumbing ------------------------------ */

  send(conn, msg) {
    const ws = conn.ws;
    if (ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  error(conn, code, message, extra) {
    this.send(conn, Object.assign({ type: 'error', code, message }, extra));
    conn.log.warn('request rejected', Object.assign({ code, message }, extra));
  }

  broadcastAccount(accountId, msg, except) {
    const str = JSON.stringify(msg);
    for (const c of this.registry.phonesIn(accountId)) if (c !== except) this.send(c, str);
  }

  /** Close a connection with a v3 close code after telling it why. */
  forceClose(conn, code, reason) {
    try { this.send(conn, { type: 'error', code: reason, message: reason }); } catch (_) { /* best effort */ }
    try { conn.ws.close(code, reason); } catch (_) { /* already closed */ }
  }

  limits() {
    return {
      maxSessionsPerAgent: this.cfg.limits.maxSessionsPerAgent,
      maxSessionsPerAccount: this.cfg.limits.maxSessionsPerAccount,
      maxInputBytes: this.cfg.limits.maxInputBytes,
      maxFrameBytes: this.cfg.maxFrameBytes,
    };
  }

  caps() { return this.cfg.legacyV2 ? RELAY_CAPS.concat('legacy') : RELAY_CAPS; }

  /* ----------------------------- connections ---------------------------- */

  onPhoneConnected(conn) {
    const reg = this.registry;
    reg.touchDevice(conn.deviceId);
    this.send(conn, {
      type: 'welcome', v: PROTOCOL_VERSION, role: 'phone', connId: conn.id,
      accountId: conn.accountId, deviceId: conn.deviceId,
      caps: this.caps(), limits: this.limits(),
      agents: reg.listAgents(conn.accountId),
      devices: reg.listDevices(conn.accountId, conn.deviceId),
    });
  }

  onAgentConnected(conn) {
    const a = this.registry.getAgent(conn.agentId);
    this.send(conn, {
      type: 'welcome', v: PROTOCOL_VERSION, role: 'agent', connId: conn.id,
      accountId: conn.accountId, agentId: conn.agentId, name: a ? a.name : '',
      caps: this.caps(),
      limits: { maxSessionsPerAgent: this.cfg.limits.maxSessionsPerAgent, maxInputBytes: this.cfg.limits.maxInputBytes, maxFrameBytes: this.cfg.maxFrameBytes },
    });
  }

  onPhoneClosed(conn) {
    const reg = this.registry;
    if (conn.lagTimer) { clearInterval(conn.lagTimer); conn.lagTimer = null; }
    for (const k of conn.attachments) {
      const [agentId, sessionId] = k.split('|');
      const rt = reg.runtime.get(agentId);
      if (!rt) continue;
      const set = rt.attachments.get(sessionId);
      if (set) { set.delete(conn.id); if (set.size === 0) rt.attachments.delete(sessionId); }
    }
    conn.attachments.clear();
    for (const agentId of conn.agentsTouched) {
      const rt = reg.runtime.get(agentId);
      if (rt && rt.conn) this.send(rt.conn, { type: 'client.gone', client: conn.id });
    }
    conn.agentsTouched.clear();
    reg.touchDevice(conn.deviceId);
  }

  onAgentClosed(conn) {
    const reg = this.registry;
    const rt = reg.runtime.get(conn.agentId);
    if (!rt || rt.conn !== null) return; // replaced by a newer connection, or already handled
    this.clearAttachments(rt);
    reg.touchAgent(conn.agentId);
    const a = reg.getAgent(conn.agentId);
    if (a) this.broadcastAccount(conn.accountId, { type: 'agent.offline', agent: conn.agentId, lastSeen: a.lastSeen });
  }

  clearAttachments(rt) {
    for (const [sessionId, set] of rt.attachments) {
      for (const connId of set) {
        const c = this.registry.connections.get(connId);
        if (c) c.attachments.delete(key(rt.agentId, sessionId));
      }
    }
    rt.attachments.clear();
  }

  /* ------------------------------ revocation ---------------------------- */

  /** Remove an agent and cut its live connection. `by` is the acting device id (or null for the CLI). */
  removeAgent(agentId, by) {
    const reg = this.registry;
    const a = reg.getAgent(agentId);
    if (!a) return false;
    const rt = reg.runtime.get(agentId);
    if (rt) {
      this.clearAttachments(rt);
      if (rt.conn) { const c = rt.conn; rt.conn = null; this.forceClose(c, CLOSE.UNAUTHORIZED, 'revoked'); }
    }
    reg.removeAgent(agentId);
    this.log.info('agent removed', { agentId, by });
    this.broadcastAccount(a.accountId, { type: 'agent.removed', agent: agentId, by: by || null });
    return true;
  }

  revokeDevice(deviceId, by) {
    const reg = this.registry;
    const d = reg.getDevice(deviceId);
    if (!d) return false;
    const conns = reg.deviceConns.get(deviceId);
    if (conns) for (const c of [...conns]) this.forceClose(c, CLOSE.UNAUTHORIZED, 'revoked');
    reg.removeDevice(deviceId);
    this.log.info('device revoked', { deviceId, by });
    this.broadcastAccount(d.accountId, { type: 'device.revoked', device: deviceId, by: by || null });
    return true;
  }

  agentRenamed(agentId, name) {
    const a = this.registry.getAgent(agentId);
    if (!a) return;
    this.broadcastAccount(a.accountId, { type: 'agent.updated', agent: agentId, name });
    const rt = this.registry.runtime.get(agentId);
    if (rt && rt.conn) this.send(rt.conn, { type: 'agent.updated', name });
  }

  /* --------------------------- phone messages --------------------------- */

  handlePhone(conn, m) {
    const v = validatePhoneMessage(m, this.cfg.limits);
    if (!v.ok) return this.error(conn, ERR.BAD_REQUEST, v.message, m && m.reqId ? { reqId: m.reqId } : undefined);
    const reg = this.registry;

    switch (m.type) {
      case 'ping':
        return this.send(conn, { type: 'pong' });

      case 'agent.list':
        return this.send(conn, { type: 'agent.list', agents: reg.listAgents(conn.accountId) });

      case 'device.list':
        return this.send(conn, { type: 'device.list', devices: reg.listDevices(conn.accountId, conn.deviceId) });

      case 'agent.rename': {
        const a = this.ownAgent(conn, m);
        if (!a) return;
        const name = cleanName(m.name);
        reg.renameAgent(a.agentId, name);
        return this.agentRenamed(a.agentId, name);
      }

      case 'agent.remove': {
        const a = this.ownAgent(conn, m);
        if (!a) return;
        return this.removeAgent(a.agentId, conn.deviceId);
      }

      case 'device.rename': {
        const id = m.device || conn.deviceId;
        const d = reg.getDevice(id);
        if (!d || d.accountId !== conn.accountId) return this.error(conn, ERR.FORBIDDEN, 'device not in your account', { device: id });
        const name = cleanName(m.name);
        reg.renameDevice(id, name);
        return this.broadcastAccount(conn.accountId, { type: 'device.updated', device: id, name });
      }

      case 'device.revoke': {
        const d = reg.getDevice(m.device);
        if (!d || d.accountId !== conn.accountId) return this.error(conn, ERR.FORBIDDEN, 'device not in your account', { device: m.device });
        return this.revokeDevice(m.device, conn.deviceId);
      }

      case 'session.create': {
        const rt = this.onlineAgent(conn, m);
        if (!rt) return;
        if (rt.sessions.size >= this.cfg.limits.maxSessionsPerAgent) {
          return this.error(conn, ERR.LIMIT, 'too many sessions on this agent', { reqId: m.reqId, agent: m.agent });
        }
        if (reg.countSessions(conn.accountId) >= this.cfg.limits.maxSessionsPerAccount) {
          return this.error(conn, ERR.LIMIT, 'too many sessions in this account', { reqId: m.reqId, agent: m.agent });
        }
        if (!this.createLimiter.hit(conn.id).ok) {
          return this.error(conn, ERR.RATE_LIMITED, 'too many sessions created recently', { reqId: m.reqId, agent: m.agent });
        }
        conn.agentsTouched.add(rt.agentId);
        const fwd = { type: 'session.create', client: conn.id, cols: m.cols, rows: m.rows };
        if (m.reqId !== undefined) fwd.reqId = m.reqId;
        if (m.shell !== undefined) fwd.shell = m.shell;
        if (m.title !== undefined) fwd.title = cleanName(m.title);
        return this.send(rt.conn, fwd);
      }

      case 'session.attach': {
        const rt = this.onlineAgent(conn, m);
        if (!rt) return;
        conn.agentsTouched.add(rt.agentId);
        const fwd = { type: 'session.attach', client: conn.id, session: m.session, cols: m.cols, rows: m.rows };
        if (m.reqId !== undefined) fwd.reqId = m.reqId;
        if (m.since !== undefined) fwd.since = m.since;
        return this.send(rt.conn, fwd);
      }

      case 'session.detach': {
        const a = this.ownAgent(conn, m);
        if (!a) return;
        const rt = reg.rt(a.agentId);
        this.detach(rt, m.session, conn);
        if (rt.conn) this.send(rt.conn, { type: 'session.detach', client: conn.id, session: m.session });
        return undefined;
      }

      case 'session.close': {
        const rt = this.onlineAgent(conn, m);
        if (!rt) return;
        return this.send(rt.conn, { type: 'session.close', session: m.session });
      }

      case 'session.rename': {
        const rt = this.onlineAgent(conn, m);
        if (!rt) return;
        return this.send(rt.conn, { type: 'session.rename', session: m.session, title: cleanName(m.title) });
      }

      case 'input': {
        const rt = this.attachedAgent(conn, m);
        if (!rt) return;
        return this.send(rt.conn, { type: 'input', session: m.session, data: m.data });
      }

      case 'resize': {
        const rt = this.attachedAgent(conn, m);
        if (!rt) return;
        return this.send(rt.conn, { type: 'resize', session: m.session, cols: m.cols, rows: m.rows });
      }

      // File transfer (a pasted image and friends): opaque to the relay, but
      // scoped to a session the phone is attached to, like input.
      case 'file.begin':
      case 'file.chunk':
      case 'file.end':
      case 'file.abort': {
        const rt = this.attachedAgent(conn, m);
        if (!rt) return;
        const fwd = { type: m.type, client: conn.id, session: m.session, reqId: m.reqId };
        if (m.type === 'file.begin') { fwd.name = m.name; fwd.mime = m.mime; fwd.size = m.size; }
        if (m.type === 'file.chunk') { fwd.seq = m.seq; fwd.data = m.data; }
        return this.send(rt.conn, fwd);
      }

      default:
        return this.error(conn, ERR.BAD_REQUEST, `unknown type "${m.type}"`);
    }
  }

  /** The agent record if it belongs to the caller's account, else an error. */
  ownAgent(conn, m) {
    const a = this.registry.getAgent(m.agent);
    if (!a || a.accountId !== conn.accountId) {
      this.error(conn, a ? ERR.FORBIDDEN : ERR.NOT_FOUND, a ? 'agent not in your account' : 'unknown agent',
        { reqId: m.reqId, agent: m.agent });
      return null;
    }
    return a;
  }

  /** Runtime of an owned agent that is online, else an error. */
  onlineAgent(conn, m) {
    const a = this.ownAgent(conn, m);
    if (!a) return null;
    const rt = this.registry.rt(a.agentId);
    if (!rt.conn || rt.conn.ws.readyState !== rt.conn.ws.OPEN) {
      this.error(conn, ERR.AGENT_OFFLINE, 'agent is offline', { reqId: m.reqId, agent: m.agent, session: m.session });
      return null;
    }
    return rt;
  }

  /** Runtime of an online agent the caller is attached to for m.session. */
  attachedAgent(conn, m) {
    const rt = this.onlineAgent(conn, m);
    if (!rt) return null;
    if (!conn.attachments.has(key(rt.agentId, m.session))) {
      this.error(conn, ERR.FORBIDDEN, 'not attached to this session', { agent: m.agent, session: m.session });
      return null;
    }
    return rt;
  }

  detach(rt, sessionId, conn) {
    const k = key(rt.agentId, sessionId);
    conn.attachments.delete(k);
    conn.lagging.delete(k);
    const set = rt.attachments.get(sessionId);
    if (set) { set.delete(conn.id); if (set.size === 0) rt.attachments.delete(sessionId); }
  }

  /* --------------------------- agent messages --------------------------- */

  handleAgent(conn, m) {
    const v = validateAgentMessage(m);
    if (!v.ok) return this.error(conn, ERR.BAD_REQUEST, v.message, m && m.reqId ? { reqId: m.reqId } : undefined);
    const reg = this.registry;
    const rt = reg.rt(conn.agentId);
    if (rt.conn !== conn) return; // superseded connection: ignore

    switch (m.type) {
      case 'ping':
        return this.send(conn, { type: 'pong' });

      case 'agent.register': {
        rt.instanceId = m.instanceId;
        this.clearAttachments(rt);
        rt.sessions = new Map();
        for (const s of m.sessions || []) rt.sessions.set(s.sessionId, this.mirrorEntry(s));
        const a = reg.updateAgentMeta(conn.agentId, m);
        conn.log.info('agent registered', { instanceId: m.instanceId, sessions: rt.sessions.size, platform: m.platform, agentVersion: m.agentVersion });
        this.send(conn, { type: 'agent.registered', agentId: conn.agentId, name: a.name });
        return this.broadcastAccount(conn.accountId, { type: 'agent.online', agent: reg.agentInfo(conn.agentId) });
      }

      case 'agent.update': {
        const name = cleanName(m.name);
        reg.renameAgent(conn.agentId, name);
        return this.broadcastAccount(conn.accountId, { type: 'agent.updated', agent: conn.agentId, name });
      }

      case 'session.created': {
        const s = this.mirrorEntry(m.session);
        rt.sessions.set(s.sessionId, s);
        const info = reg.sessionInfo(rt, s);
        const requester = m.client ? reg.connections.get(m.client) : null;
        if (requester && requester.accountId === conn.accountId) {
          const msg = { type: 'session.created', agent: conn.agentId, session: info };
          if (m.reqId !== undefined) msg.reqId = m.reqId;
          this.send(requester, msg);
        }
        return this.broadcastAccount(conn.accountId, { type: 'session.created', agent: conn.agentId, session: info }, requester);
      }

      case 'session.attached': {
        const client = reg.connections.get(m.client);
        if (!client || client.role !== 'phone' || client.accountId !== conn.accountId) {
          // The phone left before the agent answered: tell the agent so it detaches.
          return this.send(conn, { type: 'client.gone', client: m.client });
        }
        let s = rt.sessions.get(m.session);
        if (!s) { s = this.mirrorEntry({ sessionId: m.session }); rt.sessions.set(s.sessionId, s); }
        s.cols = m.cols; s.rows = m.rows; s.seq = m.seq; s.lastActiveAt = Date.now();
        let set = rt.attachments.get(m.session);
        if (!set) { set = new Set(); rt.attachments.set(m.session, set); }
        set.add(client.id);
        client.attachments.add(key(conn.agentId, m.session));
        client.lagging.delete(key(conn.agentId, m.session));
        const msg = { type: 'session.attached', agent: conn.agentId, session: m.session, from: m.from, seq: m.seq, cols: m.cols, rows: m.rows };
        if (m.reqId !== undefined) msg.reqId = m.reqId;
        return this.send(client, msg);
      }

      case 'session.updated': {
        let s = rt.sessions.get(m.session);
        if (!s) { s = this.mirrorEntry({ sessionId: m.session }); rt.sessions.set(s.sessionId, s); }
        const out = { type: 'session.updated', agent: conn.agentId, session: m.session };
        for (const k of ['title', 'state', 'cols', 'rows', 'exitCode', 'cwd']) if (m[k] !== undefined) { s[k] = m[k]; out[k] = m[k]; }
        return this.broadcastAccount(conn.accountId, out);
      }

      case 'exit': {
        const s = rt.sessions.get(m.session);
        if (s) { s.state = 'exited'; s.exitCode = m.code == null ? null : m.code; }
        return this.broadcastAccount(conn.accountId, { type: 'exit', agent: conn.agentId, session: m.session, code: m.code == null ? null : m.code });
      }

      case 'session.closed': {
        rt.sessions.delete(m.session);
        const set = rt.attachments.get(m.session);
        if (set) {
          for (const connId of set) {
            const c = reg.connections.get(connId);
            if (c) { c.attachments.delete(key(conn.agentId, m.session)); c.lagging.delete(key(conn.agentId, m.session)); }
          }
          rt.attachments.delete(m.session);
        }
        return this.broadcastAccount(conn.accountId, { type: 'session.closed', agent: conn.agentId, session: m.session, reason: m.reason || 'closed' });
      }

      case 'output': {
        const s = rt.sessions.get(m.session);
        if (s) { s.seq = m.seq; s.lastActiveAt = Date.now(); }
        const out = JSON.stringify({ type: 'output', agent: conn.agentId, session: m.session, seq: m.seq, data: m.data });
        if (m.client) {
          const client = reg.connections.get(m.client);
          if (client && client.accountId === conn.accountId) this.send(client, out);
          return undefined;
        }
        return this.fanOut(rt, m.session, out);
      }

      case 'file.stored': {
        const client = reg.connections.get(m.client);
        if (!client || client.accountId !== conn.accountId) return undefined;
        return this.send(client, {
          type: 'file.stored', reqId: m.reqId, agent: conn.agentId, session: m.session, path: m.path, size: m.size,
        });
      }

      case 'error': {
        if (!m.client) return conn.log.warn('agent error', { code: m.code, message: m.message });
        const client = reg.connections.get(m.client);
        if (client && client.accountId === conn.accountId) {
          const out = { type: 'error', code: m.code, message: m.message || m.code, agent: conn.agentId };
          if (m.reqId !== undefined) out.reqId = m.reqId;
          if (m.session !== undefined) out.session = m.session;
          this.send(client, out);
        }
        return undefined;
      }

      default:
        return this.error(conn, ERR.BAD_REQUEST, `unknown type "${m.type}"`);
    }
  }

  mirrorEntry(s) {
    return {
      sessionId: s.sessionId,
      title: s.title || '',
      shell: s.shell || '',
      state: s.state || 'running',
      createdAt: s.createdAt || Date.now(),
      lastActiveAt: s.lastActiveAt || Date.now(),
      cols: s.cols || null,
      rows: s.rows || null,
      seq: s.seq || 0,
      exitCode: s.exitCode === undefined ? null : s.exitCode,
      cwd: typeof s.cwd === 'string' ? s.cwd : '',
    };
  }

  /**
   * Deliver live output to every attached phone, honouring backpressure: a
   * phone whose socket buffer is above the high-water mark stops receiving
   * output and is told `session.lag` once it drains, so it re-attaches with
   * `since` and gets the missed range replayed.
   */
  fanOut(rt, sessionId, str) {
    const set = rt.attachments.get(sessionId);
    if (!set) return;
    const k = key(rt.agentId, sessionId);
    for (const connId of set) {
      const c = this.registry.connections.get(connId);
      if (!c || c.ws.readyState !== c.ws.OPEN) { set.delete(connId); continue; }
      if (c.lagging.has(k)) continue;
      if (c.ws.bufferedAmount > this.cfg.backpressureHighBytes) {
        c.lagging.add(k);
        this.scheduleLagCheck(c);
        continue;
      }
      c.ws.send(str);
    }
    if (set.size === 0) rt.attachments.delete(sessionId);
  }

  scheduleLagCheck(conn) {
    if (conn.lagTimer) return;
    conn.lagTimer = setInterval(() => {
      if (conn.ws.readyState !== conn.ws.OPEN) { clearInterval(conn.lagTimer); conn.lagTimer = null; return; }
      if (conn.ws.bufferedAmount >= this.cfg.backpressureLowBytes) return;
      clearInterval(conn.lagTimer); conn.lagTimer = null;
      for (const k of conn.lagging) {
        const [agent, session] = k.split('|');
        this.send(conn, { type: 'session.lag', agent, session });
      }
      conn.lagging.clear();
    }, 250);
  }
}

module.exports = { Router, RELAY_CAPS };
