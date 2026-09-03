'use strict';

/*
 * Identifiers and secrets.
 *
 *  - Ids are `<prefix>_` + 20 lowercase base32 chars from a CSPRNG. They are
 *    public handles and never grant access on their own.
 *  - Tokens are 32 random bytes, base64url. The relay stores only sha256(token)
 *    and compares hashes in constant time.
 */

const crypto = require('crypto');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_RE = /^[acds]_[a-z2-7]{20}$/;

function newId(prefix) {
  const bytes = crypto.randomBytes(20);
  let s = prefix + '_';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] & 31]; // 256 % 32 == 0: unbiased
  return s;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Constant-time string compare to avoid leaking secrets via timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** A cryptographically-random zero-padded numeric code. */
function numericCode(digits) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

function isId(v, prefix) {
  return typeof v === 'string' && ID_RE.test(v) && (!prefix || v.startsWith(prefix + '_'));
}

module.exports = { newId, newToken, hashToken, safeEqual, numericCode, isId, ID_RE };
