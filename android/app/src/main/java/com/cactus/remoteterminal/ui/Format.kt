package com.cactus.remoteterminal.ui

import android.content.Context
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo

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
            else -> context.getString(R.string.machine_last_seen, relativeTime(context, agent.lastSeen)) to R.color.status_offline
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
}
