/**
 * The Android app's `TerminalEmulatorTest` carried over, case for case.
 *
 * The point of porting the tests along with the emulator is that the two
 * clients keep rendering the same output: a sequence that behaves one way on
 * the phone has to behave the same way here, or one of these fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TerminalEmulator } from '../ui/js/terminal/emulator.js';
import {
  DEFAULT, TRUECOLOR, BOLD, DIM, ITALIC, UNDERLINE, REVERSE, STRIKE, WIDE, CONTINUATION,
  CURSOR_BLOCK, CURSOR_UNDERLINE, CURSOR_BAR,
  MOUSE_OFF, MOUSE_PRESS, MOUSE_BUTTON,
  MOUSE_EVENT_PRESS, MOUSE_EVENT_RELEASE, MOUSE_EVENT_MOTION,
  MOUSE_EVENT_WHEEL_UP, MOUSE_EVENT_WHEEL_DOWN,
} from '../ui/js/terminal/attrs.js';

const esc = '\x1b';
const csi = '\x1b[';

const term = (cols = 80, rows = 24, scrollback = 100) => new TerminalEmulator(cols, rows, scrollback);

/** Text of screen row [r] (0-based, screen coordinates). */
const screenRow = (t, r, trim = true) => t.rowText(t.totalRows() - t.rows + r, trim);
const screenRows = (t) => Array.from({ length: t.rows }, (_, r) => screenRow(t, r));
const row = (t, r) => t.rowAt(t.totalRows() - t.rows + r);
const cursor = (t) => [t.cursorRow, t.cursorCol];
const cp = (ch) => ch.codePointAt(0);

/* -------------------------------- basics -------------------------------- */

test('plain text with CR/LF', () => {
  const t = term(20, 4);
  t.feed('hello\r\nworld');
  assert.equal(screenRow(t, 0), 'hello');
  assert.equal(screenRow(t, 1), 'world');
  assert.deepEqual(cursor(t), [1, 5]);
  t.feed('\rX');
  assert.equal(screenRow(t, 1), 'Xorld');
  assert.deepEqual(cursor(t), [1, 1]);
});

test('line feed, VT/FF and backspace', () => {
  const t = term(10, 4);
  t.feed('ab\x0bc\x0c\bZ');
  assert.deepEqual(screenRows(t).slice(0, 3).map((s) => s.replace(/\s+$/, '')), ['ab', '  c', '  Z']);
});

test('autowrap marks the row; disabled autowrap overwrites the last column', () => {
  const t = term(5, 3);
  t.feed('abcdefg');
  assert.equal(screenRow(t, 0), 'abcde');
  assert.equal(row(t, 0).wrapped, true);
  assert.equal(screenRow(t, 1), 'fg');
  assert.equal(row(t, 1).wrapped, false);
  assert.deepEqual(cursor(t), [1, 2]);

  const u = term(5, 3);
  u.feed(`${csi}?7labcdefg`);
  assert.equal(screenRow(u, 0), 'abcdg');
  assert.equal(row(u, 0).wrapped, false);
  assert.deepEqual(cursor(u), [0, 4]);
});

test('a wrapped row is unmarked when the cursor moves away without printing', () => {
  const t = term(5, 3);
  t.feed('abcde'); // pending wrap, no wrap yet
  assert.deepEqual(cursor(t), [0, 4]);
  t.feed('\r\nX');
  assert.equal(row(t, 0).wrapped, false, 'CR/LF is a hard line break');
  assert.equal(screenRow(t, 1), 'X');
});

test('scrollback is bounded and cleared by ED 3', () => {
  const t = term(10, 2, 3);
  for (let i = 1; i <= 8; i++) t.feed(`l${i}\r\n`);
  assert.equal(t.totalRows(), 3 + 2);
  assert.deepEqual([0, 1, 2].map((i) => t.rowText(i)), ['l5', 'l6', 'l7']);
  assert.equal(screenRow(t, 0), 'l8');
  assert.equal(screenRow(t, 1), '');
  t.feed(`${csi}3J`);
  assert.equal(t.totalRows(), 2);
  t.maxScrollback = 1;
  for (let i = 1; i <= 4; i++) t.feed(`m${i}\r\n`);
  assert.equal(t.totalRows(), 1 + 2);
});

/* ---------------------------- cursor movement ---------------------------- */

test('cursor movement commands and bounds', () => {
  const t = term(10, 5);
  t.feed(`${csi}3;4H`);
  assert.deepEqual(cursor(t), [2, 3]);
  t.feed(`${csi}2A${csi}5C`);
  assert.deepEqual(cursor(t), [0, 8]);
  t.feed(`${csi}9C`); // clamps
  assert.deepEqual(cursor(t), [0, 9]);
  t.feed(`${csi}20B`);
  assert.deepEqual(cursor(t), [4, 9]);
  t.feed(`${csi}E`); // CNL
  assert.deepEqual(cursor(t), [4, 0]);
  t.feed(`${csi}2F`); // CPL
  assert.deepEqual(cursor(t), [2, 0]);
  t.feed(`${csi}7G${csi}2d`); // CHA, VPA
  assert.deepEqual(cursor(t), [1, 6]);
  t.feed(`${csi}H`);
  assert.deepEqual(cursor(t), [0, 0]);
});

test('save and restore the cursor via ESC 7 / ESC 8 and CSI s / u', () => {
  const t = term(20, 5);
  t.feed(`${csi}2;5H${esc}7${csi}4;1Hxyz${esc}8`);
  assert.deepEqual(cursor(t), [1, 4]);
  t.feed(`${csi}s${csi}1;1H${csi}u`);
  assert.deepEqual(cursor(t), [1, 4]);
  // SGR is part of the saved state
  t.feed(`${csi}1m${esc}7${csi}0m${esc}8A`);
  assert.equal(row(t, 1).flags[4] & BOLD, BOLD);
});

test('scroll region, insert/delete lines and scroll commands', () => {
  const t = term(10, 5);
  for (let i = 1; i <= 5; i++) t.feed(`r${i}${i < 5 ? '\r\n' : ''}`);
  t.feed(`${csi}2;4r`); // region rows 2..4 (1-based)
  assert.deepEqual(cursor(t), [0, 0]);
  t.feed(`${csi}4;1H\n`); // LF at region bottom scrolls only the region
  assert.deepEqual(screenRows(t), ['r1', 'r3', 'r4', '', 'r5']);
  assert.deepEqual(cursor(t), [3, 0]);
  t.feed(`${csi}2;1H${csi}L`); // IL at region top
  assert.deepEqual(screenRows(t), ['r1', '', 'r3', 'r4', 'r5']);
  t.feed(`${csi}M`); // DL
  assert.deepEqual(screenRows(t), ['r1', 'r3', 'r4', '', 'r5']);
  t.feed(`${csi}S`); // SU
  assert.deepEqual(screenRows(t), ['r1', 'r4', '', '', 'r5']);
  t.feed(`${csi}2T`); // SD
  assert.deepEqual(screenRows(t), ['r1', '', '', 'r4', 'r5']);
  t.feed(`${csi}r`); // reset region
  t.feed(`${csi}5;1H\n`);
  assert.deepEqual(screenRows(t), ['', '', 'r4', 'r5', '']);
  assert.equal(t.totalRows() - t.rows, 1); // r1 went to history
  assert.equal(t.rowText(0), 'r1');
});

test('a line feed outside the region does not scroll', () => {
  const t = term(10, 5);
  t.feed(`${csi}1;3r${csi}5;1Hbottom\n`);
  assert.equal(screenRow(t, 4), 'bottom');
  assert.deepEqual(cursor(t), [4, 6]);
  t.feed(`${csi}4;1H\n`);
  assert.deepEqual(cursor(t), [4, 0]);
  t.feed(`${csi}1;1H${esc}M`); // RI at region top scrolls the region down
  assert.deepEqual(cursor(t), [0, 0]);
});

/* -------------------------------- erasing -------------------------------- */

test('erase display and line variants', () => {
  const t = term(6, 3);
  t.feed(`aaaaaa\r\nbbbbbb\r\ncccccc${csi}2;3H`);
  t.feed(`${csi}K`);
  assert.deepEqual(screenRows(t), ['aaaaaa', 'bb', 'cccccc']);
  t.feed(`${csi}1K`);
  assert.equal(screenRow(t, 1), '');
  t.feed(`${csi}2;3Hxyz${csi}2;4H${csi}2K`);
  assert.equal(screenRow(t, 1), '');
  t.feed(`${csi}2;3H${csi}J`);
  assert.deepEqual(screenRows(t), ['aaaaaa', '', '']);
  t.feed(`${csi}3;1Hcccccc${csi}2;3H${csi}1J`);
  assert.deepEqual(screenRows(t), ['', '', 'cccccc']);
  t.feed(`${csi}2J`);
  assert.deepEqual(screenRows(t), ['', '', '']);
});

test('erase uses the current background colour', () => {
  const t = term(6, 2);
  t.feed(`${csi}44m${csi}2J`);
  assert.equal(row(t, 0).bg[3], 4);
  assert.equal(row(t, 1).bg[5], 4);
  t.feed(`${csi}0m${csi}1;1H${csi}2X`);
  assert.equal(row(t, 0).bg[0], DEFAULT);
  assert.equal(row(t, 0).bg[2], 4);
});

test('insert, delete and erase characters', () => {
  const t = term(8, 2);
  t.feed('abcdef');
  t.feed(`${csi}1G${csi}2P`);
  assert.equal(screenRow(t, 0), 'cdef');
  t.feed(`${csi}2@`);
  assert.equal(screenRow(t, 0), '  cdef');
  t.feed(`${csi}3G${csi}2X`);
  assert.equal(screenRow(t, 0), '    ef');
  t.feed(`${csi}20P`);
  assert.equal(screenRow(t, 0), '');
});

test('insert mode shifts existing text', () => {
  const t = term(8, 2);
  t.feed(`abcd${csi}2G${csi}4hXY${csi}4l`);
  assert.equal(screenRow(t, 0), 'aXYbcd');
  t.feed('Z');
  assert.equal(screenRow(t, 0), 'aXYZcd');
});

test('repeat the last character', () => {
  const t = term(10, 2);
  t.feed(`ab${csi}3b`);
  assert.equal(screenRow(t, 0), 'abbbb');
  t.feed(`\r\n${csi}5b`); // nothing to repeat at column 0
  assert.equal(screenRow(t, 1), '');
});

/* ---------------------------------- SGR ---------------------------------- */

test('SGR colours and attributes', () => {
  const t = term(40, 2);
  t.feed(`${csi}1;4;31ma${csi}0mb${csi}91mc${csi}38;5;123md${csi}48;5;7me${csi}38;2;10;20;30mf`);
  const r = row(t, 0);
  assert.equal(r.flags[0] & (BOLD | UNDERLINE), BOLD | UNDERLINE);
  assert.equal(r.fg[0], 1);
  assert.equal(r.flags[1], 0);
  assert.equal(r.fg[1], DEFAULT);
  assert.equal(r.fg[2], 9);
  assert.equal(r.fg[3], 123);
  assert.equal(r.bg[4], 7);
  assert.equal(r.fg[5], TRUECOLOR | (10 << 16) | (20 << 8) | 30);
  t.feed(`${csi}39;49mg${csi}7mh${csi}27;2;3;9mi`);
  assert.equal(r.fg[6], DEFAULT);
  assert.equal(r.bg[6], DEFAULT);
  assert.equal(r.flags[7] & REVERSE, REVERSE);
  assert.equal(r.flags[8] & REVERSE, 0);
  assert.equal(r.flags[8] & (DIM | ITALIC | STRIKE), DIM | ITALIC | STRIKE);
  t.feed(`${csi}22;23;29mj${csi}mk`);
  assert.equal(r.flags[9] & (DIM | ITALIC | STRIKE), 0);
  assert.equal(r.flags[10], 0);
  assert.equal(r.bg[10], DEFAULT);
});

test('SGR colon sub-parameters and underline styles', () => {
  const t = term(20, 1);
  t.feed(`${csi}38:2::1:2:3ma${csi}38:2:4:5:6mb${csi}48:5:200mc${csi}4:3md${csi}0;38;2;9;8;7me`);
  const r = row(t, 0);
  assert.equal(r.fg[0], TRUECOLOR | (1 << 16) | (2 << 8) | 3);
  assert.equal(r.fg[1], TRUECOLOR | (4 << 16) | (5 << 8) | 6);
  assert.equal(r.bg[2], 200);
  assert.equal(r.flags[3] & UNDERLINE, UNDERLINE);
  assert.equal(r.fg[4], TRUECOLOR | (9 << 16) | (8 << 8) | 7);
  assert.equal(r.flags[4] & UNDERLINE, 0);
});

/* --------------------------- alt screen & modes -------------------------- */

test('the alternate screen saves and restores the primary', () => {
  const t = term(10, 3);
  const events = [];
  t.onAltScreen = (v) => events.push(v);
  t.feed(`main${csi}2;3H`);
  t.feed(`${csi}?1049h`);
  assert.equal(t.isAltScreen, true);
  assert.deepEqual(events, [true]);
  assert.deepEqual(cursor(t), [0, 0]);
  assert.deepEqual(screenRows(t), ['', '', '']);
  t.feed('vim!');
  assert.equal(screenRow(t, 0), 'vim!');
  assert.equal(t.totalRows(), 3);
  t.feed(`${csi}?1049l`);
  assert.equal(t.isAltScreen, false);
  assert.deepEqual(events, [true, false]);
  assert.equal(screenRow(t, 0), 'main');
  assert.deepEqual(cursor(t), [1, 2]);
  // 47 without save/restore: the cursor stays where the alt screen left it
  t.feed(`${csi}?47h${csi}3;5H${csi}?47l`);
  assert.equal(screenRow(t, 0), 'main');
});

test('the alt screen does not feed scrollback', () => {
  const t = term(10, 2, 50);
  t.feed(`${csi}?1049h`);
  for (let i = 1; i <= 10; i++) t.feed(`x${i}\r\n`);
  assert.equal(t.totalRows(), 2);
  t.feed(`${csi}?1049l`);
  assert.equal(t.totalRows(), 2);
});

test('origin mode confines the cursor and its reports', () => {
  const t = term(20, 6);
  const replies = [];
  t.onResponse = (s) => replies.push(s);
  t.feed(`${csi}3;5r${csi}?6h`);
  assert.deepEqual(cursor(t), [2, 0]);
  t.feed(`${csi}1;1H`);
  assert.deepEqual(cursor(t), [2, 0]);
  t.feed(`${csi}6n`);
  assert.equal(replies.at(-1), `${csi}1;1R`);
  t.feed(`${csi}99;1H`);
  assert.deepEqual(cursor(t), [4, 0]);
  t.feed(`${csi}?6l${csi}1;1H${csi}6n`);
  assert.deepEqual(cursor(t), [0, 0]);
  assert.equal(replies.at(-1), `${csi}1;1R`);
});

test('tab stops: HTS, TBC, CBT, CHT', () => {
  const t = term(40, 2);
  t.feed('\t');
  assert.deepEqual(cursor(t), [0, 8]);
  t.feed('\t\t');
  assert.deepEqual(cursor(t), [0, 24]);
  t.feed(`${csi}4G${esc}H${csi}1G\t`);
  assert.deepEqual(cursor(t), [0, 3]);
  t.feed(`${csi}Z`);
  assert.deepEqual(cursor(t), [0, 0]);
  t.feed(`${csi}2I`);
  assert.deepEqual(cursor(t), [0, 8]);
  t.feed(`${csi}g\t`); // clear the stop at column 8: the next stop is 16
  assert.deepEqual(cursor(t), [0, 16]);
  t.feed(`${csi}3g${csi}1G\t`); // no stops left: last column
  assert.deepEqual(cursor(t), [0, 39]);
  t.feed(`${csi}5Z`);
  assert.deepEqual(cursor(t), [0, 0]);
});

test('mode flags are tracked', () => {
  const t = term();
  assert.equal(t.applicationCursorKeys, false);
  assert.equal(t.bracketedPaste, false);
  assert.equal(t.mouseMode, MOUSE_OFF);
  t.feed(`${csi}?1h${csi}?2004h${csi}?1002h${csi}?1006h${csi}?1004h${esc}=${csi}?25l${csi}?12l`);
  assert.equal(t.applicationCursorKeys, true);
  assert.equal(t.bracketedPaste, true);
  assert.equal(t.mouseMode, MOUSE_BUTTON);
  assert.equal(t.mouseSgr, true);
  assert.equal(t.focusEvents, true);
  assert.equal(t.applicationKeypad, true);
  assert.equal(t.cursorVisible, false);
  assert.equal(t.cursorBlink, false);
  t.feed(`${csi}?1000h`);
  assert.equal(t.mouseMode, MOUSE_PRESS);
  t.feed(`${csi}?1003h${csi}?1003l${csi}?1l${csi}?2004l${csi}?25h${csi}?12h${esc}>`);
  assert.equal(t.mouseMode, MOUSE_OFF);
  assert.equal(t.applicationCursorKeys, false);
  assert.equal(t.bracketedPaste, false);
  assert.equal(t.cursorVisible, true);
  assert.equal(t.cursorBlink, true);
  assert.equal(t.applicationKeypad, false);
  t.feed(`${csi}?1;2004h`); // several modes in one sequence
  assert.equal(t.applicationCursorKeys && t.bracketedPaste, true);
});

test('cursor style via DECSCUSR', () => {
  const t = term();
  t.feed(`${csi}5 q`);
  assert.equal(t.cursorStyle, CURSOR_BAR);
  assert.equal(t.cursorBlink, true);
  t.feed(`${csi}4 q`);
  assert.equal(t.cursorStyle, CURSOR_UNDERLINE);
  assert.equal(t.cursorBlink, false);
  t.feed(`${csi}2 q`);
  assert.equal(t.cursorStyle, CURSOR_BLOCK);
  assert.equal(t.cursorBlink, false);
  t.feed(`${csi}0 q`);
  assert.equal(t.cursorStyle, CURSOR_BLOCK);
  assert.equal(t.cursorBlink, true);
});

/* --------------------------------- mouse --------------------------------- */

test('mouse reports in SGR and X10 encodings', () => {
  const t = term();
  assert.equal(t.mouseReport(MOUSE_EVENT_PRESS, 4, 2, 0), null);
  t.feed(`${csi}?1000h${csi}?1006h`);
  assert.equal(t.mouseReport(MOUSE_EVENT_PRESS, 4, 2, 0), `${csi}<0;5;3M`);
  assert.equal(t.mouseReport(MOUSE_EVENT_MOTION, 5, 2, 0), null, 'motion is not reported in mode 1000');
  assert.equal(t.mouseReport(MOUSE_EVENT_RELEASE, 4, 2, 0), `${csi}<0;5;3m`);
  assert.equal(t.mouseReport(MOUSE_EVENT_WHEEL_UP, 0, 0, 0), `${csi}<64;1;1M`);
  assert.equal(t.mouseReport(MOUSE_EVENT_WHEEL_DOWN, 0, 0, 0), `${csi}<65;1;1M`);
  assert.equal(t.mouseReport(MOUSE_EVENT_PRESS, 9, 9, 2), `${csi}<2;10;10M`);
  assert.equal(t.mouseReport(MOUSE_EVENT_RELEASE, 9, 9, 2, true, false, true), `${csi}<22;10;10m`);

  t.feed(`${csi}?1002h`); // button-motion: motion only while a button is held
  assert.equal(t.mouseReport(MOUSE_EVENT_MOTION, 5, 2, 0), null);
  t.mouseReport(MOUSE_EVENT_PRESS, 4, 2, 0);
  assert.equal(t.mouseReport(MOUSE_EVENT_MOTION, 5, 2, 0), `${csi}<32;6;3M`);
  t.mouseReport(MOUSE_EVENT_RELEASE, 5, 2, 0);
  assert.equal(t.mouseReport(MOUSE_EVENT_MOTION, 6, 2, 0), null);
  t.feed(`${csi}?1003h`);
  assert.equal(t.mouseReport(MOUSE_EVENT_MOTION, 6, 2, 0), `${csi}<35;7;3M`);

  t.feed(`${csi}?1006l${csi}?1000h`);
  assert.equal(t.mouseReport(MOUSE_EVENT_PRESS, 4, 2, 0),
    `${csi}M${String.fromCharCode(32)}${String.fromCharCode(37)}${String.fromCharCode(35)}`);
  assert.equal(t.mouseReport(MOUSE_EVENT_RELEASE, 4, 2, 0),
    `${csi}M${String.fromCharCode(35)}${String.fromCharCode(37)}${String.fromCharCode(35)}`);
  assert.equal(t.mouseReport(MOUSE_EVENT_WHEEL_UP, 400, 300, 0),
    `${csi}M${String.fromCharCode(96)}${String.fromCharCode(255)}${String.fromCharCode(255)}`);
  t.feed(`${csi}?1000l`);
  assert.equal(t.mouseReport(MOUSE_EVENT_PRESS, 0, 0, 0), null);
});

/* ------------------------------- responses ------------------------------- */

test('DSR and DA replies can be muted', () => {
  const t = term(80, 24);
  const replies = [];
  t.onResponse = (s) => replies.push(s);
  t.feed(`${csi}5;7H${csi}6n${csi}5n${csi}c${csi}>c${csi}18t${csi}?6n`);
  assert.deepEqual(replies, [
    `${csi}5;7R`, `${csi}0n`, `${csi}?62;22c`, `${csi}>41;0;0c`, `${csi}8;24;80t`, `${csi}?5;7R`,
  ]);
  t.muteResponses = true;
  t.feed(`${csi}6n${csi}c`);
  assert.equal(replies.length, 6);
  t.muteResponses = false;
  t.feed(`${csi}6n`);
  assert.equal(replies.length, 7);
});

test('OSC title and clipboard', () => {
  const t = term();
  const titles = [];
  const clips = [];
  t.onTitle = (s) => titles.push(s);
  t.onClipboard = (s) => clips.push(s);
  t.feed(`${esc}]2;My Title\x07`);
  assert.equal(t.title, 'My Title');
  t.feed(`${esc}]0;Other${esc}\\after`);
  assert.equal(t.title, 'Other');
  assert.deepEqual(titles, ['My Title', 'Other']);
  assert.equal(screenRow(t, 0), 'after');
  t.feed(`${esc}]52;c;aGVsbG8gd29ybGQ=\x07`);
  assert.deepEqual(clips, ['hello world']);
  t.feed(`${esc}]52;c;?\x07${esc}]52;;\x07${esc}]8;;http://x${esc}\\link${esc}]8;;${esc}\\`);
  assert.equal(clips.length, 1);
  assert.equal(screenRow(t, 0), 'afterlink');
  // DCS / APC strings are swallowed until ST
  t.feed(`${esc}Pq#0;2;0;0;0#0~~${esc}\\X${esc}_Gi=1${esc}\\Y`);
  assert.equal(screenRow(t, 0), 'afterlinkXY');
});

test('OSC 7 reports the working directory', () => {
  const t = term();
  const dirs = [];
  t.onWorkingDirectory = (d) => dirs.push(d);
  t.feed(`${esc}]7;file://host/srv/api\x07`);
  t.feed(`${esc}]7;file://host/C:/Users/me\x07`);
  t.feed(`${esc}]7;file://host/tmp/a%20b\x07`);
  t.feed(`${esc}]7;not-a-url\x07`);
  assert.deepEqual(dirs, ['/srv/api', 'C:/Users/me', '/tmp/a b']);
});

/* -------------------------------- unicode -------------------------------- */

test('wide characters occupy two cells', () => {
  const t = term(10, 2);
  t.feed('日本x');
  const r = row(t, 0);
  assert.equal(r.codes[0], cp('日'));
  assert.equal(r.flags[0] & WIDE, WIDE);
  assert.equal(r.codes[1], 0);
  assert.equal(r.flags[1] & CONTINUATION, CONTINUATION);
  assert.equal(r.codes[2], cp('本'));
  assert.equal(r.codes[3], 0);
  assert.equal(r.codes[4], cp('x'));
  assert.deepEqual(cursor(t), [0, 5]);
  assert.equal(screenRow(t, 0), '日本x');
  t.feed('\u{1F600}');
  assert.equal(r.codes[5], 0x1f600);
  assert.equal(r.codes[6], 0);
  assert.equal(screenRow(t, 0), '日本x\u{1F600}');
});

test('a wide character at the last column wraps first', () => {
  const t = term(5, 3);
  t.feed('abcd日');
  assert.equal(screenRow(t, 0), 'abcd');
  assert.equal(row(t, 0).wrapped, true);
  assert.equal(screenRow(t, 1), '日');
  assert.deepEqual(cursor(t), [1, 2]);
  t.feed('efg日');
  assert.equal(screenRow(t, 1), '日efg');
  assert.equal(screenRow(t, 2), '日');
});

test('overwriting half of a wide glyph blanks the other half', () => {
  const t = term(10, 2);
  t.feed(`日本${csi}2Gx`);
  const r = row(t, 0);
  assert.equal(r.codes[0], cp(' '));
  assert.equal(r.flags[0], 0);
  assert.equal(r.codes[1], cp('x'));
  assert.equal(r.codes[2], cp('本'));
  t.feed(`${csi}3GY`);
  assert.equal(r.codes[2], cp('Y'));
  assert.equal(r.codes[3], cp(' '));
  assert.equal(r.flags[3], 0);
  assert.equal(screenRow(t, 0), ' xY');
});

test('combining marks attach to the previous cell', () => {
  const t = term(10, 2);
  t.feed('e\u0301x');
  const r = row(t, 0);
  assert.equal(r.codes[0], cp('e'));
  assert.equal(r.combining(0), '\u0301');
  assert.equal(r.codes[1], cp('x'));
  assert.deepEqual(cursor(t), [0, 2]);
  assert.equal(screenRow(t, 0), 'e\u0301x');
  // A variation selector attaches to the wide cell (its left half)
  t.feed('\r\n\u{1F44D}\uFE0F');
  assert.equal(row(t, 1).combining(0), '\uFE0F');
  assert.equal(screenRow(t, 1), '\u{1F44D}\uFE0F');
  // A combining mark at column 0 with nothing before it is dropped
  const u = term(10, 1);
  u.feed('\u0301');
  assert.equal(u.rowText(0), '');
});

test('a surrogate pair split across feeds is joined', () => {
  const t = term(10, 1);
  t.feed('\uD83D');
  assert.deepEqual(cursor(t), [0, 0]);
  t.feed('\uDE00!');
  assert.equal(row(t, 0).codes[0], 0x1f600);
  assert.equal(row(t, 0).codes[2], cp('!'));
  // A lone high surrogate followed by text becomes U+FFFD
  const u = term(10, 1);
  u.feed('\uD83Dab');
  assert.equal(row(u, 0).codes[0], 0xfffd);
  assert.equal(screenRow(u, 0), '\uFFFDab');
  // A lone low surrogate too
  u.feed('\uDE00');
  assert.equal(row(u, 0).codes[3], 0xfffd);
});

test('DEC special graphics charset', () => {
  const t = term(20, 2);
  t.feed(`${esc}(0qjklmn${esc}(Bq`);
  assert.equal(screenRow(t, 0), '─┘┐┌└┼q');
  t.feed(`\r\n${esc})0\x0ex\x0fx`);
  assert.equal(screenRow(t, 1), '│x');
  t.feed(`${esc}(0a${esc}(B`);
  assert.equal(screenRow(t, 1), '│x▒');
});

/* --------------------------------- resize -------------------------------- */

test('resize reflows wrapped lines wider and narrower', () => {
  const t = term(10, 3);
  t.feed('abcdefghijklmno');
  assert.deepEqual(screenRows(t), ['abcdefghij', 'klmno', '']);
  assert.deepEqual(cursor(t), [1, 5]);

  t.resize(20, 3);
  assert.equal(t.cols, 20);
  assert.deepEqual(screenRows(t), ['abcdefghijklmno', '', '']);
  assert.equal(row(t, 0).wrapped, false);
  assert.deepEqual(cursor(t), [0, 15]);
  t.feed('p');
  assert.equal(screenRow(t, 0), 'abcdefghijklmnop');

  t.resize(8, 3);
  assert.deepEqual(screenRows(t), ['abcdefgh', 'ijklmnop', '']);
  assert.equal(row(t, 0).wrapped, true);
  // Exactly past a full row: the cursor stays on the last cell with a pending
  // wrap (xterm), rather than opening a blank row that would scroll content
  // away. The next glyph is what moves it down.
  assert.deepEqual(cursor(t), [1, 7]);
  t.feed('q');
  assert.equal(screenRow(t, 2), 'q');
  assert.equal(t.totalRows(), 3);
});

test('resize keeps history and brings it on screen when taller', () => {
  const t = term(10, 3, 100);
  for (let i = 1; i <= 5; i++) t.feed(`line${i}${i < 5 ? '\r\n' : ''}`);
  assert.equal(t.totalRows(), 5);
  assert.equal(t.rowText(0), 'line1');
  t.resize(12, 3);
  assert.equal(t.totalRows(), 5);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => t.rowText(i)), ['line1', 'line2', 'line3', 'line4', 'line5']);
  assert.deepEqual(cursor(t), [2, 5]);
  t.resize(12, 5);
  assert.equal(t.totalRows(), 5);
  assert.deepEqual(screenRows(t), ['line1', 'line2', 'line3', 'line4', 'line5']);
  assert.deepEqual(cursor(t), [4, 5]);
  t.resize(12, 2);
  assert.equal(screenRow(t, 1), 'line5');
  assert.deepEqual(cursor(t), [1, 5]);
  assert.equal(t.totalRows(), 5);
});

test('resize keeps the cursor after a trailing prompt space', () => {
  const t = term(10, 3);
  t.feed('user$ ');
  assert.deepEqual(cursor(t), [0, 6]);
  t.resize(20, 3);
  assert.deepEqual(cursor(t), [0, 6]);
  t.feed('ls');
  assert.equal(screenRow(t, 0), 'user$ ls');
});

test('resize on the alt screen clips alt and reflows the primary', () => {
  const t = term(10, 3);
  t.feed(`abcdefghijkl${csi}?1049h`);
  t.feed(`${csi}3;1Hbottom`);
  t.resize(6, 2);
  assert.equal(t.isAltScreen, true);
  assert.equal(t.totalRows(), 2);
  assert.deepEqual(cursor(t), [1, 5]);
  t.feed(`${csi}?1049l`);
  assert.equal(t.cols, 6);
  assert.deepEqual(screenRows(t), ['abcdef', 'ghijkl']);
  assert.equal(cursor(t)[0], 1);
});

test('resize extends tab stops', () => {
  const t = term(10, 2);
  t.resize(40, 2);
  t.feed('\t\t\t');
  assert.deepEqual(cursor(t), [0, 24]);
});

/* --------------------------------- resets -------------------------------- */

test('a soft reset keeps the screen but resets modes', () => {
  const t = term(10, 4);
  t.feed(`keep${csi}?6h${csi}4h${csi}?25l${csi}?1h${csi}2;3r${csi}1m`);
  t.feed(`${csi}!p`);
  assert.equal(screenRow(t, 0), 'keep');
  assert.equal(t.cursorVisible, true);
  assert.equal(t.applicationCursorKeys, false);
  t.feed(`${csi}4;1HX`); // origin mode off: row 4 reachable
  assert.equal(screenRow(t, 3), 'X');
  assert.equal(row(t, 3).flags[0], 0);
  t.feed(`${csi}1;1HY`); // insert mode off: overwrite
  assert.equal(screenRow(t, 0), 'Yeep');
});

test('a full reset clears everything', () => {
  const t = term(10, 2, 10);
  t.feed(`a\r\nb\r\nc${esc}]2;T\x07${csi}?2004h${csi}?1049h`);
  t.feed(`${esc}c`);
  assert.equal(t.isAltScreen, false);
  assert.equal(t.totalRows(), 2);
  assert.deepEqual(screenRows(t), ['', '']);
  assert.equal(t.title, '');
  assert.equal(t.bracketedPaste, false);
  assert.deepEqual(cursor(t), [0, 0]);
  t.feed('x');
  assert.equal(screenRow(t, 0), 'x');
});

test('clearing the screen keeps history', () => {
  const t = term(10, 2, 10);
  t.feed('a\r\nb\r\nc');
  t.clearScreen();
  assert.equal(t.totalRows(), 3);
  assert.equal(t.rowText(0), 'a');
  assert.deepEqual(screenRows(t), ['', '']);
  t.clearScrollback();
  assert.equal(t.totalRows(), 2);
});

test('DECALN fills the screen', () => {
  const t = term(4, 2);
  t.feed(`${esc}#8`);
  assert.deepEqual(screenRows(t), ['EEEE', 'EEEE']);
  assert.deepEqual(cursor(t), [0, 0]);
});

/* --------------------------------- readout ------------------------------- */

test('consumeDirty reports changes once', () => {
  const t = term();
  assert.equal(t.consumeDirty(), true);
  assert.equal(t.consumeDirty(), false);
  t.feed('x');
  assert.equal(t.consumeDirty(), true);
  assert.equal(t.consumeDirty(), false);
  t.rowText(0);
  assert.equal(t.consumeDirty(), false);
  t.resize(30, 10);
  assert.equal(t.consumeDirty(), true);
});

test('textBetween joins wrapped rows and breaks hard lines', () => {
  const t = term(5, 4);
  t.feed('abcdefg\r\nhi\r\n日本語');
  assert.equal(t.textBetween(0, 3, 1, 1), 'defg');
  assert.equal(t.textBetween(1, 0, 2, 4), 'fg\nhi');
  assert.equal(t.textBetween(0, 0, 3, 3), 'abcdefg\nhi\n日本');
  assert.equal(t.textBetween(3, 1, 3, 3), '日本', 'starting on a continuation cell selects the glyph');
  assert.equal(t.textBetween(0, 3, 0, 2), 'cd', 'reversed coordinates are normalised');
  assert.equal(t.renderText(), 'abcdefg\nhi\n日本語');
});

test('rowText trims only when asked', () => {
  const t = term(6, 1);
  t.feed('ab');
  assert.equal(t.rowText(0), 'ab');
  assert.equal(t.rowText(0, false), 'ab    ');
});

/* ------------------------------- robustness ------------------------------ */

test('unknown and malformed sequences never desynchronise', () => {
  const t = term(20, 3);
  t.feed(`${csi}?999h${csi}>1;2m${csi}=5l${csi}99999999999999999A` +
    `${csi}1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20;21;22;23;24;25;26;27;28;29;30;31;32;33;34;35mX`);
  assert.equal(screenRow(t, 0), 'X');
  t.feed(`${esc}Q${esc}%G${esc}#3Y`);
  assert.equal(screenRow(t, 0), 'XY');
  t.feed(`${csi}日Z`); // non-ASCII aborts a CSI and is printed
  assert.equal(screenRow(t, 0), 'XY日Z');
  t.feed(`${esc}]2;unterminated\x18`);
  t.feed('more'); // CAN aborts
  assert.equal(screenRow(t, 0).startsWith('XY日Z'), true);
});

test('fuzzed input never throws and keeps the cursor in bounds', () => {
  // A small deterministic PRNG so a failure is reproducible.
  let seed = 4242;
  const rnd = (n) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const pieces = [csi, esc, `${esc}]`, `${esc}(`, `${esc}#`, '\x07', '\r', '\n', '\t', '\b', '?', ';', ':',
    'm', 'H', 'J', 'K', 'r', 'h', 'l', '@', 'P', 'X', 'L', 'M', 'S', 'T', 'b', 'n', 'c', 't', 'q', ' ', '!',
    '\x0e', '\x0f', '1049', '2004', '1006', '1002', '38;5;', '38:2:', '48;2;1;2;', '日', '\u{1F600}',
    '\uD83D', '\uDE00', 'e\u0301', 'abc', ' ', '\x18', '\\', `${esc}\\`, '%', '(0', '#8', '7', '8',
    'D', 'E', 'M', '=', '>'];
  const t = term(12, 6, 30);
  for (let i = 0; i < 4000; i++) {
    let s = '';
    const parts = 1 + rnd(5);
    for (let k = 0; k < parts; k++) {
      if (rnd(3) === 0) {
        const point = rnd(0x10ffff);
        s += String.fromCodePoint(point >= 0xd800 && point <= 0xdfff ? 0x78 : point);
      } else {
        s += pieces[rnd(pieces.length)];
      }
      if (rnd(4) === 0) s += String(rnd(300));
    }
    t.feed(s);
    if (rnd(50) === 0) t.resize(1 + rnd(29), 1 + rnd(9));
    assert.ok(t.cursorRow >= 0 && t.cursorRow < t.rows);
    assert.ok(t.cursorCol >= 0 && t.cursorCol < t.cols);
    assert.ok(t.totalRows() >= t.rows);
    t.rowText(t.totalRows() - 1);
    t.mouseReport(MOUSE_EVENT_PRESS, 1, 1, 0);
  }
  t.renderText();
  t.textBetween(0, 0, t.totalRows() - 1, t.cols - 1);
});

test('a large mixed feed stays fast', () => {
  const t = term(120, 40, 2000);
  let chunk = '';
  for (let i = 0; i < 50; i++) {
    chunk += `${csi}32mok ${csi}0m${csi}1;34mline${i}${csi}0m 日本語 e\u0301 text text text text text\r\n`;
  }
  const start = process.hrtime.bigint();
  let total = 0;
  while (total < 1_000_000) { t.feed(chunk); total += chunk.length; }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 8000, `1 MiB fed in ${ms.toFixed(0)}ms`);
  assert.equal(t.totalRows(), 2000 + 40);
});
