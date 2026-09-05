/**
 * A VT/xterm terminal emulator over a typed-array-backed grid.
 *
 * A direct port of the Android app's `TerminalEmulator.kt`: the control
 * sequences real programs use (bash/zsh/PowerShell, vim, nano, less, htop, git,
 * npm) — CSI cursor/erase/insert/delete/scroll commands, SGR with 16/256/true
 * colour, DEC private modes (origin, autowrap, alternate screen, cursor
 * visibility/style, mouse tracking, bracketed paste, application cursor keys),
 * tab stops, DEC special graphics, OSC title/clipboard/working directory,
 * DSR/DA replies, wide (CJK/emoji) and combining characters, bounded scrollback
 * and reflow on resize.
 *
 * Keeping it a port rather than a rewrite is deliberate: the two clients then
 * render identical output, and the Kotlin emulator's test suite carries over.
 */

import { Row, BLANK } from './row.js';
import { widthOf } from './wcwidth.js';
import {
  DEFAULT, TRUECOLOR,
  BOLD, DIM, ITALIC, UNDERLINE, BLINK, REVERSE, HIDDEN, STRIKE, WIDE, CONTINUATION,
  CURSOR_BLOCK, CURSOR_UNDERLINE, CURSOR_BAR,
  MOUSE_OFF, MOUSE_PRESS, MOUSE_BUTTON, MOUSE_ANY,
  MOUSE_EVENT_PRESS, MOUSE_EVENT_RELEASE, MOUSE_EVENT_MOTION,
  MOUSE_EVENT_WHEEL_UP, MOUSE_EVENT_WHEEL_DOWN,
} from './attrs.js';

const ESC = 0x1b;
const BEL = 0x07;
const REPLACEMENT = 0xfffd;
const NO_COLOR = -2147483648;
const MAX_PARAMS = 32;
const MAX_OSC = 4096;

/** DEC special graphics for 0x60..0x7E (ESC ( 0). */
const DEC_SPECIAL = [
  0x25c6, 0x2592, 0x2409, 0x240c, 0x240d, 0x240a, 0x00b0, 0x00b1, 0x2424, 0x240b,
  0x2518, 0x2510, 0x250c, 0x2514, 0x253c, 0x23ba, 0x23bb, 0x2500, 0x23bc, 0x23bd,
  0x251c, 0x2524, 0x2534, 0x252c, 0x2502, 0x2264, 0x2265, 0x03c0, 0x2260, 0x00a3, 0x00b7,
];

// Parser states (the VT500 shape the Kotlin version uses).
const S_GROUND = 0, S_ESC = 1, S_ESC_INTER = 2, S_CSI = 3,
  S_OSC = 4, S_OSC_ESC = 5, S_STRING = 6, S_STRING_ESC = 7, S_CHARSET = 8;

/**
 * Scrollback needs cheap append-and-drop at both ends; a plain array's
 * `shift()` would copy the whole history on every scrolled line.
 */
class Deque {
  constructor() { this.items = []; this.head = 0; }
  get size() { return this.items.length - this.head; }
  get(i) { return this.items[this.head + i]; }
  addLast(v) { this.items.push(v); }
  removeFirst() {
    const v = this.items[this.head];
    this.items[this.head++] = undefined;
    // Reclaim the dead prefix once it is worth the copy.
    if (this.head > 64 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return v;
  }
  clear() { this.items = []; this.head = 0; }
  toArray() { return this.items.slice(this.head); }
}

class SavedCursor {
  constructor() {
    this.row = 0; this.col = 0; this.fg = DEFAULT; this.bg = DEFAULT; this.flags = 0;
    this.origin = false; this.autowrap = true; this.g0 = 0; this.g1 = 0;
    this.shiftG1 = false; this.pendingWrap = false;
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class TerminalEmulator {
  constructor(cols = 80, rows = 24, maxScrollback = 5000) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this._maxScrollback = Math.max(0, maxScrollback);

    this.cursorRow = 0;
    this.cursorCol = 0;
    this.cursorVisible = true;
    this.cursorStyle = CURSOR_BLOCK;
    this.cursorBlink = true;
    this.isAltScreen = false;
    this.title = '';
    this.applicationCursorKeys = false;
    this.applicationKeypad = false;
    this.bracketedPaste = false;
    this.mouseMode = MOUSE_OFF;
    this.mouseSgr = false;
    this.focusEvents = false;

    this.onResponse = null;
    this.muteResponses = false;
    this.onBell = null;
    this.onTitle = null;
    this.onClipboard = null;
    /** The shell reported a new working directory (OSC 7). */
    this.onWorkingDirectory = null;
    this.onAltScreen = null;

    this.screen = Array.from({ length: this.rows }, () => new Row(this.cols));
    this.alt = Array.from({ length: this.rows }, () => new Row(this.cols));
    this.scrollback = new Deque();

    this.curFg = DEFAULT;
    this.curBg = DEFAULT;
    this.curFlags = 0;
    this.pendingWrap = false;

    this.autowrap = true;
    this.originMode = false;
    this.insertMode = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.tabStops = new Uint8Array(this.cols);
    for (let i = 0; i < this.cols; i++) this.tabStops[i] = i % 8 === 0 ? 1 : 0;

    // Character sets: 0 = ASCII, 1 = DEC special graphics.
    this.g0 = 0;
    this.g1 = 0;
    this.shiftG1 = false;

    this.savedMain = new SavedCursor();
    this.savedAlt = new SavedCursor();

    // Cursor of the primary screen while the alternate screen is active (for reflow).
    this.mainCursorRow = 0;
    this.mainCursorCol = 0;

    this.dirty = true;
    this.mouseButtonHeld = -1;

    this.state = S_GROUND;
    this.params = new Int32Array(MAX_PARAMS);
    this.subFlags = new Uint8Array(MAX_PARAMS);
    this.paramCount = 0;
    this.paramStarted = false;
    this.privMarker = 0;
    this.intermediate = 0;
    this.escIntermediateChar = 0;
    this.charsetTarget = 0;
    this.osc = '';
    this.pendingHigh = 0;
  }

  get maxScrollback() { return this._maxScrollback; }
  set maxScrollback(value) {
    this._maxScrollback = Math.max(0, value | 0);
    this.trimScrollback();
    this.dirty = true;
  }

  get buf() { return this.isAltScreen ? this.alt : this.screen; }
  get saved() { return this.isAltScreen ? this.savedAlt : this.savedMain; }

  /* ------------------------------- feeding ------------------------------ */

  feed(text) {
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      i++;
      let cp;
      if (this.pendingHigh !== 0) {
        const high = this.pendingHigh;
        this.pendingHigh = 0;
        if (c >= 0xdc00 && c <= 0xdfff) {
          cp = (high - 0xd800) * 0x400 + (c - 0xdc00) + 0x10000;
        } else {
          this.process(REPLACEMENT);
          i--;
          continue;
        }
      } else if (c >= 0xd800 && c <= 0xdbff) {
        if (i < n) {
          const d = text.charCodeAt(i);
          if (d >= 0xdc00 && d <= 0xdfff) {
            cp = (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
            i++;
          } else cp = REPLACEMENT;
        } else {
          this.pendingHigh = c;
          break;
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        cp = REPLACEMENT;
      } else cp = c;
      this.process(cp);
    }
    this.dirty = true;
  }

  process(cp) {
    switch (this.state) {
      case S_GROUND: this.ground(cp); break;
      case S_ESC: this.esc(cp); break;
      case S_ESC_INTER: this.escIntermediate(cp); break;
      case S_CSI: this.csi(cp); break;
      case S_OSC:
        if (cp === BEL) { this.finishOsc(); this.state = S_GROUND; }
        else if (cp === ESC) this.state = S_OSC_ESC;
        else if (cp < 0x20) { /* ignore other controls inside OSC */ }
        else if (this.osc.length < MAX_OSC) this.osc += String.fromCodePoint(cp);
        break;
      case S_OSC_ESC:
        if (cp === 0x5c) { this.finishOsc(); this.state = S_GROUND; }
        else { this.osc = ''; this.state = S_ESC; this.esc(cp); }
        break;
      case S_STRING:
        if (cp === ESC) this.state = S_STRING_ESC;
        else if (cp === BEL) this.state = S_GROUND;
        break;
      case S_STRING_ESC:
        this.state = cp === 0x5c ? S_GROUND : S_STRING;
        break;
      case S_CHARSET:
        this.designate(cp);
        this.state = S_GROUND;
        break;
    }
  }

  ground(cp) {
    if (cp < 0x20 || cp === 0x7f) this.control(cp);
    else if (cp >= 0x80 && cp <= 0x9f) this.c1(cp);
    else this.print(cp);
  }

  /** C0 controls; also executed while inside a CSI (per the VT500 parser). */
  control(cp) {
    switch (cp) {
      case BEL: if (this.onBell) this.onBell(); break;
      case 0x08: if (this.cursorCol > 0) this.cursorCol--; this.pendingWrap = false; break;
      case 0x09: this.tab(); break;
      case 0x0a: case 0x0b: case 0x0c: this.lineFeed(); break;
      case 0x0d: this.cursorCol = 0; this.pendingWrap = false; break;
      case 0x0e: this.shiftG1 = true; break;
      case 0x0f: this.shiftG1 = false; break;
      case ESC: this.state = S_ESC; this.escIntermediateChar = 0; break;
      case 0x18: case 0x1a: this.state = S_GROUND; break;
      default: break;
    }
  }

  c1(cp) {
    switch (cp) {
      case 0x84: this.index(); break;
      case 0x85: this.cursorCol = 0; this.lineFeed(); break;
      case 0x88: this.tabStops[clamp(this.cursorCol, 0, this.cols - 1)] = 1; break;
      case 0x8d: this.reverseIndex(); break;
      case 0x90: case 0x98: case 0x9e: case 0x9f: this.state = S_STRING; break;
      case 0x9b: this.startCsi(); break;
      case 0x9d: this.state = S_OSC; this.osc = ''; break;
      default: break;
    }
  }

  startCsi() {
    this.state = S_CSI;
    this.paramCount = 0;
    this.paramStarted = false;
    this.privMarker = 0;
    this.intermediate = 0;
    this.params[0] = 0;
    this.subFlags[0] = 0;
  }

  esc(cp) {
    this.state = S_GROUND;
    switch (cp) {
      case 0x5b: this.startCsi(); return;                   // [
      case 0x5d: this.state = S_OSC; this.osc = ''; return; // ]
      case 0x50: case 0x58: case 0x5e: case 0x5f: this.state = S_STRING; return; // P X ^ _
      case 0x28: case 0x29: case 0x2a: case 0x2b:           // ( ) * +
        this.charsetTarget = cp; this.state = S_CHARSET; return;
      case 0x37: this.saveCursor(); return;                 // 7
      case 0x38: this.restoreCursor(); return;              // 8
      case 0x44: this.index(); return;                      // D
      case 0x45: this.cursorCol = 0; this.lineFeed(); return; // E
      case 0x48: this.tabStops[clamp(this.cursorCol, 0, this.cols - 1)] = 1; return; // H
      case 0x4d: this.reverseIndex(); return;               // M
      case 0x63: this.reset(); return;                      // c
      case 0x3d: this.applicationKeypad = true; return;     // =
      case 0x3e: this.applicationKeypad = false; return;    // >
      case 0x4e: case 0x4f: case 0x5c: return;              // N O backslash
      case ESC: this.state = S_ESC; return;
      default: break;
    }
    if (cp >= 0x20 && cp <= 0x2f) { this.escIntermediateChar = cp; this.state = S_ESC_INTER; return; }
    if (cp >= 0x00 && cp <= 0x1f) { this.control(cp); return; }
  }

  escIntermediate(cp) {
    if (cp >= 0x20 && cp <= 0x2f) { this.escIntermediateChar = cp; return; }
    this.state = S_GROUND;
    if (cp === ESC) { this.state = S_ESC; return; }
    if (cp < 0x20) { this.control(cp); return; }
    if (this.escIntermediateChar === 0x23 && cp === 0x38) this.decaln(); // ESC # 8
    // ESC % G / ESC % @ (UTF-8 selection) and other 2-byte escapes are consumed.
  }

  designate(cp) {
    const set = cp === 0x30 ? 1 : 0; // '0'
    if (this.charsetTarget === 0x28) this.g0 = set;
    else if (this.charsetTarget === 0x29) this.g1 = set;
  }

  csi(cp) {
    if (cp >= 0x30 && cp <= 0x39) {
      const v = this.params[this.paramCount];
      this.params[this.paramCount] = v > 6553 ? 65535 : v * 10 + (cp - 0x30);
      this.paramStarted = true;
    } else if (cp === 0x3b || cp === 0x3a) {
      if (this.paramCount < MAX_PARAMS - 1) {
        this.paramCount++;
        this.params[this.paramCount] = 0;
        this.subFlags[this.paramCount] = cp === 0x3a ? 1 : 0;
      }
      this.paramStarted = true;
    } else if (cp >= 0x3c && cp <= 0x3f) {
      if (!this.paramStarted && this.paramCount === 0 && this.privMarker === 0) this.privMarker = cp;
      else this.intermediate = -1;
    } else if (cp >= 0x20 && cp <= 0x2f) {
      this.intermediate = this.intermediate === -1 ? -1 : cp;
    } else if (cp >= 0x40 && cp <= 0x7e) {
      this.state = S_GROUND;
      if (this.intermediate !== -1) this.dispatchCsi(cp);
    } else if (cp === ESC) {
      this.state = S_ESC;
      this.escIntermediateChar = 0;
    } else if (cp === 0x18 || cp === 0x1a) {
      this.state = S_GROUND;
    } else if (cp < 0x20) {
      this.control(cp);
    } else if (cp === 0x7f) {
      /* ignored */
    } else {
      this.state = S_GROUND; // non-ASCII aborts the sequence
      this.ground(cp);
    }
  }

  p(idx, def) {
    if (idx > this.paramCount) return def;
    const v = this.params[idx];
    return v === 0 ? def : v;
  }

  nParams() {
    return !this.paramStarted && this.paramCount === 0 ? 0 : this.paramCount + 1;
  }

  dispatchCsi(final) {
    if (this.privMarker === 0x3f) { // ?
      if (final === 0x68) { for (let i = 0; i < this.nParams(); i++) this.decMode(this.params[i], true); return; }
      if (final === 0x6c) { for (let i = 0; i < this.nParams(); i++) this.decMode(this.params[i], false); return; }
      if (final === 0x6e && this.params[0] === 6) this.respond(`\x1b[?${this.reportRow()};${this.cursorCol + 1}R`);
      return;
    }
    if (this.privMarker === 0x3e) { // >
      if (final === 0x63) this.respond('\x1b[>41;0;0c');
      return;
    }
    if (this.privMarker !== 0) return;
    if (this.intermediate === 0x20) { if (final === 0x71) this.setCursorStyle(this.params[0]); return; } // ' ' q
    if (this.intermediate === 0x21) { if (final === 0x70) this.softReset(); return; }                    // ! p
    if (this.intermediate !== 0) return;

    switch (final) {
      case 0x41: this.moveCursor(-this.p(0, 1), 0); break;                              // A
      case 0x42: case 0x65: this.moveCursor(this.p(0, 1), 0); break;                    // B e
      case 0x43: case 0x61: this.moveCursor(0, this.p(0, 1)); break;                    // C a
      case 0x44: this.moveCursor(0, -this.p(0, 1)); break;                              // D
      case 0x45: this.moveCursor(this.p(0, 1), 0); this.cursorCol = 0; break;           // E
      case 0x46: this.moveCursor(-this.p(0, 1), 0); this.cursorCol = 0; break;          // F
      case 0x47: case 0x60:                                                             // G `
        this.cursorCol = clamp(this.p(0, 1) - 1, 0, this.cols - 1); this.pendingWrap = false; break;
      case 0x64: this.setCursorRow(this.p(0, 1) - 1); break;                            // d
      case 0x48: case 0x66:                                                             // H f
        this.setCursorRow(this.p(0, 1) - 1);
        this.cursorCol = clamp(this.p(1, 1) - 1, 0, this.cols - 1);
        this.pendingWrap = false;
        break;
      case 0x49: for (let i = 0, n = this.p(0, 1); i < n; i++) this.tab(); break;       // I
      case 0x4a: this.eraseDisplay(this.params[0]); break;                              // J
      case 0x4b: this.eraseLine(this.params[0]); break;                                 // K
      case 0x4c: this.insertLines(this.p(0, 1)); break;                                 // L
      case 0x4d: this.deleteLines(this.p(0, 1)); break;                                 // M
      case 0x50: this.deleteChars(this.p(0, 1)); break;                                 // P
      case 0x40: this.insertChars(this.p(0, 1)); break;                                 // @
      case 0x58: this.eraseChars(this.p(0, 1)); break;                                  // X
      case 0x53: this.scrollUp(this.p(0, 1)); break;                                    // S
      case 0x54: this.scrollDown(this.p(0, 1)); break;                                  // T
      case 0x5a: for (let i = 0, n = this.p(0, 1); i < n; i++) this.backTab(); break;   // Z
      case 0x62: this.repeatLast(this.p(0, 1)); break;                                  // b
      case 0x63: this.respond('\x1b[?62;22c'); break;                                   // c
      case 0x67:                                                                        // g
        if (this.params[0] === 0) this.tabStops[clamp(this.cursorCol, 0, this.cols - 1)] = 0;
        else if (this.params[0] === 3) this.tabStops.fill(0);
        break;
      case 0x68: for (let i = 0; i < this.nParams(); i++) this.ansiMode(this.params[i], true); break;  // h
      case 0x6c: for (let i = 0; i < this.nParams(); i++) this.ansiMode(this.params[i], false); break; // l
      case 0x6d: this.sgr(); break;                                                     // m
      case 0x6e:                                                                        // n
        if (this.params[0] === 5) this.respond('\x1b[0n');
        else if (this.params[0] === 6) this.respond(`\x1b[${this.reportRow()};${this.cursorCol + 1}R`);
        break;
      case 0x72: {                                                                      // r
        const top = clamp(this.p(0, 1) - 1, 0, this.rows - 1);
        const bottom = clamp(this.p(1, this.rows) - 1, 0, this.rows - 1);
        if (bottom > top) { this.scrollTop = top; this.scrollBottom = bottom; }
        this.cursorRow = this.originMode ? this.scrollTop : 0;
        this.cursorCol = 0;
        this.pendingWrap = false;
        break;
      }
      case 0x73: this.saveCursor(); break;                                              // s
      case 0x75: this.restoreCursor(); break;                                           // u
      case 0x74: if (this.params[0] === 18) this.respond(`\x1b[8;${this.rows};${this.cols}t`); break; // t
      default: break;
    }
  }

  reportRow() {
    return this.originMode ? this.cursorRow - this.scrollTop + 1 : this.cursorRow + 1;
  }

  respond(s) {
    if (!this.muteResponses && this.onResponse) this.onResponse(s);
  }

  ansiMode(mode, on) {
    if (mode === 4) this.insertMode = on;
  }

  decMode(mode, on) {
    switch (mode) {
      case 1: this.applicationCursorKeys = on; break;
      case 6:
        this.originMode = on;
        this.cursorRow = on ? this.scrollTop : 0;
        this.cursorCol = 0;
        this.pendingWrap = false;
        break;
      case 7: this.autowrap = on; break;
      case 12: this.cursorBlink = on; break;
      case 25: this.cursorVisible = on; break;
      case 47: case 1047: this.switchAlt(on, false); break;
      case 1049: this.switchAlt(on, true); break;
      case 1000: this.mouseMode = on ? MOUSE_PRESS : MOUSE_OFF; break;
      case 1002: this.mouseMode = on ? MOUSE_BUTTON : MOUSE_OFF; break;
      case 1003: this.mouseMode = on ? MOUSE_ANY : MOUSE_OFF; break;
      case 1004: this.focusEvents = on; break;
      case 1006: this.mouseSgr = on; break;
      case 2004: this.bracketedPaste = on; break;
      default: break;
    }
  }

  setCursorStyle(ps) {
    switch (ps) {
      case 0: case 1: this.cursorStyle = CURSOR_BLOCK; this.cursorBlink = true; break;
      case 2: this.cursorStyle = CURSOR_BLOCK; this.cursorBlink = false; break;
      case 3: this.cursorStyle = CURSOR_UNDERLINE; this.cursorBlink = true; break;
      case 4: this.cursorStyle = CURSOR_UNDERLINE; this.cursorBlink = false; break;
      case 5: this.cursorStyle = CURSOR_BAR; this.cursorBlink = true; break;
      case 6: this.cursorStyle = CURSOR_BAR; this.cursorBlink = false; break;
      default: break;
    }
  }

  /* --------------------------------- SGR -------------------------------- */

  sgr() {
    const n = this.nParams();
    if (n === 0) { this.curFg = DEFAULT; this.curBg = DEFAULT; this.curFlags = 0; return; }
    let i = 0;
    while (i < n) {
      if (this.subFlags[i]) { i++; continue; } // unconsumed sub-parameter (e.g. 4:3 styles)
      const v = this.params[i];
      if (v === 0) { this.curFg = DEFAULT; this.curBg = DEFAULT; this.curFlags = 0; }
      else if (v === 1) this.curFlags |= BOLD;
      else if (v === 2) this.curFlags |= DIM;
      else if (v === 3) this.curFlags |= ITALIC;
      else if (v === 4) this.curFlags |= UNDERLINE;
      else if (v === 5 || v === 6) this.curFlags |= BLINK;
      else if (v === 7) this.curFlags |= REVERSE;
      else if (v === 8) this.curFlags |= HIDDEN;
      else if (v === 9) this.curFlags |= STRIKE;
      else if (v === 21) this.curFlags |= UNDERLINE;
      else if (v === 22) this.curFlags &= ~(BOLD | DIM);
      else if (v === 23) this.curFlags &= ~ITALIC;
      else if (v === 24) this.curFlags &= ~UNDERLINE;
      else if (v === 25) this.curFlags &= ~BLINK;
      else if (v === 27) this.curFlags &= ~REVERSE;
      else if (v === 28) this.curFlags &= ~HIDDEN;
      else if (v === 29) this.curFlags &= ~STRIKE;
      else if (v >= 30 && v <= 37) this.curFg = v - 30;
      else if (v === 39) this.curFg = DEFAULT;
      else if (v >= 40 && v <= 47) this.curBg = v - 40;
      else if (v === 49) this.curBg = DEFAULT;
      else if (v >= 90 && v <= 97) this.curFg = v - 90 + 8;
      else if (v >= 100 && v <= 107) this.curBg = v - 100 + 8;
      else if (v === 38) { const [col, adv] = this.extendedColor(i, n); if (col !== NO_COLOR) this.curFg = col; i += adv; }
      else if (v === 48) { const [col, adv] = this.extendedColor(i, n); if (col !== NO_COLOR) this.curBg = col; i += adv; }
      else if (v === 58) { const [, adv] = this.extendedColor(i, n); i += adv; } // underline colour: consumed, not rendered
      i++;
    }
  }

  /** Parse 38/48 arguments at index [i]; returns [colour or NO_COLOR, extra params consumed]. */
  extendedColor(i, n) {
    if (i + 1 >= n) return [NO_COLOR, 0];
    let subs = 0;
    while (i + 1 + subs < n && this.subFlags[i + 1 + subs]) subs++;
    if (subs > 0) {
      // Colon form: 38:5:n · 38:2:r:g:b · 38:2:cs:r:g:b
      const mode = this.params[i + 1];
      if (mode === 5 && subs >= 2) return [clamp(this.params[i + 2], 0, 255), subs];
      if (mode === 2 && subs >= 5) return [rgb(this.params[i + 3], this.params[i + 4], this.params[i + 5]), subs];
      if (mode === 2 && subs === 4) return [rgb(this.params[i + 2], this.params[i + 3], this.params[i + 4]), subs];
      return [NO_COLOR, subs];
    }
    // Semicolon form: 38;5;n · 38;2;r;g;b
    const mode = this.params[i + 1];
    if (mode === 5) return i + 2 < n ? [clamp(this.params[i + 2], 0, 255), 2] : [NO_COLOR, 1];
    if (mode === 2) return i + 4 < n ? [rgb(this.params[i + 2], this.params[i + 3], this.params[i + 4]), 4] : [NO_COLOR, n - i - 1];
    return [NO_COLOR, 1];
  }

  /* --------------------------------- OSC -------------------------------- */

  finishOsc() {
    const s = this.osc;
    this.osc = '';
    const semi = s.indexOf(';');
    const codeText = semi < 0 ? s : s.substring(0, semi);
    if (!/^\d+$/.test(codeText)) return;
    const code = parseInt(codeText, 10);
    const arg = semi < 0 ? '' : s.substring(semi + 1);
    if (code === 0 || code === 2) {
      this.title = arg;
      if (this.onTitle) this.onTitle(arg);
      return;
    }
    // OSC 7: the shell says where it is. Shells that do not send it simply
    // never move the value, which is why nothing depends on it.
    if (code === 7) {
      const dir = parseFileUrl(arg);
      if (dir && this.onWorkingDirectory) this.onWorkingDirectory(dir);
      return;
    }
    if (code === 52) {
      const sep = arg.indexOf(';');
      if (sep < 0) return;
      const payload = arg.substring(sep + 1);
      if (payload === '?' || payload.length === 0) return;
      const decoded = base64Decode(payload);
      if (decoded != null && this.onClipboard) this.onClipboard(decoded);
    }
  }

  /* ------------------------------- printing ----------------------------- */

  print(cpIn) {
    let cp = cpIn;
    const set = this.shiftG1 ? this.g1 : this.g0;
    if (set === 1 && cp >= 0x60 && cp <= 0x7e) cp = DEC_SPECIAL[cp - 0x60];

    const width = widthOf(cp);
    if (width === 0) { this.attachCombining(cp); return; }
    const w = width === 2 && this.cols >= 2 ? 2 : 1;
    const row0 = this.buf[this.cursorRow];

    if (this.pendingWrap) {
      if (this.autowrap) {
        row0.wrapped = true;
        this.cursorCol = 0;
        this.pendingWrap = false;
        this.lineFeed();
      } else this.pendingWrap = false;
    }
    let row = this.buf[this.cursorRow];
    if (w === 2 && this.cursorCol === this.cols - 1) {
      if (!this.autowrap) return;
      row.clear(this.cursorCol, this.curFg, this.curBg);
      row.wrapped = true;
      this.cursorCol = 0;
      this.lineFeed();
      row = this.buf[this.cursorRow];
    }
    if (this.insertMode) this.insertCells(row, this.cursorCol, w);
    // Repair wide glyphs we are about to overwrite partially.
    this.clearWideAt(row, this.cursorCol);
    if (w === 2) this.clearWideAt(row, this.cursorCol + 1);
    row.set(this.cursorCol, cp, this.curFg, this.curBg, w === 2 ? this.curFlags | WIDE : this.curFlags);
    if (w === 2) row.set(this.cursorCol + 1, 0, this.curFg, this.curBg, this.curFlags | CONTINUATION);
    this.cursorCol += w;
    if (this.cursorCol >= this.cols) { this.cursorCol = this.cols - 1; this.pendingWrap = true; }
  }

  /** Blank both halves of a wide glyph that occupies [col]. */
  clearWideAt(row, col) {
    if (col < 0 || col >= this.cols) return;
    const f = row.flags[col];
    if ((f & CONTINUATION) !== 0 && col > 0) row.clear(col - 1, row.fg[col - 1], row.bg[col - 1]);
    if ((f & WIDE) !== 0 && col + 1 < this.cols) row.clear(col + 1, row.fg[col + 1], row.bg[col + 1]);
  }

  attachCombining(cp) {
    const row = this.buf[this.cursorRow];
    let col = this.pendingWrap ? this.cursorCol : this.cursorCol - 1;
    if (col < 0) return;
    if ((row.flags[col] & CONTINUATION) !== 0) col--;
    if (col < 0) return;
    row.appendCombining(col, String.fromCodePoint(cp));
  }

  repeatLast(n) {
    const col = this.pendingWrap ? this.cursorCol : this.cursorCol - 1;
    if (col < 0) return;
    const row = this.buf[this.cursorRow];
    let c = col;
    if ((row.flags[c] & CONTINUATION) !== 0) c--;
    if (c < 0) return;
    const code = row.codes[c];
    if (code === 0 || (code === BLANK && row.flags[c] === 0)) return;
    const marks = row.combining(c);
    const count = Math.min(n, this.cols * 4);
    for (let k = 0; k < count; k++) {
      this.print(code);
      if (marks != null) {
        const r = this.buf[this.cursorRow];
        const cc = this.pendingWrap ? this.cursorCol : this.cursorCol - 1;
        if (cc >= 0) r.setCombining(cc, marks);
      }
    }
  }

  tab() {
    let c = this.cursorCol + 1;
    while (c < this.cols - 1 && !this.tabStops[c]) c++;
    this.cursorCol = clamp(c, 0, this.cols - 1);
    this.pendingWrap = false;
  }

  backTab() {
    let c = this.cursorCol - 1;
    while (c > 0 && !this.tabStops[c]) c--;
    this.cursorCol = Math.max(0, c);
    this.pendingWrap = false;
  }

  decaln() {
    for (const r of this.buf) {
      r.fill(DEFAULT, DEFAULT);
      for (let c = 0; c < this.cols; c++) r.codes[c] = 0x45; // 'E'
    }
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.pendingWrap = false;
  }

  /* -------------------------------- cursor ------------------------------ */

  moveCursor(dRow, dCol) {
    if (dRow !== 0) {
      const top = this.cursorRow >= this.scrollTop ? this.scrollTop : 0;
      const bottom = this.cursorRow <= this.scrollBottom ? this.scrollBottom : this.rows - 1;
      this.cursorRow = clamp(this.cursorRow + dRow, top, bottom);
    }
    this.cursorCol = clamp(this.cursorCol + dCol, 0, this.cols - 1);
    this.pendingWrap = false;
  }

  setCursorRow(r) {
    this.cursorRow = this.originMode
      ? clamp(this.scrollTop + r, this.scrollTop, this.scrollBottom)
      : clamp(r, 0, this.rows - 1);
    this.pendingWrap = false;
  }

  lineFeed() {
    if (this.cursorRow === this.scrollBottom) this.scrollUp(1);
    else if (this.cursorRow < this.rows - 1) this.cursorRow++;
  }

  index() { this.lineFeed(); }

  reverseIndex() {
    if (this.cursorRow === this.scrollTop) this.scrollDown(1);
    else if (this.cursorRow > 0) this.cursorRow--;
  }

  saveCursor() {
    const s = this.saved;
    s.row = this.cursorRow; s.col = this.cursorCol;
    s.fg = this.curFg; s.bg = this.curBg; s.flags = this.curFlags;
    s.origin = this.originMode; s.autowrap = this.autowrap;
    s.g0 = this.g0; s.g1 = this.g1; s.shiftG1 = this.shiftG1; s.pendingWrap = this.pendingWrap;
  }

  restoreCursor() {
    const s = this.saved;
    this.cursorRow = clamp(s.row, 0, this.rows - 1);
    this.cursorCol = clamp(s.col, 0, this.cols - 1);
    this.curFg = s.fg; this.curBg = s.bg; this.curFlags = s.flags;
    this.originMode = s.origin; this.autowrap = s.autowrap;
    this.g0 = s.g0; this.g1 = s.g1; this.shiftG1 = s.shiftG1;
    this.pendingWrap = false;
  }

  /* ------------------------------ scrolling ----------------------------- */

  scrollUp(n) {
    const g = this.buf;
    const count = clamp(n, 1, this.scrollBottom - this.scrollTop + 1);
    const toHistory = !this.isAltScreen && this.scrollTop === 0 && this.scrollBottom === this.rows - 1;
    for (let k = 0; k < count; k++) {
      const top = g[this.scrollTop];
      for (let y = this.scrollTop; y < this.scrollBottom; y++) g[y] = g[y + 1];
      if (toHistory) {
        g[this.scrollBottom] = this.pushScrollback(top);
      } else {
        top.fill(this.curFg, this.curBg);
        g[this.scrollBottom] = top;
      }
    }
  }

  /** Move [row] into history; returns a fresh (or recycled) blank row for the bottom. */
  pushScrollback(row) {
    if (this._maxScrollback <= 0) { row.fill(this.curFg, this.curBg); return row; }
    this.scrollback.addLast(row);
    if (this.scrollback.size > this._maxScrollback) {
      const recycled = this.scrollback.removeFirst();
      recycled.fill(this.curFg, this.curBg);
      return recycled;
    }
    const fresh = new Row(this.cols);
    if (this.curBg !== DEFAULT || this.curFg !== DEFAULT) fresh.fill(this.curFg, this.curBg);
    return fresh;
  }

  trimScrollback() {
    while (this.scrollback.size > this._maxScrollback) this.scrollback.removeFirst();
  }

  scrollDown(n) {
    const g = this.buf;
    const count = clamp(n, 1, this.scrollBottom - this.scrollTop + 1);
    for (let k = 0; k < count; k++) {
      const bottom = g[this.scrollBottom];
      for (let y = this.scrollBottom; y > this.scrollTop; y--) g[y] = g[y - 1];
      bottom.fill(this.curFg, this.curBg);
      g[this.scrollTop] = bottom;
    }
  }

  insertLines(n) {
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    const g = this.buf;
    const count = Math.min(n, this.scrollBottom - this.cursorRow + 1);
    for (let k = 0; k < count; k++) {
      const bottom = g[this.scrollBottom];
      for (let y = this.scrollBottom; y > this.cursorRow; y--) g[y] = g[y - 1];
      bottom.fill(this.curFg, this.curBg);
      g[this.cursorRow] = bottom;
    }
    this.cursorCol = 0;
    this.pendingWrap = false;
  }

  deleteLines(n) {
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    const g = this.buf;
    const count = Math.min(n, this.scrollBottom - this.cursorRow + 1);
    for (let k = 0; k < count; k++) {
      const top = g[this.cursorRow];
      for (let y = this.cursorRow; y < this.scrollBottom; y++) g[y] = g[y + 1];
      top.fill(this.curFg, this.curBg);
      g[this.scrollBottom] = top;
    }
    this.cursorCol = 0;
    this.pendingWrap = false;
  }

  /* --------------------------------- erase ------------------------------ */

  eraseDisplay(mode) {
    const g = this.buf;
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.cursorRow + 1; y < this.rows; y++) g[y].fill(this.curFg, this.curBg);
    } else if (mode === 1) {
      for (let y = 0; y < this.cursorRow; y++) g[y].fill(this.curFg, this.curBg);
      this.eraseLine(1);
    } else if (mode === 2) {
      for (let y = 0; y < this.rows; y++) g[y].fill(this.curFg, this.curBg);
    } else if (mode === 3) {
      this.scrollback.clear();
    }
    this.pendingWrap = false;
  }

  eraseLine(mode) {
    const row = this.buf[this.cursorRow];
    if (mode === 0) {
      this.clearWideAt(row, this.cursorCol);
      row.clearRange(this.cursorCol, this.cols, this.curFg, this.curBg);
      row.wrapped = false;
    } else if (mode === 1) {
      this.clearWideAt(row, this.cursorCol);
      row.clearRange(0, this.cursorCol + 1, this.curFg, this.curBg);
    } else if (mode === 2) {
      row.fill(this.curFg, this.curBg);
    }
    this.pendingWrap = false;
  }

  eraseChars(n) {
    const row = this.buf[this.cursorRow];
    const end = Math.min(this.cursorCol + n, this.cols);
    this.clearWideAt(row, this.cursorCol);
    this.clearWideAt(row, end - 1);
    row.clearRange(this.cursorCol, end, this.curFg, this.curBg);
    this.pendingWrap = false;
  }

  insertChars(n) {
    this.insertCells(this.buf[this.cursorRow], this.cursorCol, n);
    this.pendingWrap = false;
  }

  insertCells(row, at, n) {
    const count = clamp(n, 0, this.cols - at);
    if (count === 0) return;
    this.clearWideAt(row, at);
    row.moveCells(at, at + count, this.cols - at - count);
    row.clearRange(at, at + count, this.curFg, this.curBg);
    // A wide glyph pushed past the right edge loses its half: blank the orphan.
    if ((row.flags[this.cols - 1] & WIDE) !== 0) {
      row.clear(this.cols - 1, row.fg[this.cols - 1], row.bg[this.cols - 1]);
    }
  }

  deleteChars(n) {
    const row = this.buf[this.cursorRow];
    const count = clamp(n, 0, this.cols - this.cursorCol);
    if (count === 0) return;
    this.clearWideAt(row, this.cursorCol);
    this.clearWideAt(row, this.cursorCol + count - 1);
    row.moveCells(this.cursorCol + count, this.cursorCol, this.cols - this.cursorCol - count);
    row.clearRange(this.cols - count, this.cols, this.curFg, this.curBg);
    this.pendingWrap = false;
  }

  /* ------------------------------ alt screen ---------------------------- */

  switchAlt(toAlt, saveRestore) {
    if (toAlt === this.isAltScreen) return;
    if (toAlt) {
      if (saveRestore) this.saveCursor();
      this.mainCursorRow = this.cursorRow;
      this.mainCursorCol = this.cursorCol;
      this.isAltScreen = true;
      for (const r of this.alt) r.fill(DEFAULT, DEFAULT);
      this.cursorRow = 0;
      this.cursorCol = 0;
    } else {
      this.isAltScreen = false;
      this.cursorRow = clamp(this.mainCursorRow, 0, this.rows - 1);
      this.cursorCol = clamp(this.mainCursorCol, 0, this.cols - 1);
      if (saveRestore) this.restoreCursor();
    }
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.pendingWrap = false;
    if (this.onAltScreen) this.onAltScreen(toAlt);
  }

  /* -------------------------------- resets ------------------------------ */

  /** RIS: everything back to power-on state, screens and history cleared. */
  reset() {
    for (const r of this.screen) r.fill(DEFAULT, DEFAULT);
    for (const r of this.alt) r.fill(DEFAULT, DEFAULT);
    this.scrollback.clear();
    if (this.isAltScreen) { this.isAltScreen = false; if (this.onAltScreen) this.onAltScreen(false); }
    this.softReset();
    this.cursorRow = 0; this.cursorCol = 0;
    this.mainCursorRow = 0; this.mainCursorCol = 0;
    this.title = '';
    this.applicationKeypad = false;
    this.mouseMode = MOUSE_OFF; this.mouseSgr = false;
    this.focusEvents = false; this.bracketedPaste = false;
    this.cursorStyle = CURSOR_BLOCK; this.cursorBlink = true;
    for (let i = 0; i < this.tabStops.length; i++) this.tabStops[i] = i % 8 === 0 ? 1 : 0;
    this.state = S_GROUND;
    this.pendingHigh = 0;
    this.dirty = true;
  }

  /** DECSTR: modes/attributes/margins reset, screen contents kept. */
  softReset() {
    this.cursorVisible = true;
    this.insertMode = false;
    this.originMode = false;
    this.autowrap = true;
    this.applicationCursorKeys = false;
    this.applicationKeypad = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.curFg = DEFAULT; this.curBg = DEFAULT; this.curFlags = 0;
    this.g0 = 0; this.g1 = 0; this.shiftG1 = false;
    this.pendingWrap = false;
    for (const s of [this.savedMain, this.savedAlt]) {
      s.row = 0; s.col = 0; s.fg = DEFAULT; s.bg = DEFAULT; s.flags = 0;
      s.origin = false; s.autowrap = true; s.g0 = 0; s.g1 = 0; s.shiftG1 = false;
    }
    this.dirty = true;
  }

  /** Clear the visible screen and home the cursor (history kept). */
  clearScreen() {
    for (const r of this.buf) r.fill(DEFAULT, DEFAULT);
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.pendingWrap = false;
    this.dirty = true;
  }

  clearScrollback() {
    this.scrollback.clear();
    this.dirty = true;
  }

  /* -------------------------------- resize ------------------------------ */

  resize(newCols, newRows) {
    const nc = Math.max(1, newCols | 0);
    const nr = Math.max(1, newRows | 0);
    if (nc === this.cols && nr === this.rows) return;

    // Alternate screen: clip / pad (full-screen programs redraw on SIGWINCH).
    const newAlt = Array.from({ length: nr }, () => new Row(nc));
    for (let y = 0; y < Math.min(nr, this.rows); y++) newAlt[y].copyFrom(this.alt[y]);
    if (this.isAltScreen) {
      this.cursorRow = clamp(this.cursorRow, 0, nr - 1);
      this.cursorCol = clamp(this.cursorCol, 0, nc - 1);
    }

    // Primary screen + history: reflow logical lines.
    const curRow = this.isAltScreen ? this.mainCursorRow : this.cursorRow;
    const curCol = this.isAltScreen ? this.mainCursorCol : this.cursorCol;
    const reflowed = this.reflow(nc, nr, curRow, curCol);
    this.screen = reflowed.screen;
    if (this.isAltScreen) {
      // The cursor saved by DECSET 1049 is the primary cursor; keep it in sync so
      // leaving the alternate screen restores the reflowed position, not a stale one.
      if (this.savedMain.row === curRow && this.savedMain.col === curCol) {
        this.savedMain.row = reflowed.cursorRow;
        this.savedMain.col = reflowed.cursorCol;
      }
      this.mainCursorRow = reflowed.cursorRow;
      this.mainCursorCol = reflowed.cursorCol;
    } else {
      this.cursorRow = reflowed.cursorRow;
      this.cursorCol = reflowed.cursorCol;
    }
    this.alt = newAlt;

    const oldStops = this.tabStops;
    const stops = new Uint8Array(nc);
    for (let i = 0; i < nc; i++) stops[i] = i < oldStops.length ? oldStops[i] : (i % 8 === 0 ? 1 : 0);
    this.tabStops = stops;
    this.cols = nc;
    this.rows = nr;
    this.scrollTop = 0;
    this.scrollBottom = nr - 1;
    this.pendingWrap = this.isAltScreen ? false : reflowed.pendingWrap;
    for (const s of [this.savedMain, this.savedAlt]) {
      s.row = clamp(s.row, 0, nr - 1);
      s.col = clamp(s.col, 0, nc - 1);
    }
    this.trimScrollback();
    this.dirty = true;
  }

  reflow(nc, nr, curRow, curCol) {
    // Gather all physical rows (history + screen), dropping blank rows below the
    // cursor at the bottom of the screen (they are re-padded afterwards).
    const phys = this.scrollback.toArray();
    let lastKeep = this.rows - 1;
    while (lastKeep > curRow && this.screen[lastKeep].isBlank() && !this.screen[lastKeep - 1].wrapped) lastKeep--;
    const sbSize = phys.length;
    for (let y = 0; y <= lastKeep; y++) phys.push(this.screen[y]);
    const cursorPhys = sbSize + curRow;

    const out = [];
    let outCursorRow = -1;
    let outCursorCol = 0;
    let outPending = false;

    let i = 0;
    while (i < phys.length) {
      // One logical line = a run of rows joined by `wrapped`.
      const start = i;
      let end = i;
      while (end < phys.length - 1 && phys[end].wrapped) end++;
      let cursorUnits = -1;
      if (cursorPhys >= start && cursorPhys <= end) {
        cursorUnits = 0;
        for (let k = start; k < cursorPhys; k++) cursorUnits += phys[k].cols;
        cursorUnits += curCol;
      }
      // Lay the line's cells out at the new width.
      let row = new Row(nc);
      out.push(row);
      let x = 0;
      let units = 0; // column units consumed so far (wide = 2)
      const placeCursorIfHere = () => {
        if (cursorUnits >= 0 && outCursorRow < 0 && units >= cursorUnits) {
          outCursorRow = out.length - 1;
          outCursorCol = x - (units - cursorUnits);
          if (outCursorCol < 0) outCursorCol = 0;
        }
      };
      for (let k = start; k <= end; k++) {
        const src = phys[k];
        const limit = k === end ? src.contentEnd() : src.cols;
        let c = 0;
        while (c < limit) {
          const code = src.codes[c];
          if (code === 0) { c++; continue; }
          const wide = (src.flags[c] & WIDE) !== 0 && c + 1 < src.cols;
          const w = wide ? 2 : 1;
          placeCursorIfHere();
          if (x + w > nc) {
            if (w === 2 && nc < 2) { c++; continue; }
            row.wrapped = true;
            row = new Row(nc);
            out.push(row);
            x = 0;
          }
          row.set(x, code, src.fg[c], src.bg[c], src.flags[c] & ~CONTINUATION);
          const marks = src.combining(c);
          if (marks) row.setCombining(x, marks);
          if (wide) row.set(x + 1, 0, src.fg[c], src.bg[c], (src.flags[c] & ~WIDE) | CONTINUATION);
          x += w;
          units += w;
          c += w;
        }
        if (k < end) {
          // Continuation rows: the trailing blanks of a wrapped row are real cells.
          const pad = src.cols - limit;
          for (let p = 0; p < pad; p++) {
            placeCursorIfHere();
            if (x >= nc) { row.wrapped = true; row = new Row(nc); out.push(row); x = 0; }
            x++; units++;
          }
        }
      }
      if (cursorUnits >= 0 && outCursorRow < 0) {
        // Cursor sits after the content (e.g. after a trimmed prompt space).
        let col = x + (cursorUnits - units);
        let r = out.length - 1;
        if (col === nc && nc > 1) {
          // Exactly past a full row: keep the cursor on the last cell with a pending wrap
          // (xterm), rather than opening a blank row that would scroll content away.
          outCursorRow = r;
          outCursorCol = nc - 1;
          outPending = true;
        } else {
          while (col >= nc) { col -= nc; out[r].wrapped = true; out.push(new Row(nc)); r++; }
          outCursorRow = r;
          outCursorCol = clamp(col, 0, nc - 1);
        }
      }
      if (out.length > 0) out[out.length - 1].wrapped = false;
      i = end + 1;
    }
    if (out.length === 0) out.push(new Row(nc));
    if (outCursorRow < 0) { outCursorRow = out.length - 1; outCursorCol = 0; }

    // Split into history and the new screen so the cursor is visible.
    let screenStart = out.length - nr;
    if (screenStart > outCursorRow) screenStart = outCursorRow;
    if (screenStart < 0) screenStart = 0;
    this.scrollback.clear();
    for (let k = 0; k < screenStart; k++) this.scrollback.addLast(out[k]);
    const newScreen = Array.from({ length: nr }, (_, y) => {
      const idx = screenStart + y;
      return idx < out.length ? out[idx] : new Row(nc);
    });
    return {
      screen: newScreen,
      cursorRow: clamp(outCursorRow - screenStart, 0, nr - 1),
      cursorCol: clamp(outCursorCol, 0, nc - 1),
      pendingWrap: outPending,
    };
  }

  /* -------------------------------- readout ----------------------------- */

  totalRows() {
    return this.isAltScreen ? this.rows : this.scrollback.size + this.rows;
  }

  rowAt(index) {
    if (this.isAltScreen) return this.alt[clamp(index, 0, this.rows - 1)];
    const sb = this.scrollback.size;
    return index < sb
      ? this.scrollback.get(Math.max(0, index))
      : this.screen[clamp(index - sb, 0, this.rows - 1)];
  }

  cursorAbsRow() {
    return this.isAltScreen ? this.cursorRow : this.scrollback.size + this.cursorRow;
  }

  rowText(index, trimEnd = true) {
    return this.rowAt(index).text(trimEnd);
  }

  /**
   * A soft-wrapped row whose last cell is blank while the continuation starts
   * with a wide glyph carries one cell of wrap padding, which is not content.
   */
  wrapPadding(index, row) {
    if (!row.wrapped || row.cols === 0 || index + 1 >= this.totalRows()) return 0;
    const next = this.rowAt(index + 1);
    const last = row.cols - 1;
    return row.codes[last] === BLANK && row.combining(last) == null &&
      next.cols > 0 && (next.flags[0] & WIDE) !== 0 ? 1 : 0;
  }

  /** Whole buffer as text; soft-wrapped rows are joined without a newline. */
  renderText() {
    const out = [];
    const total = this.totalRows();
    for (let i = 0; i < total; i++) {
      const row = this.rowAt(i);
      row.appendText(out, 0, row.cols - this.wrapPadding(i, row), !row.wrapped);
      if (!row.wrapped && i < total - 1) out.push('\n');
    }
    return out.join('');
  }

  /** Text of an inclusive selection in absolute row coordinates. */
  textBetween(fromRow, fromCol, toRow, toCol) {
    let r0 = fromRow, c0 = fromCol, r1 = toRow, c1 = toCol;
    if (r1 < r0 || (r1 === r0 && c1 < c0)) { r0 = toRow; c0 = toCol; r1 = fromRow; c1 = fromCol; }
    const total = this.totalRows();
    r0 = clamp(r0, 0, total - 1);
    r1 = clamp(r1, 0, total - 1);
    const out = [];
    for (let r = r0; r <= r1; r++) {
      const row = this.rowAt(r);
      let a = r === r0 ? clamp(c0, 0, row.cols) : 0;
      const b = r === r1 ? clamp(c1 + 1, 0, row.cols) : row.cols - this.wrapPadding(r, row);
      if (a < row.cols && (row.flags[a] & CONTINUATION) !== 0) a--;
      const last = r === r1;
      row.appendText(out, Math.max(0, a), b, !row.wrapped || last);
      if (!last && !row.wrapped) out.push('\n');
    }
    return out.join('');
  }

  consumeDirty() {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  /* --------------------------------- mouse ------------------------------ */

  mouseReport(kind, col, row, button, shift = false, alt = false, ctrl = false) {
    if (this.mouseMode === MOUSE_OFF) return null;
    let code;
    let release = false;
    switch (kind) {
      case MOUSE_EVENT_PRESS:
        code = clamp(button, 0, 2);
        this.mouseButtonHeld = code;
        break;
      case MOUSE_EVENT_RELEASE:
        code = this.mouseSgr ? clamp(button, 0, 2) : 3;
        release = true;
        this.mouseButtonHeld = -1;
        break;
      case MOUSE_EVENT_MOTION:
        if (this.mouseMode === MOUSE_PRESS) return null;
        if (this.mouseMode === MOUSE_BUTTON && this.mouseButtonHeld < 0) return null;
        code = 32 + (this.mouseButtonHeld < 0 ? 3 : this.mouseButtonHeld);
        break;
      case MOUSE_EVENT_WHEEL_UP: code = 64; break;
      case MOUSE_EVENT_WHEEL_DOWN: code = 65; break;
      default: return null;
    }
    if (shift) code += 4;
    if (alt) code += 8;
    if (ctrl) code += 16;
    const x = Math.max(0, col) + 1;
    const y = Math.max(0, row) + 1;
    if (this.mouseSgr) return `\x1b[<${code};${x};${y}${release ? 'm' : 'M'}`;
    const cx = Math.min(x, 223);
    const cy = Math.min(y, 223);
    return `\x1b[M${String.fromCharCode(32 + code)}${String.fromCharCode(32 + cx)}${String.fromCharCode(32 + cy)}`;
  }
}

/* ------------------------------- helpers -------------------------------- */

function rgb(r, g, b) {
  return TRUECOLOR | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/**
 * `file://host/path` from OSC 7 to a plain path. The host is ignored (the agent
 * is the only machine that could have written it) and percent escapes are
 * decoded; anything else is refused rather than guessed at.
 */
export function parseFileUrl(raw) {
  if (!raw.startsWith('file://')) return null;
  const afterScheme = raw.substring(7);
  const slash = afterScheme.indexOf('/');
  if (slash < 0) return null;
  const path = unescapePercent(afterScheme.substring(slash));
  if (path.length === 0) return null;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) < 0x20) return null;
  // Windows shells send /C:/Users/..., which is that path with a stray slash.
  return path.length > 2 && path[0] === '/' && path[2] === ':' ? path.substring(1) : path;
}

function unescapePercent(s) {
  if (!s.includes('%')) return s;
  const bytes = [];
  let i = 0;
  const encoder = new TextEncoder();
  while (i < s.length) {
    const c = s[i];
    if (c === '%' && i + 2 < s.length) {
      const hex = s.substring(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 3; continue; }
    }
    for (const b of encoder.encode(c)) bytes.push(b);
    i++;
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

/** Lenient base64 (standard and URL alphabets) for OSC 52; null on bad input. */
export function base64Decode(s) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    let v;
    if (ch >= 'A' && ch <= 'Z') v = ch.charCodeAt(0) - 65;
    else if (ch >= 'a' && ch <= 'z') v = ch.charCodeAt(0) - 97 + 26;
    else if (ch >= '0' && ch <= '9') v = ch.charCodeAt(0) - 48 + 52;
    else if (ch === '+' || ch === '-') v = 62;
    else if (ch === '/' || ch === '_') v = 63;
    else if (ch === '=' || ch === '\n' || ch === '\r' || ch === ' ') continue;
    else return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(out));
}
