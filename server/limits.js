'use strict';

/*
 * Fixed-window rate limiters with optional lockout, keyed by an arbitrary
 * string (IP, connection id, ...). Deliberately simple: a Map of counters that
 * is pruned lazily so a long-running relay does not accumulate stale keys.
 */

class RateLimiter {
  /**
   * @param {{limit:number, windowMs:number, lockoutMs?:number, now?:()=>number}} opts
   */
  constructor({ limit, windowMs, lockoutMs = 0, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.now = now;
    /** @type {Map<string, {count:number, start:number, lockedUntil:number}>} */
    this.entries = new Map();
    this.ops = 0;
  }

  /** Record one event for `key`. Returns {ok, retryAfterMs}. */
  hit(key) {
    const now = this.now();
    if (++this.ops % 1000 === 0) this.prune(now);
    let e = this.entries.get(key);
    if (!e) { e = { count: 0, start: now, lockedUntil: 0 }; this.entries.set(key, e); }
    if (e.lockedUntil) {
      if (e.lockedUntil > now) return { ok: false, retryAfterMs: e.lockedUntil - now };
      e.lockedUntil = 0; e.count = 0; e.start = now; // lockout served: fresh window
    }
    if (now - e.start >= this.windowMs) { e.count = 0; e.start = now; }
    e.count++;
    if (e.count > this.limit) {
      if (this.lockoutMs > 0) e.lockedUntil = now + this.lockoutMs;
      return { ok: false, retryAfterMs: this.lockoutMs > 0 ? this.lockoutMs : this.windowMs - (now - e.start) };
    }
    return { ok: true, retryAfterMs: 0 };
  }

  /** Whether `key` is currently locked out without recording an event. */
  isLocked(key) {
    const e = this.entries.get(key);
    return !!e && e.lockedUntil > this.now();
  }

  reset(key) { this.entries.delete(key); }

  prune(now = this.now()) {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && now - e.start >= this.windowMs) this.entries.delete(k);
    }
  }
}

/**
 * Per-connection message budget: a rolling 1 s window. Kept separate from
 * RateLimiter because it is on the hot path and needs no Map lookup.
 */
class MessageBudget {
  constructor(perSec, now = Date.now) {
    this.perSec = perSec;
    this.now = now;
    this.start = now();
    this.count = 0;
  }

  /** @returns {boolean} true when the message is within budget */
  allow() {
    const now = this.now();
    if (now - this.start >= 1000) { this.start = now; this.count = 0; }
    return ++this.count <= this.perSec;
  }
}

module.exports = { RateLimiter, MessageBudget };
