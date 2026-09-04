package com.cactus.remoteterminal.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * OSC 7 is how a shell says where it is. Duplicating a terminal into the wrong
 * directory would be worse than duplicating it into none, so anything that is
 * not a well-formed `file://` URL has to be ignored rather than guessed at.
 */
class WorkingDirectoryTest {

    private val bel = "\u0007"

    private fun reported(payload: String): List<String> {
        val term = TerminalEmulator(80, 24, 50)
        val seen = mutableListOf<String>()
        term.onWorkingDirectory = { seen += it }
        term.feed("\u001b]7;$payload$bel")
        return seen
    }

    @Test
    fun plainPosixPathIsReported() {
        assertEquals(listOf("/srv/api"), reported("file://prod-01/srv/api"))
    }

    @Test
    fun theHostMayBeEmpty() {
        assertEquals(listOf("/home/omid"), reported("file:///home/omid"))
    }

    @Test
    fun percentEscapesAreDecoded() {
        assertEquals(listOf("/srv/my project"), reported("file://h/srv/my%20project"))
        assertEquals(listOf("/srv/naïve"), reported("file://h/srv/na%C3%AFve"))
    }

    @Test
    fun windowsPathsLoseTheLeadingSlash() {
        assertEquals(listOf("C:/Users/Omid"), reported("file:///C:/Users/Omid"))
    }

    @Test
    fun malformedPayloadsAreIgnored() {
        assertTrue(reported("").isEmpty())
        assertTrue(reported("/srv/api").isEmpty())
        assertTrue(reported("http://example.com/x").isEmpty())
        assertTrue(reported("file://host-with-no-path").isEmpty())
    }

    @Test
    fun controlCharactersAreRefused() {
        // OSC bodies stop at controls, so a smuggled newline arrives as text.
        assertTrue(reported("file://h/srv/%00etc").isEmpty())
    }

    @Test
    fun stringTerminatorEndsTheSequenceToo() {
        val term = TerminalEmulator(80, 24, 50)
        val seen = mutableListOf<String>()
        term.onWorkingDirectory = { seen += it }
        term.feed("\u001b]7;file://h/opt\u001b\\")
        assertEquals(listOf("/opt"), seen)
    }

    @Test
    fun theSequenceLeavesNothingOnTheScreen() {
        val term = TerminalEmulator(80, 24, 50)
        term.feed("a\u001b]7;file://h/opt${bel}b")
        assertEquals("ab", term.rowText(term.totalRows() - term.rows, true))
    }
}
