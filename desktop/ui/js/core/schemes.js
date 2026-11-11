/**
 * User colour schemes: stored, imported and exported in the Windows Terminal
 * scheme form (`name, background, foreground, cursorColor,
 * selectionBackground, black … brightWhite`), which is also this app's own
 * export form — so a scheme copied out of Windows Terminal's settings pastes
 * straight in, and one copied out of here pastes straight into it.
 *
 * Stored under the settings key `custom_schemes`, each with an id `user:<random>`.
 */

import { TerminalTheme } from '../terminal/theme.js';

/** The 16 ANSI colours in palette order, by their Windows Terminal names. */
export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite',
];

export const BASE_KEYS = ['background', 'foreground', 'cursorColor', 'selectionBackground'];

/** Selection is drawn over text, so a user scheme's selection gets the built-ins' translucency. */
const SELECTION_ALPHA = 0x66;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha dropped) → `#rrggbb`, or null. */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);
  return null;
}

const toInt = (hex) => parseInt(hex.slice(1), 16);
const toHex = (n) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

export function newSchemeId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `user:${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * One scheme object from JSON, or `{ error }`. Required: a name, background,
 * foreground and all 16 ANSI colours; the cursor defaults to the foreground
 * and the selection to the bright blue.
 */
export function schemeFromObject(o, { requireId = false } = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'Not a colour scheme object.' };
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { error: 'The scheme has no name.' };
  const out = { id: typeof o.id === 'string' && o.id.startsWith('user:') ? o.id : null, name };
  if (requireId && !out.id) return { error: 'The scheme has no id.' };
  const missing = [];
  for (const key of ['background', 'foreground', ...ANSI_KEYS]) {
    const hex = normalizeHex(o[key]);
    if (!hex) missing.push(key);
    else out[key] = hex;
  }
  if (missing.length) return { error: `${name}: missing or invalid ${missing.join(', ')}.` };
  out.cursorColor = normalizeHex(o.cursorColor) ?? out.foreground;
  out.selectionBackground = normalizeHex(o.selectionBackground) ?? out.brightBlue;
  return { scheme: out };
}

/**
 * Pasted JSON → `{ schemes, errors }`. Accepts one scheme object, an array of
 * them, or a Windows Terminal settings file with a `schemes` array. Imported
 * schemes always get fresh ids so they never replace an existing one.
 */
export function parseSchemeImport(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch {
    return { schemes: [], errors: ['This is not valid JSON.'] };
  }
  const list = Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray(data.schemes) ? data.schemes
      : [data];
  const schemes = [];
  const errors = [];
  for (const item of list) {
    const r = schemeFromObject(item);
    if (r.error) errors.push(r.error);
    else schemes.push({ ...r.scheme, id: newSchemeId() });
  }
  if (list.length === 0) errors.push('No colour schemes found.');
  return { schemes, errors };
}

/** The Windows Terminal form, for "Copy as JSON" (no id: it means nothing elsewhere). */
export function schemeToWindowsTerminal(scheme) {
  const o = { name: scheme.name };
  for (const key of [...BASE_KEYS, ...ANSI_KEYS]) o[key] = scheme[key];
  return o;
}

/** A user scheme copied from any theme (built-in or user), under a new name and id. */
export function schemeFromTheme(theme, name = `${theme.name} copy`) {
  const r = theme.raw;
  const scheme = {
    id: newSchemeId(),
    name,
    background: toHex(r.background),
    foreground: toHex(r.foreground),
    cursorColor: toHex(r.cursor),
    selectionBackground: toHex(r.selection),
  };
  ANSI_KEYS.forEach((key, i) => { scheme[key] = toHex(r.ansi[i]); });
  return scheme;
}

/** A scheme as a TerminalTheme the view can paint with. */
export function themeFromScheme(scheme) {
  const bg = toInt(scheme.background);
  const lum = (0.2126 * ((bg >> 16) & 0xff) + 0.7152 * ((bg >> 8) & 0xff) + 0.0722 * (bg & 0xff)) / 255;
  return new TerminalTheme(
    scheme.id,
    scheme.name,
    0xff000000 | bg,
    0xff000000 | toInt(scheme.foreground),
    0xff000000 | toInt(scheme.cursorColor),
    (SELECTION_ALPHA << 24) | toInt(scheme.selectionBackground),
    ANSI_KEYS.map((key) => toInt(scheme[key])),
    lum > 0.5,
  );
}

/** Stored list → schemes, dropping anything malformed. */
export function schemesFromJson(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const o of raw) {
    const r = schemeFromObject(o, { requireId: true });
    if (r.scheme && !seen.has(r.scheme.id)) { seen.add(r.scheme.id); out.push(r.scheme); }
  }
  return out;
}

export function schemesToJson(list) {
  return list.map((s) => ({ id: s.id, ...schemeToWindowsTerminal(s) }));
}
