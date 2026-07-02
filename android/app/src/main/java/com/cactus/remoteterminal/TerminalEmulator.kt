package com.cactus.remoteterminal

/**
 * A grid-based VT/ANSI terminal emulator.
 *
 * Unlike the original [TerminalBuffer] (which stripped every escape sequence),
 * this parses CSI/SGR/OSC sequences and maintains a real screen grid with
 * per-cell colours and attributes, a cursor, a scroll region, and an alternate
 * screen buffer — enough for colourful shells and full-screen TUIs (vim, htop,
 * less) to render.
 *
 * It is deliberately self-contained (no third-party deps) and mutated/read only
 * from the UI thread. [TerminalView] draws the grid; [MainActivity] feeds bytes.
 */
class TerminalEmulator(
    cols: Int = 80,
    rows: Int = 24,
    private val maxScrollback: Int = 2000,
) {
    /* ------------------------------ cell model ---------------------------- */

    /** Colour encoding: -1 = default, 0..255 = palette index, >=TRUECOLOR = ARGB. */
    class Cell(
        var code: Int = ' '.code,
        var fg: Int = DEFAULT,
        var bg: Int = DEFAULT,
        var flags: Int = 0,
    ) {
        fun set(code: Int, fg: Int, bg: Int, flags: Int) {
            this.code = code; this.fg = fg; this.bg = bg; this.flags = flags
        }
        fun blank(fg: Int, bg: Int) { code = ' '.code; this.fg = fg; this.bg = bg; flags = 0 }
        fun copyFrom(o: Cell) { code = o.code; fg = o.fg; bg = o.bg; flags = o.flags }
    }

    var cols = cols; private set
    var rows = rows; private set

    private var screen = alloc(rows, cols)
    private var alt = alloc(rows, cols)
    private var onAlt = false
    private val scrollback = ArrayDeque<Array<Cell>>()

    // Cursor + graphics state.
    var cursorRow = 0; private set
    var cursorCol = 0; private set
    var cursorVisible = true; private set
    private var curFg = DEFAULT
    private var curBg = DEFAULT
    private var curFlags = 0
    private var pendingWrap = false
    private var autowrap = true

    private var scrollTop = 0
    private var scrollBottom = rows - 1
    private var savedRow = 0
    private var savedCol = 0
    private var savedFg = DEFAULT
    private var savedBg = DEFAULT
    private var savedFlags = 0

    /** Set by the host to send replies (DSR / cursor reports) back to the shell. */
    var onResponse: ((String) -> Unit)? = null
    /** Notified when the alternate screen is entered/left (host uses it for key mode). */
    var onAltScreen: ((Boolean) -> Unit)? = null

    val isAltScreen: Boolean get() = onAlt

    private fun alloc(r: Int, c: Int) = Array(r) { Array(c) { Cell() } }

    /* ------------------------------ resize -------------------------------- */

    fun resize(newCols: Int, newRows: Int) {
        if (newCols == cols && newRows == rows) return
        if (newCols < 1 || newRows < 1) return
        screen = reshape(screen, newRows, newCols)
        alt = reshape(alt, newRows, newCols)
        cols = newCols; rows = newRows
        scrollTop = 0; scrollBottom = rows - 1
        cursorRow = cursorRow.coerceIn(0, rows - 1)
        cursorCol = cursorCol.coerceIn(0, cols - 1)
        pendingWrap = false
    }

    private fun reshape(old: Array<Array<Cell>>, r: Int, c: Int): Array<Array<Cell>> {
        val grid = alloc(r, c)
        for (y in 0 until minOf(r, old.size)) {
            val src = old[y]
            for (x in 0 until minOf(c, src.size)) grid[y][x].copyFrom(src[x])
        }
        return grid
    }

    /* ------------------------------- parser ------------------------------- */

    private enum class S { GROUND, ESC, CSI, OSC, OSC_ESC, CHARSET }
    private var state = S.GROUND
    private val params = StringBuilder(32)
    private var priv = false
    private val osc = StringBuilder(64)

    fun feed(text: String) {
        var i = 0
        while (i < text.length) {
            val ch = text[i]; i++
            when (state) {
                S.GROUND -> ground(ch)
                S.ESC -> esc(ch)
                S.CSI -> csi(ch)
                S.OSC -> if (ch == BEL) { finishOsc(); state = S.GROUND }
                         else if (ch == ESC) state = S.OSC_ESC
                         else osc.append(ch)
                S.OSC_ESC -> { if (ch == '\\') finishOsc(); state = S.GROUND }
                S.CHARSET -> state = S.GROUND // consume the designator byte, ignore
            }
        }
    }

    private fun ground(ch: Char) {
        when (ch) {
            ESC -> { state = S.ESC; params.setLength(0); priv = false }
            '\r' -> { cursorCol = 0; pendingWrap = false }
            '\n', 0x0B.toChar(), 0x0C.toChar() -> lineFeed()
            '\b' -> { if (cursorCol > 0) cursorCol--; pendingWrap = false }
            '\t' -> { val n = 8 - (cursorCol % 8); repeat(n) { if (cursorCol < cols - 1) cursorCol++ } }
            BEL -> {}
            0x0E.toChar(), 0x0F.toChar() -> {} // SO/SI charset shifts, ignored
            else -> if (ch.code >= 32) putChar(ch)
        }
    }

    private fun esc(ch: Char) {
        when (ch) {
            '[' -> { state = S.CSI; params.setLength(0); priv = false }
            ']' -> { state = S.OSC; osc.setLength(0) }
            '(' , ')', '*', '+' -> state = S.CHARSET
            '7' -> { saveCursor(); state = S.GROUND }
            '8' -> { restoreCursor(); state = S.GROUND }
            'D' -> { index(); state = S.GROUND }
            'M' -> { reverseIndex(); state = S.GROUND }
            'E' -> { cursorCol = 0; lineFeed(); state = S.GROUND }
            'c' -> { hardReset(); state = S.GROUND }
            '=', '>' -> state = S.GROUND // keypad modes, ignored
            else -> state = S.GROUND
        }
    }

    private fun csi(ch: Char) {
        if (ch == '?') { priv = true; return }
        if (ch in '0'..'9' || ch == ';') { params.append(ch); return }
        if (ch in ' '..'/') return // intermediates, ignored
        dispatchCsi(ch)
        state = S.GROUND
    }

    private fun pget(idx: Int, def: Int): Int {
        val parts = params.toString().split(';')
        if (idx >= parts.size) return def
        val v = parts[idx].toIntOrNull() ?: return def
        return v
    }
    private fun pcount() = if (params.isEmpty()) 0 else params.toString().split(';').size

    private fun dispatchCsi(ch: Char) {
        when (ch) {
            'A' -> moveCursor(-pget(0, 1).coerceAtLeast(1), 0)
            'B' -> moveCursor(pget(0, 1).coerceAtLeast(1), 0)
            'C' -> moveCursor(0, pget(0, 1).coerceAtLeast(1))
            'D' -> moveCursor(0, -pget(0, 1).coerceAtLeast(1))
            'E' -> { cursorRow = (cursorRow + pget(0, 1)).coerceAtMost(rows - 1); cursorCol = 0 }
            'F' -> { cursorRow = (cursorRow - pget(0, 1)).coerceAtLeast(0); cursorCol = 0 }
            'G', '`' -> { cursorCol = (pget(0, 1) - 1).coerceIn(0, cols - 1); pendingWrap = false }
            'd' -> { cursorRow = (pget(0, 1) - 1).coerceIn(0, rows - 1) }
            'H', 'f' -> {
                cursorRow = (pget(0, 1) - 1).coerceIn(0, rows - 1)
                cursorCol = (pget(1, 1) - 1).coerceIn(0, cols - 1)
                pendingWrap = false
            }
            'J' -> eraseDisplay(pget(0, 0))
            'K' -> eraseLine(pget(0, 0))
            'L' -> insertLines(pget(0, 1).coerceAtLeast(1))
            'M' -> deleteLines(pget(0, 1).coerceAtLeast(1))
            'P' -> deleteChars(pget(0, 1).coerceAtLeast(1))
            '@' -> insertChars(pget(0, 1).coerceAtLeast(1))
            'X' -> eraseChars(pget(0, 1).coerceAtLeast(1))
            'S' -> repeat(pget(0, 1).coerceAtLeast(1)) { scrollUp() }
            'T' -> repeat(pget(0, 1).coerceAtLeast(1)) { scrollDown() }
            'm' -> applySgr()
            'r' -> {
                scrollTop = (pget(0, 1) - 1).coerceIn(0, rows - 1)
                scrollBottom = (pget(1, rows) - 1).coerceIn(scrollTop, rows - 1)
                cursorRow = 0; cursorCol = 0
            }
            'h' -> setMode(true)
            'l' -> setMode(false)
            's' -> saveCursor()
            'u' -> restoreCursor()
            'n' -> if (pget(0, 0) == 6) onResponse?.invoke("$ESC[${cursorRow + 1};${cursorCol + 1}R")
            else -> {}
        }
    }

    private fun setMode(on: Boolean) {
        if (!priv) return
        when (pget(0, 0)) {
            25 -> cursorVisible = on
            7 -> autowrap = on
            47, 1047 -> switchAlt(on)
            1049 -> { if (on) saveCursor(); switchAlt(on); if (!on) restoreCursor() }
            else -> {} // mouse/bracketed-paste/etc: ignored
        }
    }

    /* ------------------------------ printing ------------------------------ */

    private fun putChar(ch: Char) {
        if (pendingWrap && autowrap) { cursorCol = 0; lineFeed(); pendingWrap = false }
        cur()[cursorRow][cursorCol].set(ch.code, effFg(), curBg, curFlags)
        if (cursorCol >= cols - 1) pendingWrap = true else cursorCol++
    }

    /** Bold brightens the 8 base fg colours, matching common xterm behaviour. */
    private fun effFg(): Int =
        if (curFlags and BOLD != 0 && curFg in 0..7) curFg + 8 else curFg

    private fun cur() = if (onAlt) alt else screen

    private fun lineFeed() {
        if (cursorRow == scrollBottom) scrollUp()
        else if (cursorRow < rows - 1) cursorRow++
    }

    private fun index() = lineFeed()

    private fun reverseIndex() {
        if (cursorRow == scrollTop) scrollDown()
        else if (cursorRow > 0) cursorRow--
    }

    /* ------------------------------ scrolling ----------------------------- */

    private fun scrollUp() {
        val g = cur()
        val top = g[scrollTop]
        // Primary screen: the line leaving the top of a full-height region is
        // pushed into scrollback so history is preserved.
        if (!onAlt && scrollTop == 0 && scrollBottom == rows - 1) pushScrollback(top)
        for (y in scrollTop until scrollBottom) g[y] = g[y + 1]
        g[scrollBottom] = top
        blankRow(g[scrollBottom])
    }

    private fun scrollDown() {
        val g = cur()
        val bottom = g[scrollBottom]
        for (y in scrollBottom downTo scrollTop + 1) g[y] = g[y - 1]
        g[scrollTop] = bottom
        blankRow(g[scrollTop])
    }

    private fun pushScrollback(row: Array<Cell>) {
        // Store a trimmed copy (trailing blanks dropped) to bound memory use.
        var end = row.size
        while (end > 0 && row[end - 1].code == ' '.code && row[end - 1].bg == DEFAULT) end--
        val copy = Array(end) { Cell().apply { copyFrom(row[it]) } }
        scrollback.addLast(copy)
        while (scrollback.size > maxScrollback) scrollback.removeFirst()
    }

    private fun blankRow(row: Array<Cell>) { for (c in row) c.blank(curFg, curBg) }

    /* ------------------------------- erase -------------------------------- */

    private fun eraseDisplay(mode: Int) {
        val g = cur()
        when (mode) {
            0 -> { eraseLine(0); for (y in cursorRow + 1 until rows) blankRow(g[y]) }
            1 -> { for (y in 0 until cursorRow) blankRow(g[y]); eraseLine(1) }
            2, 3 -> { for (y in 0 until rows) blankRow(g[y]); if (mode == 3) scrollback.clear() }
        }
    }

    private fun eraseLine(mode: Int) {
        val row = cur()[cursorRow]
        val range = when (mode) {
            0 -> cursorCol until cols
            1 -> 0..cursorCol
            else -> 0 until cols
        }
        for (x in range) row[x].blank(curFg, curBg)
    }

    private fun eraseChars(n: Int) {
        val row = cur()[cursorRow]
        for (x in cursorCol until minOf(cols, cursorCol + n)) row[x].blank(curFg, curBg)
    }

    private fun insertChars(n: Int) {
        val row = cur()[cursorRow]
        for (x in cols - 1 downTo cursorCol + n) row[x].copyFrom(row[x - n])
        for (x in cursorCol until minOf(cols, cursorCol + n)) row[x].blank(curFg, curBg)
    }

    private fun deleteChars(n: Int) {
        val row = cur()[cursorRow]
        for (x in cursorCol until cols) {
            if (x + n < cols) row[x].copyFrom(row[x + n]) else row[x].blank(curFg, curBg)
        }
    }

    private fun insertLines(n: Int) {
        if (cursorRow < scrollTop || cursorRow > scrollBottom) return
        val g = cur()
        repeat(n.coerceAtMost(scrollBottom - cursorRow + 1)) {
            val bottom = g[scrollBottom]
            for (y in scrollBottom downTo cursorRow + 1) g[y] = g[y - 1]
            g[cursorRow] = bottom; blankRow(g[cursorRow])
        }
    }

    private fun deleteLines(n: Int) {
        if (cursorRow < scrollTop || cursorRow > scrollBottom) return
        val g = cur()
        repeat(n.coerceAtMost(scrollBottom - cursorRow + 1)) {
            val top = g[cursorRow]
            for (y in cursorRow until scrollBottom) g[y] = g[y + 1]
            g[scrollBottom] = top; blankRow(g[scrollBottom])
        }
    }

    /* ------------------------------ cursor -------------------------------- */

    private fun moveCursor(dRow: Int, dCol: Int) {
        cursorRow = (cursorRow + dRow).coerceIn(0, rows - 1)
        cursorCol = (cursorCol + dCol).coerceIn(0, cols - 1)
        pendingWrap = false
    }

    private fun saveCursor() {
        savedRow = cursorRow; savedCol = cursorCol
        savedFg = curFg; savedBg = curBg; savedFlags = curFlags
    }

    private fun restoreCursor() {
        cursorRow = savedRow.coerceIn(0, rows - 1); cursorCol = savedCol.coerceIn(0, cols - 1)
        curFg = savedFg; curBg = savedBg; curFlags = savedFlags; pendingWrap = false
    }

    private fun switchAlt(toAlt: Boolean) {
        if (toAlt == onAlt) return
        onAlt = toAlt
        if (toAlt) for (row in alt) blankRow(row) // fresh alt screen
        cursorRow = 0; cursorCol = 0; pendingWrap = false
        onAltScreen?.invoke(toAlt)
    }

    private fun hardReset() {
        for (row in screen) blankRow(row)
        for (row in alt) blankRow(row)
        scrollback.clear()
        cursorRow = 0; cursorCol = 0; curFg = DEFAULT; curBg = DEFAULT; curFlags = 0
        scrollTop = 0; scrollBottom = rows - 1; onAlt = false; cursorVisible = true
    }

    /* -------------------------------- SGR --------------------------------- */

    private fun applySgr() {
        if (pcount() == 0) { curFg = DEFAULT; curBg = DEFAULT; curFlags = 0; return }
        val parts = params.toString().split(';')
        var i = 0
        while (i < parts.size) {
            when (val p = parts[i].toIntOrNull() ?: 0) {
                0 -> { curFg = DEFAULT; curBg = DEFAULT; curFlags = 0 }
                1 -> curFlags = curFlags or BOLD
                2 -> curFlags = curFlags or DIM
                3 -> curFlags = curFlags or ITALIC
                4 -> curFlags = curFlags or UNDERLINE
                5, 6 -> curFlags = curFlags or BLINK
                7 -> curFlags = curFlags or REVERSE
                8 -> curFlags = curFlags or HIDDEN
                9 -> curFlags = curFlags or STRIKE
                21, 22 -> curFlags = curFlags and (BOLD or DIM).inv()
                23 -> curFlags = curFlags and ITALIC.inv()
                24 -> curFlags = curFlags and UNDERLINE.inv()
                25 -> curFlags = curFlags and BLINK.inv()
                27 -> curFlags = curFlags and REVERSE.inv()
                28 -> curFlags = curFlags and HIDDEN.inv()
                29 -> curFlags = curFlags and STRIKE.inv()
                in 30..37 -> curFg = p - 30
                in 40..47 -> curBg = p - 40
                39 -> curFg = DEFAULT
                49 -> curBg = DEFAULT
                in 90..97 -> curFg = p - 90 + 8
                in 100..107 -> curBg = p - 100 + 8
                38 -> { val (col, adv) = extended(parts, i); curFg = col; i += adv }
                48 -> { val (col, adv) = extended(parts, i); curBg = col; i += adv }
            }
            i++
        }
    }

    /** Parse 38/48 extended colour: `;5;n` (indexed) or `;2;r;g;b` (truecolor). */
    private fun extended(parts: List<String>, i: Int): Pair<Int, Int> {
        val mode = parts.getOrNull(i + 1)?.toIntOrNull() ?: return DEFAULT to 1
        return when (mode) {
            5 -> (parts.getOrNull(i + 2)?.toIntOrNull()?.coerceIn(0, 255) ?: 0) to 2
            2 -> {
                val r = parts.getOrNull(i + 2)?.toIntOrNull() ?: 0
                val g = parts.getOrNull(i + 3)?.toIntOrNull() ?: 0
                val b = parts.getOrNull(i + 4)?.toIntOrNull() ?: 0
                (TRUECOLOR or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)) to 4
            }
            else -> DEFAULT to 1
        }
    }

    private fun finishOsc() { /* window titles etc. — parsed and ignored */ osc.setLength(0) }

    /* ------------------------------ readout ------------------------------- */

    /** Total displayable rows: scrollback history plus the live screen. */
    fun totalRows(): Int = scrollback.size + rows

    /** Row at an absolute index across scrollback (0..) then the live screen. */
    fun rowAt(index: Int): Array<Cell> {
        return if (index < scrollback.size) scrollback[index] else cur()[index - scrollback.size]
    }

    /** Absolute row index of the cursor (bottom of history). */
    fun cursorAbsRow(): Int = scrollback.size + cursorRow

    fun clear() {
        scrollback.clear()
        for (row in cur()) blankRow(row)
        cursorRow = 0; cursorCol = 0; pendingWrap = false
    }

    /** Plain-text dump of the whole buffer (used for select-all / copy). */
    fun renderText(): String = buildString {
        for (idx in 0 until totalRows()) {
            val row = rowAt(idx)
            var end = row.size
            while (end > 0 && row[end - 1].code == ' '.code) end--
            for (x in 0 until end) appendCodePoint(row[x].code)
            if (idx < totalRows() - 1) append('\n')
        }
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

        private const val ESC = '\u001B'
        private const val BEL = '\u0007'
    }
}
