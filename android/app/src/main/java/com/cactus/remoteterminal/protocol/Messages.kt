package com.cactus.remoteterminal.protocol

import org.json.JSONArray
import org.json.JSONObject

/** Protocol v3 descriptive objects and message builders (PROTOCOL.md). */

const val PROTOCOL_VERSION = 3

data class ShellInfo(val id: String, val label: String, val isDefault: Boolean) {
    companion object {
        fun fromJson(o: JSONObject) = ShellInfo(o.getString("id"), o.optString("label", o.getString("id")), o.optBoolean("default", false))
    }
}

data class SessionInfo(
    val sessionId: String,
    val title: String,
    val shell: String,
    val state: String,          // "running" | "exited"
    val createdAt: Long,
    val lastActiveAt: Long,
    val cols: Int,
    val rows: Int,
    val seq: Long,
    val attached: Int,
    val exitCode: Int?,
) {
    val isRunning: Boolean get() = state == "running"

    companion object {
        fun fromJson(o: JSONObject) = SessionInfo(
            sessionId = o.getString("sessionId"),
            title = o.optString("title", ""),
            shell = o.optString("shell", ""),
            state = o.optString("state", "running"),
            createdAt = o.optLong("createdAt", 0L),
            lastActiveAt = o.optLong("lastActiveAt", 0L),
            cols = o.optInt("cols", 0),
            rows = o.optInt("rows", 0),
            seq = o.optLong("seq", 0L),
            attached = o.optInt("attached", 0),
            exitCode = if (o.isNull("exitCode")) null else o.optInt("exitCode"),
        )
    }
}

data class AgentInfo(
    val agentId: String,
    val name: String,
    val hostname: String,
    val platform: String,       // "win32" | "linux" | "darwin"
    val os: String,
    val arch: String,
    val agentVersion: String,
    val shells: List<ShellInfo>,
    val caps: List<String>,
    val online: Boolean,
    val lastSeen: Long?,
    val instanceId: String?,
    val sessions: List<SessionInfo>,
) {
    val isWindows: Boolean get() = platform == "win32"

    companion object {
        fun fromJson(o: JSONObject): AgentInfo = AgentInfo(
            agentId = o.getString("agentId"),
            name = o.optString("name", ""),
            hostname = o.optString("hostname", ""),
            platform = o.optString("platform", ""),
            os = o.optString("os", ""),
            arch = o.optString("arch", ""),
            agentVersion = o.optString("agentVersion", ""),
            shells = o.optJSONArray("shells").toList { ShellInfo.fromJson(it) },
            caps = o.optJSONArray("caps").toStrings(),
            online = o.optBoolean("online", false),
            lastSeen = if (o.isNull("lastSeen")) null else o.optLong("lastSeen"),
            instanceId = if (o.isNull("instanceId")) null else o.optString("instanceId"),
            sessions = o.optJSONArray("sessions").toList { SessionInfo.fromJson(it) },
        )
    }
}

data class DeviceInfo(
    val deviceId: String,
    val name: String,
    val platform: String,
    val createdAt: Long,
    val lastSeen: Long?,
    val online: Boolean,
    val isSelf: Boolean,
) {
    companion object {
        fun fromJson(o: JSONObject) = DeviceInfo(
            deviceId = o.getString("deviceId"),
            name = o.optString("name", ""),
            platform = o.optString("platform", ""),
            createdAt = o.optLong("createdAt", 0L),
            lastSeen = if (o.isNull("lastSeen")) null else o.optLong("lastSeen"),
            online = o.optBoolean("online", false),
            isSelf = o.optBoolean("isSelf", false),
        )
    }
}

data class Limits(val maxSessionsPerAgent: Int, val maxSessionsPerAccount: Int, val maxInputBytes: Int, val maxFrameBytes: Int) {
    companion object {
        val DEFAULT = Limits(16, 64, 1024 * 1024, 1024 * 1024)
        fun fromJson(o: JSONObject?): Limits = if (o == null) DEFAULT else Limits(
            o.optInt("maxSessionsPerAgent", DEFAULT.maxSessionsPerAgent),
            o.optInt("maxSessionsPerAccount", DEFAULT.maxSessionsPerAccount),
            o.optInt("maxInputBytes", DEFAULT.maxInputBytes),
            o.optInt("maxFrameBytes", DEFAULT.maxFrameBytes),
        )
    }
}

inline fun <T> JSONArray?.toList(map: (JSONObject) -> T): List<T> {
    if (this == null) return emptyList()
    val out = ArrayList<T>(length())
    for (i in 0 until length()) optJSONObject(i)?.let { out.add(map(it)) }
    return out
}

fun JSONArray?.toStrings(): List<String> {
    if (this == null) return emptyList()
    val out = ArrayList<String>(length())
    for (i in 0 until length()) out.add(optString(i))
    return out
}

/** Builders for phone → relay messages. Each returns the JSON text to send. */
object Outgoing {
    private fun msg(type: String) = JSONObject().put("type", type)

    fun ping() = msg("ping").toString()
    fun agentList() = msg("agent.list").toString()
    fun deviceList() = msg("device.list").toString()
    fun agentRename(agent: String, name: String) = msg("agent.rename").put("agent", agent).put("name", name).toString()
    fun agentRemove(agent: String) = msg("agent.remove").put("agent", agent).toString()
    fun deviceRename(name: String) = msg("device.rename").put("name", name).toString()
    fun deviceRevoke(device: String) = msg("device.revoke").put("device", device).toString()
    fun sessionCreate(reqId: String, agent: String, shell: String?, cols: Int, rows: Int, title: String?) =
        msg("session.create").put("reqId", reqId).put("agent", agent).put("cols", cols).put("rows", rows)
            .also { if (shell != null) it.put("shell", shell); if (title != null) it.put("title", title) }.toString()
    fun sessionAttach(reqId: String, agent: String, session: String, since: Long?, cols: Int, rows: Int) =
        msg("session.attach").put("reqId", reqId).put("agent", agent).put("session", session).put("cols", cols).put("rows", rows)
            .also { if (since != null) it.put("since", since) }.toString()
    fun sessionDetach(agent: String, session: String) = msg("session.detach").put("agent", agent).put("session", session).toString()
    fun sessionClose(agent: String, session: String) = msg("session.close").put("agent", agent).put("session", session).toString()
    fun sessionRename(agent: String, session: String, title: String) = msg("session.rename").put("agent", agent).put("session", session).put("title", title).toString()
    fun input(agent: String, session: String, data: String) = msg("input").put("agent", agent).put("session", session).put("data", data).toString()
    fun resize(agent: String, session: String, cols: Int, rows: Int) = msg("resize").put("agent", agent).put("session", session).put("cols", cols).put("rows", rows).toString()

    // File transfer into a session (a pasted image, mostly): begin → chunks → end.
    fun fileBegin(reqId: String, agent: String, session: String, name: String, mime: String, size: Int) =
        msg("file.begin").put("reqId", reqId).put("agent", agent).put("session", session)
            .put("name", name).put("mime", mime).put("size", size).toString()
    fun fileChunk(reqId: String, agent: String, session: String, seq: Int, dataBase64: String) =
        msg("file.chunk").put("reqId", reqId).put("agent", agent).put("session", session).put("seq", seq).put("data", dataBase64).toString()
    fun fileEnd(reqId: String, agent: String, session: String) =
        msg("file.end").put("reqId", reqId).put("agent", agent).put("session", session).toString()
    fun fileAbort(reqId: String, agent: String, session: String) =
        msg("file.abort").put("reqId", reqId).put("agent", agent).put("session", session).toString()
}
