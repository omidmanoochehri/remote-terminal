package com.cactus.remoteterminal.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FuzzyMatchTest {
    @Test fun subsequenceRequiredCaseInsensitive() {
        assertNotNull(FuzzyMatch.score("NT", "New terminal"))
        assertNull(FuzzyMatch.score("tn", "Net"))
        assertNull(FuzzyMatch.score("xyz", "New terminal"))
    }

    @Test fun emptyQueryMatchesEverythingInOrder() {
        assertEquals(listOf("b", "a"), FuzzyMatch.rank(listOf("b", "a"), "  ") { it })
    }

    @Test fun wordStartsAndRunsRankHigher() {
        val ranked = FuzzyMatch.rank(listOf("Print", "Paste file", "New terminal"), "nt") { it }
        assertEquals("New terminal", ranked.first())
        val runs = FuzzyMatch.rank(listOf("Snippet: stop app", "Start recording"), "start") { it }
        assertEquals("Start recording", runs.first())
    }

    @Test fun shorterTextWinsATie() {
        assertEquals(listOf("Paste", "Paste file"), FuzzyMatch.rank(listOf("Paste file", "Paste"), "paste") { it })
        assertEquals(50, FuzzyMatch.rank((1..80).map { "x$it" }, "") { it }.size)
    }

    @Test fun fallsBackWhenPreferringWordStartsWouldFail() {
        // Jumping to the word-start "a" leaves no "b" after it; the plain match still counts.
        assertNotNull(FuzzyMatch.score("ab", "xab ac"))
    }

    @Test fun camelCaseBoundaryIsAWordStart() {
        val a = FuzzyMatch.score("ws", "WebServer")!!
        val b = FuzzyMatch.score("ws", "Weirdness")!!
        assertTrue(a > b)
    }

    @Test fun limitIsApplied() {
        assertEquals(50, FuzzyMatch.rank((1..80).map { "item $it" }, "item") { it }.size)
    }
}
