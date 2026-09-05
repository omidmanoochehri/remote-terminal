/**
 * The single place that turns keys + modifiers into the bytes a terminal
 * expects (xterm conventions). Used by the hardware keyboard, the extra-keys
 * bar and the shortcuts sheet alike, so Ctrl/Alt behave identically everywhere.
 *
 * A port of `KeyEncoder.kt`, including its test cases.
 */

const ESC = '\x1b';
const DEL = '\x7f';

export const Key = Object.freeze({
  ENTER: 'ENTER', TAB: 'TAB', BACKSPACE: 'BACKSPACE', ESCAPE: 'ESCAPE',
  UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT',
  HOME: 'HOME', END: 'END', PAGE_UP: 'PAGE_UP', PAGE_DOWN: 'PAGE_DOWN',
  INSERT: 'INSERT', DELETE: 'DELETE',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
});

export const NO_MODS = Object.freeze({ ctrl: false, alt: false, shift: false });

export function mods({ ctrl = false, alt = false, shift = false } = {}) {
  return { ctrl, alt, shift };
}

export function anyMod(m) {
  return !!(m.ctrl || m.alt || m.shift);
}

/** xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
export function modParam(m) {
  return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
}

function cursor(final, m, appCursor) {
  if (anyMod(m)) return `${ESC}[1;${modParam(m)}${final}`;
  return appCursor ? `${ESC}O${final}` : `${ESC}[${final}`;
}

function tilde(n, m) {
  return anyMod(m) ? `${ESC}[${n};${modParam(m)}~` : `${ESC}[${n}~`;
}

function ss3(final, m) {
  return anyMod(m) ? `${ESC}[1;${modParam(m)}${final}` : `${ESC}O${final}`;
}

/** Encode a special key. [appCursor] = DECCKM, [appKeypad] = DECKPAM (informational). */
export function encodeKey(key, m = NO_MODS, appCursor = false, appKeypad = false) {
  void appKeypad; // keypad mode does not change these keys
  switch (key) {
    case Key.ENTER: return m.alt ? ESC + '\r' : '\r';
    case Key.TAB: return m.shift ? ESC + '[Z' : m.alt ? ESC + '\t' : '\t';
    case Key.BACKSPACE:
      if (m.ctrl) return '\x08';
      if (m.alt) return ESC + DEL;
      return DEL;
    case Key.ESCAPE: return m.alt ? ESC + ESC : ESC;
    case Key.UP: return cursor('A', m, appCursor);
    case Key.DOWN: return cursor('B', m, appCursor);
    case Key.RIGHT: return cursor('C', m, appCursor);
    case Key.LEFT: return cursor('D', m, appCursor);
    case Key.HOME: return cursor('H', m, appCursor);
    case Key.END: return cursor('F', m, appCursor);
    case Key.INSERT: return tilde(2, m);
    case Key.DELETE: return tilde(3, m);
    case Key.PAGE_UP: return tilde(5, m);
    case Key.PAGE_DOWN: return tilde(6, m);
    case Key.F1: return ss3('P', m);
    case Key.F2: return ss3('Q', m);
    case Key.F3: return ss3('R', m);
    case Key.F4: return ss3('S', m);
    case Key.F5: return tilde(15, m);
    case Key.F6: return tilde(17, m);
    case Key.F7: return tilde(18, m);
    case Key.F8: return tilde(19, m);
    case Key.F9: return tilde(20, m);
    case Key.F10: return tilde(21, m);
    case Key.F11: return tilde(23, m);
    case Key.F12: return tilde(24, m);
    default: return '';
  }
}

/** Control byte for Ctrl+[char], or null when the combination has no control mapping. */
export function ctrlOf(cp) {
  const c = cp >= 0x61 && cp <= 0x7a ? cp - 32 : cp; // a-z → A-Z
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f); // @ A-Z [ \ ] ^ _ → 0x00..0x1F
  if (c === 0x20) return '\x00';
  if (c === 0x3f) return DEL;                                        // ?
  if (c === 0x32) return '\x00';                                     // 2
  if (c >= 0x33 && c <= 0x37) return String.fromCharCode(c - 0x33 + 0x1b); // 3..7 → ESC..US
  if (c === 0x38) return DEL;                                        // 8
  return null;
}

/** One code point with modifiers: Ctrl maps to a control byte, Alt prefixes ESC. */
export function encodeCodePoint(cp, m) {
  let s = m.ctrl ? (ctrlOf(cp) ?? String.fromCodePoint(cp)) : String.fromCodePoint(cp);
  if (m.alt) s = ESC + s;
  return s;
}

/** Encode typed text (one or more code points) with modifiers applied to each. */
export function encodeText(text, m = NO_MODS) {
  if (!m.ctrl && !m.alt) return String(text);
  let out = '';
  for (const ch of String(text)) out += encodeCodePoint(ch.codePointAt(0), m);
  return out;
}

/** Wrap pasted text in bracketed-paste markers when the application asked for them. */
export function paste(text, bracketed) {
  const clean = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  if (!bracketed) return clean;
  // Never let pasted content terminate the paste early.
  return `${ESC}[200~${clean.split(`${ESC}[201~`).join('')}${ESC}[201~`;
}

const NAMED_KEYS = {
  ENTER: Key.ENTER, RETURN: Key.ENTER,
  TAB: Key.TAB,
  BACKSPACE: Key.BACKSPACE, BS: Key.BACKSPACE,
  ESC: Key.ESCAPE, ESCAPE: Key.ESCAPE,
  UP: Key.UP, DOWN: Key.DOWN, LEFT: Key.LEFT, RIGHT: Key.RIGHT,
  HOME: Key.HOME, END: Key.END,
  PGUP: Key.PAGE_UP, PAGEUP: Key.PAGE_UP,
  PGDN: Key.PAGE_DOWN, PAGEDOWN: Key.PAGE_DOWN,
  INS: Key.INSERT, INSERT: Key.INSERT,
  DEL: Key.DELETE, DELETE: Key.DELETE,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
};

/** Bytes for a common terminal shortcut written like "Ctrl+C", "Alt+B", "Ctrl+Shift+Z". */
export function shortcut(spec) {
  const parts = String(spec).split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  let m = mods();
  for (const p of parts.slice(0, -1)) {
    switch (p.toLowerCase()) {
      case 'ctrl': case 'control': case '^': m = { ...m, ctrl: true }; break;
      case 'alt': case 'meta': m = { ...m, alt: true }; break;
      case 'shift': m = { ...m, shift: true }; break;
      default: return null;
    }
  }
  const last = parts[parts.length - 1];
  const key = NAMED_KEYS[last.toUpperCase()];
  if (key) return encodeKey(key, m);
  const points = Array.from(last);
  if (points.length !== 1) return null;
  return encodeCodePoint(points[0].codePointAt(0), m);
}
