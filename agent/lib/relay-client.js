'use strict';

/*
 * The agent's connection to the relay (protocol v3).
 *
 * Owns exactly one WebSocket at a time, reconnects with exponential backoff,
 * registers the agent and its surviving sessions on every (re)connect, and
 * translates relay messages into SessionManager calls. Sessions are never
 * touched by connection loss; only close codes 4401 (revoked) / 4409
 * (replaced) / 4426 (upgrade required) stop the client for good.
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const { advertise } = require('./shells');
const { Metrics } = require('./metrics');
const { SessionError } = require('./sessions');
const { buildEnv } = require('./env');

const PROTOCOL_VERSION = 3;
const AGENT_CAPS = ['sessions', 'replay', 'resize', 'ping', 'files', 'metrics'];
const FATAL_CLOSE = { 4401: 'revoked', 4409: 'replaced', 4426: 'upgrade_required' };

class RelayClient extends EventEmitter {
  /**
   * @param {{cfg, state, log, sessions, meta, shells, uploads?, metrics?, WebSocketImpl?, now?}} opts
   */
  constructor({ cfg, state, log, sessions, meta, shells, uploads = null, metrics = undefined, WebSocketImpl = WebSocket, now = Date.now }) {
    super();
    this.cfg = cfg;
    this.uploads = uploads;
    this.state = state;
    this.log = log;
    this.sessions = sessions;
    this.meta = meta;
    this.shells = shells;
    this.WS = WebSocketImpl;
    this.now = now;
    this.instanceId = crypto.randomBytes(8).toString('hex');
    // null disables reporting entirely (metricsIntervalMs=0); undefined takes the default collector.
    this.metrics = metrics === undefined ? new Metrics({ log }) : metrics;
    this.ws = null;
    this.attempt = 0;
    this.stopped = false;
    this.fatal = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.metricsTimer = null;
    this.drainTimer = null;
    this.paused = false;

    sessions.on('output', (s, o) => this.sendOutput(s, o));
    sessions.on('session.updated', (s, patch) => this.send(Object.assign({ type: 'session.updated', session: s.id }, patch)));
    sessions.on('exit', (s, code) => this.send({ type: 'exit', session: s.id, code }));
    sessions.on('session.closed', (s, reason) => this.send({ type: 'session.closed', session: s.id, reason }));
  }

  get connected() { return !!this.ws && this.ws.readyState === this.ws.OPEN; }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopTimers();
    if (this.ws) { try { this.ws.close(1000, 'agent shutting down'); } catch (_) { /* ignore */ } }
  }

  url() { return `${this.cfg.server}/?v=${PROTOCOL_VERSION}&role=agent`; }

  connect() {
    if (this.stopped || this.fatal) return;
    const url = this.url();
    this.log.info('connecting', { server: this.cfg.server, attempt: this.attempt });
    let ws;
    try {
      ws = new this.WS(url, { headers: { Authorization: `Bearer ${this.state.agentToken}` }, handshakeTimeout: 15000, maxPayload: 16 * 1024 * 1024 });
    } catch (err) {
      this.log.error('cannot open socket', { err: err.message });
      return this.scheduleReconnect();
    }
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.log.info('connected to relay');
      this.register();
      this.startPing();
      this.startMetrics();
      this.emit('connected');
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return this.log.warn('ignoring non-JSON message'); }
      try { this.handle(msg); } catch (err) { this.log.error('handler failure', { type: msg && msg.type, err: err.message }); }
    });

    ws.on('pong', () => { if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; } });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopTimers();
      this.sessions.resumeAll();
      this.sessions.detachAll(); // attachments live on the relay; phones re-attach after agent.online
      const why = reason ? reason.toString() : '';
      if (FATAL_CLOSE[code]) {
        this.fatal = FATAL_CLOSE[code];
        this.log.error(`relay closed the connection permanently: ${this.fatal}`, { code, reason: why });
        this.emit('fatal', this.fatal, code);
        return;
      }
      this.emit('disconnected', code);
      if (this.stopped) return;
      this.scheduleReconnect(code, why);
    });

    ws.on('error', (err) => this.log.warn('socket error', { err: err.message }));
  }

  scheduleReconnect(code, reason) {
    if (this.stopped || this.fatal || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * Math.min(500, this.cfg.baseBackoffMs));
    const delay = Math.min(this.cfg.maxBackoffMs, this.cfg.baseBackoffMs * 2 ** Math.min(this.attempt, 10)) + jitter;
    this.attempt++;
    this.log.warn('relay connection closed; reconnecting', { code, reason, delayMs: delay, attempt: this.attempt, sessions: this.sessions.sessions.size });
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  startPing() {
    this.stopTimers();
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      try { this.ws.ping(); } catch (_) { return; }
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          this.pongTimer = null;
          this.log.warn('relay did not answer ping; terminating socket');
          try { this.ws.terminate(); } catch (_) { /* ignore */ }
        }, 10000);
      }
    }, 30000);
  }

  /**
   * Publish system metrics while connected. They ride along with the register
   * payload so the machine screen has numbers the moment an agent appears,
   * then refresh on a timer — the relay keeps them in memory only, so a
   * reconnect always re-sends them.
   */
  startMetrics() {
    if (this.metricsTimer) { clearInterval(this.metricsTimer); this.metricsTimer = null; }
    const every = this.metricsEvery();
    if (!every) return;
    this.metricsTimer = setInterval(() => this.sendMetrics(), every);
    if (this.metricsTimer.unref) this.metricsTimer.unref();
  }

  /** How often to publish metrics, or 0 when they are off (or unconfigured). */
  metricsEvery() {
    if (!this.metrics) return 0;
    const every = Number(this.cfg.metricsIntervalMs);
    return Number.isFinite(every) && every > 0 ? every : 0;
  }

  sendMetrics() {
    if (!this.connected || !this.metrics) return;
    let sample;
    try { sample = this.metrics.sample(); } catch (err) { return this.log.warn('metrics sample failed', { err: err.message }); }
    if (sample && Object.keys(sample).length) this.send({ type: 'agent.metrics', metrics: sample });
    return undefined;
  }

  /** The sample to register with, or undefined when metrics are off. */
  registerMetrics() {
    if (!this.metricsEvery()) return undefined;
    try {
      const sample = this.metrics.sample();
      return sample && Object.keys(sample).length ? sample : undefined;
    } catch (err) {
      this.log.warn('metrics sample failed', { err: err.message });
      return undefined;
    }
  }

  stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    if (this.metricsTimer) { clearInterval(this.metricsTimer); this.metricsTimer = null; }
    if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
    this.paused = false;
  }

  /* --------------------------------- send --------------------------------- */

  send(obj) {
    if (!this.connected) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (err) { this.log.warn('send failed', { err: err.message }); return false; }
  }

  /** Live output with backpressure: pause every PTY while the socket buffer is high. */
  sendOutput(session, { seq, data }) {
    if (!this.connected) return;
    this.send({ type: 'output', session: session.id, seq, data });
    if (!this.paused && this.ws.bufferedAmount > this.cfg.backpressureHighBytes) {
      this.paused = true;
      this.sessions.pauseAll();
      this.log.warn('relay socket congested; pausing shells', { buffered: this.ws.bufferedAmount });
      this.drainTimer = setInterval(() => {
        if (!this.connected || this.ws.bufferedAmount <= this.cfg.backpressureLowBytes) {
          clearInterval(this.drainTimer); this.drainTimer = null;
          this.paused = false;
          this.sessions.resumeAll();
        }
      }, 100);
    }
  }

  error(msg, code, message, extra) {
    const out = Object.assign({ type: 'error', code, message }, extra);
    if (msg.reqId !== undefined) out.reqId = msg.reqId;
    if (msg.client !== undefined) out.client = msg.client;
    if (msg.session !== undefined) out.session = msg.session;
    this.send(out);
  }

  register() {
    this.send(Object.assign({
      type: 'agent.register',
      instanceId: this.instanceId,
      name: this.state.name || this.cfg.name || undefined,
      shells: advertise(this.shells),
      caps: AGENT_CAPS,
      sessions: this.sessions.list(),
      metrics: this.registerMetrics(),
    }, this.meta));
  }

  /* -------------------------------- receive ------------------------------- */

  handle(m) {
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'welcome':
        this.log.info('welcome', { v: m.v, agentId: m.agentId, name: m.name, caps: m.caps });
        if (m.v !== PROTOCOL_VERSION) this.log.warn('relay protocol version differs', { relay: m.v, agent: PROTOCOL_VERSION });
        break;
      case 'agent.registered':
        if (m.name && m.name !== this.state.name) { this.state.name = m.name; this.emit('state'); }
        this.log.info('registered', { agentId: m.agentId, name: m.name, sessions: this.sessions.sessions.size });
        this.emit('registered', m);
        break;
      case 'agent.updated':
        if (m.name) { this.state.name = m.name; this.emit('state'); this.log.info('renamed by relay', { name: m.name }); }
        break;
      case 'session.create': return this.onCreate(m);
      case 'session.attach': return this.onAttach(m);
      case 'session.detach': this.sessions.detach(m.session, m.client); break;
      case 'client.gone': this.sessions.clientGone(m.client); if (this.uploads) this.uploads.clientGone(m.client); break;
      case 'file.begin':
      case 'file.chunk':
      case 'file.end':
      case 'file.abort': return this.onFile(m);
      case 'session.close': return this.guarded(m, () => this.sessions.close(m.session, 'closed'));
      case 'session.rename': return this.guarded(m, () => this.sessions.rename(m.session, String(m.title).slice(0, 64)));
      case 'input': return this.onInput(m);
      case 'resize': return this.guarded(m, () => this.sessions.get(m.session).resize(m.cols | 0, m.rows | 0));
      case 'pong': break;
      case 'ping': this.send({ type: 'pong' }); break;
      case 'error': this.log.warn('relay error', { code: m.code, message: m.message, reqId: m.reqId }); break;
      default: this.log.debug('unhandled message', { type: m.type });
    }
    return undefined;
  }

  guarded(m, fn) {
    try { fn(); } catch (err) {
      if (err instanceof SessionError) this.error(m, err.code, err.message);
      else { this.log.error('command failed', { type: m.type, err: err.message }); this.error(m, 'internal', 'internal error'); }
    }
  }

  onCreate(m) {
    const cols = Math.max(1, Math.min(500, m.cols | 0)) || 80;
    const rows = Math.max(1, Math.min(300, m.rows | 0)) || 24;
    let session;
    try {
      session = this.sessions.create({
        shell: m.shell, cols, rows, title: m.title ? String(m.title).slice(0, 64) : undefined,
        env: buildEnv({ inherit: this.cfg.inheritEnv }),
      });
    } catch (err) {
      const code = err instanceof SessionError ? err.code : 'internal';
      this.log.warn('session.create failed', { code, err: err.message });
      return this.error(m, code, err.message);
    }
    const out = { type: 'session.created', session: session.info() };
    if (m.reqId !== undefined) out.reqId = m.reqId;
    if (m.client !== undefined) out.client = m.client;
    return this.send(out);
  }

  onAttach(m) {
    let session;
    try { session = this.sessions.get(m.session); } catch (err) { return this.error(m, err.code, err.message); }
    const replay = session.attach(m.client, m.since);
    const ack = { type: 'session.attached', client: m.client, session: session.id, from: replay.from, seq: replay.seq, cols: session.cols, rows: session.rows };
    if (m.reqId !== undefined) ack.reqId = m.reqId;
    this.send(ack);
    for (const c of replay.chunks) this.send({ type: 'output', session: session.id, seq: c.seq, data: c.data, client: m.client });
    // The attaching phone's geometry wins; other attached phones learn via session.updated.
    if (Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols > 0 && m.rows > 0) session.resize(m.cols, m.rows);
    return undefined;
  }

  /** A phone is sending a file into a session (pasted image, small upload). */
  onFile(m) {
    if (!this.uploads) return this.error(m, 'bad_request', 'this agent does not accept files');
    try {
      switch (m.type) {
        case 'file.begin':
          if (!this.sessions.has(m.session)) return this.error(m, 'unknown_session', 'no such session');
          this.uploads.begin(m.client, { reqId: m.reqId, session: m.session, name: m.name, mime: m.mime, size: m.size });
          break;
        case 'file.chunk':
          this.uploads.chunk(m.client, m.reqId, m.seq, m.data);
          break;
        case 'file.end': {
          const stored = this.uploads.end(m.client, m.reqId);
          this.send({ type: 'file.stored', reqId: m.reqId, client: m.client, session: m.session, path: stored.path, size: stored.size });
          break;
        }
        case 'file.abort':
          this.uploads.abort(m.client, m.reqId);
          break;
      }
    } catch (err) {
      const code = err.code || 'internal';
      if (code === 'internal') this.log.error('file transfer failed', { err: err.message });
      else this.log.warn('file transfer rejected', { code, err: err.message });
      this.error(m, code, err.message);
    }
    return undefined;
  }

  onInput(m) {
    if (typeof m.data !== 'string') return;
    if (m.data.length > this.cfg.maxInputBytes) return this.log.warn('input too large; dropped', { len: m.data.length });
    const session = this.sessions.sessions.get(m.session);
    if (!session) return this.error(m, 'unknown_session', 'no such session');
    if (!session.write(m.data)) this.log.debug('input to non-running session ignored', { sessionId: m.session });
    return undefined;
  }
}

module.exports = { RelayClient, PROTOCOL_VERSION, AGENT_CAPS };
