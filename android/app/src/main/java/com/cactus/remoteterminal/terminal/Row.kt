package com.cactus.remoteterminal.terminal

/**
 * One terminal row backed by parallel IntArrays (no per-cell objects).
 *
 * `codes[col]` is the code point shown in the cell (' ' for blank, 0 for the
 * right half of a wide glyph whose left half carries [TerminalEmulator.WIDE]).
 * Combining marks are rare, so they live in a lazily created map keyed by column.
 */
class Row(val cols: Int) {
    val codes = IntArray(cols) { BLANK }
    val fg = IntArray(cols) { TerminalEmulator.DEFAULT }
    val bg = IntArray(cols) { TerminalEmulator.DEFAULT }
    val flags = IntArray(cols)

    /** This row continues on the next one (soft wrap); used by reflow and selection. */
    var wrapped = false

    private var combiningMap: HashMap<Int, String>? = null

    fun combining(col: Int): String? = combiningMap?.get(col)

    fun setCombining(col: Int, marks: String?) {
        if (marks == null) { combiningMap?.remove(col); return }
        val m = combiningMap ?: HashMap<Int, String>().also { combiningMap = it }
        m[col] = marks
    }

    fun appendCombining(col: Int, mark: String) {
        val m = combiningMap ?: HashMap<Int, String>().also { combiningMap = it }
        val prev = m[col]
        m[col] = if (prev == null) mark else if (prev.length >= 16) prev else prev + mark
    }

    fun hasCombining(): Boolean = !combiningMap.isNullOrEmpty()

    fun set(col: Int, code: Int, fgc: Int, bgc: Int, fl: Int) {
        codes[col] = code; fg[col] = fgc; bg[col] = bgc; flags[col] = fl
        combiningMap?.remove(col)
    }

    /** Blank one cell with the given colours (background colour erase). */
    fun clear(col: Int, fgc: Int, bgc: Int) {
        codes[col] = BLANK; fg[col] = fgc; bg[col] = bgc; flags[col] = 0
        combiningMap?.remove(col)
    }

    /** Blank [from, to) with the given colours. */
    fun clearRange(from: Int, to: Int, fgc: Int, bgc: Int) {
        val a = from.coerceAtLeast(0)
        val b = to.coerceAtMost(cols)
        for (c in a until b) { codes[c] = BLANK; fg[c] = fgc; bg[c] = bgc; flags[c] = 0 }
        val m = combiningMap
        if (m != null && m.isNotEmpty()) for (c in a until b) m.remove(c)
    }

    fun fill(fgc: Int, bgc: Int) { clearRange(0, cols, fgc, bgc); wrapped = false }

    /** Copy cells [src, src+count) to [dst, dst+count) within this row (overlap-safe). */
    fun moveCells(src: Int, dst: Int, count: Int) {
        if (count <= 0 || src == dst) return
        System.arraycopy(codes, src, codes, dst, count)
        System.arraycopy(fg, src, fg, dst, count)
        System.arraycopy(bg, src, bg, dst, count)
        System.arraycopy(flags, src, flags, dst, count)
        val m = combiningMap
        if (m != null && m.isNotEmpty()) {
            val moved = HashMap<Int, String>()
            for ((k, v) in m) {
                if (k in src until src + count) moved[k - src + dst] = v
                else if (k !in dst until dst + count) moved[k] = v
            }
            combiningMap = moved
        }
    }

    fun copyFrom(other: Row) {
        val n = minOf(cols, other.cols)
        System.arraycopy(other.codes, 0, codes, 0, n)
        System.arraycopy(other.fg, 0, fg, 0, n)
        System.arraycopy(other.bg, 0, bg, 0, n)
        System.arraycopy(other.flags, 0, flags, 0, n)
        if (n < cols) clearRange(n, cols, TerminalEmulator.DEFAULT, TerminalEmulator.DEFAULT)
        wrapped = other.wrapped
        combiningMap = null
        val om = other.combiningMap
        if (om != null && om.isNotEmpty()) for ((k, v) in om) if (k < n) setCombining(k, v)
    }

    /** True when the cell is visually empty (blank glyph, default background, no attributes). */
    fun isBlankCell(col: Int): Boolean =
        codes[col] == BLANK && bg[col] == TerminalEmulator.DEFAULT && (flags[col] and (TerminalEmulator.UNDERLINE or TerminalEmulator.REVERSE or TerminalEmulator.STRIKE)) == 0 && combining(col) == null

    fun isBlank(): Boolean {
        for (c in 0 until cols) if (!isBlankCell(c)) return false
        return true
    }

    /** Index after the last non-blank cell (0 when the row is blank). */
    fun contentEnd(): Int {
        var end = cols
        while (end > 0 && isBlankCell(end - 1)) end--
        return end
    }

    /** Row text; continuation cells are skipped and combining marks are included. */
    fun text(trimEnd: Boolean = true): String = textRange(0, cols, trimEnd)

    fun textRange(from: Int, to: Int, trimEnd: Boolean): String {
        val sb = StringBuilder()
        appendText(sb, from, to, trimEnd)
        return sb.toString()
    }

    fun appendText(sb: StringBuilder, from: Int, to: Int, trimEnd: Boolean) {
        val a = from.coerceAtLeast(0)
        var b = to.coerceAtMost(cols)
        if (trimEnd) while (b > a && codes[b - 1] == BLANK && combining(b - 1) == null) b--
        for (c in a until b) {
            val code = codes[c]
            if (code == 0) continue // continuation of a wide glyph
            sb.appendCodePoint(code)
            combining(c)?.let { sb.append(it) }
        }
    }

    companion object {
        const val BLANK = ' '.code
    }
}
