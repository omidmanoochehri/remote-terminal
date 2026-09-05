package com.cactus.remoteterminal.terminal

import com.cactus.remoteterminal.terminal.TerminalEmulator.Companion.BOLD
import com.cactus.remoteterminal.terminal.TerminalEmulator.Companion.CONTINUATION
import com.cactus.remoteterminal.terminal.TerminalEmulator.Companion.DEFAULT
import com.cactus.remoteterminal.terminal.TerminalEmulator.Companion.TRUECOLOR
import com.cactus.remoteterminal.terminal.TerminalEmulator.Companion.UNDERLINE
import com.cactus.remoteterminal.terminal.TerminalEmulator.Companion.WIDE
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class TerminalEmulatorTest {
    private val esc = ""
    private val csi = "["

    private fun term(cols: Int = 80, rows: Int = 24, scrollback: Int = 100) = TerminalEmulator(cols, rows, scrollback)

    /** Text of screen row [r] (0-based, screen coordinates). */
    private fun TerminalEmulator.screenRow(r: Int, trim: Boolean = true) = rowText(totalRows() - rows + r, trim)
    private fun TerminalEmulator.screenRows(): List<String> = (0 until rows).map { screenRow(it) }
    private fun TerminalEmulator.row(r: Int): Row = rowAt(totalRows() - rows + r)
    private fun TerminalEmulator.cursor() = cursorRow to cursorCol

    /* ------------------------------ basics ------------------------------ */

    @Test
    fun plainTextWithCrLf() {
        val t = term(20, 4)
        t.feed("hello\r\nworld")
        assertEquals("hello", t.screenRow(0))
        assertEquals("world", t.screenRow(1))
        assertEquals(1 to 5, t.cursor())
        t.feed("\rX")
        assertEquals("Xorld", t.screenRow(1))
        assertEquals(1 to 1, t.cursor())
    }

    @Test
    fun lineFeedVtFfAndBackspace() {
        val t = term(10, 4)
        t.feed("abcd\b\bZ")
        assertEquals(listOf("ab", "  c", "  Zd"), t.screenRows().take(3).map { it.trimEnd() })
        assertEquals(2 to 3, t.cursor())
    }

    @Test
    fun autowrapMarksTheRowAndDisabledAutowrapOverwritesTheLastColumn() {
        val t = term(5, 3)
        t.feed("abcdefg")
        assertEquals("abcde", t.screenRow(0))
        assertTrue(t.row(0).wrapped)
        assertEquals("fg", t.screenRow(1))
        assertFalse(t.row(1).wrapped)
        assertEquals(1 to 2, t.cursor())

        val u = term(5, 3)
        u.feed("$csi?7l" + "abcdefg")
        assertEquals("abcdg", u.screenRow(0))
        assertFalse(u.row(0).wrapped)
        assertEquals(0 to 4, u.cursor())
    }

    @Test
    fun wrappedRowIsUnmarkedWhenTheCursorMovesAwayWithoutPrinting() {
        val t = term(5, 3)
        t.feed("abcde") // pending wrap, no wrap yet
        assertEquals(0 to 4, t.cursor())
        t.feed("\r\nX")
        assertFalse("CR/LF is a hard line break", t.row(0).wrapped)
        assertEquals("X", t.screenRow(1))
    }

    @Test
    fun scrollbackIsBoundedAndClearedByEd3() {
        val t = term(10, 2, 3)
        for (i in 1..8) t.feed("l$i\r\n")
        assertEquals(3 + 2, t.totalRows())
        // The LF after l8 scrolls it up: a 2-row terminal shows l8 on top and a blank line under the cursor.
        assertEquals(listOf("l5", "l6", "l7"), (0 until 3).map { t.rowText(it) })
        assertEquals("l8", t.screenRow(0))
        assertEquals("", t.screenRow(1))
        t.feed("${csi}3J")
        assertEquals(2, t.totalRows())
        t.maxScrollback = 1
        for (i in 1..4) t.feed("m$i\r\n")
        assertEquals(1 + 2, t.totalRows())
    }

    /* ------------------------- cursor movement -------------------------- */

    @Test
    fun cursorMovementCommandsAndBounds() {
        val t = term(10, 5)
        t.feed("${csi}3;4H")
        assertEquals(2 to 3, t.cursor())
        t.feed("${csi}2A${csi}5C")
        assertEquals(0 to 8, t.cursor())
        t.feed("${csi}9C") // clamps
        assertEquals(0 to 9, t.cursor())
        t.feed("${csi}20B")
        assertEquals(4 to 9, t.cursor())
        t.feed("${csi}E") // CNL: next line, column 0
        assertEquals(4 to 0, t.cursor())
        t.feed("${csi}2F") // CPL
        assertEquals(2 to 0, t.cursor())
        t.feed("${csi}7G${csi}2d") // CHA, VPA
        assertEquals(1 to 6, t.cursor())
        t.feed("${csi}H")
        assertEquals(0 to 0, t.cursor())
    }

    @Test
    fun saveAndRestoreCursorViaEsc7Esc8AndCsiSU() {
        val t = term(20, 5)
        t.feed("${csi}2;5H${esc}7${csi}4;1Hxyz${esc}8")
        assertEquals(1 to 4, t.cursor())
        t.feed("${csi}s${csi}1;1H${csi}u")
        assertEquals(1 to 4, t.cursor())
        // SGR is part of the saved state
        t.feed("${csi}1m${esc}7${csi}0m${esc}8A")
        assertEquals(BOLD, t.row(1).flags[4] and BOLD)
    }

    @Test
    fun scrollRegionInsertDeleteAndScrollCommands() {
        val t = term(10, 5)
        for (i in 1..5) t.feed("r$i" + if (i < 5) "\r\n" else "")
        t.feed("${csi}2;4r") // region rows 2..4 (1-based)
        assertEquals(0 to 0, t.cursor())
        t.feed("${csi}4;1H\n") // LF at region bottom scrolls only the region
        assertEquals(listOf("r1", "r3", "r4", "", "r5"), t.screenRows())
        assertEquals(3 to 0, t.cursor())
        t.feed("${csi}2;1H${csi}L") // IL at region top
        assertEquals(listOf("r1", "", "r3", "r4", "r5"), t.screenRows())
        t.feed("${csi}M") // DL
        assertEquals(listOf("r1", "r3", "r4", "", "r5"), t.screenRows())
        t.feed("${csi}S") // SU
        assertEquals(listOf("r1", "r4", "", "", "r5"), t.screenRows())
        t.feed("${csi}2T") // SD
        assertEquals(listOf("r1", "", "", "r4", "r5"), t.screenRows())
        t.feed("${csi}r") // reset region
        t.feed("${csi}5;1H\n")
        assertEquals(listOf("", "", "r4", "r5", ""), t.screenRows())
        assertEquals(1, t.totalRows() - t.rows) // r1 went to history
        assertEquals("r1", t.rowText(0))
    }

    @Test
    fun lineFeedOutsideTheRegionDoesNotScroll() {
        val t = term(10, 5)
        t.feed("${csi}1;3r${csi}5;1Hbottom\n")
        assertEquals("bottom", t.screenRow(4))
        assertEquals(4 to 6, t.cursor())
        t.feed("${csi}4;1H\n")
        assertEquals(4 to 0, t.cursor())
        // RI at region top scrolls the region down
        t.feed("${csi}1;1H${esc}M")
        assertEquals(0 to 0, t.cursor())
    }

    /* ---------------------------- erasing ------------------------------- */

    @Test
    fun eraseDisplayAndLineVariants() {
        val t = term(6, 3)
        t.feed("aaaaaa\r\nbbbbbb\r\ncccccc${csi}2;3H")
        t.feed("${csi}K")
        assertEquals(listOf("aaaaaa", "bb", "cccccc"), t.screenRows())
        t.feed("${csi}1K")
        assertEquals("", t.screenRow(1))
        t.feed("${csi}2;3Hxyz${csi}2;4H${csi}2K")
        assertEquals("", t.screenRow(1))
        t.feed("${csi}2;3H${csi}J")
        assertEquals(listOf("aaaaaa", "", ""), t.screenRows())
        t.feed("${csi}3;1Hcccccc${csi}2;3H${csi}1J")
        assertEquals(listOf("", "", "cccccc"), t.screenRows())
        t.feed("${csi}2J")
        assertEquals(listOf("", "", ""), t.screenRows())
    }

    @Test
    fun eraseUsesTheCurrentBackgroundColour() {
        val t = term(6, 2)
        t.feed("${csi}44m${csi}2J")
        assertEquals(4, t.row(0).bg[3])
        assertEquals(4, t.row(1).bg[5])
        t.feed("${csi}0m${csi}1;1H${csi}2X")
        assertEquals(DEFAULT, t.row(0).bg[0])
        assertEquals(4, t.row(0).bg[2])
    }

    @Test
    fun insertDeleteEraseCharacters() {
        val t = term(8, 2)
        t.feed("abcdef")
        t.feed("${csi}1G${csi}2P")
        assertEquals("cdef", t.screenRow(0))
        t.feed("${csi}2@")
        assertEquals("  cdef", t.screenRow(0))
        t.feed("${csi}3G${csi}2X")
        assertEquals("    ef", t.screenRow(0))
        t.feed("${csi}20P")
        assertEquals("", t.screenRow(0))
    }

    @Test
    fun insertModeShiftsExistingText() {
        val t = term(8, 2)
        t.feed("abcd${csi}2G${csi}4hXY${csi}4l")
        assertEquals("aXYbcd", t.screenRow(0))
        t.feed("Z")
        assertEquals("aXYZcd", t.screenRow(0))
    }

    @Test
    fun repeatLastCharacter() {
        val t = term(10, 2)
        t.feed("ab${csi}3b")
        assertEquals("abbbb", t.screenRow(0))
        t.feed("\r\n${csi}5b") // nothing to repeat at column 0
        assertEquals("", t.screenRow(1))
    }

    /* ------------------------------ SGR --------------------------------- */

    @Test
    fun sgrColoursAndAttributes() {
        val t = term(40, 2)
        t.feed("${csi}1;4;31ma${csi}0mb${csi}91mc${csi}38;5;123md${csi}48;5;7me${csi}38;2;10;20;30mf")
        val r = t.row(0)
        assertEquals(BOLD or UNDERLINE, r.flags[0] and (BOLD or UNDERLINE))
        assertEquals(1, r.fg[0])
        assertEquals(0, r.flags[1]); assertEquals(DEFAULT, r.fg[1])
        assertEquals(9, r.fg[2])
        assertEquals(123, r.fg[3])
        assertEquals(7, r.bg[4])
        assertEquals(TRUECOLOR or (10 shl 16) or (20 shl 8) or 30, r.fg[5])
        t.feed("${csi}39;49mg${csi}7mh${csi}27;2;3;9mi")
        assertEquals(DEFAULT, r.fg[6]); assertEquals(DEFAULT, r.bg[6])
        assertEquals(TerminalEmulator.REVERSE, r.flags[7] and TerminalEmulator.REVERSE)
        assertEquals(0, r.flags[8] and TerminalEmulator.REVERSE)
        assertEquals(TerminalEmulator.DIM or TerminalEmulator.ITALIC or TerminalEmulator.STRIKE, r.flags[8] and (TerminalEmulator.DIM or TerminalEmulator.ITALIC or TerminalEmulator.STRIKE))
        t.feed("${csi}22;23;29mj${csi}mk")
        assertEquals(0, r.flags[9] and (TerminalEmulator.DIM or TerminalEmulator.ITALIC or TerminalEmulator.STRIKE))
        assertEquals(0, r.flags[10]); assertEquals(DEFAULT, r.bg[10])
    }

    @Test
    fun sgrColonSubParametersAndUnderlineStyles() {
        val t = term(20, 1)
        t.feed("${csi}38:2::1:2:3ma${csi}38:2:4:5:6mb${csi}48:5:200mc${csi}4:3md${csi}0;38;2;9;8;7me")
        val r = t.row(0)
        assertEquals(TRUECOLOR or (1 shl 16) or (2 shl 8) or 3, r.fg[0])
        assertEquals(TRUECOLOR or (4 shl 16) or (5 shl 8) or 6, r.fg[1])
        assertEquals(200, r.bg[2])
        assertEquals(UNDERLINE, r.flags[3] and UNDERLINE)
        assertEquals(TRUECOLOR or (9 shl 16) or (8 shl 8) or 7, r.fg[4])
        assertEquals(0, r.flags[4] and UNDERLINE)
    }

    /* ------------------------- alt screen & modes ----------------------- */

    @Test
    fun alternateScreenSavesAndRestoresThePrimary() {
        val t = term(10, 3)
        val events = ArrayList<Boolean>()
        t.onAltScreen = { events.add(it) }
        t.feed("main${csi}2;3H")
        t.feed("${csi}?1049h")
        assertTrue(t.isAltScreen)
        assertEquals(listOf(true), events)
        assertEquals(0 to 0, t.cursor())
        assertEquals(listOf("", "", ""), t.screenRows())
        t.feed("vim!")
        assertEquals("vim!", t.screenRow(0))
        assertEquals(3, t.totalRows())
        t.feed("${csi}?1049l")
        assertFalse(t.isAltScreen)
        assertEquals(listOf(true, false), events)
        assertEquals("main", t.screenRow(0))
        assertEquals(1 to 2, t.cursor())
        // 47 without save/restore: cursor stays where the alt screen left it
        t.feed("${csi}?47h${csi}3;5H${csi}?47l")
        assertEquals("main", t.screenRow(0))
    }

    @Test
    fun altScreenDoesNotFeedScrollback() {
        val t = term(10, 2, 50)
        t.feed("${csi}?1049h")
        for (i in 1..10) t.feed("x$i\r\n")
        assertEquals(2, t.totalRows())
        t.feed("${csi}?1049l")
        assertEquals(2, t.totalRows())
    }

    @Test
    fun originModeConfinesCursorAndReports() {
        val t = term(20, 6)
        val replies = ArrayList<String>()
        t.onResponse = { replies.add(it) }
        t.feed("${csi}3;5r${csi}?6h")
        assertEquals(2 to 0, t.cursor())
        t.feed("${csi}1;1H")
        assertEquals(2 to 0, t.cursor())
        t.feed("${csi}6n")
        assertEquals("${csi}1;1R", replies.last())
        t.feed("${csi}99;1H")
        assertEquals(4 to 0, t.cursor())
        t.feed("${csi}?6l${csi}1;1H${csi}6n")
        assertEquals(0 to 0, t.cursor())
        assertEquals("${csi}1;1R", replies.last())
    }

    @Test
    fun tabStopsHtsTbcCbtCht() {
        val t = term(40, 2)
        t.feed("\t")
        assertEquals(0 to 8, t.cursor())
        t.feed("\t\t")
        assertEquals(0 to 24, t.cursor())
        t.feed("${csi}4G${esc}H${csi}1G\t")
        assertEquals(0 to 3, t.cursor())
        t.feed("${csi}Z")
        assertEquals(0 to 0, t.cursor())
        t.feed("${csi}2I")
        assertEquals(0 to 8, t.cursor())
        t.feed("${csi}g\t") // clear the stop at column 8: next stop is 16
        assertEquals(0 to 16, t.cursor())
        t.feed("${csi}3g${csi}1G\t") // no stops left: last column
        assertEquals(0 to 39, t.cursor())
        t.feed("${csi}5Z")
        assertEquals(0 to 0, t.cursor())
    }

    @Test
    fun modeFlagsAreTracked() {
        val t = term()
        assertFalse(t.applicationCursorKeys); assertFalse(t.bracketedPaste); assertEquals(TerminalEmulator.MOUSE_OFF, t.mouseMode)
        t.feed("${csi}?1h${csi}?2004h${csi}?1002h${csi}?1006h${csi}?1004h${esc}=${csi}?25l${csi}?12l")
        assertTrue(t.applicationCursorKeys)
        assertTrue(t.bracketedPaste)
        assertEquals(TerminalEmulator.MOUSE_BUTTON, t.mouseMode)
        assertTrue(t.mouseSgr)
        assertTrue(t.focusEvents)
        assertTrue(t.applicationKeypad)
        assertFalse(t.cursorVisible)
        assertFalse(t.cursorBlink)
        t.feed("${csi}?1000h")
        assertEquals(TerminalEmulator.MOUSE_PRESS, t.mouseMode)
        t.feed("${csi}?1003h${csi}?1003l${csi}?1l${csi}?2004l${csi}?25h${csi}?12h${esc}>")
        assertEquals(TerminalEmulator.MOUSE_OFF, t.mouseMode)
        assertFalse(t.applicationCursorKeys); assertFalse(t.bracketedPaste); assertTrue(t.cursorVisible); assertTrue(t.cursorBlink); assertFalse(t.applicationKeypad)
        // Multiple modes in one sequence
        t.feed("${csi}?1;2004h")
        assertTrue(t.applicationCursorKeys && t.bracketedPaste)
    }

    @Test
    fun cursorStyleViaDecscusr() {
        val t = term()
        t.feed("$csi 5 q".replace(" q", " q"))
        t.feed("${csi}5 q")
        assertEquals(TerminalEmulator.CURSOR_BAR, t.cursorStyle); assertTrue(t.cursorBlink)
        t.feed("${csi}4 q")
        assertEquals(TerminalEmulator.CURSOR_UNDERLINE, t.cursorStyle); assertFalse(t.cursorBlink)
        t.feed("${csi}2 q")
        assertEquals(TerminalEmulator.CURSOR_BLOCK, t.cursorStyle); assertFalse(t.cursorBlink)
        t.feed("${csi}0 q")
        assertEquals(TerminalEmulator.CURSOR_BLOCK, t.cursorStyle); assertTrue(t.cursorBlink)
    }

    /* ------------------------------ mouse ------------------------------- */

    @Test
    fun mouseReportsSgrAndX10Encodings() {
        val t = term()
        assertNull(t.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, 4, 2, 0))
        t.feed("${csi}?1000h${csi}?1006h")
        assertEquals("$csi<0;5;3M", t.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, 4, 2, 0))
        assertNull("motion is not reported in mode 1000", t.mouseReport(TerminalEmulator.MOUSE_EVENT_MOTION, 5, 2, 0))
        assertEquals("$csi<0;5;3m", t.mouseReport(TerminalEmulator.MOUSE_EVENT_RELEASE, 4, 2, 0))
        assertEquals("$csi<64;1;1M", t.mouseReport(TerminalEmulator.MOUSE_EVENT_WHEEL_UP, 0, 0, 0))
        assertEquals("$csi<65;1;1M", t.mouseReport(TerminalEmulator.MOUSE_EVENT_WHEEL_DOWN, 0, 0, 0))
        assertEquals("$csi<2;10;10M", t.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, 9, 9, 2))
        assertEquals("$csi<22;10;10m", t.mouseReport(TerminalEmulator.MOUSE_EVENT_RELEASE, 9, 9, 2, shift = true, ctrl = true))

        t.feed("${csi}?1002h") // button-motion: motion only while a button is held
        assertNull(t.mouseReport(TerminalEmulator.MOUSE_EVENT_MOTION, 5, 2, 0))
        t.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, 4, 2, 0)
        assertEquals("$csi<32;6;3M", t.mouseReport(TerminalEmulator.MOUSE_EVENT_MOTION, 5, 2, 0))
        t.mouseReport(TerminalEmulator.MOUSE_EVENT_RELEASE, 5, 2, 0)
        assertNull(t.mouseReport(TerminalEmulator.MOUSE_EVENT_MOTION, 6, 2, 0))
        t.feed("${csi}?1003h")
        assertEquals("$csi<35;7;3M", t.mouseReport(TerminalEmulator.MOUSE_EVENT_MOTION, 6, 2, 0))

        t.feed("${csi}?1006l${csi}?1000h")
        assertEquals("${csi}M" + (32 + 0).toChar() + (32 + 5).toChar() + (32 + 3).toChar(), t.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, 4, 2, 0))
        assertEquals("${csi}M" + (32 + 3).toChar() + (32 + 5).toChar() + (32 + 3).toChar(), t.mouseReport(TerminalEmulator.MOUSE_EVENT_RELEASE, 4, 2, 0))
        assertEquals("${csi}M" + (32 + 64).toChar() + (32 + 223).toChar() + (32 + 223).toChar(), t.mouseReport(TerminalEmulator.MOUSE_EVENT_WHEEL_UP, 400, 300, 0))
        t.feed("${csi}?1000l")
        assertNull(t.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, 0, 0, 0))
    }

    /* ---------------------------- responses ----------------------------- */

    @Test
    fun dsrAndDaRepliesCanBeMuted() {
        val t = term(80, 24)
        val replies = ArrayList<String>()
        t.onResponse = { replies.add(it) }
        t.feed("${csi}5;7H${csi}6n${csi}5n${csi}c${csi}>c${csi}18t${csi}?6n")
        assertEquals(listOf("${csi}5;7R", "${csi}0n", "$csi?62;22c", "$csi>41;0;0c", "${csi}8;24;80t", "$csi?5;7R"), replies)
        t.muteResponses = true
        t.feed("${csi}6n${csi}c")
        assertEquals(6, replies.size)
        t.muteResponses = false
        t.feed("${csi}6n")
        assertEquals(7, replies.size)
    }

    @Test
    fun oscTitleAndClipboard() {
        val t = term()
        val titles = ArrayList<String>()
        val clips = ArrayList<String>()
        t.onTitle = { titles.add(it) }
        t.onClipboard = { clips.add(it) }
        t.feed("$esc]2;My Title")
        assertEquals("My Title", t.title)
        t.feed("$esc]0;Other$esc\\after")
        assertEquals("Other", t.title)
        assertEquals(listOf("My Title", "Other"), titles)
        assertEquals("after", t.screenRow(0))
        t.feed("$esc]52;c;aGVsbG8gd29ybGQ=")
        assertEquals(listOf("hello world"), clips)
        t.feed("$esc]52;c;?$esc]52;;$esc]8;;http://x$esc\\link$esc]8;;$esc\\")
        assertEquals(1, clips.size)
        assertEquals("afterlink", t.screenRow(0))
        // DCS / APC strings are swallowed until ST
        t.feed("${esc}Pq#0;2;0;0;0#0~~$esc\\X${esc}_Gi=1$esc\\Y")
        assertEquals("afterlinkXY", t.screenRow(0))
    }

    /* --------------------------- unicode -------------------------------- */

    @Test
    fun wideCharactersOccupyTwoCells() {
        val t = term(10, 2)
        t.feed("日本x")
        val r = t.row(0)
        assertEquals('日'.code, r.codes[0]); assertEquals(WIDE, r.flags[0] and WIDE)
        assertEquals(0, r.codes[1]); assertEquals(CONTINUATION, r.flags[1] and CONTINUATION)
        assertEquals('本'.code, r.codes[2]); assertEquals(0, r.codes[3])
        assertEquals('x'.code, r.codes[4])
        assertEquals(0 to 5, t.cursor())
        assertEquals("日本x", t.screenRow(0))
        t.feed("😀")
        assertEquals(0x1F600, r.codes[5]); assertEquals(0, r.codes[6])
        assertEquals("日本x😀", t.screenRow(0))
    }

    @Test
    fun wideCharacterAtTheLastColumnWrapsFirst() {
        val t = term(5, 3)
        t.feed("abcd日")
        assertEquals("abcd", t.screenRow(0))
        assertTrue(t.row(0).wrapped)
        assertEquals("日", t.screenRow(1))
        assertEquals(1 to 2, t.cursor())
        t.feed("efg日")
        assertEquals("日efg", t.screenRow(1))
        assertEquals("日", t.screenRow(2))
    }

    @Test
    fun overwritingHalfOfAWideGlyphBlanksTheOtherHalf() {
        val t = term(10, 2)
        t.feed("日本${csi}2Gx")
        val r = t.row(0)
        assertEquals(' '.code, r.codes[0]); assertEquals(0, r.flags[0])
        assertEquals('x'.code, r.codes[1])
        assertEquals('本'.code, r.codes[2])
        t.feed("${csi}3GY")
        assertEquals('Y'.code, r.codes[2]); assertEquals(' '.code, r.codes[3]); assertEquals(0, r.flags[3])
        assertEquals(" xY", t.screenRow(0))
    }

    @Test
    fun combiningMarksAttachToThePreviousCell() {
        val t = term(10, 2)
        t.feed("éx")
        val r = t.row(0)
        assertEquals('e'.code, r.codes[0])
        assertEquals("́", r.combining(0))
        assertEquals('x'.code, r.codes[1])
        assertEquals(0 to 2, t.cursor())
        assertEquals("éx", t.screenRow(0))
        // ZWJ / variation selector attach to the wide cell (its left half)
        t.feed("\r\n👍️")
        assertEquals("️", t.row(1).combining(0))
        assertEquals("👍️", t.screenRow(1))
        // Combining mark at column 0 with nothing before it is dropped
        t.feed("\r\ń")
        assertEquals("", t.screenRow(1).takeIf { false } ?: t.rowText(t.totalRows() - 1))
    }

    @Test
    fun surrogatePairSplitAcrossFeedsIsJoined() {
        val t = term(10, 1)
        t.feed("\uD83D")
        assertEquals(0 to 0, t.cursor())
        t.feed("\uDE00!")
        assertEquals(0x1F600, t.row(0).codes[0])
        assertEquals('!'.code, t.row(0).codes[2])
        // A lone high surrogate followed by text becomes U+FFFD
        val u = term(10, 1)
        u.feed("\uD83Dab")
        assertEquals(0xFFFD, u.row(0).codes[0])
        assertEquals("�ab", u.screenRow(0))
        // A lone low surrogate too
        u.feed("\uDE00")
        assertEquals(0xFFFD, u.row(0).codes[3])
    }

    @Test
    fun decSpecialGraphicsCharset() {
        val t = term(20, 2)
        t.feed("$esc(0qjklmn$esc(Bq")
        assertEquals("─┘┐┌└┼q", t.screenRow(0))
        t.feed("\r\n$esc)0xx")
        assertEquals("│x", t.screenRow(1))
        t.feed("$esc(0a$esc(B")
        assertEquals("│x▒", t.screenRow(1))
    }

    /* ------------------------------ resize ------------------------------ */

    @Test
    fun resizeReflowsWrappedLinesWiderAndNarrower() {
        val t = term(10, 3)
        t.feed("abcdefghijklmno")
        assertEquals(listOf("abcdefghij", "klmno", ""), t.screenRows())
        assertEquals(1 to 5, t.cursor())

        t.resize(20, 3)
        assertEquals(20, t.cols)
        assertEquals(listOf("abcdefghijklmno", "", ""), t.screenRows())
        assertFalse(t.row(0).wrapped)
        assertEquals(0 to 15, t.cursor())
        t.feed("p")
        assertEquals("abcdefghijklmnop", t.screenRow(0))

        t.resize(8, 3)
        assertEquals(listOf("abcdefgh", "ijklmnop", ""), t.screenRows())
        assertTrue(t.row(0).wrapped)
        // Exactly past a full row: the cursor stays on the last cell with a
        // pending wrap (xterm), rather than opening a blank row that would
        // scroll content away. The next glyph is what moves it down.
        assertEquals(1 to 7, t.cursor())
        t.feed("q")
        assertEquals("q", t.screenRow(2))
        assertEquals(3, t.totalRows())
    }

    @Test
    fun resizeKeepsHistoryAndBringsItOnScreenWhenTaller() {
        val t = term(10, 3, 100)
        for (i in 1..5) t.feed("line$i" + if (i < 5) "\r\n" else "")
        assertEquals(5, t.totalRows())
        assertEquals("line1", t.rowText(0))
        t.resize(12, 3)
        assertEquals(5, t.totalRows())
        assertEquals(listOf("line1", "line2", "line3", "line4", "line5"), (0 until 5).map { t.rowText(it) })
        assertEquals(2 to 5, t.cursor())
        t.resize(12, 5)
        assertEquals(5, t.totalRows())
        assertEquals(listOf("line1", "line2", "line3", "line4", "line5"), t.screenRows())
        assertEquals(4 to 5, t.cursor())
        t.resize(12, 2)
        assertEquals("line5", t.screenRow(1))
        assertEquals(1 to 5, t.cursor())
        assertEquals(5, t.totalRows())
    }

    @Test
    fun resizeKeepsCursorAfterATrailingPromptSpace() {
        val t = term(10, 3)
        t.feed("user$ ")
        assertEquals(0 to 6, t.cursor())
        t.resize(20, 3)
        assertEquals(0 to 6, t.cursor())
        t.feed("ls")
        assertEquals("user$ ls", t.screenRow(0))
    }

    @Test
    fun resizeOnAltScreenClipsAltAndReflowsPrimary() {
        val t = term(10, 3)
        t.feed("abcdefghijkl${csi}?1049h")
        t.feed("${csi}3;1Hbottom")
        t.resize(6, 2)
        assertTrue(t.isAltScreen)
        assertEquals(2, t.totalRows())
        assertEquals(1 to 5, t.cursor())
        t.feed("${csi}?1049l")
        assertEquals(6, t.cols)
        assertEquals(listOf("abcdef", "ghijkl"), t.screenRows())
        assertEquals(1 to 6 - 1, t.cursor().first to t.cursor().second)
    }

    @Test
    fun resizeExtendsTabStops() {
        val t = term(10, 2)
        t.resize(40, 2)
        t.feed("\t\t\t")
        assertEquals(0 to 24, t.cursor())
    }

    /* ------------------------------ resets ------------------------------ */

    @Test
    fun softResetKeepsScreenButResetsModes() {
        val t = term(10, 4)
        t.feed("keep${csi}?6h${csi}4h${csi}?25l${csi}?1h${csi}2;3r${csi}1m")
        t.feed("${csi}!p")
        assertEquals("keep", t.screenRow(0))
        assertTrue(t.cursorVisible)
        assertFalse(t.applicationCursorKeys)
        t.feed("${csi}4;1HX") // origin mode off: row 4 reachable
        assertEquals("X", t.screenRow(3))
        assertEquals(0, t.row(3).flags[0])
        t.feed("${csi}1;1HY") // insert mode off: overwrite
        assertEquals("Yeep", t.screenRow(0))
    }

    @Test
    fun fullResetClearsEverything() {
        val t = term(10, 2, 10)
        t.feed("a\r\nb\r\nc$esc]2;T${csi}?2004h${csi}?1049h")
        t.feed("${esc}c")
        assertFalse(t.isAltScreen)
        assertEquals(2, t.totalRows())
        assertEquals(listOf("", ""), t.screenRows())
        assertEquals("", t.title)
        assertFalse(t.bracketedPaste)
        assertEquals(0 to 0, t.cursor())
        t.feed("x")
        assertEquals("x", t.screenRow(0))
    }

    @Test
    fun clearScreenKeepsHistory() {
        val t = term(10, 2, 10)
        t.feed("a\r\nb\r\nc")
        t.clearScreen()
        assertEquals(3, t.totalRows())
        assertEquals("a", t.rowText(0))
        assertEquals(listOf("", ""), t.screenRows())
        t.clearScrollback()
        assertEquals(2, t.totalRows())
    }

    @Test
    fun decalnFillsTheScreen() {
        val t = term(4, 2)
        t.feed("$esc#8")
        assertEquals(listOf("EEEE", "EEEE"), t.screenRows())
        assertEquals(0 to 0, t.cursor())
    }

    /* ------------------------------ readout ----------------------------- */

    @Test
    fun consumeDirtyReportsChangesOnce() {
        val t = term()
        assertTrue(t.consumeDirty())
        assertFalse(t.consumeDirty())
        t.feed("x")
        assertTrue(t.consumeDirty())
        assertFalse(t.consumeDirty())
        t.rowText(0)
        assertFalse(t.consumeDirty())
        t.resize(30, 10)
        assertTrue(t.consumeDirty())
    }

    @Test
    fun textBetweenJoinsWrappedRowsAndBreaksHardLines() {
        val t = term(5, 4)
        t.feed("abcdefg\r\nhi\r\n日本語")
        assertEquals("defg", t.textBetween(0, 3, 1, 1))
        assertEquals("fg\nhi", t.textBetween(1, 0, 2, 4))
        assertEquals("abcdefg\nhi\n日本", t.textBetween(0, 0, 3, 3))
        assertEquals("日本", t.textBetween(3, 1, 3, 3)) // starting on a continuation cell selects the glyph
        assertEquals("cd", t.textBetween(0, 3, 0, 2)) // reversed coordinates are normalised
        assertEquals("abcdefg\nhi\n日本語", t.renderText())
    }

    @Test
    fun rowTextTrimsOnlyWhenAsked() {
        val t = term(6, 1)
        t.feed("ab")
        assertEquals("ab", t.rowText(0))
        assertEquals("ab    ", t.rowText(0, trimEnd = false))
    }

    /* ------------------------------ robustness -------------------------- */

    @Test
    fun unknownAndMalformedSequencesNeverDesynchronise() {
        val t = term(20, 3)
        t.feed("${csi}?999h${csi}>1;2m${csi}=5l${csi}99999999999999999A${csi}1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20;21;22;23;24;25;26;27;28;29;30;31;32;33;34;35mX")
        assertEquals("X", t.screenRow(0))
        t.feed("${esc}Q${esc}%G${esc}#3Y")
        assertEquals("XY", t.screenRow(0))
        t.feed("$csi" + "日Z") // non-ASCII aborts a CSI and is printed
        assertEquals("XY日Z", t.screenRow(0))
        t.feed("$esc]2;unterminated")
        t.feed("more") // CAN aborts
        assertTrue(t.screenRow(0).startsWith("XY日Z"))
    }

    @Test
    fun fuzzFeedNeverThrowsAndKeepsCursorInBounds() {
        val rnd = Random(4242)
        val pieces = listOf(csi, esc, "$esc]", "$esc(", "$esc#", "", "\r", "\n", "\t", "\b", "?", ";", ":", "m", "H", "J", "K", "r", "h", "l", "@", "P", "X", "L", "M", "S", "T", "b", "n", "c", "t", "q", " ", "!", "", "", "1049", "2004", "1006", "1002", "38;5;", "38:2:", "48;2;1;2;", "日", "😀", "\uD83D", "\uDE00", "é", "abc", " ", "", "\\", "$esc\\", "%", "(0", "#8", "7", "8", "D", "E", "M", "H", "=", ">", "c")
        val t = term(12, 6, 30)
        repeat(4000) {
            val sb = StringBuilder()
            repeat(rnd.nextInt(1, 6)) {
                if (rnd.nextInt(3) == 0) sb.append(rnd.nextInt(0, 0x10FFFF).let { cp -> if (cp in 0xD800..0xDFFF) 'x'.code else cp }.let { String(Character.toChars(it)) })
                else sb.append(pieces[rnd.nextInt(pieces.size)])
                if (rnd.nextInt(4) == 0) sb.append(rnd.nextInt(0, 300))
            }
            t.feed(sb)
            if (rnd.nextInt(50) == 0) t.resize(rnd.nextInt(1, 30), rnd.nextInt(1, 10))
            assertTrue(t.cursorRow in 0 until t.rows)
            assertTrue(t.cursorCol in 0 until t.cols)
            assertTrue(t.totalRows() >= t.rows)
            t.rowText(t.totalRows() - 1)
            t.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, 1, 1, 0)
        }
        t.renderText()
        t.textBetween(0, 0, t.totalRows() - 1, t.cols - 1)
    }

    @Test
    fun largeMixedFeedIsFast() {
        val t = term(120, 40, 2000)
        val chunk = buildString {
            repeat(50) { append("${csi}32mok ${csi}0m${csi}1;34mline$it${csi}0m 日本語 é text text text text text\r\n") }
        }
        val start = System.nanoTime()
        var total = 0
        while (total < 1_000_000) { t.feed(chunk); total += chunk.length }
        val ms = (System.nanoTime() - start) / 1_000_000
        assertTrue("1 MiB fed in ${ms}ms", ms < 8000)
        assertNotEquals(0, t.totalRows())
        assertEquals(2000 + 40, t.totalRows())
    }
}
