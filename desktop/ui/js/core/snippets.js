/**
 * Snippets: saved pieces of text with optional `{{name}}` / `{{name:default}}`
 * placeholders, filled in before they are sent. The pure part — parsing,
 * filling, the stored form — lives here so the tests can reach it; the Android
 * app's `data/Snippets.kt` is the same rules.
 *
 * A snippet is `{ id, name, folder, body, run }`: `folder` is a free-text group
 * ("" for none), `body` may span several lines, and `run` sends a trailing CR
 * after the last line (otherwise the text is only typed).
 *
 * `{{{{` is a literal `{{`. A placeholder name is `[A-Za-z_][A-Za-z0-9_ -]{0,31}`
 * once trimmed; anything else between braces is left exactly as written.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_ -]{0,31}$/;

/**
 * Split a body into literal text and placeholders:
 * `[{ text }, { name, def }, …]` in order.
 */
export function tokenize(body) {
  const src = String(body ?? '');
  const out = [];
  let lit = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('{{{{', i)) { lit += '{{'; i += 4; continue; }
    if (src.startsWith('{{', i)) {
      const close = src.indexOf('}}', i + 2);
      if (close >= 0) {
        const inner = src.slice(i + 2, close);
        const colon = inner.indexOf(':');
        const rawName = (colon >= 0 ? inner.slice(0, colon) : inner).trim();
        if (NAME.test(rawName) && !inner.includes('{') && !inner.includes('\n')) {
          if (lit) { out.push({ text: lit }); lit = ''; }
          out.push({ name: rawName, def: colon >= 0 ? inner.slice(colon + 1) : '' });
          i = close + 2;
          continue;
        }
      }
    }
    lit += src[i];
    i++;
  }
  if (lit) out.push({ text: lit });
  return out;
}

/** The distinct placeholders, in order of first appearance, with the first default seen. */
export function placeholders(body) {
  const seen = new Map();
  for (const t of tokenize(body)) {
    if (t.name == null) continue;
    if (!seen.has(t.name)) seen.set(t.name, t.def);
    else if (!seen.get(t.name) && t.def) seen.set(t.name, t.def);
  }
  return [...seen].map(([name, def]) => ({ name, def }));
}

export function hasPlaceholders(body) {
  return placeholders(body).length > 0;
}

/** The body with every placeholder replaced by its value (the default when none is given). */
export function fill(body, values = {}) {
  const defaults = new Map(placeholders(body).map((p) => [p.name, p.def]));
  return tokenize(body).map((t) => {
    if (t.name == null) return t.text;
    const v = values[t.name];
    return v != null ? String(v) : defaults.get(t.name) ?? '';
  }).join('');
}

/**
 * What goes to the terminal: the lines joined with CR, as a paste would send
 * them, and a final CR when the snippet runs. [bracketed] wraps the text (not
 * the final CR) in bracketed-paste markers when the program asked for them.
 */
export function snippetInput(text, run, bracketed = false) {
  const clean = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r');
  const ESC = '\x1b';
  const body = bracketed && clean.includes('\r')
    ? `${ESC}[200~${clean.split(`${ESC}[201~`).join('')}${ESC}[201~`
    : clean;
  return run ? `${body}\r` : body;
}

/* ------------------------------- storage -------------------------------- */

export function newSnippetId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function makeSnippet({ id, name, folder = '', body = '', run = true }) {
  return { id, name, folder, body, run: !!run };
}

function snippetFromJson(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name) return null;
  if (typeof o.body !== 'string') return null;
  return makeSnippet({
    id: o.id,
    name: o.name,
    folder: typeof o.folder === 'string' ? o.folder.trim() : '',
    body: o.body,
    run: typeof o.run === 'boolean' ? o.run : true,
  });
}

export function snippetsFromJson(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.map(snippetFromJson).filter((s) => s && !seen.has(s.id) && seen.add(s.id));
}

export function snippetsToJson(list) {
  return list.map((s) => ({ id: s.id, name: s.name, folder: s.folder || '', body: s.body, run: !!s.run }));
}

/** Folders in name order, "" (no folder) first; snippets in name order inside each. */
export function groupSnippets(list, query = '') {
  const q = String(query).trim().toLowerCase();
  const kept = q
    ? list.filter((s) => s.name.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q) ||
      s.body.toLowerCase().includes(q))
    : list;
  const byFolder = new Map();
  for (const s of kept) {
    const key = s.folder || '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(s);
  }
  const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return [...byFolder.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : cmp(a, b)))
    .map((folder) => ({ folder, snippets: byFolder.get(folder).sort((a, b) => cmp(a.name, b.name)) }));
}
