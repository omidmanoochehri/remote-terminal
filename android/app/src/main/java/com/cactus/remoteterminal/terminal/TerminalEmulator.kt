package com.cactus.remoteterminal.terminal

/**
 * A VT/xterm terminal emulator over an IntArray-backed grid.
 *
 * Handles the control sequences real programs use (bash/zsh/PowerShell, vim,
 * nano, less, htop, git, npm): CSI cursor/erase/insert/delete/scroll commands,
 * SGR with 16/256/true colour, DEC private modes (origin, autowrap, alternate
 * screen, cursor visibility/style, mouse tracking, bracketed paste, application
 * cursor keys), tab stops, DEC special graphics, OSC title/clipboard, DSR/DA
 * replies, wide (CJK/emoji) and combining characters, bounded scrollback and
 * reflow on resize.
 *
 * Not thread-safe: feed/resize/readout must happen on one thread (the UI thread).
 */
class TerminalEmulator(cols: Int = 80, rows: Int = 24, maxScrollback: Int = 5000) {

    /* ------------------------------ public state ------------------------------ */

    var cols: Int = cols.coerceAtLeast(1); private set
    var rows: Int = rows.coerceAtLeast(1); private set

    var maxScrollback: Int = maxScrollback.coerceAtLeast(0)
        set(value) { field = value.coerceAtLeast(0); trimScrollback(); dirty = true }

    var cursorRow = 0; private set
    var cursorCol = 0; private set
    var cursorVisible = true; private set
    var cursorStyle = CURSOR_BLOCK; private set
    var cursorBlink = true; private set
    var isAltScreen = false; private set
    var title = ""; private set
    var applicationCursorKeys = false; private set
    var applicationKeypad = false; private set
    var bracketedPaste = false; private set
    var mouseMode = MOUSE_OFF; private set
    var mouseSgr = false; private set
    var focusEvents = false; private set

    var onResponse: ((String) -> Unit)? = null
    var muteResponses = false
    var onBell: (() -> Unit)? = null
    var onTitle: ((String) -> Unit)? = null
    var onClipboard: ((String) -> Unit)? = null
    var onAltScreen: ((Boolean) -> Unit)? = null

    /* ------------------------------ buffers ------------------------------ */

    private var screen: Array<Row> = Array(this.rows) { Row(this.cols) }
    private var alt: Array<Row> = Array(this.rows) { Row(this.cols) }
    private val scrollback = ArrayDeque<Row>()
    private val buf: Array<Row> get() = if (isAltScreen) alt else screen

    // Graphics state
    private var curFg = DEFAULT
    private var curBg = DEFAULT
    private var curFlags = 0
    private var pendingWrap = false

    // Modes
    private var autowrap = true
    private var originMode = false
    private var insertMode = false
    private var scrollTop = 0
    private var scrollBottom = this.rows - 1
    private var tabStops = BooleanArray(this.cols).also { for (i in it.indices) it[i] = i % 8 == 0 }

    // Character sets: 0 = ASCII, 1 = DEC special graphics.
    private var g0 = 0
    private var g1 = 0
    private var shiftG1 = false

    private class SavedCursor {
        var row = 0; var col = 0; var fg = DEFAULT; var bg = DEFAULT; var flags = 0
        var origin = false; var autowrap = true; var g0 = 0; var g1 = 0; var shiftG1 = false; var pendingWrap = false
    }
    private val savedMain = SavedCursor()
    private val savedAlt = SavedCursor()
    private val saved: SavedCursor get() = if (isAltScreen) savedAlt else savedMain

    // Cursor of the primary screen while the alternate screen is active (for reflow).
    private var mainCursorRow = 0
    private var mainCursorCol = 0

    private var dirty = true
    private var mouseButtonHeld = -1

    /* ------------------------------- parser ------------------------------- */

    private enum class S { GROUND, ESC, ESC_INTER, CSI, OSC, OSC_ESC, STRING, STRING_ESC, CHARSET }
    private var state = S.GROUND
    private val params = IntArray(MAX_PARAMS)
    private val subFlags = BooleanArray(MAX_PARAMS)
    private var paramCount = 0
    private var paramStarted = false
    private var privMarker = 0
    private var intermediate = 0
    private var escIntermediate = 0
    private var charsetTarget = 0
    private val osc = StringBuilder(64)
    private var pendingHigh = 0

    /* ------------------------------- feeding ------------------------------ */

    fun feed(text: CharSequence) {
        val n = text.length
        var i = 0
        while (i < n) {
            val c = text[i]; i++
            val cp: Int
            if (pendingHigh != 0) {
                val high = pendingHigh
                pendingHigh = 0
                if (c.isLowSurrogate()) { cp = Character.toCodePoint(high.toChar(), c) }
                else { process(REPLACEMENT); i--; continue }
            } else if (c.isHighSurrogate()) {
                if (i < n) {
                    val d = text[i]
                    if (d.isLowSurrogate()) { cp = Character.toCodePoint(c, d); i++ } else cp = REPLACEMENT
                } else { pendingHigh = c.code; break }
            } else if (c.isLowSurrogate()) {
                cp = REPLACEMENT
            } else cp = c.code
            process(cp)
        }
        dirty = true
    }

    private fun process(cp: Int) {
        when (state) {
            S.GROUND -> ground(cp)
            S.ESC -> esc(cp)
            S.ESC_INTER -> escIntermediate(cp)
            S.CSI -> csi(cp)
            S.OSC -> when {
                cp == BEL -> { finishOsc(); state = S.GROUND }
                cp == ESC -> state = S.OSC_ESC
                cp < 0x20 -> { /* ignore other controls inside OSC */ }
                else -> if (osc.length < MAX_OSC) osc.appendCodePoint(cp)
            }
            S.OSC_ESC -> if (cp == '\\'.code) { finishOsc(); state = S.GROUND } else { osc.setLength(0); state = S.ESC; esc(cp) }
            S.STRING -> if (cp == ESC) state = S.STRING_ESC else if (cp == BEL) state = S.GROUND
            S.STRING_ESC -> state = if (cp == '\\'.code) S.GROUND else S.STRING
            S.CHARSET -> { designate(cp); state = S.GROUND }
        }
    }

    private fun ground(cp: Int) {
        when {
            cp < 0x20 || cp == 0x7F -> control(cp)
            cp in 0x80..0x9F -> c1(cp)
            else -> print(cp)
        }
    }

    /** C0 controls; also executed while inside a CSI (per the VT500 parser). */
    private fun control(cp: Int) {
        when (cp) {
            BEL -> onBell?.invoke()
            0x08 -> { if (cursorCol > 0) cursorCol--; pendingWrap = false }
            0x09 -> tab()
            0x0A, 0x0B, 0x0C -> lineFeed()
            0x0D -> { cursorCol = 0; pendingWrap = false }
            0x0E -> shiftG1 = true
            0x0F -> shiftG1 = false
            ESC -> { state = S.ESC; escIntermediate = 0 }
            0x18, 0x1A -> state = S.GROUND
            else -> {}
        }
    }

    private fun c1(cp: Int) {
        when (cp) {
            0x84 -> index()
            0x85 -> { cursorCol = 0; lineFeed() }
            0x88 -> tabStops[cursorCol.coerceIn(0, cols - 1)] = true
            0x8D -> reverseIndex()
            0x90, 0x98, 0x9E, 0x9F -> state = S.STRING
            0x9B -> startCsi()
            0x9D -> { state = S.OSC; osc.setLength(0) }
            else -> {}
        }
    }

    private fun startCsi() {
        state = S.CSI
        paramCount = 0; paramStarted = false; privMarker = 0; intermediate = 0
        params[0] = 0; subFlags[0] = false
    }

    private fun esc(cp: Int) {
        state = S.GROUND
        when (cp) {
            '['.code -> startCsi()
            ']'.code -> { state = S.OSC; osc.setLength(0) }
            'P'.code, 'X'.code, '^'.code, '_'.code -> state = S.STRING
            '('.code, ')'.code, '*'.code, '+'.code -> { charsetTarget = cp; state = S.CHARSET }
            '7'.code -> saveCursor()
            '8'.code -> restoreCursor()
            'D'.code -> index()
            'E'.code -> { cursorCol = 0; lineFeed() }
            'H'.code -> tabStops[cursorCol.coerceIn(0, cols - 1)] = true
            'M'.code -> reverseIndex()
            'c'.code -> reset()
            '='.code -> applicationKeypad = true
            '>'.code -> applicationKeypad = false
            'N'.code, 'O'.code, '\\'.code -> {}
            in 0x20..0x2F -> { escIntermediate = cp; state = S.ESC_INTER }
            ESC -> state = S.ESC
            in 0x00..0x1F -> control(cp)
            else -> {}
        }
    }

    private fun escIntermediate(cp: Int) {
        if (cp in 0x20..0x2F) { escIntermediate = cp; return }
        state = S.GROUND
        if (cp == ESC) { state = S.ESC; return }
        if (cp < 0x20) { control(cp); return }
        if (escIntermediate == '#'.code && cp == '8'.code) decaln()
        // ESC % G / ESC % @ (UTF-8 selection) and other 2-byte escapes are consumed.
    }

    private fun designate(cp: Int) {
        val set = if (cp == '0'.code) 1 else 0
        when (charsetTarget) {
            '('.code -> g0 = set
            ')'.code -> g1 = set
            else -> {}
        }
    }

    private fun csi(cp: Int) {
        when {
            cp in '0'.code..'9'.code -> {
                val v = params[paramCount]
                params[paramCount] = if (v > 6553) 65535 else v * 10 + (cp - '0'.code)
                paramStarted = true
            }
            cp == ';'.code || cp == ':'.code -> {
                if (paramCount < MAX_PARAMS - 1) {
                    paramCount++
                    params[paramCount] = 0
                    subFlags[paramCount] = cp == ':'.code
                }
                paramStarted = true
            }
            cp in 0x3C..0x3F -> if (!paramStarted && paramCount == 0 && privMarker == 0) privMarker = cp else intermediate = -1
            cp in 0x20..0x2F -> intermediate = if (intermediate == -1) -1 else cp
            cp in 0x40..0x7E -> {
                state = S.GROUND
                if (intermediate != -1) dispatchCsi(cp)
            }
            cp == ESC -> { state = S.ESC; escIntermediate = 0 }
            cp == 0x18 || cp == 0x1A -> state = S.GROUND
            cp < 0x20 -> control(cp)
            cp == 0x7F -> {}
            else -> { state = S.GROUND; ground(cp) } // non-ASCII aborts the sequence
        }
    }

    private fun p(idx: Int, def: Int): Int {
        if (idx > paramCount) return def
        val v = params[idx]
        return if (v == 0) def else v
    }

    private fun nParams(): Int = if (!paramStarted && paramCount == 0) 0 else paramCount + 1

    private fun dispatchCsi(final: Int) {
        if (privMarker == '?'.code) {
            when (final) {
                'h'.code -> { for (i in 0 until nParams()) decMode(params[i], true); return }
                'l'.code -> { for (i in 0 until nParams()) decMode(params[i], false); return }
                'n'.code -> { if (params[0] == 6) respond("[?${reportRow()};${cursorCol + 1}R"); return }
                else -> return
            }
        }
        if (privMarker == '>'.code) {
            if (final == 'c'.code) respond("[>41;0;0c")
            return
        }
        if (privMarker != 0) return
        when (intermediate) {
            ' '.code -> { if (final == 'q'.code) setCursorStyle(params[0]); return }
            '!'.code -> { if (final == 'p'.code) softReset(); return }
            0 -> {}
            else -> return
        }
        when (final) {
            'A'.code -> moveCursor(-p(0, 1), 0)
            'B'.code, 'e'.code -> moveCursor(p(0, 1), 0)
            'C'.code, 'a'.code -> moveCursor(0, p(0, 1))
            'D'.code -> moveCursor(0, -p(0, 1))
            'E'.code -> { moveCursor(p(0, 1), 0); cursorCol = 0 }
            'F'.code -> { moveCursor(-p(0, 1), 0); cursorCol = 0 }
            'G'.code, '`'.code -> { cursorCol = (p(0, 1) - 1).coerceIn(0, cols - 1); pendingWrap = false }
            'd'.code -> setCursorRow(p(0, 1) - 1)
            'H'.code, 'f'.code -> { setCursorRow(p(0, 1) - 1); cursorCol = (p(1, 1) - 1).coerceIn(0, cols - 1); pendingWrap = false }
            'I'.code -> repeat(p(0, 1)) { tab() }
            'J'.code -> eraseDisplay(params[0])
            'K'.code -> eraseLine(params[0])
            'L'.code -> insertLines(p(0, 1))
            'M'.code -> deleteLines(p(0, 1))
            'P'.code -> deleteChars(p(0, 1))
            '@'.code -> insertChars(p(0, 1))
            'X'.code -> eraseChars(p(0, 1))
            'S'.code -> scrollUp(p(0, 1))
            'T'.code -> scrollDown(p(0, 1))
            'Z'.code -> repeat(p(0, 1)) { backTab() }
            'b'.code -> repeatLast(p(0, 1))
            'c'.code -> respond("[?62;22c")
            'g'.code -> when (params[0]) { 0 -> tabStops[cursorCol.coerceIn(0, cols - 1)] = false; 3 -> tabStops.fill(false) }
            'h'.code -> for (i in 0 until nParams()) ansiMode(params[i], true)
            'l'.code -> for (i in 0 until nParams()) ansiMode(params[i], false)
            'm'.code -> sgr()
            'n'.code -> when (params[0]) { 5 -> respond("[0n"); 6 -> respond("[${reportRow()};${cursorCol + 1}R") }
            'r'.code -> {
                val top = (p(0, 1) - 1).coerceIn(0, rows - 1)
                val bottom = (p(1, rows) - 1).coerceIn(0, rows - 1)
                if (bottom > top) { scrollTop = top; scrollBottom = bottom }
                cursorRow = if (originMode) scrollTop else 0
                cursorCol = 0; pendingWrap = false
            }
            's'.code -> saveCursor()
            'u'.code -> restoreCursor()
            't'.code -> if (params[0] == 18) respond("[8;$rows;${cols}t")
            else -> {}
        }
    }

    private fun reportRow(): Int = if (originMode) cursorRow - scrollTop + 1 else cursorRow + 1

    private fun respond(s: String) { if (!muteResponses) onResponse?.invoke(s) }

    private fun ansiMode(mode: Int, on: Boolean) {
        when (mode) { 4 -> insertMode = on }
    }

    private fun decMode(mode: Int, on: Boolean) {
        when (mode) {
            1 -> applicationCursorKeys = on
            6 -> { originMode = on; cursorRow = if (on) scrollTop else 0; cursorCol = 0; pendingWrap = false }
            7 -> autowrap = on
            12 -> cursorBlink = on
            25 -> cursorVisible = on
            47, 1047 -> switchAlt(on, false)
            1049 -> switchAlt(on, true)
            1000 -> mouseMode = if (on) MOUSE_PRESS else MOUSE_OFF
            1002 -> mouseMode = if (on) MOUSE_BUTTON else MOUSE_OFF
            1003 -> mouseMode = if (on) MOUSE_ANY else MOUSE_OFF
            1004 -> focusEvents = on
            1006 -> mouseSgr = on
            2004 -> bracketedPaste = on
            else -> {}
        }
    }

    private fun setCursorStyle(ps: Int) {
        when (ps) {
            0, 1 -> { cursorStyle = CURSOR_BLOCK; cursorBlink = true }
            2 -> { cursorStyle = CURSOR_BLOCK; cursorBlink = false }
            3 -> { cursorStyle = CURSOR_UNDERLINE; cursorBlink = true }
            4 -> { cursorStyle = CURSOR_UNDERLINE; cursorBlink = false }
            5 -> { cursorStyle = CURSOR_BAR; cursorBlink = true }
            6 -> { cursorStyle = CURSOR_BAR; cursorBlink = false }
        }
    }

    /* -------------------------------- SGR --------------------------------- */

    private fun sgr() {
        val n = nParams()
        if (n == 0) { curFg = DEFAULT; curBg = DEFAULT; curFlags = 0; return }
        var i = 0
        while (i < n) {
            if (subFlags[i]) { i++; continue } // unconsumed sub-parameter (e.g. 4:3 styles)
            when (val v = params[i]) {
                0 -> { curFg = DEFAULT; curBg = DEFAULT; curFlags = 0 }
                1 -> curFlags = curFlags or BOLD
                2 -> curFlags = curFlags or DIM
                3 -> curFlags = curFlags or ITALIC
                4 -> curFlags = curFlags or UNDERLINE
                5, 6 -> curFlags = curFlags or BLINK
                7 -> curFlags = curFlags or REVERSE
                8 -> curFlags = curFlags or HIDDEN
                9 -> curFlags = curFlags or STRIKE
                21 -> curFlags = curFlags or UNDERLINE
                22 -> curFlags = curFlags and (BOLD or DIM).inv()
                23 -> curFlags = curFlags and ITALIC.inv()
                24 -> curFlags = curFlags and UNDERLINE.inv()
                25 -> curFlags = curFlags and BLINK.inv()
                27 -> curFlags = curFlags and REVERSE.inv()
                28 -> curFlags = curFlags and HIDDEN.inv()
                29 -> curFlags = curFlags and STRIKE.inv()
                in 30..37 -> curFg = v - 30
                39 -> curFg = DEFAULT
                in 40..47 -> curBg = v - 40
                49 -> curBg = DEFAULT
                in 90..97 -> curFg = v - 90 + 8
                in 100..107 -> curBg = v - 100 + 8
                38 -> { val (col, adv) = extendedColor(i, n); if (col != NO_COLOR) curFg = col; i += adv }
                48 -> { val (col, adv) = extendedColor(i, n); if (col != NO_COLOR) curBg = col; i += adv }
                58 -> { val (_, adv) = extendedColor(i, n); i += adv } // underline colour: consumed, not rendered
                else -> {}
            }
            i++
        }
    }

    /** Parse 38/48 arguments at index [i]; returns (colour or NO_COLOR, number of extra params consumed). */
    private fun extendedColor(i: Int, n: Int): Pair<Int, Int> {
        if (i + 1 >= n) return NO_COLOR to 0
        var subs = 0
        while (i + 1 + subs < n && subFlags[i + 1 + subs]) subs++
        if (subs > 0) {
            // Colon form: 38:5:n · 38:2:r:g:b · 38:2:cs:r:g:b
            val mode = params[i + 1]
            return when {
                mode == 5 && subs >= 2 -> params[i + 2].coerceIn(0, 255) to subs
                mode == 2 && subs >= 5 -> rgb(params[i + 3], params[i + 4], params[i + 5]) to subs
                mode == 2 && subs == 4 -> rgb(params[i + 2], params[i + 3], params[i + 4]) to subs
                else -> NO_COLOR to subs
            }
        }
        // Semicolon form: 38;5;n · 38;2;r;g;b
        return when (params[i + 1]) {
            5 -> if (i + 2 < n) params[i + 2].coerceIn(0, 255) to 2 else NO_COLOR to 1
            2 -> if (i + 4 < n) rgb(params[i + 2], params[i + 3], params[i + 4]) to 4 else NO_COLOR to (n - i - 1)
            else -> NO_COLOR to 1
        }
    }

    private fun rgb(r: Int, g: Int, b: Int): Int = TRUECOLOR or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)

    /* -------------------------------- OSC --------------------------------- */

    private fun finishOsc() {
        val s = osc.toString()
        osc.setLength(0)
        val semi = s.indexOf(';')
        val code = (if (semi < 0) s else s.substring(0, semi)).toIntOrNull() ?: return
        val arg = if (semi < 0) "" else s.substring(semi + 1)
        when (code) {
            0, 2 -> { title = arg; onTitle?.invoke(arg) }
            52 -> {
                val sep = arg.indexOf(';')
                if (sep < 0) return
                val payload = arg.substring(sep + 1)
                if (payload == "?" || payload.isEmpty()) return
                val decoded = base64Decode(payload) ?: return
                onClipboard?.invoke(decoded)
            }
            else -> {}
        }
    }

    /* ------------------------------ printing ------------------------------ */

    private fun print(cpIn: Int) {
        var cp = cpIn
        val set = if (shiftG1) g1 else g0
        if (set == 1 && cp in 0x60..0x7E) cp = DEC_SPECIAL[cp - 0x60]

        val width = WcWidth.of(cp)
        if (width == 0) { attachCombining(cp); return }
        val w = if (width == 2 && cols >= 2) 2 else 1
        val row0 = buf[cursorRow]

        if (pendingWrap) {
            if (autowrap) { row0.wrapped = true; cursorCol = 0; pendingWrap = false; lineFeed() }
            else pendingWrap = false
        }
        var row = buf[cursorRow]
        if (w == 2 && cursorCol == cols - 1) {
            if (!autowrap) return
            row.clear(cursorCol, curFg, curBg)
            row.wrapped = true
            cursorCol = 0
            lineFeed()
            row = buf[cursorRow]
        }
        if (insertMode) insertCells(row, cursorCol, w)
        // Repair wide glyphs we are about to overwrite partially.
        clearWideAt(row, cursorCol)
        if (w == 2) clearWideAt(row, cursorCol + 1)
        row.set(cursorCol, cp, curFg, curBg, if (w == 2) curFlags or WIDE else curFlags)
        if (w == 2) row.set(cursorCol + 1, 0, curFg, curBg, curFlags or CONTINUATION)
        cursorCol += w
        if (cursorCol >= cols) { cursorCol = cols - 1; pendingWrap = true }
    }

    /** Blank both halves of a wide glyph that occupies [col]. */
    private fun clearWideAt(row: Row, col: Int) {
        if (col < 0 || col >= cols) return
        val f = row.flags[col]
        if (f and CONTINUATION != 0 && col > 0) row.clear(col - 1, row.fg[col - 1], row.bg[col - 1])
        if (f and WIDE != 0 && col + 1 < cols) row.clear(col + 1, row.fg[col + 1], row.bg[col + 1])
    }

    private fun attachCombining(cp: Int) {
        val row = buf[cursorRow]
        var col = if (pendingWrap) cursorCol else cursorCol - 1
        if (col < 0) return
        if (row.flags[col] and CONTINUATION != 0) col--
        if (col < 0) return
        row.appendCombining(col, String(Character.toChars(cp)))
    }

    private fun repeatLast(n: Int) {
        val col = if (pendingWrap) cursorCol else cursorCol - 1
        if (col < 0) return
        val row = buf[cursorRow]
        var c = col
        if (row.flags[c] and CONTINUATION != 0) c--
        if (c < 0) return
        val code = row.codes[c]
        if (code == 0 || code == Row.BLANK && row.flags[c] == 0) return
        val marks = row.combining(c)
        repeat(n.coerceAtMost(cols * 4)) {
            print(code)
            if (marks != null) { val r = buf[cursorRow]; val cc = if (pendingWrap) cursorCol else cursorCol - 1; if (cc >= 0) r.setCombining(cc, marks) }
        }
    }

    private fun tab() {
        var c = cursorCol + 1
        while (c < cols - 1 && !tabStops[c]) c++
        cursorCol = c.coerceIn(0, cols - 1)
        pendingWrap = false
    }

    private fun backTab() {
        var c = cursorCol - 1
        while (c > 0 && !tabStops[c]) c--
        cursorCol = c.coerceAtLeast(0)
        pendingWrap = false
    }

    private fun decaln() {
        for (r in buf) { r.fill(DEFAULT, DEFAULT); for (c in 0 until cols) r.codes[c] = 'E'.code }
        scrollTop = 0; scrollBottom = rows - 1
        cursorRow = 0; cursorCol = 0; pendingWrap = false
    }

    /* ------------------------------ cursor -------------------------------- */

    private fun moveCursor(dRow: Int, dCol: Int) {
        if (dRow != 0) {
            val top = if (cursorRow >= scrollTop) scrollTop else 0
            val bottom = if (cursorRow <= scrollBottom) scrollBottom else rows - 1
            cursorRow = (cursorRow + dRow).coerceIn(top, bottom)
        }
        cursorCol = (cursorCol + dCol).coerceIn(0, cols - 1)
        pendingWrap = false
    }

    private fun setCursorRow(r: Int) {
        cursorRow = if (originMode) (scrollTop + r).coerceIn(scrollTop, scrollBottom) else r.coerceIn(0, rows - 1)
        pendingWrap = false
    }

    private fun lineFeed() {
        if (cursorRow == scrollBottom) scrollUp(1)
        else if (cursorRow < rows - 1) cursorRow++
    }

    private fun index() = lineFeed()

    private fun reverseIndex() {
        if (cursorRow == scrollTop) scrollDown(1)
        else if (cursorRow > 0) cursorRow--
    }

    private fun saveCursor() {
        val s = saved
        s.row = cursorRow; s.col = cursorCol; s.fg = curFg; s.bg = curBg; s.flags = curFlags
        s.origin = originMode; s.autowrap = autowrap; s.g0 = g0; s.g1 = g1; s.shiftG1 = shiftG1; s.pendingWrap = pendingWrap
    }

    private fun restoreCursor() {
        val s = saved
        cursorRow = s.row.coerceIn(0, rows - 1); cursorCol = s.col.coerceIn(0, cols - 1)
        curFg = s.fg; curBg = s.bg; curFlags = s.flags
        originMode = s.origin; autowrap = s.autowrap; g0 = s.g0; g1 = s.g1; shiftG1 = s.shiftG1
        pendingWrap = false
    }

    /* ----------------------------- scrolling ------------------------------ */

    private fun scrollUp(n: Int) {
        val g = buf
        val count = n.coerceIn(1, scrollBottom - scrollTop + 1)
        val toHistory = !isAltScreen && scrollTop == 0 && scrollBottom == rows - 1
        repeat(count) {
            val top = g[scrollTop]
            for (y in scrollTop until scrollBottom) g[y] = g[y + 1]
            if (toHistory) {
                g[scrollBottom] = pushScrollback(top)
            } else {
                top.fill(curFg, curBg)
                g[scrollBottom] = top
            }
        }
    }

    /** Move [row] into history; returns a fresh (or recycled) blank row for the bottom. */
    private fun pushScrollback(row: Row): Row {
        if (maxScrollback <= 0) { row.fill(curFg, curBg); return row }
        scrollback.addLast(row)
        return if (scrollback.size > maxScrollback) {
            val recycled = scrollback.removeFirst()
            recycled.fill(curFg, curBg)
            recycled
        } else Row(cols).also { if (curBg != DEFAULT || curFg != DEFAULT) it.fill(curFg, curBg) }
    }

    private fun trimScrollback() { while (scrollback.size > maxScrollback) scrollback.removeFirst() }

    private fun scrollDown(n: Int) {
        val g = buf
        val count = n.coerceIn(1, scrollBottom - scrollTop + 1)
        repeat(count) {
            val bottom = g[scrollBottom]
            for (y in scrollBottom downTo scrollTop + 1) g[y] = g[y - 1]
            bottom.fill(curFg, curBg)
            g[scrollTop] = bottom
        }
    }

    private fun insertLines(n: Int) {
        if (cursorRow < scrollTop || cursorRow > scrollBottom) return
        val g = buf
        repeat(n.coerceAtMost(scrollBottom - cursorRow + 1)) {
            val bottom = g[scrollBottom]
            for (y in scrollBottom downTo cursorRow + 1) g[y] = g[y - 1]
            bottom.fill(curFg, curBg)
            g[cursorRow] = bottom
        }
        cursorCol = 0; pendingWrap = false
    }

    private fun deleteLines(n: Int) {
        if (cursorRow < scrollTop || cursorRow > scrollBottom) return
        val g = buf
        repeat(n.coerceAtMost(scrollBottom - cursorRow + 1)) {
            val top = g[cursorRow]
            for (y in cursorRow until scrollBottom) g[y] = g[y + 1]
            top.fill(curFg, curBg)
            g[scrollBottom] = top
        }
        cursorCol = 0; pendingWrap = false
    }

    /* ------------------------------- erase -------------------------------- */

    private fun eraseDisplay(mode: Int) {
        val g = buf
        when (mode) {
            0 -> { eraseLine(0); for (y in cursorRow + 1 until rows) g[y].fill(curFg, curBg) }
            1 -> { for (y in 0 until cursorRow) g[y].fill(curFg, curBg); eraseLine(1) }
            2 -> for (y in 0 until rows) g[y].fill(curFg, curBg)
            3 -> scrollback.clear()
        }
        pendingWrap = false
    }

    private fun eraseLine(mode: Int) {
        val row = buf[cursorRow]
        when (mode) {
            0 -> { clearWideAt(row, cursorCol); row.clearRange(cursorCol, cols, curFg, curBg); row.wrapped = false }
            1 -> { clearWideAt(row, cursorCol); row.clearRange(0, cursorCol + 1, curFg, curBg) }
            2 -> row.fill(curFg, curBg)
        }
        pendingWrap = false
    }

    private fun eraseChars(n: Int) {
        val row = buf[cursorRow]
        val end = (cursorCol + n).coerceAtMost(cols)
        clearWideAt(row, cursorCol)
        clearWideAt(row, end - 1)
        row.clearRange(cursorCol, end, curFg, curBg)
        pendingWrap = false
    }

    private fun insertChars(n: Int) {
        insertCells(buf[cursorRow], cursorCol, n)
        pendingWrap = false
    }

    private fun insertCells(row: Row, at: Int, n: Int) {
        val count = n.coerceIn(0, cols - at)
        if (count == 0) return
        clearWideAt(row, at)
        row.moveCells(at, at + count, cols - at - count)
        row.clearRange(at, at + count, curFg, curBg)
        // A wide glyph pushed past the right edge loses its half: blank the orphan.
        if (row.flags[cols - 1] and WIDE != 0) row.clear(cols - 1, row.fg[cols - 1], row.bg[cols - 1])
    }

    private fun deleteChars(n: Int) {
        val row = buf[cursorRow]
        val count = n.coerceIn(0, cols - cursorCol)
        if (count == 0) return
        clearWideAt(row, cursorCol)
        clearWideAt(row, cursorCol + count - 1)
        row.moveCells(cursorCol + count, cursorCol, cols - cursorCol - count)
        row.clearRange(cols - count, cols, curFg, curBg)
        pendingWrap = false
    }

    /* ---------------------------- alt screen ------------------------------ */

    private fun switchAlt(toAlt: Boolean, saveRestore: Boolean) {
        if (toAlt == isAltScreen) return
        if (toAlt) {
            if (saveRestore) saveCursor()
            mainCursorRow = cursorRow; mainCursorCol = cursorCol
            isAltScreen = true
            for (r in alt) r.fill(DEFAULT, DEFAULT)
            cursorRow = 0; cursorCol = 0
        } else {
            isAltScreen = false
            cursorRow = mainCursorRow.coerceIn(0, rows - 1); cursorCol = mainCursorCol.coerceIn(0, cols - 1)
            if (saveRestore) restoreCursor()
        }
        scrollTop = 0; scrollBottom = rows - 1
        pendingWrap = false
        onAltScreen?.invoke(toAlt)
    }

    /* ------------------------------ resets -------------------------------- */

    /** RIS: everything back to power-on state, screens and history cleared. */
    fun reset() {
        for (r in screen) r.fill(DEFAULT, DEFAULT)
        for (r in alt) r.fill(DEFAULT, DEFAULT)
        scrollback.clear()
        if (isAltScreen) { isAltScreen = false; onAltScreen?.invoke(false) }
        softReset()
        cursorRow = 0; cursorCol = 0; mainCursorRow = 0; mainCursorCol = 0
        title = ""
        applicationKeypad = false
        mouseMode = MOUSE_OFF; mouseSgr = false; focusEvents = false; bracketedPaste = false
        cursorStyle = CURSOR_BLOCK; cursorBlink = true
        for (i in tabStops.indices) tabStops[i] = i % 8 == 0
        state = S.GROUND; pendingHigh = 0
        dirty = true
    }

    /** DECSTR: modes/attributes/margins reset, screen contents kept. */
    fun softReset() {
        cursorVisible = true
        insertMode = false
        originMode = false
        autowrap = true
        applicationCursorKeys = false
        applicationKeypad = false
        scrollTop = 0; scrollBottom = rows - 1
        curFg = DEFAULT; curBg = DEFAULT; curFlags = 0
        g0 = 0; g1 = 0; shiftG1 = false
        pendingWrap = false
        for (s in arrayOf(savedMain, savedAlt)) { s.row = 0; s.col = 0; s.fg = DEFAULT; s.bg = DEFAULT; s.flags = 0; s.origin = false; s.autowrap = true; s.g0 = 0; s.g1 = 0; s.shiftG1 = false }
        dirty = true
    }

    /** Clear the visible screen and home the cursor (history kept). */
    fun clearScreen() {
        for (r in buf) r.fill(DEFAULT, DEFAULT)
        cursorRow = 0; cursorCol = 0; pendingWrap = false
        dirty = true
    }

    fun clearScrollback() { scrollback.clear(); dirty = true }

    /* ------------------------------ resize -------------------------------- */

    fun resize(newCols: Int, newRows: Int) {
        val nc = newCols.coerceAtLeast(1)
        val nr = newRows.coerceAtLeast(1)
        if (nc == cols && nr == rows) return

        // Alternate screen: clip / pad (full-screen programs redraw on SIGWINCH).
        val newAlt = Array(nr) { Row(nc) }
        for (y in 0 until minOf(nr, rows)) newAlt[y].copyFrom(alt[y])
        if (isAltScreen) { cursorRow = cursorRow.coerceIn(0, nr - 1); cursorCol = cursorCol.coerceIn(0, nc - 1) }

        // Primary screen + history: reflow logical lines.
        val curRow = if (isAltScreen) mainCursorRow else cursorRow
        val curCol = if (isAltScreen) mainCursorCol else cursorCol
        val reflowed = reflow(nc, nr, curRow, curCol)
        screen = reflowed.screen
        if (isAltScreen) {
            // The cursor saved by DECSET 1049 is the primary cursor; keep it in sync so leaving
            // the alternate screen restores the reflowed position, not a stale one.
            if (savedMain.row == curRow && savedMain.col == curCol) { savedMain.row = reflowed.cursorRow; savedMain.col = reflowed.cursorCol }
            mainCursorRow = reflowed.cursorRow; mainCursorCol = reflowed.cursorCol
        } else { cursorRow = reflowed.cursorRow; cursorCol = reflowed.cursorCol }
        alt = newAlt

        val oldStops = tabStops
        tabStops = BooleanArray(nc) { i -> if (i < oldStops.size) oldStops[i] else i % 8 == 0 }
        cols = nc; rows = nr
        scrollTop = 0; scrollBottom = nr - 1
        pendingWrap = if (isAltScreen) false else reflowed.pendingWrap
        for (s in arrayOf(savedMain, savedAlt)) { s.row = s.row.coerceIn(0, nr - 1); s.col = s.col.coerceIn(0, nc - 1) }
        trimScrollback()
        dirty = true
    }

    private class Reflowed(val screen: Array<Row>, val cursorRow: Int, val cursorCol: Int, val pendingWrap: Boolean)

    private fun reflow(nc: Int, nr: Int, curRow: Int, curCol: Int): Reflowed {
        // Gather all physical rows (history + screen), dropping blank rows below the
        // cursor at the bottom of the screen (they are re-padded afterwards).
        val phys = ArrayList<Row>(scrollback.size + rows)
        phys.addAll(scrollback)
        var lastKeep = rows - 1
        while (lastKeep > curRow && screen[lastKeep].isBlank() && !screen[lastKeep - 1].wrapped) lastKeep--
        for (y in 0..lastKeep) phys.add(screen[y])
        val cursorPhys = scrollback.size + curRow

        val out = ArrayList<Row>(phys.size + 8)
        var outCursorRow = -1
        var outCursorCol = 0
        var outPending = false

        var i = 0
        while (i < phys.size) {
            // One logical line = a run of rows joined by `wrapped`.
            val start = i
            var end = i
            while (end < phys.size - 1 && phys[end].wrapped) end++
            var cursorUnits = -1
            if (cursorPhys in start..end) {
                cursorUnits = 0
                for (k in start until cursorPhys) cursorUnits += phys[k].cols
                cursorUnits += curCol
            }
            // Lay the line's cells out at the new width.
            var row = Row(nc)
            val lineStart = out.size
            out.add(row)
            var x = 0
            var units = 0 // column units consumed so far (wide = 2)
            fun placeCursorIfHere() {
                if (cursorUnits >= 0 && outCursorRow < 0 && units >= cursorUnits) {
                    outCursorRow = out.size - 1
                    outCursorCol = x - (units - cursorUnits)
                    if (outCursorCol < 0) outCursorCol = 0
                }
            }
            for (k in start..end) {
                val src = phys[k]
                val limit = if (k == end) src.contentEnd() else src.cols
                var c = 0
                while (c < limit) {
                    val code = src.codes[c]
                    if (code == 0) { c++; continue }
                    val wide = src.flags[c] and WIDE != 0 && c + 1 < src.cols
                    val w = if (wide) 2 else 1
                    placeCursorIfHere()
                    if (x + w > nc) {
                        if (w == 2 && nc < 2) { c++; continue }
                        row.wrapped = true
                        row = Row(nc); out.add(row); x = 0
                    }
                    row.set(x, code, src.fg[c], src.bg[c], src.flags[c] and CONTINUATION.inv())
                    src.combining(c)?.let { row.setCombining(x, it) }
                    if (wide) row.set(x + 1, 0, src.fg[c], src.bg[c], src.flags[c] and WIDE.inv() or CONTINUATION)
                    x += w; units += w
                    c += w
                }
                // Units of the source row that were blank-trimmed still count toward the cursor offset.
                if (k != end || cursorUnits >= 0) units += (src.cols - limit).coerceAtLeast(0).let { if (k == end) 0 else it }
                if (k < end) {
                    // Continuation rows: the trailing blanks of a wrapped row are real cells.
                    val pad = src.cols - limit
                    var p = 0
                    while (p < pad) {
                        placeCursorIfHere()
                        if (x >= nc) { row.wrapped = true; row = Row(nc); out.add(row); x = 0 }
                        x++; units++; p++
                    }
                }
            }
            if (cursorUnits >= 0 && outCursorRow < 0) {
                // Cursor sits after the content (e.g. after a trimmed prompt space).
                var col = x + (cursorUnits - units)
                var r = out.size - 1
                if (col == nc && nc > 1) {
                    // Exactly past a full row: keep the cursor on the last cell with a pending wrap (xterm),
                    // rather than opening a blank row that would scroll content away.
                    outCursorRow = r; outCursorCol = nc - 1; outPending = true
                } else {
                    while (col >= nc) { col -= nc; out[r].wrapped = true; out.add(Row(nc)); r++ }
                    outCursorRow = r; outCursorCol = col.coerceIn(0, nc - 1)
                }
            }
            if (lineStart >= 0 && out.isNotEmpty()) out[out.size - 1].wrapped = false
            i = end + 1
        }
        if (out.isEmpty()) out.add(Row(nc))
        if (outCursorRow < 0) { outCursorRow = out.size - 1; outCursorCol = 0 }

        // Split into history and the new screen so the cursor is visible.
        var screenStart = out.size - nr
        if (screenStart > outCursorRow) screenStart = outCursorRow
        if (screenStart < 0) screenStart = 0
        scrollback.clear()
        for (k in 0 until screenStart) scrollback.addLast(out[k])
        val newScreen = Array(nr) { y -> val idx = screenStart + y; if (idx < out.size) out[idx] else Row(nc) }
        val cr = (outCursorRow - screenStart).coerceIn(0, nr - 1)
        return Reflowed(newScreen, cr, outCursorCol.coerceIn(0, nc - 1), outPending)
    }

    /* ------------------------------ readout ------------------------------- */

    fun totalRows(): Int = if (isAltScreen) rows else scrollback.size + rows

    fun rowAt(index: Int): Row {
        if (isAltScreen) return alt[index.coerceIn(0, rows - 1)]
        val sb = scrollback.size
        return if (index < sb) scrollback[index.coerceAtLeast(0)] else screen[(index - sb).coerceIn(0, rows - 1)]
    }

    fun cursorAbsRow(): Int = if (isAltScreen) cursorRow else scrollback.size + cursorRow

    fun rowText(index: Int, trimEnd: Boolean = true): String = rowAt(index).text(trimEnd)

    /**
     * A soft-wrapped row whose last cell is blank while the continuation starts with a
     * wide glyph carries one cell of wrap padding, which is not content.
     */
    private fun wrapPadding(index: Int, row: Row): Int {
        if (!row.wrapped || row.cols == 0 || index + 1 >= totalRows()) return 0
        val next = rowAt(index + 1)
        val last = row.cols - 1
        return if (row.codes[last] == Row.BLANK && row.combining(last) == null && next.cols > 0 && next.flags[0] and WIDE != 0) 1 else 0
    }

    /** Whole buffer as text; soft-wrapped rows are joined without a newline. */
    fun renderText(): String {
        val sb = StringBuilder()
        val total = totalRows()
        for (i in 0 until total) {
            val row = rowAt(i)
            row.appendText(sb, 0, row.cols - wrapPadding(i, row), !row.wrapped)
            if (!row.wrapped && i < total - 1) sb.append('\n')
        }
        return sb.toString()
    }

    /** Text of an inclusive selection in absolute row coordinates. */
    fun textBetween(fromRow: Int, fromCol: Int, toRow: Int, toCol: Int): String {
        var r0 = fromRow; var c0 = fromCol; var r1 = toRow; var c1 = toCol
        if (r1 < r0 || (r1 == r0 && c1 < c0)) { r0 = toRow; c0 = toCol; r1 = fromRow; c1 = fromCol }
        val total = totalRows()
        r0 = r0.coerceIn(0, total - 1); r1 = r1.coerceIn(0, total - 1)
        val sb = StringBuilder()
        for (r in r0..r1) {
            val row = rowAt(r)
            var a = if (r == r0) c0.coerceIn(0, row.cols) else 0
            val b = if (r == r1) (c1 + 1).coerceIn(0, row.cols) else row.cols - wrapPadding(r, row)
            if (a < row.cols && row.flags[a] and CONTINUATION != 0) a--
            val last = r == r1
            row.appendText(sb, a.coerceAtLeast(0), b, trimEnd = !row.wrapped || last)
            if (!last && !row.wrapped) sb.append('\n')
        }
        return sb.toString()
    }

    fun consumeDirty(): Boolean { val d = dirty; dirty = false; return d }

    /* ------------------------------- mouse -------------------------------- */

    fun mouseReport(kind: Int, col: Int, row: Int, button: Int, shift: Boolean = false, alt: Boolean = false, ctrl: Boolean = false): String? {
        if (mouseMode == MOUSE_OFF) return null
        var code: Int
        var release = false
        when (kind) {
            MOUSE_EVENT_PRESS -> { code = button.coerceIn(0, 2); mouseButtonHeld = code }
            MOUSE_EVENT_RELEASE -> { code = if (mouseSgr) button.coerceIn(0, 2) else 3; release = true; mouseButtonHeld = -1 }
            MOUSE_EVENT_MOTION -> {
                if (mouseMode == MOUSE_PRESS) return null
                if (mouseMode == MOUSE_BUTTON && mouseButtonHeld < 0) return null
                code = 32 + (if (mouseButtonHeld < 0) 3 else mouseButtonHeld)
            }
            MOUSE_EVENT_WHEEL_UP -> code = 64
            MOUSE_EVENT_WHEEL_DOWN -> code = 65
            else -> return null
        }
        if (shift) code += 4
        if (alt) code += 8
        if (ctrl) code += 16
        val x = col.coerceAtLeast(0) + 1
        val y = row.coerceAtLeast(0) + 1
        return if (mouseSgr) {
            "[<$code;$x;$y${if (release) 'm' else 'M'}"
        } else {
            val cx = x.coerceAtMost(223); val cy = y.coerceAtMost(223)
            "[M" + (32 + code).toChar() + (32 + cx).toChar() + (32 + cy).toChar()
        }
    }

    /* ------------------------------ helpers ------------------------------- */

    private fun base64Decode(s: String): String? {
        val out = java.io.ByteArrayOutputStream(s.length * 3 / 4 + 3)
        var acc = 0; var bits = 0
        for (ch in s) {
            val v = when (ch) {
                in 'A'..'Z' -> ch - 'A'
                in 'a'..'z' -> ch - 'a' + 26
                in '0'..'9' -> ch - '0' + 52
                '+', '-' -> 62
                '/', '_' -> 63
                '=', '\n', '\r', ' ' -> continue
                else -> return null
            }
            acc = (acc shl 6) or v; bits += 6
            if (bits >= 8) { bits -= 8; out.write((acc shr bits) and 0xFF) }
        }
        return String(out.toByteArray(), Charsets.UTF_8)
    }

    companion object {
        const val DEFAULT = -1
        const val TRUECOLOR = 1 shl 24

        const val BOLD = 1
        const val DIM = 1 shl 1
        const val ITALIC = 1 shl 2
        const val UNDERLINE = 1 shl 3
        const val BLINK = 1 shl 4
        const val REVERSE = 1 shl 5
        const val HIDDEN = 1 shl 6
        const val STRIKE = 1 shl 7
        const val WIDE = 1 shl 8
        const val CONTINUATION = 1 shl 9

        const val CURSOR_BLOCK = 0
        const val CURSOR_UNDERLINE = 1
        const val CURSOR_BAR = 2

        const val MOUSE_OFF = 0
        const val MOUSE_PRESS = 1000
        const val MOUSE_BUTTON = 1002
        const val MOUSE_ANY = 1003

        const val MOUSE_EVENT_PRESS = 0
        const val MOUSE_EVENT_RELEASE = 1
        const val MOUSE_EVENT_MOTION = 2
        const val MOUSE_EVENT_WHEEL_UP = 3
        const val MOUSE_EVENT_WHEEL_DOWN = 4

        private const val ESC = 0x1B
        private const val BEL = 0x07
        private const val REPLACEMENT = 0xFFFD
        private const val NO_COLOR = Int.MIN_VALUE
        private const val MAX_PARAMS = 32
        private const val MAX_OSC = 4096

        /** DEC special graphics for 0x60..0x7E (ESC ( 0). */
        private val DEC_SPECIAL = intArrayOf(
            0x25C6, 0x2592, 0x2409, 0x240C, 0x240D, 0x240A, 0x00B0, 0x00B1, 0x2424, 0x240B,
            0x2518, 0x2510, 0x250C, 0x2514, 0x253C, 0x23BA, 0x23BB, 0x2500, 0x23BC, 0x23BD,
            0x251C, 0x2524, 0x2534, 0x252C, 0x2502, 0x2264, 0x2265, 0x03C0, 0x2260, 0x00A3, 0x00B7,
        )
    }
}
