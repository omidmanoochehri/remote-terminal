/**
 * Renders a `TerminalEmulator` on a canvas and turns the mouse and keyboard
 * into terminal input — the desktop counterpart of the Android `TerminalView`.
 *
 *  - Drawing: only visible rows, cells batched into same-style runs; wide
 *    glyphs drawn per cell; box/block drawing characters drawn as primitives so
 *    TUI borders align whatever font supplies the glyph.
 *  - Scrolling: wheel through scrollback, "follow" mode pinned to the newest
 *    output, a count of rows that arrived while scrolled up.
 *  - Selection: drag to select, double-click a word, triple-click a line,
 *    Ctrl+C / Ctrl+Shift+C to copy, right-click for the actions.
 *  - Search: highlights matches and jumps between them.
 *  - Mouse reporting: when the application enabled it, clicks, drags and the
 *    wheel are reported instead of scrolling locally.
 *  - Input: the hardware keyboard (with IME composition through a hidden text
 *    area) and the shared `ModifierState` for the on-screen Ctrl/Alt/Shift —
 *    all encoded by `KeyEncoder`.
 */

import { TerminalEmulator } from './emulator.js';
import { REMOTE } from './theme.js';
import { ModifierState } from './modifiers.js';
import * as Keys from './keyencoder.js';
import {
  DEFAULT, TRUECOLOR, BOLD, DIM, ITALIC, UNDERLINE, REVERSE, HIDDEN, STRIKE, WIDE, CONTINUATION,
  CURSOR_BLOCK, CURSOR_UNDERLINE, CURSOR_BAR,
  MOUSE_OFF, MOUSE_EVENT_PRESS, MOUSE_EVENT_RELEASE, MOUSE_EVENT_MOTION,
  MOUSE_EVENT_WHEEL_UP, MOUSE_EVENT_WHEEL_DOWN,
} from './attrs.js';

/** Glyphs a proportional font renders at clearly different widths. */
const WIDTH_SAMPLE = ['i', 'l', 'W', '@', '1', ' ', 'm'];
const BLINK_MS = 530;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class TerminalView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    this.emulator = new TerminalEmulator();
    this.theme = REMOTE;
    this.modifiers = new ModifierState();

    /* Host callbacks, mirroring the Android view's. */
    this.onInput = null;
    this.onGeometryChanged = null;
    this.onFollowChanged = null;
    this.onFontSizeChanged = null;
    this.onCopy = null;
    this.onPasteRequest = null;
    this.onSwitchTab = null;
    this.onSearchResult = null;
    this.onContextMenu = null;

    /** Cursor style from settings; a DECSCUSR request from the application wins. */
    this.cursorStyleSetting = CURSOR_BLOCK;
    this.blinkEnabled = true;
    /** In the alternate screen without mouse reporting, the wheel sends arrow keys. */
    this.arrowsInAltScreen = true;
    /** Whether Shift + wheel switches tabs (a setting; off while selecting). */
    this.wheelSwitchTabs = true;

    this.fontSize = 13;
    this.lineSpacing = 1.0;
    this.fontFamily = "'RT Mono', ui-monospace, Consolas, monospace";
    this.charW = 8;
    this.lineH = 16;
    this.baseline = 12;
    this.dpr = window.devicePixelRatio || 1;

    this.topRow = 0;
    this.follow = true;
    this.lastReportedNew = -1;
    this.cursorOn = true;
    this.hasFocus = false;

    this.selection = null;      // { startRow, startCol, endRow, endCol }
    this.selecting = false;
    this.selectMode = 'char';   // 'char' | 'word' | 'line'
    this.matches = [];
    this.currentMatch = -1;
    this.searchQuery = '';

    this.frameQueued = false;
    this.composing = '';

    this.buildInput();
    this.applyFont();
    this.wireEvents();

    this.blinkTimer = setInterval(() => {
      if (!this.blinkEnabled || !this.hasFocus) {
        if (!this.cursorOn) { this.cursorOn = true; this.invalidate(); }
        return;
      }
      this.cursorOn = !this.cursorOn;
      this.invalidate();
    }, BLINK_MS);

    this.resizeObserver = new ResizeObserver(() => this.recomputeGeometry());
    this.resizeObserver.observe(canvas);
  }

  destroy() {
    clearInterval(this.blinkTimer);
    this.resizeObserver.disconnect();
    this.input.remove();
  }

  /* -------------------------------- input --------------------------------- */

  /**
   * A hidden, focusable text area receives keys. It exists so the IME has
   * somewhere to compose (Chinese, Japanese, Korean, dead keys) — a canvas
   * cannot host a composition on its own.
   */
  buildInput() {
    const input = document.createElement('textarea');
    input.className = 'terminal-input';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'Terminal input');
    Object.assign(input.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
      padding: '0',
      border: 'none',
      outline: 'none',
      opacity: '0',
      resize: 'none',
      zIndex: '1',
    });
    this.input = input;
    this.canvas.parentElement?.append(input);
  }

  focus() { this.input.focus({ preventScroll: true }); }

  /* ------------------------------ emulator -------------------------------- */

  setEmulator(emulator) {
    if (this.emulator === emulator) return;
    this.emulator = emulator;
    this.selection = null;
    this.clearSearch();
    this.follow = true;
    this.recomputeGeometry();
    this.scrollToBottom();
  }

  setTheme(theme) {
    this.theme = theme;
    this.invalidate();
  }

  /* -------------------------------- font ---------------------------------- */

  setFontSize(size, notify = true) {
    const clamped = clamp(size, 8, 32);
    if (Math.abs(clamped - this.fontSize) < 0.01) return;
    this.fontSize = clamped;
    this.applyFont();
    this.recomputeGeometry();
    this.invalidate();
    if (notify) this.onFontSizeChanged?.(clamped);
  }

  setLineSpacing(mult) {
    this.lineSpacing = clamp(mult, 0.8, 2);
    this.applyFont();
    this.recomputeGeometry();
    this.invalidate();
  }

  /**
   * The bundled face, or the platform monospace when the user asked for it.
   * Either way the cell width is measured from the face we actually draw with,
   * so a line can never come up short of the right edge.
   */
  setFontFamily(preferSystem) {
    const wanted = preferSystem
      ? "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace"
      : "'RT Mono', ui-monospace, Consolas, monospace";
    if (wanted === this.fontFamily) return;
    this.fontFamily = wanted;
    this.applyFont();
    this.recomputeGeometry();
    this.invalidate();
  }

  applyFont() {
    const ctx = this.ctx;
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    let width = ctx.measureText('M').width;
    for (const s of WIDTH_SAMPLE) width = Math.max(width, ctx.measureText(s).width);
    this.charW = Math.max(1, width);
    // A cell tall enough for ascenders and descenders, then the spacing multiplier.
    const metrics = ctx.measureText('Mgy');
    const ascent = metrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = metrics.actualBoundingBoxDescent || this.fontSize * 0.25;
    const natural = Math.ceil((ascent + descent) * 1.28);
    this.lineH = Math.max(1, natural * this.lineSpacing);
    this.baseline = ascent + (this.lineH - (ascent + descent)) / 2;
    this.strokeWidth = Math.max(1, this.fontSize / 12);
  }

  /* ------------------------------ geometry -------------------------------- */

  get cols() { return Math.max(2, Math.floor(this.canvas.clientWidth / this.charW)); }
  get rows() { return Math.max(2, Math.floor(this.canvas.clientHeight / this.lineH)); }

  recomputeGeometry() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.dpr = window.devicePixelRatio || 1;
    const pw = Math.round(width * this.dpr);
    const ph = Math.round(height * this.dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.applyFont();
    }
    const c = this.cols;
    const r = this.rows;
    if (c !== this.emulator.cols || r !== this.emulator.rows) this.onGeometryChanged?.(c, r);
    this.clampScroll();
    this.invalidate();
  }

  /** Ask the host to (re)send geometry, e.g. after the emulator was swapped. */
  pushGeometry() {
    if (this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) {
      this.onGeometryChanged?.(this.cols, this.rows);
    }
  }

  /* ------------------------------ scrolling ------------------------------- */

  maxTop() { return Math.max(0, this.emulator.totalRows() - this.rows); }

  clampScroll() {
    const m = this.maxTop();
    this.topRow = this.follow ? m : clamp(this.topRow, 0, m);
  }

  /** Call after feeding output: keeps following the end and refreshes the count. */
  notifyUpdated() {
    if (this.follow) this.topRow = this.maxTop();
    else if (this.topRow > this.maxTop()) this.topRow = this.maxTop();
    this.reportFollow();
    this.invalidate();
  }

  reportFollow() {
    const newRows = this.follow ? 0 : Math.max(0, this.maxTop() - this.topRow);
    if (newRows !== this.lastReportedNew) {
      this.lastReportedNew = newRows;
      this.onFollowChanged?.(this.follow, newRows);
    }
  }

  scrollToBottom() {
    this.follow = true;
    this.topRow = this.maxTop();
    this.reportFollow();
    this.invalidate();
  }

  scrollByRows(delta) {
    if (delta === 0) return;
    const m = this.maxTop();
    this.topRow = clamp(this.topRow + delta, 0, m);
    this.follow = this.topRow >= m;
    this.reportFollow();
    this.invalidate();
  }

  scrollToRow(absRow) {
    const m = this.maxTop();
    this.topRow = clamp(absRow - Math.floor(this.rows / 2), 0, m);
    this.follow = this.topRow >= m;
    this.reportFollow();
    this.invalidate();
  }

  /* ------------------------------- drawing -------------------------------- */

  invalidate() {
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      this.draw();
    });
  }

  draw() {
    const ctx = this.ctx;
    const t = this.theme;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = t.background;
    ctx.fillRect(0, 0, width, height);

    const em = this.emulator;
    const total = em.totalRows();
    const visible = this.rows;
    const cursorAbs = em.cursorAbsRow();
    const showCursor = em.cursorVisible && (this.cursorOn || !this.blinkEnabled);
    const sel = this.normalizedSelection();

    let y = 0;
    for (let r = 0; r < visible; r++) {
      const abs = this.topRow + r;
      if (abs >= total) break;
      const row = em.rowAt(abs);
      this.drawRow(row, y);
      if (sel && abs >= sel[0] && abs <= sel[2]) this.drawSelectionRow(abs, y, sel, row.cols);
      if (this.matches.length > 0) this.drawSearchRow(abs, y);
      if (showCursor && abs === cursorAbs) this.drawCursor(row, y);
      y += this.lineH;
    }
  }

  drawRow(row, y) {
    const ctx = this.ctx;
    const n = row.cols;
    const { codes, fg: fgs, bg: bgs, flags } = row;
    let x = 0;
    while (x < n) {
      const fl = flags[x];
      if ((fl & CONTINUATION) !== 0) { x++; continue; }
      const fg = fgs[x];
      const bg = bgs[x];
      const code = codes[x];
      // Wide glyphs and box-drawing characters are drawn one cell at a time.
      if ((fl & WIDE) !== 0 || isBoxDrawing(code)) {
        const w = (fl & WIDE) !== 0 ? 2 : 1;
        this.drawCell(row, x, w, y);
        x += w;
        continue;
      }
      // Batch a run of narrow cells with identical style.
      const start = x;
      let text = '';
      while (
        x < n &&
        flags[x] === fl && fgs[x] === fg && bgs[x] === bg &&
        !isBoxDrawing(codes[x]) && row.combining(x) == null &&
        (flags[x] & WIDE) === 0
      ) {
        text += String.fromCodePoint(codes[x] || 0x20);
        x++;
      }
      if (x === start) { this.drawCell(row, x, 1, y); x++; continue; }
      this.paintRun(ctx, text, start, x - start, y, fg, bg, fl);
    }
  }

  styleColors(fgIn, bgIn, fl) {
    let fg = fgIn;
    const bg = bgIn;
    if ((fl & BOLD) !== 0 && fg >= 0 && fg <= 7) fg += 8; // bold brightens the base colours (xterm)
    let fgc = this.resolve(fg, true);
    let bgc = this.resolve(bg, false);
    if ((fl & REVERSE) !== 0) { const tmp = fgc; fgc = bgc; bgc = tmp; }
    if ((fl & DIM) !== 0) fgc = blend(fgc, bgc, 0.55);
    return [fgc, bgc];
  }

  paintRun(ctx, text, startCol, cells, y, fg, bg, fl) {
    const [fgc, bgc] = this.styleColors(fg, bg, fl);
    const x0 = startCol * this.charW;
    const x1 = (startCol + cells) * this.charW;
    if (bgc !== this.theme.background) {
      ctx.fillStyle = bgc;
      ctx.fillRect(x0, y, x1 - x0, this.lineH);
    }
    if ((fl & HIDDEN) !== 0) return;
    this.applyTextStyle(fgc, fl);
    ctx.fillText(text, x0, y + this.baseline);
    this.drawTextDecoration(fl, x0, x1, y, fgc);
  }

  applyTextStyle(color, fl) {
    const ctx = this.ctx;
    const weight = (fl & BOLD) !== 0 ? '700' : '400';
    const style = (fl & ITALIC) !== 0 ? 'italic ' : '';
    ctx.font = `${style}${weight} ${this.fontSize}px ${this.fontFamily}`;
    ctx.fillStyle = color;
  }

  /** Underline and strike-through are drawn, not styled: canvas has no text decoration. */
  drawTextDecoration(fl, x0, x1, y, color) {
    if ((fl & (UNDERLINE | STRIKE)) === 0) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, this.fontSize / 14);
    ctx.beginPath();
    if ((fl & UNDERLINE) !== 0) {
      const uy = Math.round(y + this.baseline + this.fontSize * 0.16) + 0.5;
      ctx.moveTo(x0, uy);
      ctx.lineTo(x1, uy);
    }
    if ((fl & STRIKE) !== 0) {
      const sy = Math.round(y + this.baseline - this.fontSize * 0.3) + 0.5;
      ctx.moveTo(x0, sy);
      ctx.lineTo(x1, sy);
    }
    ctx.stroke();
  }

  drawCell(row, col, cells, y) {
    const ctx = this.ctx;
    const fl = row.flags[col];
    const [fgc, bgc] = this.styleColors(row.fg[col], row.bg[col], fl);
    const x0 = col * this.charW;
    const x1 = x0 + cells * this.charW;
    if (bgc !== this.theme.background) {
      ctx.fillStyle = bgc;
      ctx.fillRect(x0, y, x1 - x0, this.lineH);
    }
    if ((fl & HIDDEN) !== 0) return;
    const code = row.codes[col];
    if (isBoxDrawing(code) && this.drawBox(code, x0, y, this.charW, this.lineH, fgc)) return;
    this.applyTextStyle(fgc, fl);
    let text = String.fromCodePoint(code || 0x20);
    const marks = row.combining(col);
    if (marks) text += marks;
    ctx.fillText(text, x0, y + this.baseline);
    this.drawTextDecoration(fl, x0, x1, y, fgc);
  }

  drawCursor(row, y) {
    const ctx = this.ctx;
    const em = this.emulator;
    const col = clamp(em.cursorCol, 0, row.cols - 1);
    const wide = (row.flags[col] & WIDE) !== 0;
    const x0 = col * this.charW;
    const x1 = x0 + (wide ? 2 : 1) * this.charW;
    const style = em.cursorStyle !== CURSOR_BLOCK ? em.cursorStyle : this.cursorStyleSetting;
    ctx.fillStyle = this.theme.cursor;
    if (!this.hasFocus) {
      // Unfocused: an outline, so it is clear where the caret is without
      // pretending the window has the keyboard.
      ctx.strokeStyle = this.theme.cursor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, this.lineH - 1);
      return;
    }
    if (style === CURSOR_UNDERLINE) {
      const h = Math.max(2, this.lineH / 8);
      ctx.fillRect(x0, y + this.lineH - h, x1 - x0, h);
      return;
    }
    if (style === CURSOR_BAR) {
      ctx.fillRect(x0, y, Math.max(2, this.charW / 6), this.lineH);
      return;
    }
    ctx.fillRect(x0, y, x1 - x0, this.lineH);
    const code = row.codes[col];
    if (code !== 0 && code !== 0x20 && !isBoxDrawing(code)) {
      this.applyTextStyle(this.theme.background, row.flags[col]);
      ctx.fillText(String.fromCodePoint(code), x0, y + this.baseline);
    }
  }

  drawSelectionRow(abs, y, sel, cols) {
    const from = abs === sel[0] ? sel[1] : 0;
    const to = abs === sel[2] ? sel[3] : cols - 1;
    if (to < from) return;
    this.ctx.fillStyle = this.theme.selection;
    this.ctx.fillRect(from * this.charW, y, (to - from + 1) * this.charW, this.lineH);
  }

  drawSearchRow(abs, y) {
    const ctx = this.ctx;
    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      if (m.row !== abs) continue;
      ctx.fillStyle = i === this.currentMatch ? 'rgba(255, 179, 0, 0.67)' : 'rgba(255, 179, 0, 0.4)';
      ctx.fillRect(m.startCol * this.charW, y, (m.endCol - m.startCol + 1) * this.charW, this.lineH);
    }
  }

  resolve(code, isFg) {
    const t = this.theme;
    if (code === DEFAULT) return isFg ? t.foreground : t.background;
    if ((code & TRUECOLOR) !== 0) {
      const v = code & 0xffffff;
      return `#${v.toString(16).padStart(6, '0')}`;
    }
    if (code >= 0 && code <= 255) return t.palette[code];
    return isFg ? t.foreground : t.background;
  }

  /* ---------------------------- box drawing ------------------------------- */

  /**
   * Draw common box/block characters with primitives so borders line up
   * regardless of which font supplies the glyph. Returns false for shapes we
   * leave to the font.
   */
  drawBox(code, x, y, w, h, color) {
    const ctx = this.ctx;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = this.strokeWidth;
    ctx.lineCap = 'butt';

    const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    const hLeft = () => line(x, cy, cx, cy);
    const hRight = () => line(cx, cy, x + w, cy);
    const vUp = () => line(cx, y, cx, cy);
    const vDown = () => line(cx, cy, cx, y + h);
    const rect = (a, b, c, d) => ctx.fillRect(a, b, c - a, d - b);

    const between = (lo, hi) => code >= lo && code <= hi;

    if ([0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2550].includes(code)) { line(x, cy, x + w, cy); return true; }
    if ([0x2502, 0x2503, 0x2506, 0x2507, 0x250a, 0x250b, 0x254e, 0x254f, 0x2551].includes(code)) { line(cx, y, cx, y + h); return true; }
    if ([0x250c, 0x250d, 0x250e, 0x250f, 0x2552, 0x2553, 0x2554, 0x256d].includes(code)) { hRight(); vDown(); return true; }
    if ([0x2510, 0x2511, 0x2512, 0x2513, 0x2555, 0x2556, 0x2557, 0x256e].includes(code)) { hLeft(); vDown(); return true; }
    if ([0x2514, 0x2515, 0x2516, 0x2517, 0x2558, 0x2559, 0x255a, 0x2570].includes(code)) { hRight(); vUp(); return true; }
    if ([0x2518, 0x2519, 0x251a, 0x251b, 0x255b, 0x255c, 0x255d, 0x256f].includes(code)) { hLeft(); vUp(); return true; }
    if (between(0x251c, 0x2523) || [0x255e, 0x255f, 0x2560].includes(code)) { vUp(); vDown(); hRight(); return true; }
    if (between(0x2524, 0x252b) || [0x2561, 0x2562, 0x2563].includes(code)) { vUp(); vDown(); hLeft(); return true; }
    if (between(0x252c, 0x2533) || [0x2564, 0x2565, 0x2566].includes(code)) { hLeft(); hRight(); vDown(); return true; }
    if (between(0x2534, 0x253b) || [0x2567, 0x2568, 0x2569].includes(code)) { hLeft(); hRight(); vUp(); return true; }
    if (between(0x253c, 0x254b) || [0x256a, 0x256b, 0x256c].includes(code)) { hLeft(); hRight(); vUp(); vDown(); return true; }
    if (code === 0x2574) { hLeft(); return true; }
    if (code === 0x2575) { vUp(); return true; }
    if (code === 0x2576) { hRight(); return true; }
    if (code === 0x2577) { vDown(); return true; }
    if (code === 0x2588) { rect(x, y, x + w, y + h); return true; }
    if (code === 0x2580) { rect(x, y, x + w, cy); return true; }
    if (code === 0x2584) { rect(x, cy, x + w, y + h); return true; }
    if (code === 0x258c) { rect(x, y, cx, y + h); return true; }
    if (code === 0x2590) { rect(cx, y, x + w, y + h); return true; }
    if (between(0x2581, 0x2583) || between(0x2585, 0x2587)) {
      const frac = (code - 0x2580) / 8;
      rect(x, y + h * (1 - frac), x + w, y + h);
      return true;
    }
    if (between(0x2589, 0x258b) || between(0x258d, 0x258f)) {
      const frac = (0x2590 - code) / 8;
      rect(x, y, x + w * frac, y + h);
      return true;
    }
    if (code === 0x2591 || code === 0x2592 || code === 0x2593) {
      const alpha = code === 0x2591 ? 0.25 : code === 0x2592 ? 0.5 : 0.75;
      ctx.save();
      ctx.globalAlpha = alpha;
      rect(x, y, x + w, y + h);
      ctx.restore();
      return true;
    }
    if (code === 0x2596) { rect(x, cy, cx, y + h); return true; }
    if (code === 0x2597) { rect(cx, cy, x + w, y + h); return true; }
    if (code === 0x2598) { rect(x, y, cx, cy); return true; }
    if (code === 0x259d) { rect(cx, y, x + w, cy); return true; }
    return false;
  }

  /* -------------------------------- events -------------------------------- */

  wireEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onContextMenu?.(e);
    });
    canvas.addEventListener('mousedown', () => this.focus());

    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.input.addEventListener('compositionstart', () => { this.composing = ' '; });
    this.input.addEventListener('compositionend', (e) => {
      this.composing = '';
      if (e.data) this.typeText(e.data);
      this.input.value = '';
    });
    this.input.addEventListener('input', (e) => {
      // Composition text arrives on compositionend; plain input is typed at once.
      if (this.composing) return;
      if (e.isComposing) return;
      const text = this.input.value;
      this.input.value = '';
      if (text) this.typeText(text);
    });
    this.input.addEventListener('focus', () => { this.hasFocus = true; this.cursorOn = true; this.invalidate(); });
    this.input.addEventListener('blur', () => { this.hasFocus = false; this.invalidate(); });
    this.input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (text) { e.preventDefault(); this.onPasteRequest?.(text); }
    });
    this.input.addEventListener('copy', (e) => {
      const text = this.selectedText();
      if (text) { e.preventDefault(); e.clipboardData?.setData('text/plain', text); }
    });
  }

  /* -------------------------------- mouse --------------------------------- */

  /** Cell under a point: `[col, absRow]`, or the screen row when [screenRelative]. */
  cellAt(clientX, clientY, screenRelative = false) {
    const rect = this.canvas.getBoundingClientRect();
    const col = clamp(Math.floor((clientX - rect.left) / this.charW), 0, this.emulator.cols - 1);
    const row = clamp(Math.floor((clientY - rect.top) / this.lineH), 0, this.rows - 1);
    if (screenRelative) return [col, clamp(row, 0, this.emulator.rows - 1)];
    return [col, clamp(this.topRow + row, 0, Math.max(0, this.emulator.totalRows() - 1))];
  }

  mouseMods(e) {
    return { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey };
  }

  /** Mouse reporting is on for a click only when the app asked and we are live. */
  reportsMouse(e) {
    return this.emulator.mouseMode !== MOUSE_OFF && this.follow && !e.shiftKey;
  }

  onMouseDown(e) {
    if (e.button === 2) return; // the context menu handler takes it
    if (this.reportsMouse(e)) {
      const [col, row] = this.cellAt(e.clientX, e.clientY, true);
      const m = this.mouseMods(e);
      const report = this.emulator.mouseReport(MOUSE_EVENT_PRESS, col, row, e.button === 1 ? 1 : e.button === 2 ? 2 : 0, m.shift, m.alt, m.ctrl);
      if (report) { this.onInput?.(report); e.preventDefault(); return; }
    }
    if (e.button !== 0) return;
    const [col, row] = this.cellAt(e.clientX, e.clientY);
    if (e.detail >= 3) {
      this.selectLine(row);
      this.selectMode = 'line';
    } else if (e.detail === 2) {
      this.selectWord(row, col);
      this.selectMode = 'word';
    } else {
      this.selection = { startRow: row, startCol: col, endRow: row, endCol: col };
      this.selectMode = 'char';
      this.selecting = true;
      this.follow = false;
      this.reportFollow();
    }
    this.invalidate();
    e.preventDefault();
  }

  onMouseMove(e) {
    if (this.selecting) {
      const [col, row] = this.cellAt(e.clientX, e.clientY);
      this.selection.endRow = row;
      this.selection.endCol = col;
      // Auto-scroll when dragging past an edge.
      const rect = this.canvas.getBoundingClientRect();
      if (e.clientY < rect.top + this.lineH) this.scrollByRows(-1);
      else if (e.clientY > rect.bottom - this.lineH) this.scrollByRows(1);
      this.invalidate();
      return;
    }
    if (this.emulator.mouseMode === MOUSE_OFF || !this.follow) return;
    const [col, row] = this.cellAt(e.clientX, e.clientY, true);
    if (col === this.lastMouseCol && row === this.lastMouseRow) return;
    this.lastMouseCol = col;
    this.lastMouseRow = row;
    const m = this.mouseMods(e);
    const report = this.emulator.mouseReport(MOUSE_EVENT_MOTION, col, row, 0, m.shift, m.alt, m.ctrl);
    if (report) this.onInput?.(report);
  }

  onMouseUp(e) {
    if (this.selecting) {
      this.selecting = false;
      const sel = this.normalizedSelection();
      // A click that selected nothing is a click, not an empty selection.
      if (sel && sel[0] === sel[2] && sel[1] === sel[3]) this.selection = null;
      this.invalidate();
      return;
    }
    if (this.emulator.mouseMode === MOUSE_OFF || !this.follow || e.shiftKey) return;
    const [col, row] = this.cellAt(e.clientX, e.clientY, true);
    const m = this.mouseMods(e);
    const report = this.emulator.mouseReport(
      MOUSE_EVENT_RELEASE, col, row, e.button === 1 ? 1 : e.button === 2 ? 2 : 0, m.shift, m.alt, m.ctrl);
    if (report) this.onInput?.(report);
  }

  onWheel(e) {
    // Ctrl + wheel is the desktop's pinch zoom.
    if (e.ctrlKey) {
      e.preventDefault();
      this.setFontSize(this.fontSize + (e.deltaY < 0 ? 1 : -1));
      return;
    }
    // Shift + wheel moves between tabs, when the setting allows it.
    if (e.shiftKey && this.wheelSwitchTabs && this.onSwitchTab && !this.selection) {
      e.preventDefault();
      this.onSwitchTab(e.deltaY > 0);
      return;
    }
    const lines = wheelLines(e, this.lineH, this.rows);
    if (lines === 0) return;
    e.preventDefault();

    const em = this.emulator;
    if (em.mouseMode !== MOUSE_OFF && this.follow) {
      const [col, row] = this.cellAt(e.clientX, e.clientY, true);
      const kind = lines > 0 ? MOUSE_EVENT_WHEEL_DOWN : MOUSE_EVENT_WHEEL_UP;
      for (let i = 0; i < Math.abs(lines); i++) {
        const report = em.mouseReport(kind, col, row, 0);
        if (report) this.onInput?.(report);
      }
      return;
    }
    if (em.isAltScreen && this.arrowsInAltScreen && this.follow) {
      const key = lines > 0 ? Keys.Key.DOWN : Keys.Key.UP;
      const bytes = Keys.encodeKey(key, Keys.NO_MODS, em.applicationCursorKeys);
      for (let i = 0; i < Math.abs(lines); i++) this.onInput?.(bytes);
      return;
    }
    this.scrollByRows(lines);
  }

  /* ------------------------------ selection ------------------------------- */

  normalizedSelection() {
    const s = this.selection;
    if (!s) return null;
    return s.startRow < s.endRow || (s.startRow === s.endRow && s.startCol <= s.endCol)
      ? [s.startRow, s.startCol, s.endRow, s.endCol]
      : [s.endRow, s.endCol, s.startRow, s.startCol];
  }

  selectWord(row, col) {
    if (row >= this.emulator.totalRows()) return;
    const text = this.emulator.rowText(row, false);
    if (col >= text.length) return;
    const wordChar = (c) => /[\p{L}\p{N}_\-./~:@]/u.test(c);
    let s = col;
    let e = col;
    if (wordChar(text[col])) {
      while (s > 0 && wordChar(text[s - 1])) s--;
      while (e < text.length - 1 && wordChar(text[e + 1])) e++;
    }
    this.selection = { startRow: row, startCol: s, endRow: row, endCol: e };
    this.follow = false;
    this.reportFollow();
  }

  selectLine(row) {
    const emulator = this.emulator;
    if (row >= emulator.totalRows()) return;
    // A soft-wrapped logical line selects whole, the way copying it should.
    let first = row;
    while (first > 0 && emulator.rowAt(first - 1).wrapped) first--;
    let last = row;
    while (last < emulator.totalRows() - 1 && emulator.rowAt(last).wrapped) last++;
    this.selection = { startRow: first, startCol: 0, endRow: last, endCol: emulator.rowAt(last).cols - 1 };
    this.follow = false;
    this.reportFollow();
  }

  selectedText() {
    const sel = this.normalizedSelection();
    if (!sel) return null;
    return this.emulator.textBetween(sel[0], sel[1], sel[2], sel[3]);
  }

  hasSelection() { return this.selection != null; }

  clearSelection() {
    this.selection = null;
    this.invalidate();
  }

  selectAll() {
    const total = this.emulator.totalRows();
    if (total === 0) return;
    this.selection = { startRow: 0, startCol: 0, endRow: total - 1, endCol: this.emulator.cols - 1 };
    this.invalidate();
  }

  /* -------------------------------- search -------------------------------- */

  /** Find [query] in the whole buffer (case-insensitive) and jump to the nearest match. */
  search(query) {
    this.matches = [];
    this.currentMatch = -1;
    this.searchQuery = query;
    if (query) {
      const q = query.toLowerCase();
      const total = this.emulator.totalRows();
      for (let r = 0; r < total; r++) {
        const text = this.emulator.rowText(r, true).toLowerCase();
        let from = 0;
        for (;;) {
          const i = text.indexOf(q, from);
          if (i < 0) break;
          this.matches.push({ row: r, startCol: i, endCol: i + q.length - 1 });
          from = i + Math.max(1, q.length);
        }
      }
      if (this.matches.length > 0) {
        // Nearest match at or above the visible top row, else the last one.
        let idx = -1;
        for (let i = this.matches.length - 1; i >= 0; i--) {
          if (this.matches[i].row <= this.topRow + this.rows - 1) { idx = i; break; }
        }
        this.currentMatch = idx < 0 ? this.matches.length - 1 : idx;
        this.scrollToRow(this.matches[this.currentMatch].row);
      }
    }
    this.onSearchResult?.(this.currentMatch >= 0 ? this.currentMatch + 1 : 0, this.matches.length);
    this.invalidate();
    return this.matches.length;
  }

  searchNext(forward) {
    if (this.matches.length === 0) return;
    this.currentMatch = (this.currentMatch + (forward ? 1 : -1) + this.matches.length) % this.matches.length;
    this.scrollToRow(this.matches[this.currentMatch].row);
    this.onSearchResult?.(this.currentMatch + 1, this.matches.length);
    this.invalidate();
  }

  clearSearch() {
    if (this.matches.length === 0 && !this.searchQuery) return;
    this.matches = [];
    this.currentMatch = -1;
    this.searchQuery = '';
    this.onSearchResult?.(0, 0);
    this.invalidate();
  }

  /* ------------------------------- keyboard ------------------------------- */

  onKeyDown(e) {
    if (e.isComposing || this.composing) return;

    const hw = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };

    // Copy and paste keep their desktop meanings; the shell gets Ctrl+C only
    // when there is nothing selected, which is what every terminal does.
    if (e.ctrlKey && e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'c') { const t = this.selectedText(); if (t) this.onCopy?.(t); e.preventDefault(); return; }
      if (key === 'v') { this.onPasteRequest?.(); e.preventDefault(); return; }
      if (key === 'a') { this.selectAll(); e.preventDefault(); return; }
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' && this.hasSelection()) {
      const t = this.selectedText();
      if (t) { this.onCopy?.(t); this.clearSelection(); e.preventDefault(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Insert') {
      const t = this.selectedText();
      if (t) { this.onCopy?.(t); e.preventDefault(); return; }
    }
    if (e.shiftKey && !e.ctrlKey && e.key === 'Insert') { this.onPasteRequest?.(); e.preventDefault(); return; }

    // Shift+PageUp / Shift+PageDown scroll the scrollback, as on a real console.
    if (e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'PageUp') { this.scrollByRows(-(this.rows - 1)); e.preventDefault(); return; }
      if (e.key === 'PageDown') { this.scrollByRows(this.rows - 1); e.preventDefault(); return; }
      if (e.key === 'Home') { this.topRow = 0; this.follow = false; this.reportFollow(); this.invalidate(); e.preventDefault(); return; }
      if (e.key === 'End') { this.scrollToBottom(); e.preventDefault(); return; }
    }

    const key = SPECIAL_KEYS[e.key];
    if (key) {
      this.sendKey(key, hw);
      e.preventDefault();
      return;
    }
    if (MODIFIER_KEYS.has(e.key)) return;

    // A printable key: the `input` event would deliver it too, but Ctrl/Alt
    // combinations never reach it, so they are encoded here.
    if (e.key.length === 1 || Array.from(e.key).length === 1) {
      if (e.ctrlKey || e.altKey || e.metaKey) {
        this.typeText(e.key, hw);
        e.preventDefault();
      }
      // Plain characters fall through to the textarea's `input` event, so the
      // IME and dead keys keep working.
      return;
    }
  }

  mergeMods(hw) {
    const sticky = this.modifiers.mods();
    if (!hw) return sticky;
    return { ctrl: sticky.ctrl || hw.ctrl, alt: sticky.alt || hw.alt, shift: sticky.shift || hw.shift };
  }

  /** Send typed text, applying sticky/hardware modifiers, then release one-shots. */
  typeText(text, hw = null) {
    if (!text) return;
    const out = Keys.encodeText(text, this.mergeMods(hw));
    this.modifiers.consume();
    this.onInput?.(out);
    this.scrollToBottom();
  }

  /** Send a special key with sticky/hardware modifiers. */
  sendKey(key, hw = null) {
    const em = this.emulator;
    const out = Keys.encodeKey(key, this.mergeMods(hw), em.applicationCursorKeys, em.applicationKeypad);
    this.modifiers.consume();
    this.onInput?.(out);
    this.scrollToBottom();
  }

  /** Send raw bytes (shortcuts, pasted text already wrapped by the host). */
  sendRaw(s) {
    if (!s) return;
    this.onInput?.(s);
    this.scrollToBottom();
  }

  /** Pasted text, wrapped for bracketed paste when the application asked for it. */
  paste(text) {
    this.sendRaw(Keys.paste(text, this.emulator.bracketedPaste));
  }
}

/* -------------------------------- helpers -------------------------------- */

const SPECIAL_KEYS = {
  Enter: Keys.Key.ENTER,
  NumpadEnter: Keys.Key.ENTER,
  Tab: Keys.Key.TAB,
  Backspace: Keys.Key.BACKSPACE,
  Escape: Keys.Key.ESCAPE,
  ArrowUp: Keys.Key.UP,
  ArrowDown: Keys.Key.DOWN,
  ArrowLeft: Keys.Key.LEFT,
  ArrowRight: Keys.Key.RIGHT,
  Home: Keys.Key.HOME,
  End: Keys.Key.END,
  PageUp: Keys.Key.PAGE_UP,
  PageDown: Keys.Key.PAGE_DOWN,
  Insert: Keys.Key.INSERT,
  Delete: Keys.Key.DELETE,
  F1: Keys.Key.F1, F2: Keys.Key.F2, F3: Keys.Key.F3, F4: Keys.Key.F4,
  F5: Keys.Key.F5, F6: Keys.Key.F6, F7: Keys.Key.F7, F8: Keys.Key.F8,
  F9: Keys.Key.F9, F10: Keys.Key.F10, F11: Keys.Key.F11, F12: Keys.Key.F12,
};

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Process', 'Unidentified']);

function isBoxDrawing(code) {
  return code >= 0x2500 && code <= 0x259f;
}

/** Wheel deltas come in pixels, lines or pages depending on the device. */
function wheelLines(e, lineH, rows) {
  if (e.deltaMode === 1) return Math.round(e.deltaY);
  if (e.deltaMode === 2) return Math.round(e.deltaY) * Math.max(1, rows - 1);
  return Math.round(e.deltaY / lineH) || (e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0);
}

function blend(a, b, wa) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const mix = (i) => Math.round(ca[i] * wa + cb[i] * (1 - wa));
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

function parseColor(css) {
  if (css.startsWith('#')) {
    const v = parseInt(css.slice(1), 16);
    if (css.length === 7) return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((p) => parseFloat(p));
    return [parts[0] | 0, parts[1] | 0, parts[2] | 0];
  }
  return [0, 0, 0];
}
