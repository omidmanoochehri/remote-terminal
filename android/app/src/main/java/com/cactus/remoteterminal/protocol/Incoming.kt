package com.cactus.remoteterminal.protocol

import org.json.JSONObject

/** Relay → phone messages, parsed into typed events (PROTOCOL.md §5). */
sealed class RelayEvent {
    data class Welcome(
        val version: Int, val connId: String, val accountId: String, val deviceId: String,
        val caps: List<String>, val limits: Limits, val agents: List<AgentInfo>, val devices: List<DeviceInfo>,
    ) : RelayEvent()
    data class AgentList(val agents: List<AgentInfo>) : RelayEvent()
    data class AgentOnline(val agent: AgentInfo) : RelayEvent()
    data class AgentOffline(val agentId: String, val lastSeen: Long?) : RelayEvent()
    data class AgentUpdated(val agentId: String, val name: String) : RelayEvent()
    data class AgentRemoved(val agentId: String, val by: String?) : RelayEvent()
    data class DeviceList(val devices: List<DeviceInfo>) : RelayEvent()
    data class DeviceUpdated(val deviceId: String, val name: String) : RelayEvent()
    data class DeviceRevoked(val deviceId: String, val by: String?) : RelayEvent()
    data class SessionCreated(val agentId: String, val session: SessionInfo, val reqId: String?) : RelayEvent()
    data class SessionAttached(val agentId: String, val sessionId: String, val from: Long, val seq: Long, val cols: Int, val rows: Int, val reqId: String?) : RelayEvent()
    data class SessionUpdated(val agentId: String, val sessionId: String, val title: String?, val state: String?, val cols: Int?, val rows: Int?, val exitCode: Int?) : RelayEvent()
    data class Exit(val agentId: String, val sessionId: String, val code: Int?) : RelayEvent()
    data class SessionClosed(val agentId: String, val sessionId: String, val reason: String) : RelayEvent()
    data class SessionLag(val agentId: String, val sessionId: String) : RelayEvent()
    data class Output(val agentId: String, val sessionId: String, val seq: Long, val data: String) : RelayEvent()
    data class FileStored(val agentId: String, val sessionId: String, val path: String, val size: Long, val reqId: String?) : RelayEvent()
    data class Error(val code: String, val message: String, val reqId: String?, val agentId: String?, val sessionId: String?) : RelayEvent() {
        /** Human-readable text for the UI. */
        val display: String
            get() = when (code) {
                "agent_offline" -> "The machine is offline."
                "unknown_session" -> "That terminal no longer exists."
                "limit_reached" -> "Limit reached: $message"
                "rate_limited" -> "Too many requests; try again in a moment."
                "forbidden" -> "Not allowed: $message"
                "unauthorized" -> "Not authorized. Pair this phone again."
                "unsupported_version" -> "The relay speaks a different protocol version."
                else -> message.ifEmpty { code }
            }
    }
    object Pong : RelayEvent()
    data class Unknown(val type: String) : RelayEvent()
}

object Incoming {
    private fun JSONObject.str(key: String): String? = if (!has(key) || isNull(key)) null else optString(key)
    private fun JSONObject.int(key: String): Int? = if (!has(key) || isNull(key)) null else optInt(key)
    private fun JSONObject.long(key: String): Long? = if (!has(key) || isNull(key)) null else optLong(key)

    /** Parse one relay message. Throws on malformed JSON; unknown types become [RelayEvent.Unknown]. */
    fun parse(text: String): RelayEvent {
        val o = JSONObject(text)
        return when (val type = o.optString("type")) {
            "output" -> RelayEvent.Output(o.getString("agent"), o.getString("session"), o.getLong("seq"), o.optString("data"))
            "welcome" -> RelayEvent.Welcome(
                version = o.optInt("v", 0), connId = o.optString("connId"), accountId = o.optString("accountId"),
                deviceId = o.optString("deviceId"), caps = o.optJSONArray("caps").toStrings(),
                limits = Limits.fromJson(o.optJSONObject("limits")),
                agents = o.optJSONArray("agents").toList { AgentInfo.fromJson(it) },
                devices = o.optJSONArray("devices").toList { DeviceInfo.fromJson(it) },
            )
            "agent.list" -> RelayEvent.AgentList(o.optJSONArray("agents").toList { AgentInfo.fromJson(it) })
            "agent.online" -> RelayEvent.AgentOnline(AgentInfo.fromJson(o.getJSONObject("agent")))
            "agent.offline" -> RelayEvent.AgentOffline(o.getString("agent"), o.long("lastSeen"))
            "agent.updated" -> RelayEvent.AgentUpdated(o.getString("agent"), o.optString("name"))
            "agent.removed" -> RelayEvent.AgentRemoved(o.getString("agent"), o.str("by"))
            "device.list" -> RelayEvent.DeviceList(o.optJSONArray("devices").toList { DeviceInfo.fromJson(it) })
            "device.updated" -> RelayEvent.DeviceUpdated(o.getString("device"), o.optString("name"))
            "device.revoked" -> RelayEvent.DeviceRevoked(o.getString("device"), o.str("by"))
            "session.created" -> RelayEvent.SessionCreated(o.getString("agent"), SessionInfo.fromJson(o.getJSONObject("session")), o.str("reqId"))
            "session.attached" -> RelayEvent.SessionAttached(
                o.getString("agent"), o.getString("session"), o.getLong("from"), o.getLong("seq"), o.optInt("cols"), o.optInt("rows"), o.str("reqId"),
            )
            "session.updated" -> RelayEvent.SessionUpdated(
                o.getString("agent"), o.getString("session"), o.str("title"), o.str("state"), o.int("cols"), o.int("rows"), o.int("exitCode"),
            )
            "exit" -> RelayEvent.Exit(o.getString("agent"), o.getString("session"), o.int("code"))
            "session.closed" -> RelayEvent.SessionClosed(o.getString("agent"), o.getString("session"), o.optString("reason", "closed"))
            "session.lag" -> RelayEvent.SessionLag(o.getString("agent"), o.getString("session"))
            "file.stored" -> RelayEvent.FileStored(o.getString("agent"), o.getString("session"), o.optString("path"), o.optLong("size", 0L), o.str("reqId"))
            "error" -> RelayEvent.Error(o.optString("code", "internal"), o.optString("message"), o.str("reqId"), o.str("agent"), o.str("session"))
            "pong" -> RelayEvent.Pong
            else -> RelayEvent.Unknown(type)
        }
    }
}
