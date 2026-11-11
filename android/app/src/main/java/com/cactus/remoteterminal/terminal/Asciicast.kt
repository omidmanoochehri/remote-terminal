package com.cactus.remoteterminal.terminal

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Terminal recordings in asciicast v2: a JSON header line, then one JSON array
 * per event — `[seconds, "o", text]` for output, `[seconds, "r", "COLSxROWS"]`
 * for a resize. The format asciinema and its players read, so a recording
 * shared from here plays anywhere.
 *
 * Kept identical to the desktop's `ui/js/core/asciicast.js`.
 */
object Asciicast {

    data class Header(
        val width: Int,
        val height: Int,
        /** Unix seconds when recording started. */
        val timestamp: Long,
        val title: String,
        /** Which machine it was recorded on (an extra header key players ignore). */
        val machine: String = "",
    )

    data class Event(val time: Double, val type: String, val data: String)

    data class Cast(val header: Header, val events: List<Event>) {
        val duration: Double get() = events.lastOrNull()?.time ?: 0.0
    }

    fun headerLine(h: Header): String {
        val o = JSONObject()
            .put("version", 2)
            .put("width", h.width)
            .put("height", h.height)
            .put("timestamp", h.timestamp)
        if (h.title.isNotEmpty()) o.put("title", h.title)
        if (h.machine.isNotEmpty()) o.put("machine", h.machine)
        return o.toString()
    }

    fun eventLine(time: Double, type: String, data: String): String =
        "[" + String.format(Locale.US, "%.6f", time) + ", " + JSONObject.quote(type) + ", " + JSONObject.quote(data) + "]"

    fun resizeData(cols: Int, rows: Int) = "${cols}x$rows"

    /** "120x40" → (120, 40), or null. */
    fun parseSize(data: String): Pair<Int, Int>? {
        val x = data.indexOf('x')
        if (x <= 0) return null
        val c = data.substring(0, x).toIntOrNull() ?: return null
        val r = data.substring(x + 1).toIntOrNull() ?: return null
        return if (c > 0 && r > 0) c to r else null
    }

    fun parseHeader(line: String): Header {
        val o = try { JSONObject(line) } catch (_: Exception) { throw IllegalArgumentException("Not an asciicast recording.") }
        if (o.optInt("version", -1) != 2) throw IllegalArgumentException("Only asciicast version 2 recordings can be played.")
        return Header(
            width = o.optInt("width", 80).coerceIn(1, 1000),
            height = o.optInt("height", 24).coerceIn(1, 1000),
            timestamp = o.optLong("timestamp", 0L),
            title = o.optString("title", ""),
            machine = o.optString("machine", ""),
        )
    }

    /** Parse a whole recording; malformed event lines are skipped, a bad header throws [IllegalArgumentException]. */
    fun parse(text: String): Cast = parse(text.lineSequence())

    fun parse(lines: Sequence<String>): Cast {
        val it = lines.iterator()
        var headerLine: String? = null
        while (it.hasNext()) { val l = it.next(); if (l.isNotBlank()) { headerLine = l; break } }
        val header = parseHeader(headerLine ?: throw IllegalArgumentException("The recording is empty."))
        val events = ArrayList<Event>()
        var last = 0.0
        while (it.hasNext()) {
            val l = it.next()
            if (l.isBlank()) continue
            val e = parseEvent(l) ?: continue
            // Time never runs backwards in a player; clamp rather than reorder.
            val t = maxOf(last, e.time)
            last = t
            events += if (t == e.time) e else e.copy(time = t)
        }
        return Cast(header, events)
    }

    fun parseEvent(line: String): Event? = try {
        val a = JSONArray(line)
        val t = a.getDouble(0)
        val type = a.getString(1)
        val data = a.getString(2)
        if (t.isNaN() || t < 0) null else Event(t, type, data)
    } catch (_: Exception) { null }

    /** The seconds of the last event of a recording file's text without keeping the events. */
    fun lastEventTime(lines: Sequence<String>): Double {
        var last = 0.0
        for (l in lines.drop(1)) if (l.isNotBlank()) parseEvent(l)?.let { last = maxOf(last, it.time) }
        return last
    }
}

/**
 * Writes a recording as it happens and keeps count of its size, so it can be
 * stopped at [limitBytes]. [output] and [resize] return false once the limit
 * was reached; nothing past it is written.
 */
class CastWriter(
    private val sink: Appendable,
    header: Asciicast.Header,
    private val limitBytes: Long = LIMIT_BYTES,
) {
    var bytes: Long = 0; private set
    var lastTime: Double = 0.0; private set
    var full: Boolean = false; private set

    init { write(Asciicast.headerLine(header)) }

    fun output(time: Double, data: String): Boolean = event(time, "o", data)

    fun resize(time: Double, cols: Int, rows: Int): Boolean = event(time, "r", Asciicast.resizeData(cols, rows))

    private fun event(time: Double, type: String, data: String): Boolean {
        if (full) return false
        if (data.isEmpty()) return true
        val t = maxOf(lastTime, time)
        val line = Asciicast.eventLine(t, type, data)
        if (bytes + utf8Length(line) + 1 > limitBytes) { full = true; return false }
        lastTime = t
        write(line)
        return true
    }

    private fun write(line: String) {
        sink.append(line).append('\n')
        bytes += utf8Length(line) + 1
    }

    companion object {
        /** 16 MiB per recording. */
        const val LIMIT_BYTES = 16L * 1024 * 1024

        fun utf8Length(s: String): Int {
            var n = 0
            var i = 0
            while (i < s.length) {
                val c = s[i]
                n += when {
                    c.code < 0x80 -> 1
                    c.code < 0x800 -> 2
                    Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> { i++; 4 }
                    else -> 3
                }
                i++
            }
            return n
        }
    }
}

/**
 * Playback times for a recording. With [skipIdle] every pause longer than
 * [idleCap] seconds is shortened to it, so a recording of a long wait plays
 * in a moment. Seeking replays the events up to a time into a fresh screen.
 */
class CastTimeline(events: List<Asciicast.Event>, skipIdle: Boolean, idleCap: Double = 1.0) {
    /** Play time of each event, non-decreasing. */
    val times: DoubleArray = DoubleArray(events.size).also { out ->
        var prevRaw = 0.0
        var at = 0.0
        for ((i, e) in events.withIndex()) {
            val gap = (e.time - prevRaw).coerceAtLeast(0.0)
            at += if (skipIdle) minOf(gap, idleCap) else gap
            out[i] = at
            prevRaw = e.time
        }
    }

    val duration: Double get() = if (times.isEmpty()) 0.0 else times[times.size - 1]

    /** How many events are due at play time [t] (events at exactly [t] included). */
    fun countAt(t: Double): Int {
        var lo = 0
        var hi = times.size
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            if (times[mid] <= t) lo = mid + 1 else hi = mid
        }
        return lo
    }
}
