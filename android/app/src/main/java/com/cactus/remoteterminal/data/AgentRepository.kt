package com.cactus.remoteterminal.data

import android.content.Context
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.DeviceInfo
import com.cactus.remoteterminal.protocol.MachineMetrics
import com.cactus.remoteterminal.protocol.Outgoing
import com.cactus.remoteterminal.protocol.RelayEvent
import com.cactus.remoteterminal.protocol.SessionInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * The account's machines and phones as the relay reports them. Kept up to
 * date from relay events; the last snapshot is cached locally so the
 * Machines screen can show (offline) machines immediately at start-up and
 * while reconnecting.
 */
class AgentRepository(context: Context, private val client: RelayClient) : RelayClient.Listener {
    private val cache = context.applicationContext.getSharedPreferences("rt_agents_cache", Context.MODE_PRIVATE)

    private val _agents = MutableStateFlow<List<AgentInfo>>(loadCache())
    val agents: StateFlow<List<AgentInfo>> = _agents

    private val _devices = MutableStateFlow<List<DeviceInfo>>(emptyList())
    val devices: StateFlow<List<DeviceInfo>> = _devices

    init { client.addListener(this) }

    fun agent(agentId: String): AgentInfo? = _agents.value.firstOrNull { it.agentId == agentId }
    fun session(agentId: String, sessionId: String): SessionInfo? = agent(agentId)?.sessions?.firstOrNull { it.sessionId == sessionId }

    fun refresh() { client.send(Outgoing.agentList()); client.send(Outgoing.deviceList()) }
    fun renameAgent(agentId: String, name: String) = client.send(Outgoing.agentRename(agentId, name))
    fun removeAgent(agentId: String) = client.send(Outgoing.agentRemove(agentId))
    fun renameDevice(name: String) = client.send(Outgoing.deviceRename(name))
    fun revokeDevice(deviceId: String) = client.send(Outgoing.deviceRevoke(deviceId))

    /* ------------------------------- events ------------------------------- */

    override fun onRelayEvent(event: RelayEvent) {
        when (event) {
            is RelayEvent.Welcome -> { setAgents(event.agents); _devices.value = event.devices }
            is RelayEvent.AgentList -> setAgents(event.agents)
            is RelayEvent.AgentOnline -> upsert(event.agent)
            // An offline machine keeps its terminals, but its CPU and free
            // memory are last week's news: drop them rather than show them.
            is RelayEvent.AgentOffline -> update(event.agentId) {
                it.copy(online = false, lastSeen = event.lastSeen ?: it.lastSeen, sessions = it.sessions, metrics = MachineMetrics.EMPTY)
            }
            is RelayEvent.AgentUpdated -> update(event.agentId) { it.copy(name = event.name) }
            // Metrics tick every few seconds and mean nothing offline, so they
            // move the flow without rewriting the on-disk snapshot.
            is RelayEvent.AgentMetrics -> update(event.agentId, cache = false) { it.copy(metrics = event.metrics) }
            is RelayEvent.AgentRemoved -> setAgents(_agents.value.filterNot { it.agentId == event.agentId })
            is RelayEvent.DeviceList -> _devices.value = event.devices
            is RelayEvent.DeviceUpdated -> _devices.value = _devices.value.map { if (it.deviceId == event.deviceId) it.copy(name = event.name) else it }
            is RelayEvent.DeviceRevoked -> _devices.value = _devices.value.filterNot { it.deviceId == event.deviceId }
            is RelayEvent.SessionCreated -> update(event.agentId) { a ->
                a.copy(sessions = a.sessions.filterNot { it.sessionId == event.session.sessionId } + event.session)
            }
            is RelayEvent.SessionUpdated -> updateSession(event.agentId, event.sessionId) { s ->
                s.copy(
                    title = event.title ?: s.title, state = event.state ?: s.state,
                    cols = event.cols ?: s.cols, rows = event.rows ?: s.rows, exitCode = event.exitCode ?: s.exitCode,
                    cwd = event.cwd ?: s.cwd,
                )
            }
            is RelayEvent.SessionAttached -> updateSession(event.agentId, event.sessionId) { s -> s.copy(cols = event.cols, rows = event.rows, seq = event.seq) }
            is RelayEvent.Exit -> updateSession(event.agentId, event.sessionId) { it.copy(state = "exited", exitCode = event.code) }
            is RelayEvent.SessionClosed -> update(event.agentId) { a -> a.copy(sessions = a.sessions.filterNot { it.sessionId == event.sessionId }) }
            else -> {}
        }
    }

    override fun onConnectionState(state: RelayClient.ConnectionState) {
        // While disconnected nobody is reachable; keep the list but show everything offline.
        if (state !is RelayClient.ConnectionState.Connected && state !is RelayClient.ConnectionState.Connecting) {
            if (_agents.value.any { it.online }) {
                _agents.value = _agents.value.map { it.copy(online = false, metrics = MachineMetrics.EMPTY) }
            }
        }
    }

    private fun setAgents(list: List<AgentInfo>, cache: Boolean = true) {
        _agents.value = list.sortedWith(compareBy({ !it.online }, { it.name.lowercase() }))
        if (cache) saveCache(list)
    }

    private fun upsert(agent: AgentInfo) = setAgents(_agents.value.filterNot { it.agentId == agent.agentId } + agent)

    private fun update(agentId: String, cache: Boolean = true, f: (AgentInfo) -> AgentInfo) {
        if (_agents.value.none { it.agentId == agentId }) return
        setAgents(_agents.value.map { if (it.agentId == agentId) f(it) else it }, cache)
    }

    private fun updateSession(agentId: String, sessionId: String, f: (SessionInfo) -> SessionInfo) = update(agentId) { a ->
        if (a.sessions.none { it.sessionId == sessionId }) a
        else a.copy(sessions = a.sessions.map { if (it.sessionId == sessionId) f(it) else it })
    }

    /* -------------------------------- cache ------------------------------- */

    private fun saveCache(list: List<AgentInfo>) {
        val arr = JSONArray()
        for (a in list) {
            arr.put(JSONObject()
                .put("agentId", a.agentId).put("name", a.name).put("hostname", a.hostname).put("platform", a.platform)
                .put("os", a.os).put("arch", a.arch).put("agentVersion", a.agentVersion)
                .put("shells", JSONArray().also { s -> a.shells.forEach { s.put(JSONObject().put("id", it.id).put("label", it.label).put("default", it.isDefault)) } })
                .put("lastSeen", a.lastSeen ?: JSONObject.NULL)
                .put("online", false))
        }
        cache.edit().putString("agents", arr.toString()).apply()
    }

    private fun loadCache(): List<AgentInfo> {
        val raw = cache.getString("agents", null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            List(arr.length()) { AgentInfo.fromJson(arr.getJSONObject(it)) }
        } catch (_: Exception) { emptyList() }
    }

    fun clearCache() { cache.edit().clear().apply(); _agents.value = emptyList(); _devices.value = emptyList() }
}
