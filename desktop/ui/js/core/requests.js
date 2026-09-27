/**
 * Agent requests (PROTOCOL.md §6b): a question for a machine rather than a
 * terminal — list a folder, read a slice of a file, list the processes.
 *
 * Each request carries its own `reqId` and is answered once, by
 * `agent.response` or by `error`. This class owns only the correlation: the
 * relay client hands it every event and it settles the matching promise. It
 * has no DOM and no socket of its own, so the tests drive it directly.
 */

import { Outgoing } from '../protocol/messages.js';

export const REQUEST_TIMEOUT_MS = 30_000;

export class RequestError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export class AgentRequests {
  /**
   * @param {(json:string) => boolean} send  false when the socket is not open
   */
  constructor(send, { timeoutMs = REQUEST_TIMEOUT_MS, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = new Map();
    this.counter = 0;
  }

  /** Resolves to the method's `result` object; rejects with a RequestError. */
  request(agentId, method, params = {}) {
    const reqId = `q${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (!this.pending.delete(reqId)) return;
        reject(new RequestError('timeout', 'The machine did not answer in time.'));
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      let sent = false;
      try {
        sent = this.send(Outgoing.agentRequest(reqId, agentId, method, params));
      } catch {
        sent = false;
      }
      if (!sent) this.settle(reqId, null, new RequestError('disconnected', 'Not connected to the relay.'));
    });
  }

  /** Offer an incoming event; true when it answered one of ours. */
  handle(event) {
    if (!event || !event.reqId || !this.pending.has(event.reqId)) return false;
    if (event.kind === 'agentResponse') return this.settle(event.reqId, event.result, null);
    if (event.kind === 'error') return this.settle(event.reqId, null, new RequestError(event.code, event.message));
    return false;
  }

  settle(reqId, result, error) {
    const p = this.pending.get(reqId);
    if (!p) return false;
    this.pending.delete(reqId);
    this.clearTimer(p.timer);
    if (error) p.reject(error);
    else p.resolve(result ?? {});
    return true;
  }

  /** The socket went: nothing in flight will ever be answered. */
  failAll(code = 'disconnected', message = 'Connection lost.') {
    for (const reqId of [...this.pending.keys()]) this.settle(reqId, null, new RequestError(code, message));
  }
}

/**
 * Whether a machine can answer a feature's requests, and if not, why — in the
 * words the Files and Processes screens show.
 * @param {string[]} relayCaps  `welcome.caps`
 * @param {{online:boolean, caps:string[], name?:string, hostname?:string}} agent
 * @param {'fs'|'procs'} cap
 */
export function featureGate(relayCaps, agent, cap) {
  const name = agent?.name || agent?.hostname || 'This machine';
  if (!agent) return { ok: false, reason: 'unknown' };
  if (!(relayCaps || []).includes('requests') || !(agent.caps || []).includes(cap)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!agent.online) return { ok: false, reason: 'offline', name };
  return { ok: true, reason: null };
}
