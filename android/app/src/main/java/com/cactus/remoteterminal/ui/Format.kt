package com.cactus.remoteterminal.ui

import android.content.Context
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.TerminalSession
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.SessionInfo
import java.util.Locale
import kotlin.math.roundToInt

/** Small presentation helpers shared by the screens. */
object Format {
    fun relativeTime(context: Context, at: Long?, now: Long = System.currentTimeMillis()): String {
        if (at == null || at <= 0) return context.getString(R.string.machine_never_seen)
        val d = (now - at).coerceAtLeast(0)
        val minutes = d / 60_000
        return when {
            minutes < 1 -> context.getString(R.string.time_just_now)
            minutes < 60 -> context.getString(R.string.time_minutes, minutes.toInt())
            minutes < 60 * 24 -> context.getString(R.string.time_hours, (minutes / 60).toInt())
            else -> context.getString(R.string.time_days, (minutes / (60 * 24)).toInt())
        }
    }

    /** Presence glyph carried in text so state never relies on colour alone. */
    fun presence(context: Context, agent: AgentInfo, connection: RelayClient.ConnectionState): Pair<String, Int> {
        val connected = connection is RelayClient.ConnectionState.Connected
        return when {
            !connected -> connectionLabel(context, connection) to R.color.status_reconnecting
            agent.online -> context.getString(R.string.machine_online) to R.color.status_online
            agent.lastSeen == null || agent.lastSeen <= 0 ->
                context.getString(R.string.machine_never_seen) to R.color.status_offline
            else -> context.getString(R.string.machine_last_seen, relativeTime(context, agent.lastSeen)) to R.color.status_offline
        }
    }

    /**
     * The longer presence line used on the machine cards: "Online · Last seen
     * now" / "Offline · 2h ago". Falls back to the relay state when the phone
     * itself is not connected, because then nothing is known to be online.
     */
    fun presenceDetail(context: Context, agent: AgentInfo, connection: RelayClient.ConnectionState): Pair<String, Int> {
        val connected = connection is RelayClient.ConnectionState.Connected
        return when {
            !connected -> connectionLabel(context, connection) to R.color.rt_status_warn
            agent.online -> context.getString(R.string.presence_online_last_seen) to R.color.rt_status_online
            else -> context.getString(
                R.string.presence_offline_since, relativeTime(context, agent.lastSeen)
            ) to R.color.rt_status_offline
        }
    }

    fun connectionLabel(context: Context, s: RelayClient.ConnectionState): String = when (s) {
        is RelayClient.ConnectionState.Connected -> context.getString(R.string.state_connected)
        is RelayClient.ConnectionState.Connecting -> context.getString(R.string.state_connecting)
        is RelayClient.ConnectionState.Reconnecting -> {
            val secs = ((s.nextAtMs - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
            if (secs > 1) context.getString(R.string.state_reconnecting_in, secs.toInt()) else context.getString(R.string.state_reconnecting)
        }
        is RelayClient.ConnectionState.Disconnected -> context.getString(R.string.state_disconnected)
        is RelayClient.ConnectionState.Unpaired -> context.getString(R.string.state_unpaired)
        is RelayClient.ConnectionState.Failed -> context.getString(R.string.state_failed, s.reason)
    }

    fun connectionColor(s: RelayClient.ConnectionState): Int = when (s) {
        is RelayClient.ConnectionState.Connected -> R.color.status_online
        is RelayClient.ConnectionState.Failed -> R.color.status_error
        is RelayClient.ConnectionState.Unpaired, is RelayClient.ConnectionState.Disconnected -> R.color.status_offline
        else -> R.color.status_reconnecting
    }

    fun machineSubtitle(agent: AgentInfo): String {
        val parts = ArrayList<String>()
        if (agent.hostname.isNotEmpty() && agent.hostname != agent.name) parts.add(agent.hostname)
        if (agent.os.isNotEmpty()) parts.add(agent.os) else if (agent.platform.isNotEmpty()) parts.add(agent.platform)
        return parts.joinToString(" · ")
    }

    /** Hostname · OS · architecture, as the machine cards show it. */
    fun machineSubtitleFull(agent: AgentInfo): String {
        val parts = ArrayList<String>()
        if (agent.hostname.isNotEmpty()) parts.add(agent.hostname)
        if (agent.os.isNotEmpty()) parts.add(agent.os) else if (agent.platform.isNotEmpty()) parts.add(agent.platform)
        if (agent.arch.isNotEmpty()) parts.add(agent.arch)
        return parts.joinToString(" · ")
    }

    /** "bash • detached • just now" under a terminal row. */
    fun terminalMeta(context: Context, s: SessionInfo): String {
        val state = when {
            !s.isRunning -> context.getString(R.string.session_state_exited, s.exitCode ?: 0)
            s.attached > 0 -> context.getString(R.string.session_state_running)
            else -> context.getString(R.string.session_state_detached)
        }
        val age = relativeTime(context, if (s.lastActiveAt > 0) s.lastActiveAt else s.createdAt)
        return listOf(s.shell, state, age).filter { it.isNotEmpty() }.joinToString(" • ")
    }

    fun terminalTitle(context: Context, s: SessionInfo): String =
        s.title.ifEmpty { s.shell.ifEmpty { context.getString(R.string.terminal) } }

    fun terminalTitle(context: Context, s: TerminalSession): String =
        s.title.ifEmpty { s.shell.ifEmpty { context.getString(R.string.terminal) } }

    /** Human byte size with one decimal above a gigabyte, as the metric tiles show it. */
    fun bytes(value: Long): String {
        if (value <= 0) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        var v = value.toDouble()
        var unit = 0
        while (v >= 1024 && unit < units.lastIndex) { v /= 1024; unit++ }
        return if (unit >= 3) String.format(Locale.getDefault(), "%.1f %s", v, units[unit])
        else String.format(Locale.getDefault(), "%.0f %s", v, units[unit])
    }

    fun percent(fraction: Float): String = "${(fraction * 100).roundToInt()}%"

    /**
     * "12d 4h" / "4h 20m" / "13m" — the uptime tile and the terminal footer.
     * A session that started seconds ago reads "0m", not "unknown"; only a
     * negative value (no start time at all) is unknown.
     */
    fun duration(context: Context, seconds: Long): String {
        if (seconds < 0) return context.getString(R.string.value_unknown)
        val days = seconds / 86_400
        val hours = (seconds % 86_400) / 3_600
        val minutes = (seconds % 3_600) / 60
        return when {
            days > 0 -> "${days}d ${hours}h"
            hours > 0 -> "${hours}h ${minutes}m"
            else -> "${minutes}m"
        }
    }

    /** Relay host without the scheme, for the settings and details rows. */
    fun relayHost(relayUrl: String?): String {
        if (relayUrl.isNullOrBlank()) return "—"
        return try {
            val uri = java.net.URI(relayUrl)
            uri.host?.let { host -> if (uri.port > 0) "$host:${uri.port}" else host } ?: relayUrl
        } catch (_: Exception) {
            relayUrl
        }
    }

    fun isSecureRelay(relayUrl: String?): Boolean = relayUrl?.startsWith("wss://") == true
}
