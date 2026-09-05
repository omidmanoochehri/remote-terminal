/**
 * What a pairing payload is allowed to contain. A port of `PairingPayload.kt`,
 * kept separate from the pairing screen so the accepted shapes are testable.
 *
 * Two forms are accepted:
 *  - a bare six-digit code, as the agent prints it and a paired device shows it;
 *  - a `remoteterminal://pair?relay=…&code=…` link, which also carries the relay.
 *
 * Anything else is rejected: pairing must not silently take a relay URL from
 * whatever happens to be on the clipboard.
 */

const CODE = /^[0-9]{6}$/;

export function parsePairingPayload(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (CODE.test(trimmed)) return { relay: null, code: trimmed };

  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd < 0) return null;
  if (trimmed.slice(0, schemeEnd).toLowerCase() !== 'remoteterminal') return null;

  const queryStart = trimmed.indexOf('?');
  if (queryStart < 0) return null;
  const query = trimmed.slice(queryStart + 1);
  if (!query) return null;

  const params = new Map();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!key) continue;
    params.set(key, decode(eq < 0 ? '' : pair.slice(eq + 1)));
  }

  const code = (params.get('code') ?? '').replace(/\D/g, '');
  if (!CODE.test(code)) return null;

  const relay = params.get('relay') || null;
  // Only relay URLs we would connect to anyway; never an arbitrary scheme.
  if (relay && !relay.startsWith('ws://') && !relay.startsWith('wss://')) return null;
  return { relay, code };
}

/** Minimal percent-decoding; pairing links carry only a URL and digits. */
function decode(value) {
  if (!value.includes('%') && !value.includes('+')) return value;
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}
