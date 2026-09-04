package com.cactus.remoteterminal.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.AgentRepository
import com.cactus.remoteterminal.data.SessionRepository
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.data.TerminalSession
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.RelayEvent
import com.cactus.remoteterminal.ui.MainActivity

/**
 * Optional, quiet notifications: a machine you are using went offline, a
 * terminal's process exited, a terminal rang the bell. Only raised while the
 * app is in the background and only when the corresponding setting is on;
 * never for ordinary output.
 */
class Notifier(
    private val context: Context,
    private val settings: Settings,
    private val client: RelayClient,
    private val agents: AgentRepository,
    private val sessions: SessionRepository,
) : RelayClient.Listener {

    @Volatile var foreground = true
    private val usedAgents = HashSet<String>()

    init {
        createChannels()
        client.addListener(this)
        sessions.onSessionExited = { s -> if (!foreground && settings.notifyExit) notifyExit(s) }
        sessions.onBell = { s ->
            if (foreground && settings.bell == "vibrate") vibrate()
            if (!foreground && settings.notifyBell) notifyBell(s)
        }
    }

    private var lastVibrate = 0L
    private fun vibrate() {
        val now = System.currentTimeMillis()
        if (now - lastVibrate < 300) return // a flood of bells should not buzz continuously
        lastVibrate = now
        try {
            val v = if (Build.VERSION.SDK_INT >= 31) {
                (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager).defaultVibrator
            } else @Suppress("DEPRECATION") (context.getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator)
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(android.os.VibrationEffect.createOneShot(40, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
            else @Suppress("DEPRECATION") v.vibrate(40)
        } catch (_: Throwable) { /* no vibrator */ }
    }

    /** Remember machines the user actively opened, so offline alerts are only for those. */
    fun noteAgentUsed(agentId: String) { usedAgents.add(agentId) }

    override fun onRelayEvent(event: RelayEvent) {
        if (event !is RelayEvent.AgentOffline) return
        // Two ways to opt in: the global "machine goes offline" setting for
        // machines you have opened, or per-machine connection alerts.
        val perMachine = settings.connectionAlerts(event.agentId)
        val global = settings.notifyAgentOffline && event.agentId in usedAgents
        if (!perMachine && !(global && !foreground)) return
        if (foreground && !perMachine) return
        val name = agents.agent(event.agentId)?.name ?: "A machine"
        post(
            CHANNEL_STATUS, event.agentId.hashCode(),
            context.getString(R.string.notif_offline_title, name),
            context.getString(R.string.notif_offline_text),
        )
    }

    private fun notifyExit(s: TerminalSession) {
        val machine = agents.agent(s.agentId)?.name ?: ""
        post(CHANNEL_TERMINAL, s.sessionId.hashCode(), context.getString(R.string.notif_exit_title, s.displayTitle),
            context.getString(R.string.notif_exit_text, machine, s.exitCode ?: 0), s)
    }

    private fun notifyBell(s: TerminalSession) {
        val machine = agents.agent(s.agentId)?.name ?: ""
        post(CHANNEL_TERMINAL, s.sessionId.hashCode(), context.getString(R.string.notif_bell_title, s.displayTitle), machine, s)
    }

    private fun post(channel: String, id: Int, title: String, text: String, session: TerminalSession? = null) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (session != null) { putExtra(MainActivity.EXTRA_AGENT, session.agentId); putExtra(MainActivity.EXTRA_SESSION, session.sessionId) }
        }
        val pi = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_terminal)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try { NotificationManagerCompat.from(context).notify(id, n) } catch (_: SecurityException) { /* permission revoked */ }
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL_STATUS, context.getString(R.string.channel_status), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = context.getString(R.string.channel_status_desc)
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_TERMINAL, context.getString(R.string.channel_terminal), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = context.getString(R.string.channel_terminal_desc)
        })
    }

    companion object {
        const val CHANNEL_STATUS = "status"
        const val CHANNEL_TERMINAL = "terminal"
    }
}
