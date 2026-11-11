/**
 * Wake-on-LAN: the magic packet (six 0xFF bytes, then the MAC sixteen times),
 * the MAC parser, and the directed broadcast for an interface's subnet. The
 * UDP send itself is the Rust command `wake_on_lan`; everything here is pure.
 *
 * Stored per machine under `wol.<agentId>` as `{ mac, broadcast, port }`.
 */

export const DEFAULT_BROADCAST = '255.255.255.255';
export const DEFAULT_WOL_PORT = 9;

/**
 * A MAC address written with `:`, `-`, `.` or nothing between the digits →
 * six bytes, or null. `aa:bb:cc:dd:ee:ff`, `AA-BB-CC-DD-EE-FF`,
 * `aabb.ccdd.eeff` and `aabbccddeeff` are all the same address.
 */
export function parseMac(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let hex;
  if (/^[0-9a-f]{2}([:-])[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i.test(s)) hex = s.replace(/[:-]/g, '');
  else if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(s)) hex = s.replace(/\./g, '');
  else if (/^[0-9a-f]{12}$/i.test(s)) hex = s;
  else return null;
  const bytes = new Uint8Array(6);
  for (let i = 0; i < 6; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Six bytes → `aa:bb:cc:dd:ee:ff`. */
export function formatMac(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

/** 102 bytes: 6 × 0xFF, then the MAC 16 times. */
export function magicPacket(mac) {
  const bytes = typeof mac === 'string' ? parseMac(mac) : mac;
  if (!bytes || bytes.length !== 6) throw new Error('Invalid MAC address');
  const packet = new Uint8Array(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) packet.set(bytes, 6 + i * 6);
  return packet;
}

export function parseIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function formatIPv4(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
}

/**
 * The directed broadcast for an IPv4 `address/prefix`: `192.168.1.20/24` →
 * `192.168.1.255`. Null for anything else (IPv6 has no broadcast); a /31 or
 * /32 has no broadcast of its own, so those give the limited broadcast.
 */
export function directedBroadcast(cidr) {
  const m = /^([^/]+)\/(\d{1,2})$/.exec(String(cidr ?? '').trim());
  if (!m) return null;
  const ip = parseIPv4(m[1]);
  const prefix = Number(m[2]);
  if (ip == null || prefix > 32) return null;
  if (prefix >= 31) return DEFAULT_BROADCAST;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return formatIPv4((ip | (~mask >>> 0)) >>> 0);
}

/**
 * What to remember from a `sys.info` answer: the first interface with a MAC and
 * an IPv4 address, and the broadcast of that address's subnet. Null when no
 * interface qualifies.
 */
export function wolFromSysInfo(info) {
  for (const iface of Array.isArray(info?.interfaces) ? info.interfaces : []) {
    const mac = iface?.mac ? parseMac(iface.mac) : null;
    if (!mac || mac.every((b) => b === 0)) continue;
    const v4 = (Array.isArray(iface.addresses) ? iface.addresses : []).find((a) => a?.family === 'IPv4' || a?.family === 4);
    if (!v4) continue;
    return {
      mac: formatMac(mac),
      broadcast: directedBroadcast(v4.cidr) ?? DEFAULT_BROADCAST,
      port: DEFAULT_WOL_PORT,
    };
  }
  return null;
}

/** A stored `wol.<agentId>` value, checked; null when there is no usable MAC. */
export function wolConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mac = parseMac(raw.mac);
  if (!mac) return null;
  const broadcast = parseIPv4(raw.broadcast) != null ? String(raw.broadcast).trim() : DEFAULT_BROADCAST;
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_WOL_PORT;
  return { mac: formatMac(mac), broadcast, port };
}
