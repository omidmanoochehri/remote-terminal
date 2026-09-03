package com.cactus.remoteterminal

import android.app.Application
import androidx.appcompat.app.AppCompatDelegate
import com.cactus.remoteterminal.data.AgentRepository
import com.cactus.remoteterminal.data.CredentialStore
import com.cactus.remoteterminal.data.SessionRepository
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.notify.Notifier

/**
 * Process-wide singletons. The relay connection and the open terminal tabs
 * live here (not in an Activity) so they survive rotation and navigation;
 * the shells themselves live on the agents and survive everything else.
 */
class App : Application() {
    lateinit var settings: Settings; private set
    lateinit var credentials: CredentialStore; private set
    lateinit var client: RelayClient; private set
    lateinit var agents: AgentRepository; private set
    lateinit var sessions: SessionRepository; private set
    lateinit var notifier: Notifier; private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = Settings(this)
        applyAppTheme(settings.appTheme)
        credentials = CredentialStore(this)
        client = RelayClient(this, credentials)
        agents = AgentRepository(this, client)
        sessions = SessionRepository(client, agents, settings)
        notifier = Notifier(this, settings, client, agents, sessions)
        sessions.onClipboard = { _, text ->
            if (settings.osc52Clipboard) {
                val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("terminal", text))
            }
        }
    }

    fun applyAppTheme(mode: String) {
        AppCompatDelegate.setDefaultNightMode(
            when (mode) {
                "dark" -> AppCompatDelegate.MODE_NIGHT_YES
                "light" -> AppCompatDelegate.MODE_NIGHT_NO
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
        )
    }

    companion object {
        lateinit var instance: App; private set
    }
}
