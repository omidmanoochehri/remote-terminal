'use strict';

/*
 * Short-lived pairing codes (protocol v3).
 *
 * An authenticated principal (an agent or an already-paired device) mints a
 * numeric code bound to its account. A phone redeems the code exactly once to
 * obtain a device token. Codes expire, are single-use, one-per-issuer (minting
 * again replaces the previous code), and are invalidated after too many wrong
 * guesses while they are outstanding. IP and global attempt budgets live in
 * the HTTP layer (see http.js); this store only knows about codes.
 */

const { numericCode } = require('./tokens');

class PairingStore {
  constructor({ digits = 6, ttlSec = 300, maxWrongGuesses = 25, now = Date.now } = {}) {
    this.digits = digits;
    this.ttlMs = ttlSec * 1000;
    this.maxWrongGuesses = maxWrongGuesses;
    this.now = now;
    /** @type {Map<string, {code:string, accountId:string, issuedBy:string, expires:number, wrong:number}>} */
    this.byCode = new Map();
    /** @type {Map<string, string>} issuer id -> code */
    this.byIssuer = new Map();
  }

  /** Mint a code for `accountId` on behalf of `issuedBy` (agent or device id). */
  mint({ accountId, issuedBy }) {
    this.prune();
    const prev = this.byIssuer.get(issuedBy);
    if (prev) this.byCode.delete(prev);
    let code;
    do { code = numericCode(this.digits); } while (this.byCode.has(code));
    const expires = this.now() + this.ttlMs;
    this.byCode.set(code, { code, accountId, issuedBy, expires, wrong: 0 });
    this.byIssuer.set(issuedBy, code);
    return { code, expiresAt: expires, ttlSec: Math.round(this.ttlMs / 1000) };
  }

  /**
   * Redeem a code. Returns {ok:true, accountId, issuedBy} or {ok:false}.
   * A wrong guess counts against every outstanding code (defence in depth on
   * top of the per-IP / global budgets), and codes past the guess cap die.
   */
  redeem(code) {
    this.prune();
    const key = String(code == null ? '' : code);
    const entry = this.byCode.get(key);
    if (!entry) {
      for (const e of this.byCode.values()) {
        if (++e.wrong >= this.maxWrongGuesses) this.remove(e);
      }
      return { ok: false };
    }
    this.remove(entry); // single use
    return { ok: true, accountId: entry.accountId, issuedBy: entry.issuedBy };
  }

  remove(entry) {
    this.byCode.delete(entry.code);
    if (this.byIssuer.get(entry.issuedBy) === entry.code) this.byIssuer.delete(entry.issuedBy);
  }

  /** Drop expired entries. */
  prune() {
    const now = this.now();
    for (const e of this.byCode.values()) if (now > e.expires) this.remove(e);
  }

  get size() { return this.byCode.size; }
}

module.exports = { PairingStore };
