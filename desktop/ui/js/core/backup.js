/**
 * Backup & restore: presets, snippets, colour schemes, command shortcuts and
 * the portable appearance / terminal / keyboard preferences, in one JSON file
 * both apps read and write — a phone backup restores on the desktop and the
 * other way round.
 *
 * Never in a backup: credentials, device ids, the relay URL, tokens, the app
 * lock, favourites, pins, or anything kept per machine or per terminal.
 */

import { presetsFromJson, presetsToJson } from './preset.js';
import { snippetsFromJson, snippetsToJson } from './snippets.js';
import { schemesFromJson, schemesToJson } from './schemes.js';

export const BACKUP_FORMAT = 'remote-terminal-backup';
export const BACKUP_VERSION = 1;

const bool = (v) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const num = (lo, hi) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};
const str = (v) => (typeof v === 'string' ? v : undefined);
const oneOf = (...values) => (v) => (values.includes(v) ? v : undefined);

/**
 * The portable preferences, by their settings key, each with the check that
 * accepts (and normalises) a value. The phone keeps some numbers as strings,
 * so numeric strings are accepted; anything else of the wrong type is skipped.
 */
export const PORTABLE_SETTINGS = {
  font_size: num(8, 32),
  line_spacing: num(0.8, 2),
  cursor_style: oneOf('block', 'underline', 'bar'),
  cursor_blink: bool,
  terminal_theme: str,
  terminal_font_family: oneOf('bundled', 'system'),
  scrollback_lines: num(500, 50000),
  // The phone also has "vibrate"; on the desktop the nearest thing is the tone.
  bell: (v) => (v === 'vibrate' ? 'sound' : oneOf('sound', 'none')(v)),
  haptics: bool,
  osc52_clipboard: bool,
  paste_confirm_lines: num(1, 100000),
  command_bar: bool,
  extra_keys_row1: str,
  extra_keys_row2: str,
  extra_keys_row3: str,
  clickable_links: bool,
  wheel_switch_tabs: bool,
  show_extra_keys: bool,
};

/** The same preference under the other app's name. */
const ALIASES = { swipe_switch_tabs: 'wheel_switch_tabs' };

/** Settings keys this app does not keep (the phone's haptics). */
const NOT_HERE = new Set(['haptics']);

/**
 * Build a backup from the raw settings values (the settings file's object).
 * [lists] are the already-parsed presets, snippets, schemes and shortcuts.
 */
export function buildBackup(values, { presets, snippets, customSchemes, commandShortcuts, app = 'desktop', appVersion, now = Date.now() }) {
  const settings = {};
  for (const [key, check] of Object.entries(PORTABLE_SETTINGS)) {
    if (!(key in values)) continue;
    const v = check(values[key]);
    if (v !== undefined) settings[key] = v;
  }
  // Written under both names so either app finds it.
  if ('wheel_switch_tabs' in settings) settings.swipe_switch_tabs = settings.wheel_switch_tabs;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    app,
    appVersion: appVersion ?? '',
    presets: presetsToJson(presets ?? []),
    snippets: snippetsToJson(snippets ?? []),
    customSchemes: schemesToJson(customSchemes ?? []),
    commandShortcuts: (commandShortcuts ?? []).map(([label, command]) => ({ label, command })),
    settings,
  };
}

/**
 * Read a backup file. `{ ok: true, backup }` with every section already
 * checked (bad entries dropped), or `{ ok: false, error }` in words.
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) {
    return { ok: false, error: 'This is not a Remote Terminal backup.' };
  }
  if (data.version !== BACKUP_VERSION) {
    return { ok: false, error: `This backup is version ${data.version}; this app reads version ${BACKUP_VERSION}.` };
  }
  const settings = {};
  if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
    for (const [rawKey, value] of Object.entries(data.settings)) {
      const key = ALIASES[rawKey] ?? rawKey;
      const check = PORTABLE_SETTINGS[key];
      if (!check || NOT_HERE.has(key)) continue;
      const v = check(value);
      if (v !== undefined) settings[key] = v;
    }
  }
  const shortcuts = Array.isArray(data.commandShortcuts)
    ? data.commandShortcuts
      .filter((e) => e && typeof e.label === 'string' && typeof e.command === 'string' && e.label.trim())
      .map((e) => [e.label, e.command])
    : null;
  return {
    ok: true,
    backup: {
      app: typeof data.app === 'string' ? data.app : '',
      appVersion: typeof data.appVersion === 'string' ? data.appVersion : '',
      exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : null,
      presets: presetsFromJson(data.presets),
      snippets: snippetsFromJson(data.snippets),
      customSchemes: schemesFromJson(data.customSchemes),
      commandShortcuts: shortcuts,
      settings,
    },
  };
}

/** Counts for the confirmation: "3 presets, 12 snippets, 2 schemes, 9 settings". */
export function backupSummary(backup) {
  return {
    presets: backup.presets.length,
    snippets: backup.snippets.length,
    schemes: backup.customSchemes.length,
    shortcuts: backup.commandShortcuts ? backup.commandShortcuts.length : 0,
    settings: Object.keys(backup.settings).length,
  };
}

/** Merge by id, the incoming copy winning; the current order is kept, new ones appended. */
export function mergeById(current, incoming) {
  const byId = new Map(incoming.map((x) => [x.id, x]));
  const out = current.map((x) => byId.get(x.id) ?? x);
  const have = new Set(current.map((x) => x.id));
  for (const x of incoming) if (!have.has(x.id)) out.push(x);
  return out;
}

/**
 * What the lists and settings become. [mode] is 'merge' (by id, incoming wins;
 * shortcuts merge by label) or 'replace' (the backup's lists replace this
 * device's; settings it does not mention are left alone either way).
 */
export function applyBackup(current, backup, mode) {
  const replace = mode === 'replace';
  const list = (key) => (replace ? backup[key] : mergeById(current[key], backup[key]));
  let shortcuts = current.commandShortcuts;
  if (backup.commandShortcuts) {
    if (replace) shortcuts = backup.commandShortcuts;
    else {
      const incoming = new Map(backup.commandShortcuts);
      shortcuts = current.commandShortcuts.map(([label, command]) => [label, incoming.get(label) ?? command]);
      const have = new Set(current.commandShortcuts.map(([label]) => label));
      for (const pair of backup.commandShortcuts) if (!have.has(pair[0])) shortcuts.push(pair);
    }
  }
  return {
    presets: list('presets'),
    snippets: list('snippets'),
    customSchemes: list('customSchemes'),
    commandShortcuts: shortcuts,
    settings: { ...backup.settings },
  };
}

/** A file name for an export: remote-terminal-backup-20260929.json. */
export function backupFileName(now = Date.now()) {
  const d = new Date(now);
  const two = (n) => String(n).padStart(2, '0');
  return `remote-terminal-backup-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}.json`;
}
