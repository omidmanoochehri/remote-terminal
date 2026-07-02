'use strict';

/*
 * Short-lived pairing codes. An agent registering a room mints a numeric code
 * with a TTL; a phone redeems it once to join. Codes are single-use and per
 * room, so the room id itself carries no authority.
 */

const crypto = require('crypto');

/** A cryptographically-random zero-padded numeric code. */
function numericCode(digits) {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(digits, '0');
}

class PairingStore {
  constructor(digits = 6) {
    this.digits = digits;
    /** @type {Map<string, {code: string, expires: number}>} */
    this.byRoom = new Map();
  }

  mint(room, ttlSec) {
    const code = numericCode(this.digits);
    const expires = Date.now() + ttlSec * 1000;
    this.byRoom.set(room, { code, expires });
    return { code, expires: Math.round(expires / 1000) };
  }

  redeem(room, code) {
    const entry = this.byRoom.get(room);
    if (!entry) return false;
    if (Date.now() > entry.expires) { this.byRoom.delete(room); return false; }
    if (String(code) !== entry.code) return false;
    this.byRoom.delete(room); // single use
    return true;
  }

  /** Drop expired entries (call periodically if long-running). */
  prune() {
    const now = Date.now();
    for (const [room, e] of this.byRoom) if (now > e.expires) this.byRoom.delete(room);
  }
}

module.exports = { PairingStore, numericCode };
