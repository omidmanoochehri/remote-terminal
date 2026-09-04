'use strict';

/*
 * The relay's in-memory picture of the world, layered over the persisted
 * identity records in state.js:
 *
 *   account ─┬─ agents   (record + runtime: live connection, instanceId,
 *            │            session mirror, attachments)
 *            └─ devices  (record + live phone connections)
 *
 * Everything on the routing hot path is a Map lookup: connections by id,
 * agents by id / token hash, devices by token hash, phones by account,
 * attachments by (agent, session).
 */

const { newId, newToken, hashToken } = require('./tokens');

class Registry {
  constructor(state, cfg, log) {
    this.state = state;
    this.cfg = cfg;
    this.log = log;

    /** @type {Map<string,string>} sha256(token) -> agentId */
    this.agentsByTokenHash = new Map();
    /** @type {Map<string,string>} sha256(token) -> deviceId */
    this.devicesByTokenHash = new Map();
    /** @type {Map<string, AgentRuntime>} */
    this.runtime = new Map();
    /** @type {Map<string, Conn>} */
    this.connections = new Map();
    /** @type {Map<string, Set<Conn>>} accountId -> phone connections */
    this.phonesByAccount = new Map();
    /** @type {Map<string, Set<Conn>>} deviceId -> connections */
    this.deviceConns = new Map();

    for (const a of Object.values(this.data.agents)) this.agentsByTokenHash.set(a.tokenHash, a.agentId);
    for (const d of Object.values(this.data.devices)) this.devicesByTokenHash.set(d.tokenHash, d.deviceId);
  }

  get data() { return this.state.data; }

  /* ------------------------------ accounts ------------------------------ */

  ensureAccount(accountId) {
    let acc = this.data.accounts[accountId];
    if (!acc) {
      acc = { accountId, name: accountId, createdAt: Date.now() };
      this.data.accounts[accountId] = acc;
      this.state.save();
    }
    return acc;
  }

  /* ------------------------------- agents ------------------------------- */

  createAgent({ accountId, name, hostname, platform, os, arch, agentVersion, protocol }) {
    this.ensureAccount(accountId);
    const agentId = newId('a');
    const token = newToken();
    const record = {
      agentId, accountId,
      name: name || hostname || agentId,
      hostname: hostname || '', platform: platform || '', os: os || '', arch: arch || '',
      agentVersion: agentVersion || '', protocol: protocol || null,
      shells: [], caps: [],
      tokenHash: hashToken(token),
      createdAt: Date.now(), lastSeen: null,
    };
    this.data.agents[agentId] = record;
    this.agentsByTokenHash.set(record.tokenHash, agentId);
    this.state.save();
    this.state.flush(); // a crash here must not orphan a token the agent already holds
    return { record, token };
  }

  findAgentByToken(token) {
    const id = this.agentsByTokenHash.get(hashToken(token));
    return id ? this.data.agents[id] || null : null;
  }

  getAgent(agentId) { return this.data.agents[agentId] || null; }

  /** Merge metadata announced in agent.register. The relay-side name wins. */
  updateAgentMeta(agentId, meta) {
    const a = this.data.agents[agentId];
    if (!a) return null;
    for (const k of ['hostname', 'platform', 'os', 'arch', 'agentVersion', 'protocol']) {
      if (meta[k] !== undefined) a[k] = meta[k];
    }
    if (Array.isArray(meta.shells)) a.shells = meta.shells.map((s) => ({ id: s.id, label: s.label || s.id, default: !!s.default }));
    if (Array.isArray(meta.caps)) a.caps = meta.caps.slice();
    if (!a.name && meta.name) a.name = meta.name;
    a.lastSeen = Date.now();
    this.state.save();
    return a;
  }

  renameAgent(agentId, name) {
    const a = this.data.agents[agentId];
    if (!a) return null;
    a.name = name;
    this.state.save();
    return a;
  }

  touchAgent(agentId) {
    const a = this.data.agents[agentId];
    if (a) { a.lastSeen = Date.now(); this.state.save(); }
  }

  removeAgent(agentId) {
    const a = this.data.agents[agentId];
    if (!a) return false;
    this.agentsByTokenHash.delete(a.tokenHash);
    delete this.data.agents[agentId];
    this.runtime.delete(agentId);
    this.state.save();
    this.state.flush();
    return true;
  }

  countAgents(accountId) {
    let n = 0;
    for (const a of Object.values(this.data.agents)) if (a.accountId === accountId) n++;
    return n;
  }

  /* ------------------------------- devices ------------------------------ */

  createDevice({ accountId, name, platform, appVersion, pairedVia }) {
    this.ensureAccount(accountId);
    const deviceId = newId('d');
    const token = newToken();
    const record = {
      deviceId, accountId,
      name: name || 'Phone', platform: platform || '', appVersion: appVersion || '',
      pairedVia: pairedVia || null,
      tokenHash: hashToken(token),
      createdAt: Date.now(), lastSeen: null,
    };
    this.data.devices[deviceId] = record;
    this.devicesByTokenHash.set(record.tokenHash, deviceId);
    this.state.save();
    this.state.flush();
    return { record, token };
  }

  findDeviceByToken(token) {
    const id = this.devicesByTokenHash.get(hashToken(token));
    return id ? this.data.devices[id] || null : null;
  }

  getDevice(deviceId) { return this.data.devices[deviceId] || null; }

  renameDevice(deviceId, name) {
    const d = this.data.devices[deviceId];
    if (!d) return null;
    d.name = name;
    this.state.save();
    return d;
  }

  touchDevice(deviceId) {
    const d = this.data.devices[deviceId];
    if (d) { d.lastSeen = Date.now(); this.state.save(); }
  }

  removeDevice(deviceId) {
    const d = this.data.devices[deviceId];
    if (!d) return false;
    this.devicesByTokenHash.delete(d.tokenHash);
    delete this.data.devices[deviceId];
    this.state.save();
    this.state.flush();
    return true;
  }

  countDevices(accountId) {
    let n = 0;
    for (const d of Object.values(this.data.devices)) if (d.accountId === accountId) n++;
    return n;
  }

  /* ------------------------------- runtime ------------------------------ */

  /** Runtime slot for an agent (created on demand). */
  rt(agentId) {
    let r = this.runtime.get(agentId);
    if (!r) {
      r = {
        agentId,
        conn: null,
        instanceId: null,
        /** @type {Map<string, object>} sessionId -> SessionInfo (display cache) */
        sessions: new Map(),
        /** Last system metrics the agent published, or null. Never persisted. */
        metrics: null,
        /** @type {Map<string, Set<string>>} sessionId -> phone connIds */
        attachments: new Map(),
      };
      this.runtime.set(agentId, r);
    }
    return r;
  }

  /**
   * Remember the metrics an agent just published. They live on the runtime
   * slot rather than the record on purpose: CPU load and free memory from the
   * last time a machine was up say nothing about it now, so they go away with
   * the connection instead of being served as if they were current.
   */
  setAgentMetrics(agentId, metrics) {
    const r = this.rt(agentId);
    r.metrics = sanitizeMetrics(metrics);
    return r.metrics;
  }

  clearAgentMetrics(agentId) {
    const r = this.runtime.get(agentId);
    if (r) r.metrics = null;
  }

  isOnline(agentId) {
    const r = this.runtime.get(agentId);
    return !!(r && r.conn && r.conn.ws.readyState === r.conn.ws.OPEN);
  }

  isDeviceOnline(deviceId) {
    const set = this.deviceConns.get(deviceId);
    if (!set) return false;
    for (const c of set) if (c.ws.readyState === c.ws.OPEN) return true;
    return false;
  }

  /* -------------------------------- views ------------------------------- */

  sessionInfo(rt, s) {
    const att = rt.attachments.get(s.sessionId);
    return {
      sessionId: s.sessionId,
      title: s.title || '',
      shell: s.shell || '',
      state: s.state || 'running',
      createdAt: s.createdAt || null,
      lastActiveAt: s.lastActiveAt || null,
      cols: s.cols || null,
      rows: s.rows || null,
      seq: s.seq || 0,
      attached: att ? att.size : 0,
      exitCode: s.exitCode === undefined ? null : s.exitCode,
      cwd: s.cwd || '',
    };
  }

  agentInfo(agentId, { withSessions = true } = {}) {
    const a = this.data.agents[agentId];
    if (!a) return null;
    const r = this.runtime.get(agentId);
    const info = {
      agentId: a.agentId,
      name: a.name,
      hostname: a.hostname, platform: a.platform, os: a.os, arch: a.arch,
      agentVersion: a.agentVersion, protocol: a.protocol,
      shells: a.shells || [], caps: a.caps || [],
      online: this.isOnline(agentId),
      lastSeen: a.lastSeen,
      instanceId: r ? r.instanceId : null,
    };
    if (r && r.metrics && this.isOnline(agentId)) info.metrics = r.metrics;
    if (withSessions) info.sessions = r ? [...r.sessions.values()].map((s) => this.sessionInfo(r, s)) : [];
    return info;
  }

  listAgents(accountId) {
    const out = [];
    for (const a of Object.values(this.data.agents)) {
      if (a.accountId === accountId) out.push(this.agentInfo(a.agentId));
    }
    out.sort((x, y) => x.name.localeCompare(y.name));
    return out;
  }

  deviceInfo(d, selfId) {
    return {
      deviceId: d.deviceId, name: d.name, platform: d.platform,
      createdAt: d.createdAt, lastSeen: d.lastSeen,
      online: this.isDeviceOnline(d.deviceId), isSelf: d.deviceId === selfId,
    };
  }

  listDevices(accountId, selfId) {
    const out = [];
    for (const d of Object.values(this.data.devices)) if (d.accountId === accountId) out.push(this.deviceInfo(d, selfId));
    out.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    return out;
  }

  countSessions(accountId) {
    let n = 0;
    for (const r of this.runtime.values()) {
      const a = this.data.agents[r.agentId];
      if (a && a.accountId === accountId && this.isOnline(r.agentId)) n += r.sessions.size;
    }
    return n;
  }

  countOnlineAgents() {
    let n = 0;
    for (const r of this.runtime.values()) if (this.isOnline(r.agentId)) n++;
    return n;
  }

  countOnlineSessions() {
    let n = 0;
    for (const r of this.runtime.values()) if (this.isOnline(r.agentId)) n += r.sessions.size;
    return n;
  }

  /* ----------------------------- connections ---------------------------- */

  addConn(conn) {
    this.connections.set(conn.id, conn);
    if (conn.role === 'phone') {
      let set = this.phonesByAccount.get(conn.accountId);
      if (!set) { set = new Set(); this.phonesByAccount.set(conn.accountId, set); }
      set.add(conn);
      let dset = this.deviceConns.get(conn.deviceId);
      if (!dset) { dset = new Set(); this.deviceConns.set(conn.deviceId, dset); }
      dset.add(conn);
    } else if (conn.role === 'agent') {
      this.rt(conn.agentId).conn = conn;
    }
  }

  removeConn(conn) {
    this.connections.delete(conn.id);
    if (conn.role === 'phone') {
      const set = this.phonesByAccount.get(conn.accountId);
      if (set) { set.delete(conn); if (set.size === 0) this.phonesByAccount.delete(conn.accountId); }
      const dset = this.deviceConns.get(conn.deviceId);
      if (dset) { dset.delete(conn); if (dset.size === 0) this.deviceConns.delete(conn.deviceId); }
    } else if (conn.role === 'agent') {
      const r = this.runtime.get(conn.agentId);
      if (r && r.conn === conn) r.conn = null;
    }
  }

  phonesIn(accountId) { return this.phonesByAccount.get(accountId) || EMPTY; }
}

const EMPTY = new Set();

const METRIC_FIELDS = ['memoryUsed', 'memoryTotal', 'storageUsed', 'storageTotal', 'uptimeSec'];

/**
 * Keep the known metric fields and nothing else, so what the relay hands to a
 * phone is exactly the shape the app parses. Validation already rejected
 * nonsense values; this drops anything extra an agent decided to send.
 */
function sanitizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const out = {};
  if (typeof metrics.cpuLoad === 'number') out.cpuLoad = Math.min(1, Math.max(0, metrics.cpuLoad));
  for (const k of METRIC_FIELDS) if (typeof metrics[k] === 'number' && metrics[k] >= 0) out[k] = Math.round(metrics[k]);
  out.at = Date.now();
  return Object.keys(out).length > 1 ? out : null;
}

module.exports = { Registry, sanitizeMetrics };
