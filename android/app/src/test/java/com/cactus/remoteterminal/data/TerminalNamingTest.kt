package com.cactus.remoteterminal.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Copies of copies are the case that matters: a machine where every terminal
 * is called "deploy (2) (2) (2)" is worse than one with no names at all.
 */
class TerminalNamingTest {

    @Test
    fun firstCopyIsNumberedTwo() {
        assertEquals("deploy (2)", TerminalNaming.copyTitle("deploy", listOf("deploy")))
    }

    @Test
    fun copyingACopyKeepsCounting() {
        val taken = listOf("deploy", "deploy (2)")
        assertEquals("deploy (3)", TerminalNaming.copyTitle("deploy (2)", taken))
        assertEquals("deploy (3)", TerminalNaming.copyTitle("deploy", taken))
    }

    @Test
    fun gapsAreFilledRatherThanSkipped() {
        assertEquals("deploy (3)", TerminalNaming.copyTitle("deploy", listOf("deploy", "deploy (2)", "deploy (4)")))
    }

    @Test
    fun namesEndingInBracketsAreNotMistakenForCounters() {
        assertEquals("build (linux) (2)", TerminalNaming.copyTitle("build (linux)", listOf("build (linux)")))
    }

    @Test
    fun surroundingSpaceIsIgnoredOnBothSides() {
        // " api (2) " is the same name as "api (2)", so the copy is (3).
        assertEquals("api (3)", TerminalNaming.copyTitle("  api  ", listOf(" api (2) ", "api")))
        assertEquals("api (2)", TerminalNaming.copyTitle("api", emptyList()))
    }

    @Test
    fun anUntitledTerminalStaysUntitled() {
        // The agent names these itself ("bash 2"), which is better than "(2)".
        assertEquals("", TerminalNaming.copyTitle("", listOf("bash")))
        assertEquals("", TerminalNaming.copyTitle("   ", listOf("bash")))
    }
}
