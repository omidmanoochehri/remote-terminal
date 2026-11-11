package com.cactus.remoteterminal.data

/**
 * "Watch for text": does a terminal's live output contain [text]?
 *
 * Case-insensitive, and blind to colour and cursor escapes — `error` printed
 * in red is still `error`. Output arrives in arbitrary chunks, so the end of
 * each one is kept and the next is searched together with it: a match split
 * across two chunks is still a match, and one is never reported twice.
 *
 * With [regex] the text is a regular expression (also case-insensitive). With
 * a [reply] the watch is a trigger: the reply is typed into the terminal when
 * it matches, at most once per [REPLY_INTERVAL_MS].
 */
class OutputWatch(
    val text: String,
    val keepWatching: Boolean,
    val regex: Boolean = false,
    /** Raw reply as the user wrote it (escapes not yet decoded); null or empty for a plain watch. */
    val reply: String? = null,
) {
    private val needle = text.lowercase()
    private val pattern: Regex? = if (regex) Regex(text, RegexOption.IGNORE_CASE) else null
    private var tail = ""
    private var lastReplyAt = Long.MIN_VALUE / 2

    val isTrigger: Boolean get() = !reply.isNullOrEmpty()

    /** Feed one chunk of live output; true when it completes a match. */
    fun feed(chunk: String): Boolean {
        pattern?.let { return feedRegex(it, chunk) }
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

    private fun feedRegex(p: Regex, chunk: String): Boolean {
        if (text.isEmpty()) return false
        val hay = tail + stripEscapes(chunk)
        // An expression that can match nothing (`x*`) would fire on every chunk; only real text counts.
        val m = p.findAll(hay).firstOrNull { it.value.isNotEmpty() }
        val rest = if (m != null) hay.substring(minOf(hay.length, m.range.last + 1)) else hay
        tail = if (rest.length > REGEX_TAIL) rest.substring(rest.length - REGEX_TAIL) else rest
        return m != null
    }

    /**
     * The decoded reply to type now, or null: not a trigger, or it already
     * replied less than [REPLY_INTERVAL_MS] ago.
     */
    fun replyNow(nowMs: Long): String? {
        if (!isTrigger) return null
        if (nowMs - lastReplyAt < REPLY_INTERVAL_MS) return null
        lastReplyAt = nowMs
        return decodeReply(reply!!)
    }

    companion object {
        /** A trigger replies at most this often. */
        const val REPLY_INTERVAL_MS = 2_000L
        /** How much of the previous chunk a regular expression is searched with. */
        private const val REGEX_TAIL = 256

        private val ESCAPES = Regex(
            "\u001B\\[[0-?]*[ -/]*[@-~]" +          // CSI: colours, cursor movement
                "|\u001B\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)" + // OSC: titles, hyperlinks
                "|\u001B[PX^_][^\u001B]*\u001B\\\\" +  // DCS / SOS / PM / APC
                "|\u001B[@-Z\\\\-_]" +                  // two-byte escapes
                "|[\u0000-\u0008\u000B-\u001F\u007F]",  // other controls (keep tab and newline)
        )

        fun stripEscapes(s: String): String = if (s.indexOf('\u001B') < 0 && s.none { it < ' ' && it != '\n' && it != '\t' }) s else ESCAPES.replace(s, "")

        /** Why [pattern] is not a usable regular expression, or null when it is. */
        fun regexError(pattern: String): String? = try {
            Regex(pattern); null
        } catch (e: Exception) {
            e.message?.lineSequence()?.firstOrNull()?.ifEmpty { null } ?: "Invalid regular expression"
        }

        /** `\r`, `\n`, `\t`, `\e` (Escape) and `\\`; any other backslash is kept as typed. */
        fun decodeReply(s: String): String {
            val out = StringBuilder(s.length)
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '\\' && i + 1 < s.length) {
                    val d = when (s[i + 1]) {
                        'r' -> '\r'
                        'n' -> '\n'
                        't' -> '\t'
                        'e' -> '\u001B'
                        '\\' -> '\\'
                        else -> null
                    }
                    if (d != null) { out.append(d); i += 2; continue }
                }
                out.append(c)
                i++
            }
            return out.toString()
        }
    }
}
