/**
 * Long-lived relay credentials. The token itself never sits in the renderer's
 * storage: it is held by the Rust side, sealed with DPAPI under the current
 * Windows account (the desktop's answer to the Android Keystore wrapping in
 * `CredentialStore.kt`). This class caches the non-secret parts so screens can
 * show the relay and the device id without a round trip.
 */

import { credentialStore } from './platform.js';

export class Credentials {
  constructor() {
    this.relayUrl = null;
    this.deviceId = null;
    this.accountId = null;
    this.token = null;
    this.loaded = false;
  }

  static async load() {
    const c = new Credentials();
    await c.reload();
    return c;
  }

  async reload() {
    try {
      const found = await credentialStore.load();
      this.apply(found);
    } catch {
      this.apply(null);
    }
    this.loaded = true;
    return this.isPaired;
  }

  apply(found) {
    this.relayUrl = found?.relayUrl ?? null;
    this.deviceId = found?.deviceId ?? null;
    this.accountId = found?.accountId ?? null;
    this.token = found?.deviceToken ?? null;
  }

  get isPaired() {
    return !!(this.relayUrl && this.token);
  }

  async save({ relayUrl, deviceId, deviceToken, accountId }) {
    await credentialStore.save({ relayUrl, deviceId, deviceToken, accountId: accountId || 'default' });
    this.apply({ relayUrl, deviceId, deviceToken, accountId: accountId || 'default' });
  }

  async clear() {
    await credentialStore.clear();
    this.apply(null);
  }
}

/**
 * Normalise what the user typed into a ws(s):// URL — a port of
 * `RelayHttp.normalizeRelayUrl`. A bare host gets `wss://`, because that is the
 * transport the product expects; `http(s)` are accepted and mapped, since that
 * is what a browser would have shown the user.
 */
export function normalizeRelayUrl(input) {
  const trimmed = String(input).trim().replace(/\/+$/, '');
  const scheme = /^(wss?|https?):\/\/(.*)$/i.exec(trimmed);
  const rest = scheme ? scheme[2] : trimmed;
  const secure = !scheme || /^(wss|https)$/i.test(scheme[1]);
  const url = `${secure ? 'wss' : 'ws'}://${rest}`;

  // A scheme with nothing after it, or a path with no authority, is not a relay.
  const authority = rest.split('/')[0];
  if (!authority || authority.endsWith(':') || !hostOf(url)) {
    throw new Error('Relay URL needs a host');
  }
  return url;
}

/** Host (with port) of a ws(s):// URL, or null when it has none. */
export function hostOf(url) {
  try {
    const parsed = new URL(url.replace(/^ws/, 'http'));
    return parsed.hostname ? (parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname) : null;
  } catch {
    return null;
  }
}

/**
 * Addresses where plain `ws://` is a reasonable choice. Anything else gets the
 * warning before pairing, exactly as on the phone.
 */
export function isPrivateHost(url) {
  const host = (hostOf(url) || '').split(':')[0];
  if (!host) return false;
  return (
    host === 'localhost' ||
    host === '10.0.2.2' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    host.startsWith('127.') ||
    host.endsWith('.local')
  );
}
