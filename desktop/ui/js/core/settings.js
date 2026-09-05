/**
 * Typed access to user settings — the desktop's answer to the Android app's
 * `Settings.kt`, key for key, so a user moving between the two finds the same
 * choices with the same defaults.
 *
 * Values live in one JSON file in the app's configuration directory. Writes are
 * debounced (settings change on every keystroke of a search box) but always
 * flushed before the window closes. `version` bumps on every change so screens
 * can re-read cheaply.
 */

import { store } from './platform.js';
import { presetsFromJson, presetsToJson } from './preset.js';
import { Emitter } from './emitter.js';

export const SORT_STATUS = 'status';
export const SORT_NAME = 'name';
export const SORT_RECENT = 'recent';

export const FONT_BUNDLED = 'bundled';
export const FONT_SYSTEM = 'system';

/** The settings screen advertises this number, so it lives next to the store. */
export const COMMAND_HISTORY_MAX = 500;
const MAX_RECENT_DIRECTORIES = 8;

// Extra-keys rows: tokens separated by spaces; `a|b` gives long-press alternates.
export const DEFAULT_ROW1 = 'ESC CTRL ALT TAB UP DOWN LEFT RIGHT HOME END PGUP PGDN INS DEL';
export const DEFAULT_ROW2 = '-|_ /|\\ ~|` ||& :|; "|\' [|{ ]|} (|) <|> =|+ *|# $|@ ?|! ,|.';
export const DEFAULT_ROW3 = 'F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12';

export const DEFAULT_COMMANDS = [
  ['ls -la', 'ls -la'],
  ['pwd', 'pwd'],
  ['clear', 'clear'],
  ['git status', 'git status'],
  ['git pull', 'git pull'],
  ['docker ps', 'docker ps'],
];

const KEYS = {
  fontSize: 'font_size',
  lineSpacing: 'line_spacing',
  cursorStyle: 'cursor_style',
  cursorBlink: 'cursor_blink',
  terminalTheme: 'terminal_theme',
  appTheme: 'app_theme',
  keepAwake: 'keep_awake',
  scrollback: 'scrollback_lines',
  bell: 'bell',
  osc52: 'osc52_clipboard',
  pasteConfirm: 'paste_confirm_lines',
  commandBar: 'command_bar',
  keysRow1: 'extra_keys_row1',
  keysRow2: 'extra_keys_row2',
  keysRow3: 'extra_keys_row3',
  notifyOffline: 'notify_agent_offline',
  notifyBell: 'notify_bell',
  notifyExit: 'notify_exit',
  deviceName: 'device_name',
  commands: 'command_shortcuts',
  appLock: 'app_lock',
  showExtraKeys: 'show_extra_keys',
  fontFamily: 'terminal_font_family',
  machineSort: 'machine_sort',
  favouriteMachines: 'favourite_machines',
  pinnedTerminals: 'pinned_terminals',
  commandHistory: 'command_history',
  wheelTabs: 'wheel_switch_tabs',
  presets: 'terminal_presets',
};

export class Settings extends Emitter {
  constructor() {
    super();
    this.values = {};
    this.version = 0;
    this.flushTimer = null;
    this.pending = false;
  }

  static async load() {
    const settings = new Settings();
    try {
      const raw = await store.read('settings');
      if (raw) settings.values = JSON.parse(raw) || {};
    } catch {
      // A settings file we cannot parse is a settings file we start again from;
      // nothing in it is irreplaceable.
      settings.values = {};
    }
    return settings;
  }

  /* ------------------------------ plumbing ----------------------------- */

  get(key, fallback) {
    const v = this.values[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    if (this.values[key] === value) return;
    if (value === undefined || value === null) delete this.values[key];
    else this.values[key] = value;
    this.changed();
  }

  changed() {
    this.version++;
    this.emit('changed', this.version);
    this.scheduleFlush();
  }

  scheduleFlush() {
    this.pending = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
  }

  async flush() {
    if (!this.pending) return;
    this.pending = false;
    try {
      await store.write('settings', JSON.stringify(this.values, null, 2));
    } catch {
      this.pending = true; // try again on the next change or on close
    }
  }

  /* ---------------------------- terminal look --------------------------- */

  get fontSize() { return clamp(numberOr(this.get(KEYS.fontSize), 13), 8, 32); }
  set fontSize(v) { this.set(KEYS.fontSize, clamp(v, 8, 32)); }

  get lineSpacing() { return numberOr(this.get(KEYS.lineSpacing), 1.0); }
  set lineSpacing(v) { this.set(KEYS.lineSpacing, v); }

  get cursorStyle() { return this.get(KEYS.cursorStyle, 'block'); }
  set cursorStyle(v) { this.set(KEYS.cursorStyle, v); }

  get cursorBlink() { return this.get(KEYS.cursorBlink, true); }
  set cursorBlink(v) { this.set(KEYS.cursorBlink, !!v); }

  get terminalTheme() { return this.get(KEYS.terminalTheme, 'remote'); }
  set terminalTheme(v) { this.set(KEYS.terminalTheme, v); }

  /**
   * "system" | "dark" | "light". The product is designed dark, so that is the
   * default; the setting still switches to the light palette or follows the
   * system when the user asks.
   */
  get appTheme() { return this.get(KEYS.appTheme, 'dark'); }
  set appTheme(v) { this.set(KEYS.appTheme, v); }

  get keepAwake() { return this.get(KEYS.keepAwake, true); }
  set keepAwake(v) { this.set(KEYS.keepAwake, !!v); }

  get scrollbackLines() { return clamp(Math.round(numberOr(this.get(KEYS.scrollback), 5000)), 500, 50000); }
  set scrollbackLines(v) { this.set(KEYS.scrollback, clamp(Math.round(v), 500, 50000)); }

  get terminalFontFamily() { return this.get(KEYS.fontFamily, FONT_BUNDLED); }
  set terminalFontFamily(v) { this.set(KEYS.fontFamily, v); }

  /* ----------------------------- interaction ---------------------------- */

  /** "sound" plays the system alert, "none" stays silent. */
  get bell() { return this.get(KEYS.bell, 'sound'); }
  set bell(v) { this.set(KEYS.bell, v); }

  get osc52Clipboard() { return this.get(KEYS.osc52, true); }
  set osc52Clipboard(v) { this.set(KEYS.osc52, !!v); }

  get pasteConfirmLines() { return Math.round(numberOr(this.get(KEYS.pasteConfirm), 3)); }
  set pasteConfirmLines(v) { this.set(KEYS.pasteConfirm, Math.round(v)); }

  /** A horizontal wheel gesture (or Ctrl+Tab) moves to the next/previous tab. */
  get wheelSwitchTabs() { return this.get(KEYS.wheelTabs, true); }
  set wheelSwitchTabs(v) { this.set(KEYS.wheelTabs, !!v); }

  get commandBar() { return this.get(KEYS.commandBar, true); }
  set commandBar(v) { this.set(KEYS.commandBar, !!v); }

  get showExtraKeys() { return this.get(KEYS.showExtraKeys, true); }
  set showExtraKeys(v) { this.set(KEYS.showExtraKeys, !!v); }

  get extraKeysRow1() { return this.get(KEYS.keysRow1, DEFAULT_ROW1); }
  get extraKeysRow2() { return this.get(KEYS.keysRow2, DEFAULT_ROW2); }
  get extraKeysRow3() { return this.get(KEYS.keysRow3, DEFAULT_ROW3); }

  setKeyRows(row1, row2, row3) {
    this.values[KEYS.keysRow1] = row1 || DEFAULT_ROW1;
    this.values[KEYS.keysRow2] = row2 || DEFAULT_ROW2;
    this.values[KEYS.keysRow3] = row3 || DEFAULT_ROW3;
    this.changed();
  }

  /* ---------------------------- notifications --------------------------- */

  get notifyAgentOffline() { return this.get(KEYS.notifyOffline, true); }
  set notifyAgentOffline(v) { this.set(KEYS.notifyOffline, !!v); }

  get notifyBell() { return this.get(KEYS.notifyBell, false); }
  set notifyBell(v) { this.set(KEYS.notifyBell, !!v); }

  get notifyExit() { return this.get(KEYS.notifyExit, true); }
  set notifyExit(v) { this.set(KEYS.notifyExit, !!v); }

  /* -------------------------------- device ------------------------------ */

  get deviceName() { return this.get(KEYS.deviceName, ''); }
  set deviceName(v) { this.set(KEYS.deviceName, v); }

  /** App lock: the device credential prompt before anything is shown. */
  get appLock() { return this.get(KEYS.appLock, false); }
  set appLock(v) { this.set(KEYS.appLock, !!v); }

  /** User-defined command shortcuts (label → text sent with a trailing CR). */
  get commandShortcuts() {
    const raw = this.get(KEYS.commands);
    if (!Array.isArray(raw)) return DEFAULT_COMMANDS;
    const parsed = raw
      .filter((e) => e && typeof e.label === 'string' && typeof e.command === 'string')
      .map((e) => [e.label, e.command]);
    return parsed.length > 0 || raw.length === 0 ? parsed : DEFAULT_COMMANDS;
  }

  set commandShortcuts(pairs) {
    this.set(KEYS.commands, pairs.map(([label, command]) => ({ label, command })));
  }

  /** How machines are ordered on the Machines screen. */
  get machineSort() { return this.get(KEYS.machineSort, SORT_STATUS); }
  set machineSort(v) { this.set(KEYS.machineSort, v); }

  /* --------------------------- per-machine memory ----------------------- */

  lastShell(agentId) { return this.get(`last_shell.${agentId}`, null); }
  setLastShell(agentId, shellId) { this.set(`last_shell.${agentId}`, shellId); }

  /* ------------------------- favourites and pins ------------------------ */

  /** Machines the user starred; they sort first and feed the Home count. */
  get favouriteMachines() {
    const v = this.get(KEYS.favouriteMachines);
    return new Set(Array.isArray(v) ? v : []);
  }

  set favouriteMachines(set) { this.set(KEYS.favouriteMachines, [...set]); }

  isFavouriteMachine(agentId) { return this.favouriteMachines.has(agentId); }

  toggleFavouriteMachine(agentId) {
    const next = this.favouriteMachines;
    const added = !next.has(agentId);
    if (added) next.add(agentId); else next.delete(agentId);
    this.favouriteMachines = next;
    return added;
  }

  /** Pinned terminals, stored as "agentId|sessionId". */
  get pinnedTerminals() {
    const v = this.get(KEYS.pinnedTerminals);
    return new Set(Array.isArray(v) ? v : []);
  }

  set pinnedTerminals(set) { this.set(KEYS.pinnedTerminals, [...set]); }

  isPinnedTerminal(agentId, sessionId) { return this.pinnedTerminals.has(`${agentId}|${sessionId}`); }

  togglePinnedTerminal(agentId, sessionId) {
    const key = `${agentId}|${sessionId}`;
    const next = this.pinnedTerminals;
    const added = !next.has(key);
    if (added) next.add(key); else next.delete(key);
    this.pinnedTerminals = next;
    return added;
  }

  /* ----------------------------- per-machine ---------------------------- */

  /** Re-attach this machine's terminals automatically after a drop (default on). */
  autoReconnect(agentId) { return this.get(`auto_reconnect.${agentId}`, true); }
  setAutoReconnect(agentId, value) { this.set(`auto_reconnect.${agentId}`, !!value); }

  /** Hold the relay socket open for this machine while the window is hidden. */
  keepAlive(agentId) { return this.get(`keep_alive.${agentId}`, true); }
  setKeepAlive(agentId, value) { this.set(`keep_alive.${agentId}`, !!value); }

  /** Raise a notification when this specific machine drops off. */
  connectionAlerts(agentId) { return this.get(`alerts.${agentId}`, false); }
  setConnectionAlerts(agentId, value) { this.set(`alerts.${agentId}`, !!value); }

  /** Working directories the user has started terminals in, most recent first. */
  recentDirectories(agentId) {
    const v = this.get(`dirs.${agentId}`);
    return Array.isArray(v) ? v.map(String) : [];
  }

  noteDirectory(agentId, dir) {
    if (!dir || !dir.trim()) return;
    const next = [dir, ...this.recentDirectories(agentId).filter((d) => d !== dir)].slice(0, MAX_RECENT_DIRECTORIES);
    this.set(`dirs.${agentId}`, next);
  }

  /* ---------------------------- per-terminal ---------------------------- */

  /** "Restore on reconnect" for one session (default on: that is the product's promise). */
  restoreOnReconnect(sessionKey) { return this.get(`restore.${sessionKey}`, true); }
  setRestoreOnReconnect(sessionKey, value) { this.set(`restore.${sessionKey}`, !!value); }

  /** "Notify when a long command finishes" for one session. */
  notifyOnFinish(sessionKey) { return this.get(`notify_finish.${sessionKey}`, this.notifyExit); }
  setNotifyOnFinish(sessionKey, value) { this.set(`notify_finish.${sessionKey}`, !!value); }

  /**
   * Colour scheme for one terminal, or null when it follows the app-wide
   * setting. Kept per session so a production shell can stay visibly different
   * from a scratch one.
   */
  terminalThemeFor(sessionKey) { return this.get(`theme.${sessionKey}`, null); }

  setTerminalTheme(sessionKey, themeId) {
    if (themeId == null) {
      delete this.values[`theme.${sessionKey}`];
      this.changed();
    } else {
      this.set(`theme.${sessionKey}`, themeId);
    }
  }

  forgetSessionPrefs(sessionKey) {
    let touched = false;
    for (const prefix of ['restore.', 'notify_finish.', 'theme.']) {
      const key = prefix + sessionKey;
      if (key in this.values) { delete this.values[key]; touched = true; }
    }
    if (touched) this.changed();
  }

  /* ------------------------- terminal presets --------------------------- */

  /** Saved ways to start a terminal, in the order the user arranged them. */
  get terminalPresets() { return presetsFromJson(this.get(KEYS.presets)); }
  set terminalPresets(list) { this.set(KEYS.presets, presetsToJson(list)); }

  preset(id) { return this.terminalPresets.find((p) => p.id === id) || null; }

  /** Presets that can start on [agentId]: its own, plus the machine-agnostic ones. */
  presetsFor(agentId) {
    return this.terminalPresets.filter((p) => p.agentId == null || p.agentId === agentId);
  }

  /** Insert, or replace the one carrying the same id. */
  savePreset(preset) {
    const current = this.terminalPresets;
    this.terminalPresets = current.some((p) => p.id === preset.id)
      ? current.map((p) => (p.id === preset.id ? preset : p))
      : [...current, preset];
  }

  deletePreset(id) {
    this.terminalPresets = this.terminalPresets.filter((p) => p.id !== id);
  }

  /* ------------------------- command history ---------------------------- */

  /** Commands sent from the command bar, newest first. */
  get commandHistory() {
    const v = this.get(KEYS.commandHistory);
    return Array.isArray(v) ? v.map(String) : [];
  }

  set commandHistory(list) { this.set(KEYS.commandHistory, list.slice(0, COMMAND_HISTORY_MAX)); }

  noteCommand(command) {
    const trimmed = String(command).trim();
    if (!trimmed) return;
    this.commandHistory = [trimmed, ...this.commandHistory.filter((c) => c !== trimmed)];
  }

  clearCommandHistory() { this.set(KEYS.commandHistory, undefined); }

  /* ------------------------------- tabs --------------------------------- */

  openTabs(agentId) {
    const v = this.get(`tabs.${agentId}`);
    return Array.isArray(v) ? v.map(String) : [];
  }

  setOpenTabs(agentId, sessionIds) { this.set(`tabs.${agentId}`, sessionIds); }

  activeTab(agentId) { return this.get(`active.${agentId}`, null); }
  setActiveTab(agentId, sessionId) { this.set(`active.${agentId}`, sessionId); }
}

function numberOr(value, fallback) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
