package com.cactus.remoteterminal.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.Lifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.ActivityMainBinding
import com.cactus.remoteterminal.net.RelayClient
import kotlinx.coroutines.launch

/**
 * Single-activity host. Portrait phones show one screen at a time (Machines →
 * Machine → Terminal); on wide screens (sw600dp) the Machines list stays in a
 * side pane while the machine/terminal screens use the main pane.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val app get() = application as App
    val twoPane: Boolean get() = binding.listPane != null

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* optional */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Draw edge to edge (the platform default from Android 15) and let each
        // screen pad its own chrome out of the system bars — see ui/Insets.kt.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        WindowInsetsControllerCompat(window, binding.root).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }

        if (savedInstanceState == null) {
            if (!app.credentials.isPaired) openPair(initial = true)
            else {
                if (twoPane) {
                    supportFragmentManager.commit { replace(R.id.listPane, MachinesFragment()) }
                    supportFragmentManager.commit { replace(R.id.container, PlaceholderFragment()) }
                } else {
                    supportFragmentManager.commit { replace(R.id.container, MachinesFragment()) }
                }
                handleIntent(intent)
            }
            maybeAskNotifications()
        }

        // A revoked/unpaired phone always lands on the pairing screen.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.client.state.collect { s ->
                    if (s is RelayClient.ConnectionState.Unpaired && supportFragmentManager.findFragmentById(R.id.container) !is PairFragment) openPair(initial = true)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val agent = intent?.getStringExtra(EXTRA_AGENT) ?: return
        val session = intent.getStringExtra(EXTRA_SESSION)
        if (app.credentials.isPaired) openTerminal(agent, session)
    }

    override fun onStart() {
        super.onStart()
        app.notifier.foreground = true
        app.client.setForeground(true)
    }

    override fun onStop() {
        super.onStop()
        app.notifier.foreground = false
        app.client.setForeground(false)
    }

    /* ----------------------------- navigation ----------------------------- */

    private fun show(fragment: Fragment, tag: String, addToBackStack: Boolean = true) {
        supportFragmentManager.commit {
            setReorderingAllowed(true)
            replace(R.id.container, fragment, tag)
            if (addToBackStack) addToBackStack(tag)
        }
    }

    fun openMachines() {
        if (twoPane) { supportFragmentManager.popBackStack(null, androidx.fragment.app.FragmentManager.POP_BACK_STACK_INCLUSIVE); return }
        supportFragmentManager.popBackStack(null, androidx.fragment.app.FragmentManager.POP_BACK_STACK_INCLUSIVE)
        if (supportFragmentManager.findFragmentById(R.id.container) !is MachinesFragment) show(MachinesFragment(), "machines", addToBackStack = false)
    }

    fun openAgent(agentId: String) {
        app.notifier.noteAgentUsed(agentId)
        show(AgentFragment.newInstance(agentId), "agent:$agentId")
    }

    fun openTerminal(agentId: String, sessionId: String?) {
        app.notifier.noteAgentUsed(agentId)
        show(TerminalFragment.newInstance(agentId, sessionId), "terminal:$agentId")
    }

    fun openPair(initial: Boolean = false) {
        supportFragmentManager.popBackStack(null, androidx.fragment.app.FragmentManager.POP_BACK_STACK_INCLUSIVE)
        if (twoPane) supportFragmentManager.findFragmentById(R.id.listPane)?.let { supportFragmentManager.commit { remove(it) } }
        show(PairFragment(), "pair", addToBackStack = !initial)
    }

    /** After a successful pairing: rebuild the normal screens. */
    fun onPaired() {
        supportFragmentManager.popBackStack(null, androidx.fragment.app.FragmentManager.POP_BACK_STACK_INCLUSIVE)
        if (twoPane) {
            supportFragmentManager.commit { replace(R.id.listPane, MachinesFragment()) }
            show(PlaceholderFragment(), "placeholder", addToBackStack = false)
        } else show(MachinesFragment(), "machines", addToBackStack = false)
    }

    fun openDevices() = show(DevicesFragment(), "devices")
    fun openSettings() = show(SettingsFragment(), "settings")

    private fun maybeAskNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        val s = app.settings
        if (!(s.notifyAgentOffline || s.notifyExit || s.notifyBell)) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("rt_ui", MODE_PRIVATE)
        if (prefs.getBoolean("asked_notifications", false)) return
        prefs.edit().putBoolean("asked_notifications", true).apply()
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    companion object {
        const val EXTRA_AGENT = "agent"
        const val EXTRA_SESSION = "session"
    }
}

/** Empty right pane on tablets before a machine is chosen. */
class PlaceholderFragment : Fragment(R.layout.fragment_placeholder)
