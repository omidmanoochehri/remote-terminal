package com.cactus.remoteterminal.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutputWatchTest {
    @Test fun matchesCaseInsensitivelyThroughColours() {
        val w = OutputWatch("Build FAILED", keepWatching = false)
        assertFalse(w.feed("compiling…\r\n"))
        assertTrue(w.feed("\u001B[1;31mbuild\u001B[0m failed\r\n"))
    }

    @Test fun findsAMatchSplitAcrossChunks() {
        val w = OutputWatch("ready", keepWatching = true)
        assertFalse(w.feed("server is re"))
        assertTrue(w.feed("ady on :8080"))
    }

    @Test fun neverReportsTheSameOccurrenceTwice() {
        val w = OutputWatch("done", keepWatching = true)
        assertTrue(w.feed("done"))
        assertFalse(w.feed(""))
        assertFalse(w.feed(" and more"))
        assertTrue(w.feed(" done again"))
    }

    @Test fun oscTitlesAndControlsAreIgnored() {
        assertEquals("abc", OutputWatch.stripEscapes("\u001B]0;title\u0007a\rb\u001B[2Kc"))
        assertEquals("tab\tand\nline", OutputWatch.stripEscapes("tab\tand\nline"))
        val w = OutputWatch("title", keepWatching = false)
        assertFalse(w.feed("\u001B]0;my title\u0007prompt$ "))
    }
}
