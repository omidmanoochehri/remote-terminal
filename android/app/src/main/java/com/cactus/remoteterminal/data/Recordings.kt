package com.cactus.remoteterminal.data

import android.content.Context
import com.cactus.remoteterminal.terminal.Asciicast
import com.cactus.remoteterminal.terminal.CastWriter
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.util.UUID

/**
 * Terminal recordings kept on this phone (`filesDir/recordings/<id>.cast`,
 * asciicast v2) with a small `<id>.json` beside each for the list: title,
 * machine, when, how long, how big. Renaming touches only the sidecar; an
 * export writes the current title into the header.
 */
class Recordings(context: Context) {
    val dir: File = File(context.filesDir, "recordings")
    private val active = HashSet<String>()

    data class Meta(
        val id: String,
        val title: String,
        val machine: String,
        /** Epoch ms when recording started. */
        val startedAt: Long,
        val durationSec: Double,
        val size: Long,
    )

    fun castFile(id: String) = File(dir, "$id.cast")
    private fun metaFile(id: String) = File(dir, "$id.json")

    /** Finished recordings, newest first. Call off the main thread. */
    fun list(): List<Meta> {
        val files = dir.listFiles { f -> f.name.endsWith(".cast") } ?: return emptyList()
        return files.mapNotNull { f ->
            val id = f.name.removeSuffix(".cast")
            if (synchronized(active) { id in active }) null else meta(id)
        }.sortedByDescending { it.startedAt }
    }

    fun meta(id: String): Meta? {
        val cast = castFile(id)
        if (!cast.isFile) return null
        readSidecar(id)?.let { return it.copy(size = cast.length()) }
        // No sidecar (the app died while recording): rebuild it from the file itself.
        return try {
            val header = cast.bufferedReader().use { r -> Asciicast.parseHeader(r.readLine() ?: return null) }
            val duration = cast.bufferedReader().use { r -> Asciicast.lastEventTime(r.lineSequence()) }
            Meta(id, header.title.ifEmpty { id }, header.machine, header.timestamp * 1000, duration, cast.length())
                .also { writeSidecar(it) }
        } catch (_: Exception) { null }
    }

    private fun readSidecar(id: String): Meta? = try {
        val o = JSONObject(metaFile(id).readText())
        Meta(id, o.optString("title"), o.optString("machine"), o.optLong("startedAt"), o.optDouble("duration", 0.0), o.optLong("size"))
    } catch (_: Exception) { null }

    private fun writeSidecar(m: Meta) {
        runCatching {
            metaFile(m.id).writeText(
                JSONObject().put("title", m.title).put("machine", m.machine).put("startedAt", m.startedAt)
                    .put("duration", m.durationSec).put("size", m.size).toString()
            )
        }
    }

    fun rename(id: String, title: String) {
        val m = meta(id) ?: return
        writeSidecar(m.copy(title = title))
    }

    fun delete(id: String) {
        castFile(id).delete()
        metaFile(id).delete()
    }

    /** Copy a recording to [out] with its current title in the header. Call off the main thread. */
    fun export(id: String, out: java.io.OutputStream) {
        val m = meta(id)
        val w = BufferedWriter(OutputStreamWriter(out, Charsets.UTF_8))
        castFile(id).bufferedReader().use { r ->
            var first = true
            for (line in r.lineSequence()) {
                if (first) {
                    first = false
                    val h = runCatching { Asciicast.parseHeader(line) }.getOrNull()
                    w.write(if (h != null && m != null) Asciicast.headerLine(h.copy(title = m.title)) else line)
                } else w.write(line)
                w.write("\n")
            }
        }
        w.flush()
    }

    /** A file name for sharing or saving: the title, made safe, with `.cast`. */
    fun fileName(m: Meta): String =
        m.title.replace(Regex("[^A-Za-z0-9._ -]+"), "_").trim().take(60).ifEmpty { "recording" } + ".cast"

    /** Start recording a terminal of [cols]×[rows]. */
    fun start(title: String, machine: String, cols: Int, rows: Int): Recorder {
        dir.mkdirs()
        val id = System.currentTimeMillis().toString(36) + "-" + UUID.randomUUID().toString().take(6)
        synchronized(active) { active += id }
        val now = System.currentTimeMillis()
        val header = Asciicast.Header(cols, rows, now / 1000, title, machine)
        return Recorder(id, title, machine, now, castFile(id), header)
    }

    /**
     * One recording in progress. Writes go through a buffer on the calling
     * (main) thread; terminal output arrives in chunks, so this is a handful
     * of small appends a second.
     */
    inner class Recorder internal constructor(
        val id: String,
        private val title: String,
        private val machine: String,
        val startedAt: Long,
        file: File,
        header: Asciicast.Header,
    ) {
        private val out = BufferedWriter(OutputStreamWriter(file.outputStream(), Charsets.UTF_8), 32 * 1024)
        private val writer = CastWriter(out, header)
        private val startNanos = System.nanoTime()
        var stopped = false; private set

        val full: Boolean get() = writer.full

        private fun now() = (System.nanoTime() - startNanos) / 1e9

        /** False once the size limit is reached; the caller then stops the recording. */
        fun output(data: String): Boolean = !stopped && runCatching { writer.output(now(), data) }.getOrDefault(false)

        fun resize(cols: Int, rows: Int) { if (!stopped) runCatching { writer.resize(now(), cols, rows) } }

        fun stop(): Meta {
            if (!stopped) {
                stopped = true
                runCatching { out.flush(); out.close() }
            }
            synchronized(active) { active -= id }
            val m = Meta(id, title, machine, startedAt, writer.lastTime, castFile(id).length())
            writeSidecar(m)
            return m
        }
    }
}
