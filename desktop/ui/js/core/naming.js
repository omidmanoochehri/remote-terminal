/**
 * Naming for terminals the app creates from an existing one. Duplicating
 * "deploy" gives "deploy (2)", duplicating that gives "deploy (3)" rather than
 * "deploy (2) (2)", so a machine full of copies still reads as a list.
 *
 * A port of `TerminalNaming.kt`.
 */

const COPY_SUFFIX = /\s*\((\d+)\)$/;

/** The title for a copy of [title], avoiding every name in [taken]. */
export function copyTitle(title, taken) {
  const base = String(title).trim().replace(COPY_SUFFIX, '').trim();
  if (!base) return '';
  const used = new Set([...taken].map((t) => String(t).trim()));
  let n = 2;
  while (used.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}
