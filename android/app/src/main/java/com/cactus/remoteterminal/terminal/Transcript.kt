package com.cactus.remoteterminal.terminal

/**
 * A terminal as plain text, for "Save transcript" and "Share transcript": the
 * scrollback and the screen, soft-wrapped rows joined back into the lines the
 * program wrote, trailing spaces trimmed, trailing blank lines dropped. The
 * desktop app's `terminal/transcript.js` does the same.
 */
object Transcript {
    fun of(emulator: TerminalEmulator): String = clean(emulator.renderText())

    /** Trim each line's trailing whitespace and drop blank lines at the end. */
    fun clean(text: String): String {
        val lines = text.split('\n').map { it.trimEnd() }.toMutableList()
        while (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.size - 1)
        return if (lines.isEmpty()) "" else lines.joinToString("\n") + "\n"
    }

    /** `{title}-{yyyyMMdd-HHmmss}.txt`, with the title made safe for a file name. */
    fun fileName(title: String, at: java.util.Date = java.util.Date()): String {
        val safe = title.replace(Regex("[^A-Za-z0-9._-]+"), "-").trim('-', '.').ifEmpty { "terminal" }.take(48)
        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(at)
        return "$safe-$stamp.txt"
    }
}
