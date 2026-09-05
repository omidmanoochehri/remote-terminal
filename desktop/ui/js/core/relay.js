/**
 * The desktop's single relay connection — a port of `RelayClient.kt`.
 *
 * Authenticates with the stored device token, keeps the socket alive with
 * exponential-backoff reconnects (and an immediate retry when the network comes
 * back), parses incoming messages into typed events and delivers them in order.
 * Requests carrying a `reqId` can be awaited with `request()`.
 *
 * Sessions live on the agents, so a dropped socket loses nothing: listeners
 * (SessionRepository) re-attach with `since` after `connected`.
 */

import { Emitter } from './emitter.js';
import { socket, listen } from './platform.js';
import { parseIncoming, makeError } from '../protocol/incoming.js';
import { Outgoing, PROTOCOL_VERSION } from '../protocol/messages.js';

/** How long the socket is held after the window is hidden, then closed to idle quietly. */
export const BACKGROUND_GRACE_MS = 90_000;
/** Cheap enough to be a keepalive, slow enough not to matter. */
const PING_INTERVAL_MS = 20_000;

export const ConnectionState = Object.freeze({
  UNPAIRED: 'unpaired',
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  /** Not retrying: the relay refused us permanently (protocol mismatch). */
  FAILED: 'failed',
});

export class RelayClient extends Emitter {
  constructor(credentials, appVersion) {
    super();
    this.credentials = credentials;
    this.appVersion = appVersion;

    this.state = { name: credentials.isPaired ? ConnectionState.DISCONNECTED : ConnectionState.UNPAIRED };
    this.latencyMs = null;

    this.connectionId = null;
    this.wanted = false;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pingSentAt = 0;
    this.foreground = true;
    this.backgroundTimer = null;

    this.pending = new Map();
    this.reqCounter = 0;

    /**
     * Asked when the window is hidden: false closes the socket at once instead
     * of holding it for the grace period. Set from the per-machine "Keep alive".
     */
    this.keepAliveInBackground = null;

    this.deviceId = credentials.deviceId;
    this.accountId = credentials.accountId;
    this.connId = null;
    this.limits = null;

    this.wireSocketEvents();
    this.wireNetworkEvents();
  }

  get isConnected() { return this.state.name === ConnectionState.CONNECTED; }

  async wireSocketEvents() {
    await listen('ws:open', () => {
      // Wait for `welcome` before declaring connected (the relay may still refuse us).
    });
    await listen('ws:text', ({ payload }) => {
      if (payload.id !== this.connectionId) return; // a frame from a socket we gave up on
      let event;
      try {
        event = parseIncoming(payload.data);
      } catch (err) {
        console.warn('bad relay message', err);
        return;
      }
      this.dispatch(event);
    });
    await listen('ws:close', ({ payload }) => {
      if (payload.id !== this.connectionId) return;
      this.onClose(payload.code, payload.reason, payload.remote);
    });
    await listen('ws:error', ({ payload }) => {
      if (payload.id !== this.connectionId) return;
      console.warn('relay socket error:', payload.message);
    });
  }

  wireNetworkEvents() {
    // The web view knows when the machine loses and regains its network; a
    // reconnect then happens at once instead of waiting out the backoff.
    window.addEventListener('online', () => {
      if (this.wanted && this.connectionId == null) this.reconnectNow('network available');
    });
    window.addEventListener('offline', () => {
      // Nothing to do: the socket will fail on its own and schedule a retry.
    });
  }

  /* ------------------------------ lifecycle ----------------------------- */

  /** Connect (if paired) and keep connected until `stop()`. */
  start() {
    if (!this.credentials.isPaired) { this.setState({ name: ConnectionState.UNPAIRED }); return; }
    this.wanted = true;
    this.cancelBackgroundClose();
    if (this.connectionId == null) this.connect();
  }

  stop() {
    this.wanted = false;
    this.cancelReconnect();
    this.cancelPing();
    this.latencyMs = null;
    const id = this.connectionId;
    this.connectionId = null;
    if (id != null) socket.close(id, 1000, 'app closed').catch(() => {});
    this.setState({ name: this.credentials.isPaired ? ConnectionState.DISCONNECTED : ConnectionState.UNPAIRED });
  }

  /** Call after pairing: connect with the freshly stored token. */
  onPaired() {
    this.deviceId = this.credentials.deviceId;
    this.accountId = this.credentials.accountId;
    this.attempt = 0;
    this.start();
  }

  /** Forget credentials locally (the relay may also have revoked them). */
  async unpair() {
    this.stop();
    await this.credentials.clear();
    this.deviceId = null;
    this.setState({ name: ConnectionState.UNPAIRED });
  }

  /**
   * Foreground/background hint from the window. Hidden, the socket is kept for
   * a grace period and then closed; sessions keep running on the agents and are
   * re-attached on return.
   */
  setForeground(fg) {
    this.foreground = fg;
    if (fg) {
      this.cancelBackgroundClose();
      if (this.wanted && this.connectionId == null) this.reconnectNow('foreground');
      else if (!this.wanted && this.credentials.isPaired) this.start();
      return;
    }
    if (!this.wanted) return;
    this.cancelBackgroundClose();
    // Machines can opt out of the background grace period ("Keep alive" in
    // machine settings); with none opted in the socket goes at once.
    if (this.keepAliveInBackground && this.keepAliveInBackground() === false) {
      this.cancelReconnect();
      this.cancelPing();
      const id = this.connectionId;
      if (id != null) socket.close(id, 1000, 'background').catch(() => {});
      return;
    }
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      if (this.foreground) return;
      this.cancelReconnect();
      const id = this.connectionId;
      if (id != null) socket.close(id, 1000, 'background').catch(() => {});
    }, BACKGROUND_GRACE_MS);
  }

  cancelBackgroundClose() {
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  reconnectNow(reason) {
    if (!this.wanted) return;
    this.cancelReconnect();
    if (this.connectionId != null) return;
    this.attempt = 0;
    console.info('reconnect now:', reason);
    this.connect();
  }

  async connect() {
    if (!this.credentials.isPaired) {
      this.wanted = false;
      this.setState({ name: ConnectionState.UNPAIRED });
      return;
    }
    const base = this.credentials.relayUrl.replace(/\/+$/, '');
    const url = `${base}/?v=${PROTOCOL_VERSION}&role=phone&caps=sessions,replay,ping,color`;
    this.setState({ name: ConnectionState.CONNECTING, attempt: this.attempt });
    try {
      this.connectionId = await socket.connect(url, this.credentials.token);
    } catch (err) {
      this.connectionId = null;
      this.scheduleReconnect(String(err?.message || err));
    }
  }

  scheduleReconnect(reason) {
    if (!this.wanted) { this.setState({ name: ConnectionState.DISCONNECTED }); return; }
    this.cancelReconnect();
    const delay = Math.min(30_000, 500 * (1 << Math.min(this.attempt, 6))) + Math.floor(Math.random() * 400);
    this.attempt++;
    this.setState({ name: ConnectionState.RECONNECTING, attempt: this.attempt, nextAtMs: Date.now() + delay, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted && this.connectionId == null) this.connect();
    }, delay);
  }

  cancelReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  setState(next) {
    if (sameState(this.state, next)) return;
    this.state = next;
    this.emit('state', next);
  }

  /* -------------------------------- sending ----------------------------- */

  /** Send raw JSON text. Returns false when not connected. */
  send(json) {
    if (!this.isConnected || this.connectionId == null) return false;
    socket.send(this.connectionId, json).catch((err) => console.warn('send failed', err));
    return true;
  }

  nextReqId() { return `r${++this.reqCounter}`; }

  /**
   * Send a request built with a fresh reqId and await the correlated reply
   * (`session.created`, `session.attached`, `file.stored` or `error`).
   */
  request(build, timeoutMs = 15_000) {
    const reqId = this.nextReqId();
    return this.awaitReply(reqId, timeoutMs, () => this.send(build(reqId)));
  }

  /**
   * Like `request`, but the caller sends several messages under one reqId
   * (a file transfer: begin, chunks, end) and awaits the single reply.
   */
  requestMulti(sendAll, timeoutMs = 120_000) {
    const reqId = this.nextReqId();
    return this.awaitReply(reqId, timeoutMs, () => sendAll(reqId));
  }

  awaitReply(reqId, timeoutMs, send) {
    return new Promise((resolve) => {
      const finish = (event) => {
        if (!this.pending.has(reqId)) return;
        this.pending.delete(reqId);
        clearTimeout(timer);
        resolve(event);
      };
      const timer = setTimeout(
        () => finish(makeError('timeout', 'The relay did not answer in time.', reqId)),
        timeoutMs,
      );
      this.pending.set(reqId, finish);
      Promise.resolve()
        .then(send)
        .then((ok) => {
          if (ok === false) finish(makeError('disconnected', 'Not connected to the relay.', reqId));
        })
        .catch((err) => finish(makeError('disconnected', String(err?.message || err), reqId)));
    });
  }

  /* ------------------------------- receiving ---------------------------- */

  dispatch(event) {
    switch (event.kind) {
      case 'welcome':
        this.attempt = 0;
        this.connId = event.connId;
        this.deviceId = event.deviceId;
        this.accountId = event.accountId;
        this.limits = event.limits;
        this.setState({ name: ConnectionState.CONNECTED });
        this.schedulePing(true);
        break;
      case 'pong':
        if (this.pingSentAt > 0) {
          this.latencyMs = Math.max(0, Date.now() - this.pingSentAt);
          this.pingSentAt = 0;
          this.emit('latency', this.latencyMs);
        }
        break;
      case 'error': {
        const resolve = event.reqId ? this.pending.get(event.reqId) : null;
        if (resolve) { resolve(event); return; }
        this.emit('relayError', event);
        break;
      }
      case 'sessionCreated':
      case 'sessionAttached':
      case 'fileStored': {
        const resolve = event.reqId ? this.pending.get(event.reqId) : null;
        if (resolve) resolve(event);
        break;
      }
      default:
        break;
    }
    this.emit('event', event);
  }

  /**
   * Keep one ping in flight at a time. The relay answers with `pong`, which
   * gives the Machines and Machine-details screens a real latency figure
   * instead of a guess; it also keeps middleboxes from idling the socket out.
   */
  schedulePing(immediate = false) {
    this.cancelPing();
    const run = () => {
      this.pingTimer = null;
      if (!this.isConnected) return;
      this.pingSentAt = Date.now();
      if (!this.send(Outgoing.ping())) this.pingSentAt = 0;
      this.schedulePing();
    };
    this.pingTimer = setTimeout(run, immediate ? 0 : PING_INTERVAL_MS);
  }

  cancelPing() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  async onClose(code, reason, remote) {
    this.connectionId = null;
    this.cancelPing();
    this.pingSentAt = 0;
    this.latencyMs = null;
    this.emit('latency', null);
    for (const resolve of [...this.pending.values()]) {
      resolve(makeError('disconnected', 'Connection lost.'));
    }
    this.pending.clear();

    if (code === 4401) {
      console.warn('relay revoked this device');
      this.wanted = false;
      await this.credentials.clear();
      this.deviceId = null;
      this.setState({ name: ConnectionState.UNPAIRED });
      this.emit('event', makeError('unauthorized', 'This device was unpaired.'));
      return;
    }
    if (code === 4426) {
      this.wanted = false;
      this.setState({
        name: ConnectionState.FAILED,
        reason: `This app is too old for the relay (protocol v${PROTOCOL_VERSION} required).`,
      });
      return;
    }
    const why = reason && reason.trim() ? reason : remote ? `closed by relay (${code})` : 'connection lost';
    if (!this.wanted || (!this.foreground && this.backgroundTimer == null && code === 1000)) {
      this.setState({ name: ConnectionState.DISCONNECTED });
    } else {
      this.scheduleReconnect(why);
    }
  }
}

function sameState(a, b) {
  if (a.name !== b.name) return false;
  return a.attempt === b.attempt && a.reason === b.reason && a.nextAtMs === b.nextAtMs;
}
