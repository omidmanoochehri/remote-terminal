package com.cactus.remoteterminal

/**
 * A deliberately small terminal model. It is NOT a full ANSI emulator — it
 * strips escape sequences and handles the control characters a normal shell
 * echo produces (CR, LF, BS, TAB) so the prompt and command output read
 * correctly.
 *
 * Lines are kept in a bounded scrollback. render() returns the whole visible
 * buffer as plain text for the output TextView.
 */
class TerminalBuffer(private val maxLines: Int = 3000) {

    private val lines = ArrayList<StringBuilder>().apply { add(StringBuilder()) }
    private var col = 0 // cursor column within the last line

    private fun cur(): StringBuilder = lines[lines.size - 1]

    /** Feed raw PTY text; ANSI escapes are stripped, control chars applied. */
    fun feed(raw: String) {
        val text = stripAnsi(raw)
        var i = 0
        while (i < text.length) {
            when (val c = text[i]) {
                '\r' -> col = 0
                '\n' -> {
                    lines.add(StringBuilder())
                    col = 0
                    trim()
                }
                '\b' -> if (col > 0) col--
                '\t' -> {
                    val spaces = 8 - (col % 8)
                    repeat(spaces) { putChar(' ') }
                }
                else -> if (c.code >= 32) putChar(c)
            }
            i++
        }
    }

    private fun putChar(c: Char) {
        val line = cur()
        if (col < line.length) {
            line.setCharAt(col, c) // overwrite (handles cursor moves / redraws)
        } else {
            while (line.length < col) line.append(' ')
            line.append(c)
        }
        col++
    }

    private fun trim() {
        while (lines.size > maxLines) lines.removeAt(0)
    }

    fun render(): String = buildString {
        for (idx in lines.indices) {
            append(lines[idx])
            if (idx < lines.size - 1) append('\n')
        }
    }

    fun clear() {
        lines.clear()
        lines.add(StringBuilder())
        col = 0
    }

    companion object {
        // Build control chars from code points so the source stays plain ASCII.
        private val ESC = 27.toChar().toString()
        private val BEL = 7.toChar().toString()

        // CSI: ESC [ params intermediates final. Colors, cursor moves, erase…
        private val CSI = Regex(ESC + "\\[[0-9;?]*[ -/]*[@-~]")
        // OSC: ESC ] ... terminated by BEL or ST (ESC \).
        private val OSC = Regex(ESC + "\\][^" + BEL + "]*(?:" + BEL + "|" + ESC + "\\\\)")
        // Any leftover escape: ESC plus an optional single Fe byte (@ .. _).
        private val OTHER_ESC = Regex(ESC + "[@-_]?")

        fun stripAnsi(s: String): String =
            s.replace(CSI, "")
                .replace(OSC, "")
                .replace(OTHER_ESC, "")
    }
}
