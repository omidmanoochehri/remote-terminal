/**
 * The process manager's model: ordering, filtering, and whether a process may
 * be ended from here — the same rules as the Android app's `Processes.kt`.
 */

export const SORT_CPU = 'cpu';
export const SORT_MEMORY = 'memory';
export const SORT_NAME = 'name';

/** `OFFICE\ann` and `ann` are the same person; case never matters. */
export function sameUser(a, b) {
  if (!a || !b) return false;
  const short = (s) => String(s).toLowerCase().split('\\').pop();
  return String(a).toLowerCase() === String(b).toLowerCase() || short(a) === short(b);
}

/**
 * Whether [proc] can be ended, given the listing's `killable` and `owner`:
 * `{ ok: true }`, or `{ ok: false, reason: 'off' | 'notOwn' }`.
 */
export function endPermission(listing, proc) {
  const killable = listing?.killable ?? 'all';
  if (killable === 'none') return { ok: false, reason: 'off' };
  if (killable === 'own' && !sameUser(proc.user, listing.owner)) return { ok: false, reason: 'notOwn' };
  return { ok: true, reason: null };
}

/** Busiest first by default; memory largest first; names A→Z. */
export function arrangeProcesses(list, { sort = SORT_CPU, filter = '' } = {}) {
  const q = String(filter || '').trim().toLowerCase();
  const kept = q
    ? list.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid) === q || String(p.pid).startsWith(q) ||
      (p.user || '').toLowerCase().includes(q) || (p.cmd || '').toLowerCase().includes(q))
    : list.slice();
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.pid - b.pid;
  return kept.sort((a, b) => {
    if (sort === SORT_MEMORY) return b.mem - a.mem || byName(a, b);
    if (sort === SORT_NAME) return byName(a, b);
    return (b.cpu ?? -1) - (a.cpu ?? -1) || b.mem - a.mem || byName(a, b);
  });
}

/** "12.5%" / "0.0%" / "—" for a process too new to have a figure. */
export function cpuLabel(cpu) {
  return cpu == null ? '—' : `${(cpu * 100).toFixed(1)}%`;
}
