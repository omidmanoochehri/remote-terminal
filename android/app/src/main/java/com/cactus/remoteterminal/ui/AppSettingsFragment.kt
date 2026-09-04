package com.cactus.remoteterminal.ui

import android.Manifest
import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.BuildConfig
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.databinding.FragmentAppSettingsBinding
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.BottomNavView
import com.cactus.remoteterminal.ui.design.SettingsBuilder
import com.cactus.remoteterminal.ui.design.bind
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/**
 * App settings. Every preference the app has ever had is here, grouped as the
 * design groups them; the rows that need more room (fonts, key rows, history)
 * open a screen or a dialog rather than growing the list.
 */
class AppSettingsFragment : Fragment(), RtScreen {
    override val showsBottomNav = true
    override val navDestination = BottomNavView.Destination.SETTINGS

    private var _binding: FragmentAppSettingsBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    private var query: String = ""

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { build() }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentAppSettingsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.scroll.padForNavigationBar()
        Design.excludeFromAutofill(view)

        binding.headerBar.bind(
            title = getString(R.string.nav_settings),
            subtitle = getString(R.string.settings_subtitle),
            onSearch = { toggleSearch(!binding.searchBar.root.visible) },
            onRefresh = null,
            onOverflow = { anchor -> overflow(anchor) },
        )

        binding.searchBar.searchInput.hint = getString(R.string.settings_search_hint)
        binding.searchBar.searchInput.doAfterTextChanged { text ->
            query = text?.toString().orEmpty()
            binding.searchBar.searchClear.visible = query.isNotEmpty()
            build()
        }
        binding.searchBar.searchClear.setOnClickListener { binding.searchBar.searchInput.setText("") }

        build()

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.settings.version.collect { build() }
            }
        }
    }

    /** The header magnifier filters the list rather than opening another screen. */
    private fun toggleSearch(show: Boolean) {
        binding.searchBar.root.visible = show
        if (show) {
            binding.searchBar.searchInput.requestFocus()
            requireContext().getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                ?.showSoftInput(binding.searchBar.searchInput, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        } else {
            binding.searchBar.searchInput.setText("")
        }
    }

    private fun overflow(anchor: View) {
        val menu = android.widget.PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.setting_paired_phones)
        menu.menu.add(0, 2, 1, R.string.setting_unpair)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> host.openDevices()
                2 -> confirmUnpair()
            }
            true
        }
        menu.show()
    }

    /* ------------------------------ the list ------------------------------ */

    private fun build() {
        val b = _binding ?: return
        val s = app.settings
        val builder = SettingsBuilder(b.sections, query)
        builder.clear()

        builder.section(getString(R.string.group_appearance))
            .row(
                R.drawable.ic_rt_moon_star, R.color.rt_primary,
                getString(R.string.setting_theme), getString(R.string.setting_theme_desc),
                value = themeLabel(s.appTheme),
            ) { chooseFromArray(R.string.setting_theme, R.array.app_theme_entries, R.array.app_theme_values, s.appTheme) { value ->
                s.raw.edit().putString(Settings.KEY_APP_THEME, value).apply()
                app.applyAppTheme(value)
            } }
            .row(
                R.drawable.ic_rt_font, R.color.rt_accent,
                getString(R.string.setting_terminal_font),
                getString(R.string.setting_terminal_font_value, fontLabel(s.terminalFontFamily), trimFloat(s.fontSizeSp)),
            ) { host.openTerminalFontSettings() }

        builder.section(getString(R.string.group_terminal))
            .toggle(
                R.drawable.ic_rt_keyboard, R.color.rt_primary,
                getString(R.string.setting_extra_keys), getString(R.string.setting_extra_keys_desc),
                checked = s.showExtraKeys,
            ) { value -> s.showExtraKeys = value }
            .toggle(
                R.drawable.ic_rt_bell, R.color.rt_amber,
                getString(R.string.setting_command_notifications), getString(R.string.setting_command_notifications_desc),
                checked = s.notifyExit,
            ) { value ->
                s.raw.edit().putBoolean(Settings.KEY_NOTIFY_EXIT, value).apply()
                if (value) askNotificationsIfNeeded()
            }
            .row(
                R.drawable.ic_rt_history, R.color.rt_purple,
                getString(R.string.setting_command_history),
                resources.getQuantityString(R.plurals.setting_command_history_desc, Settings.COMMAND_HISTORY_MAX, Settings.COMMAND_HISTORY_MAX),
                value = s.commandHistory.size.toString(),
            ) { host.openCommandHistory() }
            .toggle(
                R.drawable.ic_rt_command, R.color.rt_accent,
                getString(R.string.setting_command_bar), getString(R.string.setting_command_bar_desc),
                checked = s.commandBar,
            ) { value -> s.commandBar = value }
            .row(
                R.drawable.ic_rt_panel_top, R.color.rt_primary,
                getString(R.string.setting_scrollback), null,
                value = s.scrollbackLines.toString(),
            ) { chooseFromArray(R.string.setting_scrollback, R.array.scrollback_entries, R.array.scrollback_values, s.scrollbackLines.toString()) { value ->
                s.raw.edit().putString(Settings.KEY_SCROLLBACK, value).apply()
            } }
            .toggle(
                R.drawable.ic_rt_lightbulb, R.color.rt_amber,
                getString(R.string.setting_keep_awake), null,
                checked = s.keepAwake,
            ) { value -> s.raw.edit().putBoolean(Settings.KEY_KEEP_AWAKE, value).apply() }
            .toggle(
                R.drawable.ic_rt_copy, R.color.rt_accent,
                getString(R.string.setting_osc52), getString(R.string.setting_osc52_desc),
                checked = s.osc52Clipboard,
            ) { value -> s.raw.edit().putBoolean(Settings.KEY_OSC52, value).apply() }
            .row(
                R.drawable.ic_rt_message, R.color.rt_purple,
                getString(R.string.setting_paste_confirm), null,
                value = pasteConfirmLabel(s.pasteConfirmLines),
            ) { chooseFromArray(R.string.setting_paste_confirm, R.array.paste_confirm_entries, R.array.paste_confirm_values, s.pasteConfirmLines.toString()) { value ->
                s.raw.edit().putString(Settings.KEY_PASTE_CONFIRM, value).apply()
            } }
            .row(
                R.drawable.ic_rt_bell_ring, R.color.rt_amber,
                getString(R.string.setting_bell), null,
                value = bellLabel(s.bell),
            ) { chooseFromArray(R.string.setting_bell, R.array.bell_entries, R.array.bell_values, s.bell) { value ->
                s.raw.edit().putString(Settings.KEY_BELL, value).apply()
            } }
            .toggle(
                R.drawable.ic_rt_activity, R.color.rt_primary,
                getString(R.string.setting_haptics), null,
                checked = s.haptics,
            ) { value -> s.raw.edit().putBoolean(Settings.KEY_HAPTICS, value).apply() }

        builder.section(getString(R.string.group_keyboard))
            .row(
                R.drawable.ic_rt_keyboard, R.color.rt_accent,
                getString(R.string.setting_key_rows), getString(R.string.setting_key_rows_desc),
            ) { editKeyRows() }
            .row(
                R.drawable.ic_rt_command, R.color.rt_primary,
                getString(R.string.setting_command_shortcuts), getString(R.string.setting_command_shortcuts_desc),
                value = s.commandShortcuts.size.toString(),
            ) { editCommandShortcuts() }

        builder.section(getString(R.string.group_notifications))
            .toggle(
                R.drawable.ic_rt_wifi_off, R.color.rt_amber,
                getString(R.string.setting_notify_offline), null,
                checked = s.notifyAgentOffline,
            ) { value ->
                s.raw.edit().putBoolean(Settings.KEY_NOTIFY_OFFLINE, value).apply()
                if (value) askNotificationsIfNeeded()
            }
            .toggle(
                R.drawable.ic_rt_terminal_square, R.color.rt_primary,
                getString(R.string.setting_notify_exit), null,
                checked = s.notifyExit,
            ) { value ->
                s.raw.edit().putBoolean(Settings.KEY_NOTIFY_EXIT, value).apply()
                if (value) askNotificationsIfNeeded()
            }
            .toggle(
                R.drawable.ic_rt_bell, R.color.rt_purple,
                getString(R.string.setting_notify_bell), null,
                checked = s.notifyBell,
            ) { value ->
                s.raw.edit().putBoolean(Settings.KEY_NOTIFY_BELL, value).apply()
                if (value) askNotificationsIfNeeded()
            }

        val keyguard = ContextCompat.getSystemService(requireContext(), KeyguardManager::class.java)
        val lockAvailable = keyguard?.isDeviceSecure == true
        builder.section(getString(R.string.group_security_connection))
            .toggle(
                R.drawable.ic_rt_fingerprint, R.color.rt_primary,
                getString(R.string.setting_biometric),
                if (lockAvailable) getString(R.string.setting_biometric_desc) else getString(R.string.setting_biometric_unavailable),
                checked = s.biometricLock && lockAvailable,
                enabled = lockAvailable,
            ) { value -> s.biometricLock = value }
            .row(
                R.drawable.ic_rt_globe, R.color.rt_accent,
                getString(R.string.setting_default_relay),
                Format.relayHost(app.credentials.relayUrl),
            ) { MachineActions.copy(requireContext(), app.credentials.relayUrl ?: "") }
            .row(
                R.drawable.ic_rt_phone, R.color.rt_purple,
                getString(R.string.setting_paired_phones), null,
            ) { host.openDevices() }
            .row(
                R.drawable.ic_rt_fingerprint, R.color.rt_text_muted,
                getString(R.string.setting_device_id),
                app.credentials.deviceId ?: getString(R.string.value_unknown),
            ) { MachineActions.copy(requireContext(), app.credentials.deviceId ?: "") }
            .row(
                R.drawable.ic_rt_trash, R.color.rt_danger,
                getString(R.string.setting_unpair), null,
            ) { confirmUnpair() }

        builder.footnote(getString(R.string.about_line, BuildConfig.VERSION_NAME, BuildConfig.PROTOCOL_VERSION))
        builder.finish()

        if (builder.isEmpty) {
            b.stateBlock.show(
                icon = R.drawable.ic_rt_search,
                title = getString(R.string.empty_search_title),
                body = getString(R.string.empty_search_body, query),
                actionLabel = R.string.clear_search,
                actionIcon = R.drawable.ic_rt_close,
            ) { b.searchBar.searchInput.setText("") }
        } else {
            b.stateBlock.hide()
        }
    }

    /* -------------------------------- helpers ----------------------------- */

    private fun themeLabel(value: String): String =
        labelFor(R.array.app_theme_entries, R.array.app_theme_values, value)

    private fun bellLabel(value: String): String =
        labelFor(R.array.bell_entries, R.array.bell_values, value)

    private fun pasteConfirmLabel(value: Int): String =
        labelFor(R.array.paste_confirm_entries, R.array.paste_confirm_values, value.toString())

    private fun fontLabel(value: String): String =
        getString(if (value == Settings.FONT_SYSTEM) R.string.font_system else R.string.font_bundled)

    private fun labelFor(entries: Int, values: Int, value: String): String {
        val e = resources.getStringArray(entries)
        val v = resources.getStringArray(values)
        val index = v.indexOf(value)
        return if (index >= 0) e[index] else value
    }

    private fun trimFloat(value: Float): String =
        if (value % 1f == 0f) value.toInt().toString() else value.toString()

    private fun chooseFromArray(title: Int, entries: Int, values: Int, current: String, onPick: (String) -> Unit) {
        val e = resources.getStringArray(entries)
        val v = resources.getStringArray(values)
        val index = v.indexOf(current).coerceAtLeast(0)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(title)
            .setSingleChoiceItems(e, index) { dialog, which ->
                onPick(v[which])
                dialog.dismiss()
                build()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun askNotificationsIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.permission_notifications_title)
            .setMessage(R.string.permission_notifications_body)
            .setPositiveButton(R.string.permission_allow) { _, _ ->
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            .setNegativeButton(R.string.permission_not_now, null)
            .show()
    }

    private fun editKeyRows() {
        val s = app.settings
        val input = EditText(requireContext()).apply {
            setText(listOf(s.extraKeysRow1, s.extraKeysRow2, s.extraKeysRow3).joinToString("\n"))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setPadding(48, 32, 48, 32)
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.setting_key_rows)
            .setMessage(R.string.pref_keys_help)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val rows = input.text.toString().lines()
                s.raw.edit()
                    .putString(Settings.KEY_KEYS_ROW1, rows.getOrElse(0) { Settings.DEFAULT_ROW1 }.trim())
                    .putString(Settings.KEY_KEYS_ROW2, rows.getOrElse(1) { Settings.DEFAULT_ROW2 }.trim())
                    .putString(Settings.KEY_KEYS_ROW3, rows.getOrElse(2) { Settings.DEFAULT_ROW3 }.trim())
                    .apply()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun editCommandShortcuts() {
        val s = app.settings
        val input = EditText(requireContext()).apply {
            setText(s.commandShortcuts.joinToString("\n") { "${it.first} = ${it.second}" })
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setPadding(48, 32, 48, 32)
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.setting_command_shortcuts)
            .setMessage(R.string.pref_commands_help)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                s.commandShortcuts = input.text.toString().lines().mapNotNull { line ->
                    val t = line.trim()
                    if (t.isEmpty()) return@mapNotNull null
                    val eq = t.indexOf('=')
                    if (eq > 0) t.substring(0, eq).trim() to t.substring(eq + 1).trim() else t to t
                }
                build()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun confirmUnpair() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.unpair)
            .setMessage(R.string.unpair_confirm)
            .setPositiveButton(R.string.unpair) { _, _ ->
                app.agents.clearCache()
                app.client.unpair()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
