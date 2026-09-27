package com.cactus.remoteterminal.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinkFinderTest {
    private fun links(line: String) = LinkFinder.find(line).map { line.substring(it.first, it.last + 1) }

    @Test fun findsPlainLinks() {
        assertEquals(listOf("https://example.com/a?b=1#c"), links("see https://example.com/a?b=1#c now"))
        assertEquals(listOf("http://x.org", "ftp://files.x.org/pub"), links("http://x.org and ftp://files.x.org/pub"))
        assertEquals(listOf("file:///home/ann/report.txt"), links("open file:///home/ann/report.txt"))
    }

    @Test fun sentencePunctuationIsNotPartOfTheLink() {
        assertEquals(listOf("https://example.com/docs"), links("Read https://example.com/docs."))
        assertEquals(listOf("https://example.com"), links("Is it https://example.com?!"))
        assertEquals(listOf("https://example.com/x"), links("\"https://example.com/x\","))
        assertEquals(listOf("https://example.com/x"), links("'https://example.com/x';"))
    }

    @Test fun bracketsAreKeptOnlyWhenTheLinkOpenedThem() {
        assertEquals(listOf("https://x.org/a"), links("(see https://x.org/a)"))
        assertEquals(listOf("https://en.wikipedia.org/wiki/Tree_(graph)"), links("https://en.wikipedia.org/wiki/Tree_(graph)"))
        assertEquals(listOf("https://en.wikipedia.org/wiki/Tree_(graph)"), links("(https://en.wikipedia.org/wiki/Tree_(graph))."))
        assertEquals(listOf("https://x.org/a[1]"), links("[https://x.org/a[1]]"))
        assertEquals(listOf("https://x.org/{id}"), links("{https://x.org/{id}}"))
    }

    @Test fun stopsAtQuotesAnglesAndBackticks() {
        assertEquals(listOf("https://x.org/a"), links("<https://x.org/a>"))
        assertEquals(listOf("https://x.org/a"), links("`https://x.org/a`"))
        assertEquals(listOf("https://x.org/a"), links("href=\"https://x.org/a\""))
    }

    @Test fun aSchemeAloneIsNotALink() {
        assertEquals(emptyList<String>(), links("https:// and http://."))
        assertEquals(emptyList<String>(), links("no links here, only example.com"))
    }

    @Test fun linkAtMapsCellsAndFollowsSoftWraps() {
        val t = TerminalEmulator(20, 4, 10)
        // 20 columns: the URL wraps onto the second row.
        t.feed("go https://example.com/long/path ok\r\n")
        val first = t.totalRows() - t.rows
        assertEquals("https://example.com/long/path", LinkFinder.linkAt(t, first, 5))
        assertEquals("https://example.com/long/path", LinkFinder.linkAt(t, first + 1, 3))
        assertNull(LinkFinder.linkAt(t, first, 0))      // "go"
        assertNull(LinkFinder.linkAt(t, first + 1, 14)) // "ok"
        assertNull(LinkFinder.linkAt(t, first + 2, 0))  // blank row
    }

    @Test fun linkAtCountsWideGlyphsByCell() {
        val t = TerminalEmulator(40, 3, 10)
        t.feed("日本 https://x.org/a")
        val row = t.totalRows() - t.rows
        // Two wide glyphs take four cells, then a space: the link starts at column 5.
        assertNull(LinkFinder.linkAt(t, row, 4))
        assertEquals("https://x.org/a", LinkFinder.linkAt(t, row, 5))
        assertEquals("https://x.org/a", LinkFinder.linkAt(t, row, 19))
    }
}
