package com.cactus.remoteterminal.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentManager
import androidx.fragment.app.commit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.ActivityMainBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.ui.design.BottomNavView
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/**
 * Contract every screen implements so the shell knows how to frame it: the
 * four destinations behind the navigation bar keep it visible, detail screens
 * (a terminal, a form, a settings page) take the whole window.
 */
interface RtScreen {
    val showsBottomNav: Boolean get() = false
    /** The navigation destination this screen belongs to, when it has one. */
    val navDestination: BottomNavView.Destination? get() = null
}

/**
 * Single-activity host. The four top-level destinations (Home, Machines,
 * Terminals, Settings) are swapped in place behind a floating navigation bar;
 * every other screen is pushed onto the back stack over them.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val app get() = application as App
    private var unlocked = false

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* optional */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Draw edge to edge (the platform default from Android 15); each screen
        // pads its own chrome out of the system bars — see ui/Insets.kt.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        WindowInsetsControllerCompat(window, binding.root).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }

        // The bar floats 8dp above the gesture/navigation inset, never on top of it.
        val baseMargin = resources.getDimensionPixelSize(R.dimen.rt_nav_margin)
        ViewCompat.setOnApplyWindowInsetsListener(binding.bottomNav) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            (v.layoutParams as android.widget.FrameLayout.LayoutParams).also {
                it.bottomMargin = baseMargin + bars.bottom
                v.layoutParams = it
            }
            insets
        }

        binding.bottomNav.onSelected = { destination -> openTab(destination, fromUser = true) }
        supportFragmentManager.addOnBackStackChangedListener { syncChrome() }

        if (savedInstanceState == null) {
            if (!app.credentials.isPaired) openAddMachine(initial = true)
            else {
                openTab(BottomNavView.Destination.HOME, fromUser = false)
                handleIntent(intent)
            }
        }

        // After a rotation or a process restart the fragment manager restores
        // the screen itself, so the chrome has to be re-derived from whatever
        // came back rather than from the transaction we did not run.
        supportFragmentManager.executePendingTransactions()
        syncChrome()

        // A revoked or unpaired phone always lands back on pairing.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.client.state.collect { s ->
                    if (s is RelayClient.ConnectionState.Unpaired &&
                        supportFragmentManager.findFragmentById(R.id.container) !is AddMachineFragment
                    ) openAddMachine(initial = true)
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
        guardWithAppLock()
    }

    override fun onStop() {
        super.onStop()
        app.notifier.foreground = false
        app.client.setForeground(false)
        // Leaving the app re-arms the lock; a rotation does not.
        if (!isChangingConfigurations) unlocked = false
    }

    /* ------------------------------ app lock ------------------------------ */

    private val lockPrompt = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            unlocked = true
            binding.lockCover.visible = false
        } else {
            // Refusing the prompt must not leave the terminal readable.
            finish()
        }
    }

    /**
     * Optional app lock. Uses the device credential prompt (fingerprint, face,
     * PIN — whatever the phone is set up for) instead of pulling in a
     * biometric library; the content stays covered until it succeeds.
     */
    private fun guardWithAppLock() {
        if (!app.settings.biometricLock || unlocked) {
            binding.lockCover.visible = false
            return
        }
        val keyguard = getSystemService(android.app.KeyguardManager::class.java)
        val intent = keyguard?.createConfirmDeviceCredentialIntent(
            getString(R.string.app_name), getString(R.string.setting_biometric_desc)
        )
        if (intent == null) {
            // No screen lock configured any more: the setting cannot be honoured.
            app.settings.biometricLock = false
            binding.lockCover.visible = false
            return
        }
        binding.lockCover.visible = true
        lockPrompt.launch(intent)
    }

    /* ----------------------------- navigation ----------------------------- */

    /** Show one of the four destinations, resetting anything pushed over it. */
    fun openTab(destination: BottomNavView.Destination, fromUser: Boolean) {
        supportFragmentManager.popBackStack(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
        val fragment: Fragment = when (destination) {
            BottomNavView.Destination.HOME -> HomeFragment()
            BottomNavView.Destination.MACHINES -> MachinesFragment()
            BottomNavView.Destination.TERMINALS -> AllTerminalsFragment()
            BottomNavView.Destination.SETTINGS -> AppSettingsFragment()
        }
        supportFragmentManager.commit {
            setReorderingAllowed(true)
            replace(R.id.container, fragment, destination.name)
        }
        binding.bottomNav.selected = destination
        if (!fromUser) syncChrome()
        supportFragmentManager.executePendingTransactions()
        syncChrome()
    }

    private fun push(fragment: Fragment, tag: String, addToBackStack: Boolean = true) {
        supportFragmentManager.commit {
            setReorderingAllowed(true)
            replace(R.id.container, fragment, tag)
            if (addToBackStack) addToBackStack(tag)
        }
        supportFragmentManager.executePendingTransactions()
        syncChrome()
    }

    /** Keep the navigation bar in step with whatever is on screen. */
    private fun syncChrome() {
        val current = supportFragmentManager.findFragmentById(R.id.container)
        val screen = current as? RtScreen
        binding.bottomNav.visible = screen?.showsBottomNav == true
        screen?.navDestination?.let { binding.bottomNav.selected = it }
    }

    fun openMachines() = openTab(BottomNavView.Destination.MACHINES, fromUser = false)
    fun openTerminalsTab() = openTab(BottomNavView.Destination.TERMINALS, fromUser = false)
    fun openHome() = openTab(BottomNavView.Destination.HOME, fromUser = false)
    fun openSettings() = openTab(BottomNavView.Destination.SETTINGS, fromUser = false)

    fun openMachine(agentId: String, tab: MachineFragment.Tab = MachineFragment.Tab.TERMINALS) {
        app.notifier.noteAgentUsed(agentId)
        push(MachineFragment.newInstance(agentId, tab), "machine:$agentId")
    }

    fun openMachineSettings(agentId: String) = push(MachineSettingsFragment.newInstance(agentId), "machineSettings:$agentId")

    fun openTerminal(agentId: String, sessionId: String?) {
        app.notifier.noteAgentUsed(agentId)
        push(TerminalFragment.newInstance(agentId, sessionId), "terminal:$agentId")
    }

    fun openNewTerminal(agentId: String?) = push(NewTerminalFragment.newInstance(agentId), "newTerminal")

    fun openAddMachine(initial: Boolean = false) {
        supportFragmentManager.popBackStack(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
        push(AddMachineFragment(), "addMachine", addToBackStack = !initial)
    }

    fun openDevices() = push(DevicesFragment(), "devices")

    fun openCommandHistory() = push(CommandHistoryFragment(), "commandHistory")

    fun openTerminalFontSettings() = push(TerminalFontFragment(), "terminalFont")

    fun openQrScanner(onResult: (relay: String?, code: String) -> Unit) {
        QrScanFragment.pendingResult = onResult
        push(QrScanFragment(), "qrScan")
    }

    /** After a successful pairing: rebuild the normal screens. */
    fun onPaired() {
        supportFragmentManager.popBackStack(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
        openTab(BottomNavView.Destination.HOME, fromUser = false)
        maybeAskNotifications()
    }

    /* --------------------------- permissions ------------------------------ */

    /**
     * Explain before the system dialog appears: the platform prompt gives no
     * room for a reason, and a refused prompt cannot be shown again.
     */
    fun maybeAskNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        val s = app.settings
        if (!(s.notifyAgentOffline || s.notifyExit || s.notifyBell)) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("rt_ui", MODE_PRIVATE)
        if (prefs.getBoolean("asked_notifications", false)) return
        prefs.edit().putBoolean("asked_notifications", true).apply()
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.permission_notifications_title)
            .setMessage(R.string.permission_notifications_body)
            .setPositiveButton(R.string.permission_allow) { _, _ ->
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            .setNegativeButton(R.string.permission_not_now, null)
            .show()
    }

    companion object {
        const val EXTRA_AGENT = "agent"
        const val EXTRA_SESSION = "session"
    }
}
