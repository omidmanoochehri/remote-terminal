/**
 * Links in terminal output — the same finder as the Android app's `Links.kt`.
 *
 * A URL printed by a program is often longer than the terminal is wide, so
 * links are found on a *logical* line (a run of rows joined by soft wraps) and
 * then mapped back to the cells they cover. The rules for where a link ends
 * are the usual ones: trailing punctuation belongs to the sentence, and a
 * closing bracket belongs to the link only when the link opened it.
 */

import { CONTINUATION } from './attrs.js';

const URL_RE = /(?:https?|ftp|file):\/\/[^\s<>"'`]+/g;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
const PAIRS = { ')': '(', ']': '[', '}': '{' };

function count(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Every link in [text]: `{ start, end, url }` with `end` exclusive, in UTF-16
 * indices.
 */
export function findLinks(text) {
  const out = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    for (;;) {
      const last = url[url.length - 1];
      if (TRAILING.has(last)) { url = url.slice(0, -1); continue; }
      const open = PAIRS[last];
      if (open && count(url, open) < count(url, last)) { url = url.slice(0, -1); continue; }
      break;
    }
    // "https://" on its own is not a link.
    if (/^[a-z]+:\/\/$/i.test(url)) continue;
    out.push({ start: m.index, end: m.index + url.length, url });
  }
  return out;
}

/** Only these open in a browser; a `file:` link names a file on the far machine. */
export function isOpenable(url) {
  return /^(https?|ftp):\/\//i.test(url);
}

/**
 * The logical line through absolute row [absRow]: its text, and for every
 * UTF-16 index of that text the `[row, col]` cell it came from.
 */
export function logicalLine(emulator, absRow) {
  const total = emulator.totalRows();
  if (total === 0) return { text: '', cells: [], firstRow: absRow, lastRow: absRow };
  let first = Math.max(0, Math.min(absRow, total - 1));
  while (first > 0 && emulator.rowAt(first - 1).wrapped) first--;
  let last = first;
  while (last < total - 1 && emulator.rowAt(last).wrapped) last++;
  if (absRow > last) {
    // absRow was clamped past the end; nothing to find.
    return { text: '', cells: [], firstRow: absRow, lastRow: absRow };
  }
  const parts = [];
  const cells = [];
  for (let r = first; r <= last; r++) {
    const row = emulator.rowAt(r);
    let end = row.cols;
    if (!row.wrapped) end = row.contentEnd();
    for (let c = 0; c < end; c++) {
      const code = row.codes[c];
      if (code === 0 || (row.flags[c] & CONTINUATION) !== 0) continue;
      const ch = String.fromCodePoint(code);
      for (let i = 0; i < ch.length; i++) cells.push([r, c]);
      parts.push(ch);
      const marks = row.combining(c);
      if (marks) {
        for (let i = 0; i < marks.length; i++) cells.push([r, c]);
        parts.push(marks);
      }
    }
  }
  return { text: parts.join(''), cells, firstRow: first, lastRow: last };
}

/**
 * The link covering cell ([absRow], [col]), with the per-row column spans it
 * occupies (`spans: [{ row, startCol, endCol }]`, endCol inclusive), or null.
 */
export function linkAt(emulator, absRow, col) {
  const line = logicalLine(emulator, absRow);
  if (!line.text) return null;
  for (const link of findLinks(line.text)) {
    const spans = spansOf(line.cells, link.start, link.end);
    if (spans.some((s) => s.row === absRow && col >= s.startCol && col <= s.endCol)) {
      return { url: link.url, spans };
    }
  }
  return null;
}

function spansOf(cells, start, end) {
  const spans = [];
  for (let i = start; i < end; i++) {
    const [row, col] = cells[i];
    const lastSpan = spans[spans.length - 1];
    if (lastSpan && lastSpan.row === row) lastSpan.endCol = Math.max(lastSpan.endCol, col);
    else spans.push({ row, startCol: col, endCol: col });
  }
  return spans;
}
