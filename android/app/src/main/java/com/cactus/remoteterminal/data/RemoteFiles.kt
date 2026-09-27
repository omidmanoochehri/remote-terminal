package com.cactus.remoteterminal.data

import android.util.Base64
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentReply
import com.cactus.remoteterminal.protocol.FsListing
import com.cactus.remoteterminal.protocol.ProcessList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream

/** A request the machine refused, with its protocol code (`exists`, `forbidden` …) and its own words. */
class RemoteError(val code: String, message: String) : Exception(message)

/**
 * The machine tools over agent requests (PROTOCOL.md §6b): the file browser's
 * listing, transfers and edits, and the process manager. Every call is made on
 * the main thread and suspends until the agent answers; file bytes are read
 * and written on the IO dispatcher and never held whole in memory.
 */
class RemoteFiles(private val client: RelayClient) {

    private suspend fun call(agentId: String, method: String, params: JSONObject): JSONObject =
        when (val r = client.agentCall(agentId, method, params)) {
            is AgentReply.Ok -> r.result
            is AgentReply.Failed -> throw RemoteError(r.code, r.display)
        }

    suspend fun list(agentId: String, path: String?): FsListing =
        FsListing.fromJson(call(agentId, "fs.list", JSONObject().also { if (!path.isNullOrEmpty()) it.put("path", path) }))

    suspend fun mkdir(agentId: String, path: String) { call(agentId, "fs.mkdir", JSONObject().put("path", path)) }

    suspend fun rename(agentId: String, from: String, to: String) { call(agentId, "fs.rename", JSONObject().put("from", from).put("to", to)) }

    suspend fun delete(agentId: String, path: String, recursive: Boolean) {
        call(agentId, "fs.delete", JSONObject().put("path", path).put("recursive", recursive))
    }

    suspend fun processes(agentId: String): ProcessList = ProcessList.fromJson(call(agentId, "proc.list", JSONObject()))

    suspend fun kill(agentId: String, pid: Int, force: Boolean) {
        call(agentId, "proc.kill", JSONObject().put("pid", pid).put("force", force))
    }

    private class Slice(val offset: Long, val bytes: ByteArray, val size: Long, val eof: Boolean)

    private suspend fun read(agentId: String, path: String, offset: Long): Slice {
        val r = call(agentId, "fs.read", JSONObject().put("path", path).put("offset", offset).put("length", CHUNK))
        val bytes = Base64.decode(r.optString("data"), Base64.DEFAULT)
        return Slice(r.optLong("offset", offset), bytes, r.optLong("size", 0L), r.optBoolean("eof", true))
    }

    /**
     * Copy a file from the machine into [out], a slice at a time with up to
     * [WINDOW] reads in flight. [onProgress] gets (bytes so far, total).
     * Returns the number of bytes written.
     */
    suspend fun download(agentId: String, path: String, out: OutputStream, onProgress: (Long, Long) -> Unit): Long = coroutineScope {
        val first = read(agentId, path, 0)
        withContext(Dispatchers.IO) { out.write(first.bytes) }
        var written = first.bytes.size.toLong()
        val total = first.size
        onProgress(written, total)
        if (first.eof) { withContext(Dispatchers.IO) { out.flush() }; return@coroutineScope written }

        var next = written
        val window = ArrayDeque<Deferred<Slice>>()
        fun launchNext() {
            val at = next
            next += CHUNK
            window.addLast(async { read(agentId, path, at) })
        }
        while (next < total && window.size < WINDOW) launchNext()
        while (window.isNotEmpty()) {
            val s = window.removeFirst().await()
            if (s.offset != written) throw RemoteError("io_error", "The file changed while it was downloading.")
            withContext(Dispatchers.IO) { out.write(s.bytes) }
            written += s.bytes.size
            onProgress(written, total)
            // A file that shrank ends early; one that grew is taken as it was when we started.
            if (s.eof || s.bytes.isEmpty()) break
            if (next < total) launchNext()
        }
        for (d in window) d.cancel()
        withContext(Dispatchers.IO) { out.flush() }
        written
    }

    /**
     * Copy [input] to [path] on the machine. The agent keeps the slices in a
     * hidden part file and only renames it into place with the final one, so
     * a cancelled upload leaves nothing half-written behind; the part file is
     * removed on the way out as well. Throws [RemoteError] `exists` when the
     * name is taken and [overwrite] is false.
     */
    suspend fun upload(agentId: String, path: String, input: InputStream, total: Long, overwrite: Boolean, onProgress: (Long, Long) -> Unit) {
        var offset = 0L
        var started = false
        try {
            var current = withContext(Dispatchers.IO) { readChunk(input) }
            while (true) {
                // Read ahead one slice: the only way to know this one is the last.
                val ahead = if (current.size < CHUNK) ByteArray(0) else withContext(Dispatchers.IO) { readChunk(input) }
                val final = ahead.isEmpty()
                val params = JSONObject()
                    .put("path", path).put("offset", offset)
                    .put("data", Base64.encodeToString(current, Base64.NO_WRAP))
                    .put("final", final).put("overwrite", overwrite)
                call(agentId, "fs.write", params)
                started = true
                offset += current.size
                onProgress(offset, total)
                if (final) return
                current = ahead
            }
        } catch (e: Throwable) {
            if (started && (e is CancellationException || e !is RemoteError)) {
                withContext(NonCancellable) { runCatching { delete(agentId, "$path.rtpart", recursive = false) } }
            }
            throw e
        }
    }

    private fun readChunk(input: InputStream): ByteArray {
        val buf = ByteArray(CHUNK)
        var n = 0
        while (n < CHUNK) {
            val r = input.read(buf, n, CHUNK - n)
            if (r < 0) break
            n += r
        }
        return if (n == CHUNK) buf else buf.copyOf(n)
    }

    companion object {
        /** 192 KiB raw, 256 KiB of base64: the agent's largest read, well inside the frame limit. */
        const val CHUNK = 192 * 1024
        /** Reads in flight during a download. */
        const val WINDOW = 3
    }
}
