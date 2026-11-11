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

    const val SYSTEM = "sys"
    const val PORTS = "ports"

    fun system(relayCaps: Collection<String>, agent: AgentInfo): Boolean =
        RELAY_REQUESTS in relayCaps && SYSTEM in agent.caps

    fun ports(relayCaps: Collection<String>, agent: AgentInfo): Boolean =
        RELAY_REQUESTS in relayCaps && PORTS in agent.caps

    /** The System screen shows when the machine can answer either of its two requests. */
    fun systemView(relayCaps: Collection<String>, agent: AgentInfo): Boolean =
        system(relayCaps, agent) || ports(relayCaps, agent)
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

/* --------------------------------- system --------------------------------- */

/** One address of a network interface (`sys.info`). */
data class NetAddress(val family: String, val address: String, val cidr: String?)

data class NetInterface(val name: String, val mac: String?, val addresses: List<NetAddress>)

/** `sys.info`: every field but hostname, platform and interfaces may be missing (null). */
data class SysInfo(
    val hostname: String,
    val platform: String,
    val os: String?,
    val release: String?,
    val arch: String?,
    val cpuModel: String?,
    val cpus: Int?,
    val memoryTotal: Long?,
    val uptimeSec: Long?,
    val agentUptimeSec: Long?,
    val nodeVersion: String?,
    val agentVersion: String?,
    val user: String?,
    val timezone: String?,
    val interfaces: List<NetInterface>,
) {
    companion object {
        private fun JSONObject.str(key: String): String? = when (val v = if (isNull(key)) null else opt(key)) {
            is String -> v.ifEmpty { null }
            is Number -> v.toString()
            else -> null
        }

        private fun JSONObject.long(key: String): Long? =
            if (!has(key) || isNull(key)) null else (opt(key) as? Number)?.toLong()

        fun fromJson(o: JSONObject) = SysInfo(
            hostname = o.optString("hostname"),
            platform = o.optString("platform"),
            os = o.str("os"),
            release = o.str("release"),
            arch = o.str("arch"),
            cpuModel = o.str("cpuModel"),
            cpus = o.long("cpus")?.toInt(),
            memoryTotal = o.long("memoryTotal"),
            uptimeSec = o.long("uptimeSec"),
            agentUptimeSec = o.long("agentUptimeSec"),
            nodeVersion = o.str("nodeVersion"),
            agentVersion = o.str("agentVersion"),
            user = o.str("user"),
            timezone = o.str("timezone"),
            interfaces = o.optJSONArray("interfaces").toList { i ->
                NetInterface(
                    name = i.optString("name"),
                    mac = i.str("mac")?.takeIf { it.replace(":", "").replace("-", "").any { c -> c != '0' } },
                    addresses = i.optJSONArray("addresses").toList { a ->
                        NetAddress(a.optString("family"), a.optString("address"), a.str("cidr"))
                    },
                )
            },
        )
    }
}

/** One listening socket (`net.ports`). */
data class ListeningPort(
    val proto: String,
    val family: String,
    val address: String,
    val port: Int,
    val pid: Int?,
    val process: String?,
) {
    /** `address:port`, with IPv6 addresses bracketed. */
    val endpoint: String get() = if (address.contains(':')) "[$address]:$port" else "$address:$port"

    companion object {
        fun fromJson(o: JSONObject) = ListeningPort(
            proto = o.optString("proto", "tcp"),
            family = o.optString("family", "IPv4"),
            address = o.optString("address"),
            port = o.optInt("port"),
            pid = if (!o.has("pid") || o.isNull("pid")) null else o.optInt("pid"),
            process = if (!o.has("process") || o.isNull("process")) null else o.optString("process").ifEmpty { null },
        )
    }
}

data class PortList(val ports: List<ListeningPort>, val sampledAt: Long, val truncated: Boolean) {
    companion object {
        fun fromJson(o: JSONObject) = PortList(
            ports = o.optJSONArray("ports").toList { ListeningPort.fromJson(it) },
            sampledAt = o.optLong("sampledAt", 0L),
            truncated = o.optBoolean("truncated", false),
        )

        /** Filter on port, protocol, address, process name and pid. */
        fun filter(list: List<ListeningPort>, query: String): List<ListeningPort> {
            val q = query.trim().lowercase()
            if (q.isEmpty()) return list
            return list.filter {
                it.port.toString().startsWith(q) || it.proto.lowercase() == q || it.address.lowercase().contains(q) ||
                    (it.process?.lowercase()?.contains(q) == true) || it.pid?.toString() == q
            }
        }
    }
}
