/**
 * The terminal's extra-keys bar: configurable rows of special keys, sticky
 * Ctrl/Alt/Shift with one-shot and locked states, a symbol row that can be
 * swapped for an alternate row, and right-click alternates (`-|_`).
 *
 * A port of `ExtraKeysView.kt`. Row definitions are space-separated tokens and
 * come from Settings, so users can customise them.
 */

import { Key } from './keyencoder.js';
import { Which, Mode } from './modifiers.js';
import { el, clear, svgIcon } from '../ui/dom.js';

export const Action = Object.freeze({ SPECIAL: 'special', MODIFIER: 'modifier', TEXT: 'text', SWAP: 'swap' });

const SPECIAL = {
  ESC: Key.ESCAPE, TAB: Key.TAB, ENTER: Key.ENTER, BKSP: Key.BACKSPACE,
  UP: Key.UP, DOWN: Key.DOWN, LEFT: Key.LEFT, RIGHT: Key.RIGHT,
  HOME: Key.HOME, END: Key.END, PGUP: Key.PAGE_UP, PGDN: Key.PAGE_DOWN,
  INS: Key.INSERT, DEL: Key.DELETE,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
};

const LABELS = {
  ESC: 'Esc', TAB: 'Tab', ENTER: '⏎', BKSP: '⌫',
  UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→',
  HOME: 'Home', END: 'End', PGUP: 'PgUp', PGDN: 'PgDn', INS: 'Ins', DEL: 'Del',
};

function single(token) {
  const up = token.toUpperCase();
  if (SPECIAL[up]) return { label: LABELS[up] ?? up, action: Action.SPECIAL, key: SPECIAL[up], alternates: [] };
  switch (up) {
    case 'CTRL': return { label: 'Ctrl', action: Action.MODIFIER, which: Which.CTRL, alternates: [] };
    case 'ALT': return { label: 'Alt', action: Action.MODIFIER, which: Which.ALT, alternates: [] };
    case 'SHIFT': return { label: 'Shift', action: Action.MODIFIER, which: Which.SHIFT, alternates: [] };
    case 'SWAP': return { label: '⇄', action: Action.SWAP, alternates: [] };
    default: return { label: token, action: Action.TEXT, text: token, alternates: [] };
  }
}

/** One token → key spec. `a|b|c` = key a with right-click alternates b, c. */
export function parseToken(token) {
  if (!token) return null;
  // Split on '|' unless the token IS the pipe character (or starts with it, e.g. "||&").
  const parts = token.startsWith('|')
    ? ['|', ...token.slice(1).split('|').filter(Boolean)]
    : token.split('|').filter(Boolean);
  if (parts.length === 0) return null;
  const spec = single(parts[0]);
  if (!spec) return null;
  spec.alternates = parts.slice(1).map(single).filter(Boolean);
  return spec;
}

export function parseRow(def) {
  return String(def).trim().split(/\s+/).map(parseToken).filter(Boolean);
}

export class ExtraKeysBar {
  constructor(container, modifiers) {
    this.container = container;
    this.modifiers = modifiers;
    this.rowSpecs = [];
    this.alternateIndex = 0;
    this.compactIndex = 0;
    this.compact = false;
    this.hapticsPlaceholder = null;
    /** Host callback: a key was chosen. */
    this.onKey = null;
    this.modifierButtons = [];
    this.modifiers.onChanged = () => this.refreshModifiers();
  }

  setCompact(compact) {
    if (this.compact === compact) return;
    this.compact = compact;
    this.rebuild();
  }

  /** Configure from row definition strings (first row = navigation, others alternate). */
  setRows(rows) {
    this.rowSpecs = rows.map(parseRow).filter((r) => r.length > 0);
    this.alternateIndex = 0;
    this.compactIndex = 0;
    this.rebuild();
  }

  rebuild() {
    clear(this.container);
    this.modifierButtons = [];
    if (this.rowSpecs.length === 0) return;
    if (this.compact) {
      this.container.append(this.buildRow(this.rowSpecs[this.compactIndex % this.rowSpecs.length], this.rowSpecs.length > 1));
    } else {
      this.container.append(this.buildRow(this.rowSpecs[0], false));
      if (this.rowSpecs.length > 1) {
        const index = 1 + (this.alternateIndex % (this.rowSpecs.length - 1));
        this.container.append(this.buildRow(this.rowSpecs[index], this.rowSpecs.length > 2));
      }
    }
    this.refreshModifiers();
  }

  buildRow(specs, swap) {
    const row = el('div.key-row');
    if (swap) {
      row.append(el('button.key', {
        title: 'Switch key row',
        'aria-label': 'Switch key row',
        onClick: () => {
          if (this.compact) this.compactIndex = (this.compactIndex + 1) % this.rowSpecs.length;
          else this.alternateIndex = (this.alternateIndex + 1) % Math.max(1, this.rowSpecs.length - 1);
          this.rebuild();
        },
      }, svgIcon('swipe')));
    }
    for (const spec of specs) row.append(this.buildKey(spec));
    return row;
  }

  buildKey(spec) {
    const button = el('button.key', { text: spec.label });
    if (spec.action === Action.MODIFIER) {
      button.title = spec.label;
      this.modifierButtons.push([spec.which, button, spec.label]);
      button.addEventListener('click', () => {
        this.modifiers.tap(spec.which, performance.now());
        this.refreshModifiers();
      });
      return button;
    }
    if (spec.action === Action.SWAP) {
      button.addEventListener('click', () => {
        this.alternateIndex = (this.alternateIndex + 1) % Math.max(1, this.rowSpecs.length - 1);
        this.rebuild();
      });
      return button;
    }
    button.addEventListener('click', () => this.onKey?.(spec));
    if (spec.alternates.length > 0) {
      const alt = spec.alternates[0];
      button.title = `Right-click for ${alt.label}`;
      button.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onKey?.(alt);
      });
    }
    return button;
  }

  /**
   * A held modifier is shown two ways at once: the key lights up and its label
   * gains a marker — never colour alone.
   */
  refreshModifiers() {
    for (const [which, button, base] of this.modifierButtons) {
      const mode = this.modifiers.mode(which);
      button.classList.toggle('active', mode !== Mode.OFF);
      button.textContent = mode === Mode.OFF ? base : mode === Mode.ONESHOT ? `${base} ●` : `${base} ⇩`;
      button.setAttribute('aria-pressed', String(mode !== Mode.OFF));
    }
  }
}
