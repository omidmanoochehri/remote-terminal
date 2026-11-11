package com.cactus.remoteterminal.terminal

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AsciicastTest {
    private val header = Asciicast.Header(100, 30, 1727600000, "deploy", "prod-01")

    @Test fun writerProducesAsciicastV2() {
        val sb = StringBuilder()
        val w = CastWriter(sb, header)
        assertTrue(w.output(0.5, "hello\r\n\u001B[31mred\u001B[0m \"q\""))
        assertTrue(w.resize(1.25, 120, 40))
        assertTrue(w.output(2.0, "é✓"))
        val lines = sb.toString().trimEnd('\n').split('\n')
        assertEquals(4, lines.size)
        val h = JSONObject(lines[0])
        assertEquals(2, h.getInt("version")); assertEquals(100, h.getInt("width")); assertEquals(30, h.getInt("height"))
        assertEquals(1727600000L, h.getLong("timestamp")); assertEquals("deploy", h.getString("title"))
        val e = JSONArray(lines[1])
        assertEquals(0.5, e.getDouble(0), 1e-9); assertEquals("o", e.getString(1))
        assertEquals("hello\r\n\u001B[31mred\u001B[0m \"q\"", e.getString(2))
        assertEquals("120x40", JSONArray(lines[2]).getString(2))
        assertEquals(sb.toString().toByteArray(Charsets.UTF_8).size.toLong(), w.bytes)
    }

    @Test fun writerStopsAtTheLimit() {
        val sb = StringBuilder()
        val w = CastWriter(sb, header, limitBytes = 200)
        var n = 0
        while (w.output(n * 0.1, "0123456789")) n++
        assertTrue(w.full)
        assertTrue(w.bytes <= 200)
        assertFalse(w.output(99.0, "more"))
        assertEquals(w.bytes, sb.toString().toByteArray(Charsets.UTF_8).size.toLong())
    }

    @Test fun timeNeverRunsBackwardsInTheWriter() {
        val sb = StringBuilder()
        val w = CastWriter(sb, header)
        w.output(2.0, "a"); w.output(1.0, "b")
        assertEquals(2.0, JSONArray(sb.lines()[2]).getDouble(0), 1e-9)
    }

    @Test fun parserReadsWhatTheWriterWrites() {
        val sb = StringBuilder()
        val w = CastWriter(sb, header)
        w.output(0.1, "a"); w.resize(0.2, 90, 20); w.output(3.5, "b")
        val cast = Asciicast.parse(sb.toString() + "garbage line\n[1]\n")
        assertEquals(header, cast.header)
        assertEquals(listOf("o", "r", "o"), cast.events.map { it.type })
        assertEquals(3.5, cast.duration, 1e-9)
        assertEquals(90 to 20, Asciicast.parseSize(cast.events[1].data))
    }

    @Test fun parserRejectsOtherFormats() {
        for (bad in listOf("", "{\"version\":1,\"width\":80,\"height\":24}", "not json")) {
            try { Asciicast.parse(bad); fail(bad) } catch (_: IllegalArgumentException) {}
        }
    }

    @Test fun parseSizeRejectsNonsense() {
        assertEquals(null, Asciicast.parseSize("x"))
        assertEquals(null, Asciicast.parseSize("0x10"))
        assertEquals(null, Asciicast.parseSize("80by24"))
    }

    @Test fun lastEventTime() {
        val text = Asciicast.headerLine(header) + "\n[0.5, \"o\", \"a\"]\n[7.25, \"o\", \"b\"]\n"
        assertEquals(7.25, Asciicast.lastEventTime(text.lineSequence()), 1e-9)
    }

    @Test fun idleCappedTimeline() {
        val events = listOf(0.5, 1.0, 11.0, 11.2, 40.0).map { Asciicast.Event(it, "o", "x") }
        val raw = CastTimeline(events, skipIdle = false)
        assertEquals(40.0, raw.duration, 1e-9)
        val capped = CastTimeline(events, skipIdle = true)
        // 0.5, +0.5, +1 (capped from 10), +0.2, +1 (capped from 28.8)
        assertEquals(listOf(0.5, 1.0, 2.0, 2.2, 3.2), capped.times.toList().map { Math.round(it * 1000) / 1000.0 })
        assertEquals(3.2, capped.duration, 1e-9)
    }

    @Test fun countAtIsTheEventsDueByATime() {
        val t = CastTimeline(listOf(1.0, 2.0, 2.0, 3.0).map { Asciicast.Event(it, "o", "x") }, skipIdle = false)
        assertEquals(0, t.countAt(0.5))
        assertEquals(1, t.countAt(1.0))
        assertEquals(3, t.countAt(2.5))
        assertEquals(4, t.countAt(99.0))
        assertEquals(0, CastTimeline(emptyList(), true).countAt(1.0))
    }
}
