'use strict';

/*
 * Connection authorization for the relay.
 *
 * Two independent mechanisms, both optional (a bare room token still works for
 * local/dev, matching v1):
 *   1. A shared `authToken` — every client must present it (query `token=` or
 *      an `Authorization: Bearer` header).
 *   2. Short-lived pairing codes — the agent registers a room and is issued a
 *      numeric code; the phone joins by presenting that code (`pair=`).
 *
 * See ./pairing.js for the code store and ../PROTOCOL.md for the messages.
 */

const crypto = require('crypto');
const { PairingStore } = require('./pairing');

const pairing = new PairingStore();

/** Constant-time string compare to avoid leaking the token via timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @returns {{ok: boolean, reason?: string, paired?: object}}
 *   `paired` (when present) is a control message to send back to the client,
 *   e.g. a freshly minted pairing code for an agent.
 */
function authorize({ cfg, role, room, token, pair }) {
  // 1) Shared token gate (if configured).
  if (cfg.authToken) {
    if (!token || !safeEqual(token, cfg.authToken)) return { ok: false, reason: 'unauthorized' };
  }

  // 2) Pairing (if enabled). Agents mint codes; phones must present a valid one.
  if (cfg.pairing && cfg.pairing.enabled) {
    if (role === 'agent') {
      const code = pairing.mint(room, cfg.pairing.ttlSec);
      return { ok: true, paired: { type: 'paired', code: code.code, expires: code.expires } };
    }
    if (role === 'phone') {
      if (!pair || !pairing.redeem(room, pair)) return { ok: false, reason: 'invalid or expired pairing code' };
      return { ok: true };
    }
  }

  return { ok: true };
}

module.exports = { authorize, pairing, safeEqual };
