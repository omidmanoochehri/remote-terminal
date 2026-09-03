package com.cactus.remoteterminal.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.preference.EditTextPreference
import androidx.preference.ListPreference
import androidx.preference.Preference
import androidx.preference.PreferenceFragmentCompat
import androidx.preference.SwitchPreferenceCompat
import android.view.View
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.BuildConfig
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Settings
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** Settings screen backed by `res/xml/preferences.xml` (same keys as [Settings]). */
class SettingsFragment : PreferenceFragmentCompat() {
    private val app get() = requireActivity().application as App
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
        preferenceManager.sharedPreferencesName = Settings.NAME
        setPreferencesFromResource(R.xml.preferences, rootKey)

        findPreference<ListPreference>(Settings.KEY_APP_THEME)?.setOnPreferenceChangeListener { _, v -> app.applyAppTheme(v as String); true }
        for (key in listOf(Settings.KEY_FONT_SIZE, Settings.KEY_LINE_SPACING, Settings.KEY_CURSOR_STYLE, Settings.KEY_TERMINAL_THEME,
            Settings.KEY_APP_THEME, Settings.KEY_BELL, Settings.KEY_PASTE_CONFIRM, Settings.KEY_SCROLLBACK)) {
            findPreference<ListPreference>(key)?.summaryProvider = ListPreference.SimpleSummaryProvider.getInstance()
        }
        for (key in listOf(Settings.KEY_KEYS_ROW1, Settings.KEY_KEYS_ROW2, Settings.KEY_KEYS_ROW3)) {
            findPreference<EditTextPreference>(key)?.summaryProvider = EditTextPreference.SimpleSummaryProvider.getInstance()
        }
        findPreference<EditTextPreference>(Settings.KEY_COMMANDS)?.let { p ->
            p.text = app.settings.commandShortcuts.joinToString("\n") { "${it.first} = ${it.second}" }
            p.summary = getString(R.string.pref_commands_help)
            p.setOnPreferenceChangeListener { _, v ->
                val list = (v as String).lines().mapNotNull { line ->
                    val t = line.trim(); if (t.isEmpty()) return@mapNotNull null
                    val eq = t.indexOf('=')
                    if (eq > 0) t.substring(0, eq).trim() to t.substring(eq + 1).trim() else t to t
                }
                app.settings.commandShortcuts = list
                false // stored via Settings, not as the raw preference text
            }
        }
        for (key in listOf(Settings.KEY_NOTIFY_OFFLINE, Settings.KEY_NOTIFY_EXIT, Settings.KEY_NOTIFY_BELL)) {
            findPreference<SwitchPreferenceCompat>(key)?.setOnPreferenceChangeListener { _, v ->
                if (v == true && Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                true
            }
        }
        findPreference<Preference>("pref_relay")?.summary = app.credentials.relayUrl ?: "—"
        findPreference<Preference>("pref_device_id")?.summary = app.credentials.deviceId ?: "—"
        findPreference<Preference>("pref_devices")?.setOnPreferenceClickListener { (requireActivity() as MainActivity).openDevices(); true }
        findPreference<Preference>("pref_unpair")?.setOnPreferenceClickListener {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.unpair)
                .setMessage(R.string.unpair_confirm)
                .setPositiveButton(R.string.unpair) { _, _ -> app.agents.clearCache(); app.client.unpair() }
                .setNegativeButton(R.string.cancel, null)
                .show()
            true
        }
        findPreference<Preference>("pref_about")?.summary = getString(R.string.pref_about, BuildConfig.VERSION_NAME, BuildConfig.PROTOCOL_VERSION)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        listView.clipToPadding = false
        listView.padForAllBars()
    }
}
