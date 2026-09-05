/**
 * The key encoder, the sticky modifiers, the extra-key rows and the cell-width
 * table — the Android app's `KeyEncoderTest`, `ModifierStateTest` and
 * `WcWidthTest` carried over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as Keys from '../ui/js/terminal/keyencoder.js';
import { ModifierState, Which, Mode } from '../ui/js/terminal/modifiers.js';
import { parseRow, Action } from '../ui/js/terminal/extrakeys.js';
import { widthOf, isCombining } from '../ui/js/terminal/wcwidth.js';

const esc = '\x1b';
const ctrl = Keys.mods({ ctrl: true });
const alt = Keys.mods({ alt: true });
const shift = Keys.mods({ shift: true });

/* ----------------------------- key encoding ----------------------------- */

test('cursor keys follow DECCKM and modifiers', () => {
  assert.equal(Keys.encodeKey(Keys.Key.UP), `${esc}[A`);
  assert.equal(Keys.encodeKey(Keys.Key.UP, Keys.NO_MODS, true), `${esc}OA`);
  assert.equal(Keys.encodeKey(Keys.Key.RIGHT, ctrl), `${esc}[1;5C`);
  assert.equal(Keys.encodeKey(Keys.Key.LEFT, alt), `${esc}[1;3D`);
  assert.equal(Keys.encodeKey(Keys.Key.DOWN, shift), `${esc}[1;2B`);
  assert.equal(Keys.encodeKey(Keys.Key.HOME, Keys.mods({ ctrl: true, alt: true }), true), `${esc}[1;7H`);
  assert.equal(Keys.encodeKey(Keys.Key.END), `${esc}[F`);
});

test('editing and function keys', () => {
  assert.equal(Keys.encodeKey(Keys.Key.INSERT), `${esc}[2~`);
  assert.equal(Keys.encodeKey(Keys.Key.DELETE, ctrl), `${esc}[3;5~`);
  assert.equal(Keys.encodeKey(Keys.Key.PAGE_UP), `${esc}[5~`);
  assert.equal(Keys.encodeKey(Keys.Key.PAGE_DOWN, shift), `${esc}[6;2~`);
  assert.equal(Keys.encodeKey(Keys.Key.F1), `${esc}OP`);
  assert.equal(Keys.encodeKey(Keys.Key.F4, ctrl), `${esc}[1;5S`);
  assert.equal(Keys.encodeKey(Keys.Key.F5), `${esc}[15~`);
  assert.equal(Keys.encodeKey(Keys.Key.F12, alt), `${esc}[24;3~`);
  assert.equal(Keys.encodeKey(Keys.Key.ENTER), '\r');
  assert.equal(Keys.encodeKey(Keys.Key.ENTER, alt), `${esc}\r`);
  assert.equal(Keys.encodeKey(Keys.Key.TAB), '\t');
  assert.equal(Keys.encodeKey(Keys.Key.TAB, shift), `${esc}[Z`);
  assert.equal(Keys.encodeKey(Keys.Key.BACKSPACE), '\x7f');
  assert.equal(Keys.encodeKey(Keys.Key.BACKSPACE, ctrl), '\x08');
  assert.equal(Keys.encodeKey(Keys.Key.BACKSPACE, alt), `${esc}\x7f`);
  assert.equal(Keys.encodeKey(Keys.Key.ESCAPE), esc);
});

test('control characters', () => {
  assert.equal(Keys.encodeText('c', ctrl), '\x03');
  assert.equal(Keys.encodeText('C', ctrl), '\x03');
  assert.equal(Keys.encodeText('d', ctrl), '\x04');
  assert.equal(Keys.encodeText('z', ctrl), '\x1a');
  assert.equal(Keys.encodeText('l', ctrl), '\x0c');
  assert.equal(Keys.encodeText(' ', ctrl), '\x00');
  assert.equal(Keys.encodeText('@', ctrl), '\x00');
  assert.equal(Keys.encodeText('[', ctrl), esc);
  assert.equal(Keys.encodeText('\\', ctrl), '\x1c');
  assert.equal(Keys.encodeText(']', ctrl), '\x1d');
  assert.equal(Keys.encodeText('^', ctrl), '\x1e');
  assert.equal(Keys.encodeText('_', ctrl), '\x1f');
  assert.equal(Keys.encodeText('?', ctrl), '\x7f');
  assert.equal(Keys.encodeText('a', Keys.mods({ ctrl: true, alt: true })), `${esc}\x01`);
  assert.equal(Keys.encodeText('b', alt), `${esc}b`);
  assert.equal(Keys.encodeText('ab', Keys.NO_MODS), 'ab');
  assert.equal(Keys.encodeText('ab', Keys.mods({ ctrl: true, alt: true })), `${esc}\x01${esc}\x02`);
  assert.equal(Keys.encodeText('9', ctrl), '9', 'no control mapping: the character passes through');
  assert.equal(Keys.ctrlOf('9'.codePointAt(0)), null);
  assert.equal(Keys.encodeText('\u{1F600}', ctrl), '\u{1F600}');
});

test('paste and shortcuts', () => {
  assert.equal(Keys.paste('a\r\nb\nc', false), 'a\rb\rc');
  assert.equal(Keys.paste('x', true), `${esc}[200~x${esc}[201~`);
  assert.equal(Keys.paste(`a${esc}[201~b`, true), `${esc}[200~ab${esc}[201~`);
  assert.equal(Keys.shortcut('Ctrl+C'), '\x03');
  assert.equal(Keys.shortcut('ctrl+d'), '\x04');
  assert.equal(Keys.shortcut('Alt+b'), `${esc}b`);
  assert.equal(Keys.shortcut('Ctrl+Up'), `${esc}[1;5A`);
  assert.equal(Keys.shortcut('Shift+Tab'), `${esc}[Z`);
  assert.equal(Keys.shortcut('F1'), `${esc}OP`);
  assert.equal(Keys.shortcut('Hyper+X'), null);
  assert.equal(Keys.shortcut(''), null);
});

/* ---------------------------- sticky modifiers --------------------------- */

test('a tap is one-shot, a double tap locks, a further tap releases', () => {
  const m = new ModifierState();
  let changes = 0;
  m.onChanged = () => { changes++; };
  assert.equal(m.tap(Which.CTRL, 1000), Mode.ONESHOT);
  assert.equal(m.mods().ctrl, true);
  assert.equal(m.tap(Which.CTRL, 1200), Mode.LOCKED);
  m.consume();
  assert.equal(m.mods().ctrl, true, 'locked survives a key');
  assert.equal(m.tap(Which.CTRL, 5000), Mode.OFF);
  assert.equal(m.mods().ctrl, false);
  assert.equal(changes, 3);
});

test('a one-shot releases after one key and a slow second tap turns it off', () => {
  const m = new ModifierState();
  m.tap(Which.ALT, 0);
  m.consume();
  assert.equal(m.mods().alt, false);
  m.tap(Which.ALT, 10_000);
  assert.equal(m.tap(Which.ALT, 20_000), Mode.OFF);
});

test('modifiers are independent and clear resets all of them', () => {
  const m = new ModifierState();
  m.tap(Which.CTRL, 0);
  m.tap(Which.SHIFT, 0);
  const mods = m.mods();
  assert.equal(mods.ctrl && mods.shift && !mods.alt, true);
  assert.equal(m.anyActive, true);
  m.clear();
  assert.equal(m.anyActive, false);
});

test('extra key rows parse tokens and alternates', () => {
  const row = parseRow('ESC CTRL -|_ ||& F5 hello');
  assert.equal(row.length, 6);
  assert.equal(row[0].action, Action.SPECIAL);
  assert.equal(row[0].key, Keys.Key.ESCAPE);
  assert.equal(row[1].action, Action.MODIFIER);
  assert.equal(row[1].which, Which.CTRL);
  assert.equal(row[2].action, Action.TEXT);
  assert.equal(row[2].text, '-');
  assert.equal(row[2].alternates.length, 1);
  assert.equal(row[2].alternates[0].label, '_');
  assert.equal(row[3].text, '|');
  assert.equal(row[3].alternates[0].label, '&');
  assert.equal(row[4].key, Keys.Key.F5);
  assert.equal(row[5].text, 'hello');
});

/* ------------------------------- cell width ------------------------------ */

test('ASCII and Latin are one cell', () => {
  assert.equal(widthOf('a'.codePointAt(0)), 1);
  assert.equal(widthOf('~'.codePointAt(0)), 1);
  assert.equal(widthOf(0xe9), 1);   // é precomposed
  assert.equal(widthOf(0x2500), 1); // box drawing
  assert.equal(widthOf(0x2588), 1); // full block
  assert.equal(widthOf(0x0410), 1); // Cyrillic
  assert.equal(widthOf(0x05d0), 1); // Hebrew alef
});

test('controls are zero width', () => {
  assert.equal(widthOf(0x00), 0);
  assert.equal(widthOf(0x1b), 0);
  assert.equal(widthOf(0x7f), 0);
  assert.equal(widthOf(0x9b), 0);
});

test('combining and format characters are zero width', () => {
  assert.equal(widthOf(0x0301), 0);  // combining acute
  assert.equal(widthOf(0x0308), 0);  // combining diaeresis
  assert.equal(widthOf(0x200d), 0);  // zero width joiner
  assert.equal(widthOf(0xfe0f), 0);  // variation selector-16
  assert.equal(widthOf(0x20e3), 0);  // combining enclosing keycap
  assert.equal(widthOf(0x1160), 0);  // Hangul jungseong filler
  assert.equal(widthOf(0xe0100), 0); // variation selector supplement
  assert.equal(widthOf(0xfeff), 0);  // BOM / ZWNBSP
  assert.equal(isCombining(0x0301), true);
  assert.equal(isCombining('a'.codePointAt(0)), false);
});

test('East Asian wide characters and emoji are two cells', () => {
  assert.equal(widthOf('日'.codePointAt(0)), 2);
  assert.equal(widthOf('本'.codePointAt(0)), 2);
  assert.equal(widthOf(0xac00), 2);  // Hangul syllable
  assert.equal(widthOf(0xff21), 2);  // fullwidth A
  assert.equal(widthOf(0x3000), 2);  // ideographic space
  assert.equal(widthOf(0x1f600), 2);
  assert.equal(widthOf(0x1f680), 2);
  assert.equal(widthOf(0x2705), 2);
  assert.equal(widthOf(0x20000), 2); // CJK extension B
});

test('regional indicators and text-presentation symbols are narrow', () => {
  // Regional indicator letters are ambiguous; most terminals give them 1 cell.
  assert.equal(widthOf(0x1f1e6), 1);
  assert.equal(widthOf(0x263a), 1); // ☺ has text presentation by default
  assert.equal(widthOf(0x2601), 1); // ☁ too
});
