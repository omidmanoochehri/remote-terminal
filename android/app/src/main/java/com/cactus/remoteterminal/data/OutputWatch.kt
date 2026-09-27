package com.cactus.remoteterminal.data

/**
 * "Watch for text": does a terminal's live output contain [text]?
 *
 * Case-insensitive, and blind to colour and cursor escapes — `error` printed
 * in red is still `error`. Output arrives in arbitrary chunks, so the end of
 * each one is kept and the next is searched together with it: a match split
 * across two chunks is still a match, and one is never reported twice.
 */
class OutputWatch(val text: String, val keepWatching: Boolean) {
    private val needle = text.lowercase()
    private var tail = ""

    /** Feed one chunk of live output; true when it completes a match. */
    fun feed(chunk: String): Boolean {
        if (needle.isEmpty()) return false
        val hay = tail + stripEscapes(chunk).lowercase()
        val hit = hay.indexOf(needle)
        // Keep just enough to catch a match that straddles the next boundary;
        // after a hit, keep nothing of it so it is not found again.
        val keepFrom = if (hit >= 0) hit + needle.length else 0
        val rest = hay.substring(keepFrom)
        tail = if (rest.length >= needle.length) rest.substring(rest.length - (needle.length - 1)) else rest
        return hit >= 0
    }

    companion object {
        private val ESCAPES = Regex(
            "\u001B\\[[0-?]*[ -/]*[@-~]" +          // CSI: colours, cursor movement
                "|\u001B\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)" + // OSC: titles, hyperlinks
                "|\u001B[PX^_][^\u001B]*\u001B\\\\" +  // DCS / SOS / PM / APC
                "|\u001B[@-Z\\\\-_]" +                  // two-byte escapes
                "|[\u0000-\u0008\u000B-\u001F\u007F]",  // other controls (keep tab and newline)
        )

        fun stripEscapes(s: String): String = if (s.indexOf('\u001B') < 0 && s.none { it < ' ' && it != '\n' && it != '\t' }) s else ESCAPES.replace(s, "")
    }
}
