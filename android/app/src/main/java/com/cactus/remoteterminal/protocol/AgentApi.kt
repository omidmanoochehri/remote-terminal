package com.cactus.remoteterminal.protocol

import org.json.JSONObject

/*
 * Agent requests (PROTOCOL.md §6b): the answers the file browser and the
 * process manager work from, and the small pure rules around them — how a
 * folder is sorted and filtered, how a path is split into breadcrumbs, whose
 * process may be ended. No Android here, so all of it is unit tested.
 */

/** What came back from one `agent.request`: a result object, or a refusal with the agent's reason. */
sealed class AgentReply {
    data class Ok(val result: JSONObject) : AgentReply()
    data class Failed(val code: String, val message: String) : AgentReply() {
        /** Text for the UI: the agent's own message where it gave one. */
        val display: String
            get() = when (code) {
                "timeout" -> "The machine did not answer in time."
                "disconnected" -> "Not connected to the relay."
                "agent_offline" -> "The machine is offline."
                "unsupported" -> "The agent on this machine is too old for this."
                else -> message.ifEmpty { code }
            }
    }

    companion object {
        /** The reply carried by a relay event, or null when the event is not one. */
        fun of(event: RelayEvent): AgentReply? = when (event) {
            is RelayEvent.AgentResponse -> Ok(event.result)
            is RelayEvent.Error -> Failed(event.code, event.message)
            else -> null
        }
    }
}

/** The capabilities that switch the machine tools on (relay `requests`, agent `fs` / `procs`). */
object AgentCaps {
    const val RELAY_REQUESTS = "requests"
    const val FILES = "fs"
    const val PROCESSES = "procs"

    fun files(relayCaps: Collection<String>, agent: AgentInfo): Boolean =
        RELAY_REQUESTS in relayCaps && FILES in agent.caps

    fun processes(relayCaps: Collection<String>, agent: AgentInfo): Boolean =
        RELAY_REQUESTS in relayCaps && PROCESSES in agent.caps
}

/* ---------------------------------- files --------------------------------- */

data class FsEntry(
    val name: String,
    /** "file" | "dir" | "link" | "other" */
    val type: String,
    val size: Long,
    val mtime: Long,
    val hidden: Boolean,
    val link: Boolean,
    val broken: Boolean,
) {
    val isDir: Boolean get() = type == "dir"
    val isFile: Boolean get() = type == "file"

    companion object {
        fun fromJson(o: JSONObject) = FsEntry(
            name = o.optString("name"),
            type = o.optString("type", "other"),
            size = o.optLong("size", 0L),
            mtime = o.optLong("mtime", 0L),
            hidden = o.optBoolean("hidden", false),
            link = o.optBoolean("link", false),
            broken = o.optBoolean("broken", false),
        )
    }
}

data class FsListing(
    val path: String,
    val root: String,
    /** Null at the root: there is nowhere further up to go. */
    val parent: String?,
    val sep: String,
    val entries: List<FsEntry>,
    val truncated: Boolean,
) {
    companion object {
        fun fromJson(o: JSONObject): FsListing {
            val path = o.optString("path")
            return FsListing(
                path = path,
                root = o.optString("root", path),
                parent = if (o.isNull("parent")) null else o.optString("parent").ifEmpty { null },
                sep = o.optString("sep").ifEmpty { if (path.contains('\\')) "\\" else "/" },
                entries = o.optJSONArray("entries").toList { FsEntry.fromJson(it) },
                truncated = o.optBoolean("truncated", false),
            )
        }
    }
}

object FsPaths {
    enum class Sort { NAME, SIZE, MODIFIED }

    data class Crumb(val label: String, val path: String)

    /** A child of [dir]: one separator between them, never two. */
    fun child(dir: String, name: String, sep: String): String =
        if (dir.endsWith(sep)) dir + name else dir + sep + name

    /** The last segment of a path, or the path itself for a root like `/` or `C:\`. */
    fun name(path: String, sep: String): String =
        path.trimEnd(*sep.toCharArray()).substringAfterLast(sep).ifEmpty { path }

    /**
     * Breadcrumbs from the browsable root down to [path]. The root is one
     * crumb (the folder's own name); every folder below it is another.
     */
    fun breadcrumbs(path: String, root: String, sep: String): List<Crumb> {
        val crumbs = arrayListOf(Crumb(name(root, sep), root))
        if (path.length <= root.length || !path.startsWith(root)) return crumbs
        var at = root
        for (segment in path.substring(root.length).split(sep).filter { it.isNotEmpty() }) {
            at = child(at, segment, sep)
            crumbs.add(Crumb(segment, at))
        }
        return crumbs
    }

    /**
     * What a folder shows: hidden entries only when asked, those matching the
     * filter (case-insensitive, anywhere in the name), folders first, then by
     * the chosen order — largest and newest first, names A→Z.
     */
    fun arrange(entries: List<FsEntry>, sort: Sort, showHidden: Boolean, filter: String): List<FsEntry> {
        val q = filter.trim().lowercase()
        val shown = entries.filter { (showHidden || !it.hidden) && (q.isEmpty() || it.name.lowercase().contains(q)) }
        val byName = compareBy<FsEntry, String>(String.CASE_INSENSITIVE_ORDER) { it.name }
        val order = when (sort) {
            Sort.NAME -> byName
            Sort.SIZE -> compareByDescending<FsEntry> { it.size }.then(byName)
            Sort.MODIFIED -> compareByDescending<FsEntry> { it.mtime }.then(byName)
        }
        return shown.sortedWith(compareBy<FsEntry> { !it.isDir }.then(order))
    }

    private val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp")

    fun isImage(name: String): Boolean = name.substringAfterLast('.', "").lowercase() in IMAGE_EXTENSIONS

    /** Text is what has no NUL byte in its first few KiB; that is what `file` and git do too. */
    fun looksLikeText(bytes: ByteArray): Boolean {
        val n = minOf(bytes.size, 8192)
        for (i in 0 until n) if (bytes[i].toInt() == 0) return false
        return true
    }
}

/* -------------------------------- processes ------------------------------- */

data class ProcessInfo(
    val pid: Int,
    val name: String,
    val user: String,
    /** Share of the whole machine, 0..1; null while the process is too new to measure. */
    val cpu: Float?,
    val mem: Long,
    val ppid: Int?,
    val cmd: String,
) {
    companion object {
        fun fromJson(o: JSONObject) = ProcessInfo(
            pid = o.optInt("pid"),
            name = o.optString("name"),
            user = o.optString("user"),
            cpu = if (!o.has("cpu") || o.isNull("cpu")) null else o.optDouble("cpu").toFloat(),
            mem = o.optLong("mem", 0L),
            ppid = if (!o.has("ppid") || o.isNull("ppid")) null else o.optInt("ppid"),
            cmd = o.optString("cmd", ""),
        )
    }
}

data class ProcessList(
    val processes: List<ProcessInfo>,
    val total: Int,
    /** "all" | "own" | "none" */
    val killable: String,
    val owner: String?,
) {
    /** Why [p] cannot be ended from here, or null when it can. */
    fun refusal(p: ProcessInfo): Refusal? = when {
        killable == "none" -> Refusal.TurnedOff
        killable == "own" && !Processes.sameUser(p.user, owner) -> Refusal.NotOwn(owner ?: "")
        else -> null
    }

    sealed class Refusal {
        object TurnedOff : Refusal()
        data class NotOwn(val owner: String) : Refusal()
    }

    companion object {
        fun fromJson(o: JSONObject): ProcessList {
            val list = o.optJSONArray("processes").toList { ProcessInfo.fromJson(it) }
            return ProcessList(
                processes = list,
                total = o.optInt("total", list.size),
                killable = o.optString("killable", "all"),
                owner = if (!o.has("owner") || o.isNull("owner")) null else o.optString("owner").ifEmpty { null },
            )
        }
    }
}

object Processes {
    enum class Sort { CPU, MEMORY, NAME }

    /** `OFFICE\ann`, `office\ANN` and `ann` are one person; case never matters. */
    fun sameUser(a: String?, b: String?): Boolean {
        if (a.isNullOrEmpty() || b.isNullOrEmpty()) return false
        val short = { s: String -> s.lowercase().substringAfterLast('\\') }
        return a.equals(b, ignoreCase = true) || short(a) == short(b)
    }

    /** Filter on name, pid, user and command line; order busiest, biggest or A→Z. */
    fun arrange(list: List<ProcessInfo>, sort: Sort, filter: String): List<ProcessInfo> {
        val q = filter.trim().lowercase()
        val shown = if (q.isEmpty()) list else list.filter {
            it.name.lowercase().contains(q) || it.pid.toString() == q || it.pid.toString().startsWith(q) ||
                it.user.lowercase().contains(q) || it.cmd.lowercase().contains(q)
        }
        val byName = compareBy<ProcessInfo, String>(String.CASE_INSENSITIVE_ORDER) { it.name }.thenBy { it.pid }
        return shown.sortedWith(
            when (sort) {
                Sort.CPU -> compareByDescending<ProcessInfo> { it.cpu ?: -1f }.thenByDescending { it.mem }.then(byName)
                Sort.MEMORY -> compareByDescending<ProcessInfo> { it.mem }.then(byName)
                Sort.NAME -> byName
            }
        )
    }

    /** "12.5%" / "0%" / "—" for a process too new to measure. */
    fun cpuLabel(cpu: Float?): String {
        if (cpu == null) return "—"
        val pct = cpu * 100f
        return if (pct >= 10f || pct == 0f) "${Math.round(pct)}%" else String.format(java.util.Locale.US, "%.1f%%", pct)
    }
}
