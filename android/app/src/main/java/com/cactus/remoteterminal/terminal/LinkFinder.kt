package com.cactus.remoteterminal.terminal

/**
 * Links in terminal output, for "tap to open". The desktop app's
 * `terminal/links.js` is a port of this; keep the two in step.
 *
 * A link is `http://`, `https://`, `ftp://` or `file://` followed by anything
 * that is not whitespace, a quote, a backtick or an angle bracket. Punctuation
 * that ends a sentence (`.,;:!?'"`) is not part of it, and neither is a
 * closing bracket the link did not open — `(see https://x.org/a)` gives
 * `https://x.org/a`, while `https://en.wikipedia.org/wiki/Tree_(graph)` keeps
 * its parenthesis.
 *
 * Links are found on a *logical* line: rows joined across soft wraps, so a URL
 * the terminal broke over two rows is still one link.
 */
object LinkFinder {
    private val URL = Regex("(?:https?|ftp|file)://[^\\s<>\"'`]+")
    private const val TRAILING = ".,;:!?'\""
    private val PAIRS = mapOf(')' to '(', ']' to '[', '}' to '{')

    /** Character ranges [start, end) of the links in [line]. */
    fun find(line: String): List<IntRange> {
        val out = ArrayList<IntRange>()
        for (m in URL.findAll(line)) {
            val start = m.range.first
            var end = m.range.last + 1
            while (end > start) {
                val c = line[end - 1]
                if (c in TRAILING) { end--; continue }
                val open = PAIRS[c]
                if (open != null && unbalanced(line, start, end, open, c)) { end--; continue }
                break
            }
            // "https://" alone is not a link.
            if (line.substring(start, end).substringAfter("://").isNotEmpty()) out.add(start until end)
        }
        return out
    }

    private fun unbalanced(line: String, start: Int, end: Int, open: Char, close: Char): Boolean {
        var depth = 0
        for (i in start until end) {
            when (line[i]) { open -> depth++; close -> depth-- }
        }
        return depth < 0
    }

    /** The link covering [col] of [absRow] in [emulator], if any. */
    fun linkAt(emulator: TerminalEmulator, absRow: Int, col: Int): String? {
        val total = emulator.totalRows()
        if (absRow !in 0 until total) return null
        // Walk back to the first row of this logical line, then gather it.
        var first = absRow
        while (first > 0 && emulator.rowAt(first - 1).wrapped) first--
        val text = StringBuilder()
        val cellOf = ArrayList<Long>() // (row << 32) | col for each char
        var r = first
        while (r < total) {
            val row = emulator.rowAt(r)
            val end = if (row.wrapped) row.cols else row.contentEnd()
            for (c in 0 until end) {
                val code = row.codes[c]
                if (code == 0) continue // right half of a wide glyph
                val chars = Character.toChars(code)
                for (ch in chars) { text.append(ch); cellOf.add((r.toLong() shl 32) or c.toLong()) }
                row.combining(c)?.let { marks -> for (ch in marks) { text.append(ch); cellOf.add((r.toLong() shl 32) or c.toLong()) } }
            }
            if (!row.wrapped) break
            r++
        }
        val target = (absRow.toLong() shl 32) or col.toLong()
        for (range in find(text.toString())) {
            val a = cellOf[range.first]
            val b = cellOf[range.last]
            if (target in a..b) return text.substring(range.first, range.last + 1)
        }
        return null
    }
}
