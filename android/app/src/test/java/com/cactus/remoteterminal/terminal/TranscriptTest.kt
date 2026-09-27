package com.cactus.remoteterminal.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    @Test fun trimsTrailingSpacesAndBlankLinesAtTheEnd() {
        assertEquals("a\n\nb\n", Transcript.clean("a   \n  \nb\t\n\n   \n"))
        assertEquals("", Transcript.clean("   \n\n"))
    }

    @Test fun joinsSoftWrappedRowsAndKeepsScrollback() {
        val t = TerminalEmulator(10, 3, 100)
        t.feed("first line\r\n0123456789abcdef\r\nx\r\ny\r\nz")
        // "0123456789abcdef" wrapped over two rows on screen; it is one line here,
        // and "first line" scrolled off the screen but is still in the transcript.
        assertEquals("first line\n0123456789abcdef\nx\ny\nz\n", Transcript.of(t))
    }

    @Test fun fileNamesAreSafeAndStamped() {
        val at = java.util.GregorianCalendar(2026, 8, 3, 1, 15, 0).time
        assertEquals("API-logs-prod-20260903-011500.txt", Transcript.fileName("API logs / prod", at))
        assertEquals("terminal-20260903-011500.txt", Transcript.fileName("...", at))
        assertTrue(Transcript.fileName("x".repeat(200), at).length < 70)
    }
}
