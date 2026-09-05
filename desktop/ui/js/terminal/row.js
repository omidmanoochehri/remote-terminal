/**
 * One terminal row backed by parallel typed arrays (no per-cell objects).
 *
 * `codes[col]` is the code point shown in the cell (' ' for blank, 0 for the
 * right half of a wide glyph whose left half carries `WIDE`). Combining marks
 * are rare, so they live in a lazily created map keyed by column.
 *
 * A port of `Row.kt`.
 */

import { DEFAULT, UNDERLINE, REVERSE, STRIKE } from './attrs.js';

export const BLANK = 0x20;

export class Row {
  constructor(cols) {
    this.cols = cols;
    this.codes = new Int32Array(cols).fill(BLANK);
    this.fg = new Int32Array(cols).fill(DEFAULT);
    this.bg = new Int32Array(cols).fill(DEFAULT);
    this.flags = new Int32Array(cols);
    /** This row continues on the next one (soft wrap); used by reflow and selection. */
    this.wrapped = false;
    this.combiningMap = null;
  }

  combining(col) {
    return this.combiningMap ? this.combiningMap.get(col) ?? null : null;
  }

  setCombining(col, marks) {
    if (marks == null) {
      if (this.combiningMap) this.combiningMap.delete(col);
      return;
    }
    if (!this.combiningMap) this.combiningMap = new Map();
    this.combiningMap.set(col, marks);
  }

  appendCombining(col, mark) {
    if (!this.combiningMap) this.combiningMap = new Map();
    const prev = this.combiningMap.get(col);
    this.combiningMap.set(col, prev == null ? mark : prev.length >= 16 ? prev : prev + mark);
  }

  hasCombining() {
    return !!this.combiningMap && this.combiningMap.size > 0;
  }

  set(col, code, fgc, bgc, fl) {
    this.codes[col] = code;
    this.fg[col] = fgc;
    this.bg[col] = bgc;
    this.flags[col] = fl;
    if (this.combiningMap) this.combiningMap.delete(col);
  }

  /** Blank one cell with the given colours (background colour erase). */
  clear(col, fgc, bgc) {
    this.codes[col] = BLANK;
    this.fg[col] = fgc;
    this.bg[col] = bgc;
    this.flags[col] = 0;
    if (this.combiningMap) this.combiningMap.delete(col);
  }

  /** Blank [from, to) with the given colours. */
  clearRange(from, to, fgc, bgc) {
    const a = Math.max(0, from);
    const b = Math.min(this.cols, to);
    for (let c = a; c < b; c++) {
      this.codes[c] = BLANK;
      this.fg[c] = fgc;
      this.bg[c] = bgc;
      this.flags[c] = 0;
    }
    if (this.combiningMap && this.combiningMap.size > 0) {
      for (let c = a; c < b; c++) this.combiningMap.delete(c);
    }
  }

  fill(fgc, bgc) {
    this.clearRange(0, this.cols, fgc, bgc);
    this.wrapped = false;
  }

  /** Copy cells [src, src+count) to [dst, dst+count) within this row (overlap-safe). */
  moveCells(src, dst, count) {
    if (count <= 0 || src === dst) return;
    this.codes.copyWithin(dst, src, src + count);
    this.fg.copyWithin(dst, src, src + count);
    this.bg.copyWithin(dst, src, src + count);
    this.flags.copyWithin(dst, src, src + count);
    const m = this.combiningMap;
    if (m && m.size > 0) {
      const moved = new Map();
      for (const [k, v] of m) {
        if (k >= src && k < src + count) moved.set(k - src + dst, v);
        else if (!(k >= dst && k < dst + count)) moved.set(k, v);
      }
      this.combiningMap = moved;
    }
  }

  copyFrom(other) {
    const n = Math.min(this.cols, other.cols);
    this.codes.set(other.codes.subarray(0, n), 0);
    this.fg.set(other.fg.subarray(0, n), 0);
    this.bg.set(other.bg.subarray(0, n), 0);
    this.flags.set(other.flags.subarray(0, n), 0);
    if (n < this.cols) this.clearRange(n, this.cols, DEFAULT, DEFAULT);
    this.wrapped = other.wrapped;
    this.combiningMap = null;
    const om = other.combiningMap;
    if (om && om.size > 0) for (const [k, v] of om) if (k < n) this.setCombining(k, v);
  }

  /** True when the cell is visually empty (blank glyph, default background, no attributes). */
  isBlankCell(col) {
    return (
      this.codes[col] === BLANK &&
      this.bg[col] === DEFAULT &&
      (this.flags[col] & (UNDERLINE | REVERSE | STRIKE)) === 0 &&
      this.combining(col) == null
    );
  }

  isBlank() {
    for (let c = 0; c < this.cols; c++) if (!this.isBlankCell(c)) return false;
    return true;
  }

  /** Index after the last non-blank cell (0 when the row is blank). */
  contentEnd() {
    let end = this.cols;
    while (end > 0 && this.isBlankCell(end - 1)) end--;
    return end;
  }

  /** Row text; continuation cells are skipped and combining marks are included. */
  text(trimEnd = true) {
    return this.textRange(0, this.cols, trimEnd);
  }

  textRange(from, to, trimEnd) {
    const out = [];
    this.appendText(out, from, to, trimEnd);
    return out.join('');
  }

  /** Append the row's text into [out]; `out` is an array of string pieces. */
  appendText(out, from, to, trimEnd) {
    const a = Math.max(0, from);
    let b = Math.min(this.cols, to);
    if (trimEnd) {
      while (b > a && this.codes[b - 1] === BLANK && this.combining(b - 1) == null) b--;
    }
    for (let c = a; c < b; c++) {
      const code = this.codes[c];
      if (code === 0) continue; // continuation of a wide glyph
      out.push(String.fromCodePoint(code));
      const marks = this.combining(c);
      if (marks) out.push(marks);
    }
  }
}
