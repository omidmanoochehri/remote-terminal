/**
 * The System view's model: the listening-ports filter and the few labels
 * built from `sys.info` / `net.ports` answers (PROTOCOL.md §6b).
 */

/** Ports by port then protocol, narrowed by [filter] (port, protocol, address, process or pid). */
export function arrangePorts(list, filter = '') {
  const q = String(filter ?? '').trim().toLowerCase();
  const rows = (Array.isArray(list) ? list : []).filter((p) => p && Number.isInteger(p.port));
  const kept = q
    ? rows.filter((p) =>
      String(p.port).startsWith(q) ||
      String(p.proto || '').toLowerCase() === q ||
      String(p.address || '').toLowerCase().includes(q) ||
      String(p.process || '').toLowerCase().includes(q) ||
      (p.pid != null && String(p.pid) === q))
    : rows.slice();
  return kept.sort((a, b) => a.port - b.port || String(a.proto).localeCompare(String(b.proto)) ||
    String(a.address).localeCompare(String(b.address)));
}

/**
 * `address:port` as it would be typed: IPv6 in brackets, and a wildcard bind
 * shown as the address it listens on.
 */
export function endpoint(p) {
  const address = String(p.address ?? '');
  return address.includes(':') ? `[${address}]:${p.port}` : `${address}:${p.port}`;
}

/** "sshd (1234)", "1234", or null when neither is known. */
export function processLabel(p) {
  if (p.process && p.pid != null) return `${p.process} (${p.pid})`;
  if (p.process) return String(p.process);
  if (p.pid != null) return String(p.pid);
  return null;
}
