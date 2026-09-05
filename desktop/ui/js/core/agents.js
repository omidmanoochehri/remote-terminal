/**
 * The account's machines and devices as the relay reports them — a port of
 * `AgentRepository.kt`. Kept up to date from relay events; the last snapshot is
 * cached on disk so the Machines screen can show (offline) machines immediately
 * at start-up and while reconnecting.
 */

import { Emitter } from './emitter.js';
import { store } from './platform.js';
import { Outgoing, agentFromJson, EMPTY_METRICS, isRunning } from '../protocol/messages.js';
import { ConnectionState } from './relay.js';

export class AgentRepository extends Emitter {
  constructor(client) {
    super();
    this.client = client;
    this.agents = [];
    this.devices = [];
    this.cacheDirty = false;

    client.on('event', (event) => this.onEvent(event));
    client.on('state', (state) => this.onConnectionState(state));
  }

  static async load(client) {
    const repo = new AgentRepository(client);
    try {
      const raw = await store.read('agents');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) repo.agents = parsed.map(agentFromJson);
      }
    } catch {
      repo.agents = [];
    }
    return repo;
  }

  agent(agentId) { return this.agents.find((a) => a.agentId === agentId) || null; }

  session(agentId, sessionId) {
    return this.agent(agentId)?.sessions.find((s) => s.sessionId === sessionId) || null;
  }

  refresh() {
    this.client.send(Outgoing.agentList());
    this.client.send(Outgoing.deviceList());
  }

  renameAgent(agentId, name) { this.client.send(Outgoing.agentRename(agentId, name)); }
  removeAgent(agentId) { this.client.send(Outgoing.agentRemove(agentId)); }
  renameDevice(name) { this.client.send(Outgoing.deviceRename(name)); }
  revokeDevice(deviceId) { this.client.send(Outgoing.deviceRevoke(deviceId)); }

  /* -------------------------------- events ------------------------------ */

  onEvent(event) {
    switch (event.kind) {
      case 'welcome':
        this.setAgents(event.agents);
        this.setDevices(event.devices);
        break;
      case 'agentList':
        this.setAgents(event.agents);
        break;
      case 'agentOnline':
        this.upsert(event.agent);
        break;
      // An offline machine keeps its terminals, but its CPU and free memory are
      // last week's news: drop them rather than show them.
      case 'agentOffline':
        this.update(event.agentId, (a) => ({
          ...a,
          online: false,
          lastSeen: event.lastSeen ?? a.lastSeen,
          metrics: EMPTY_METRICS,
        }));
        break;
      case 'agentUpdated':
        this.update(event.agentId, (a) => ({ ...a, name: event.name }));
        break;
      // Metrics tick every few seconds and mean nothing offline, so they move
      // the list without rewriting the on-disk snapshot — and they publish
      // `metrics` rather than `agents`, so only the screens that show a meter
      // redraw. A list that rebuilt itself every few seconds would blur fields
      // and swallow clicks that landed mid-rebuild.
      case 'agentMetrics':
        this.update(event.agentId, (a) => ({ ...a, metrics: event.metrics }), { cache: false, quiet: true });
        break;
      case 'agentRemoved':
        this.setAgents(this.agents.filter((a) => a.agentId !== event.agentId));
        break;
      case 'deviceList':
        this.setDevices(event.devices);
        break;
      case 'deviceUpdated':
        this.setDevices(this.devices.map((d) => (d.deviceId === event.deviceId ? { ...d, name: event.name } : d)));
        break;
      case 'deviceRevoked':
        this.setDevices(this.devices.filter((d) => d.deviceId !== event.deviceId));
        break;
      case 'sessionCreated':
        this.update(event.agentId, (a) => ({
          ...a,
          sessions: [...a.sessions.filter((s) => s.sessionId !== event.session.sessionId), event.session],
        }));
        break;
      case 'sessionUpdated':
        this.updateSession(event.agentId, event.sessionId, (s) => ({
          ...s,
          title: event.title ?? s.title,
          state: event.state ?? s.state,
          cols: event.cols ?? s.cols,
          rows: event.rows ?? s.rows,
          exitCode: event.exitCode ?? s.exitCode,
          cwd: event.cwd ?? s.cwd,
        }));
        break;
      case 'sessionAttached':
        this.updateSession(event.agentId, event.sessionId, (s) => ({
          ...s, cols: event.cols, rows: event.rows, seq: event.seq,
        }));
        break;
      case 'exit':
        this.updateSession(event.agentId, event.sessionId, (s) => ({ ...s, state: 'exited', exitCode: event.code }));
        break;
      case 'sessionClosed':
        this.update(event.agentId, (a) => ({
          ...a, sessions: a.sessions.filter((s) => s.sessionId !== event.sessionId),
        }));
        break;
      default:
        break;
    }
  }

  onConnectionState(state) {
    // While disconnected nobody is reachable; keep the list but show everything offline.
    if (state.name === ConnectionState.CONNECTED || state.name === ConnectionState.CONNECTING) return;
    if (this.agents.some((a) => a.online)) {
      this.setAgents(this.agents.map((a) => ({ ...a, online: false, metrics: EMPTY_METRICS })));
    }
  }

  /* -------------------------------- state ------------------------------- */

  setAgents(list, { cache = true, quiet = false } = {}) {
    this.agents = [...list].sort(
      (a, b) => Number(!a.online) - Number(!b.online) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
    if (cache) this.saveCache();
    this.emit(quiet ? 'metrics' : 'agents', this.agents);
  }

  setDevices(list) {
    this.devices = list;
    this.emit('devices', this.devices);
  }

  upsert(agent) {
    this.setAgents([...this.agents.filter((a) => a.agentId !== agent.agentId), agent]);
  }

  update(agentId, fn, options = {}) {
    if (!this.agents.some((a) => a.agentId === agentId)) return;
    this.setAgents(this.agents.map((a) => (a.agentId === agentId ? fn(a) : a)), options);
  }

  updateSession(agentId, sessionId, fn) {
    this.update(agentId, (a) =>
      a.sessions.some((s) => s.sessionId === sessionId)
        ? { ...a, sessions: a.sessions.map((s) => (s.sessionId === sessionId ? fn(s) : s)) }
        : a);
  }

  /* -------------------------------- cache ------------------------------- */

  /**
   * Only the identity of each machine is cached, never its live state: a cached
   * machine always reads as offline with no sessions until the relay says
   * otherwise, so the list can never show a terminal that is not there.
   */
  saveCache() {
    const snapshot = this.agents.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      hostname: a.hostname,
      platform: a.platform,
      os: a.os,
      arch: a.arch,
      agentVersion: a.agentVersion,
      shells: a.shells.map((s) => ({ id: s.id, label: s.label, default: s.isDefault })),
      lastSeen: a.lastSeen,
      online: false,
    }));
    store.write('agents', JSON.stringify(snapshot)).catch(() => {});
  }

  async clearCache() {
    await store.remove('agents').catch(() => {});
    this.setAgents([], { cache: false });
    this.setDevices([]);
  }

  /* ------------------------------- queries ------------------------------ */

  /** Every terminal on the account, paired with the machine hosting it. */
  allSessions() {
    return this.agents.flatMap((agent) => agent.sessions.map((session) => ({ agent, session })));
  }

  runningCount() {
    return this.agents.reduce((n, a) => n + a.sessions.filter(isRunning).length, 0);
  }
}
