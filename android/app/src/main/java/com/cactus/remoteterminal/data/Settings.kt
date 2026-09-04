package com.cactus.remoteterminal.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * Typed access to user settings (SharedPreferences, non-secret). The keys
 * match `res/xml/preferences.xml` so the settings screen edits the same
 * values. [version] bumps on every change so observers can re-read cheaply.
 */
class Settings(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version

    private val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> _version.value = _version.value + 1 }

    init { prefs.registerOnSharedPreferenceChangeListener(listener) }

    val raw: SharedPreferences get() = prefs

    // Terminal display
    var fontSizeSp: Float
        get() = prefs.getString(KEY_FONT_SIZE, null)?.toFloatOrNull() ?: 13f
        set(v) { prefs.edit().putString(KEY_FONT_SIZE, v.coerceIn(8f, 32f).toString()).apply() }
    val lineSpacing: Float get() = prefs.getString(KEY_LINE_SPACING, "1.0")?.toFloatOrNull() ?: 1.0f
    val cursorStyle: String get() = prefs.getString(KEY_CURSOR_STYLE, "block") ?: "block"
    val cursorBlink: Boolean get() = prefs.getBoolean(KEY_CURSOR_BLINK, true)
    val terminalTheme: String get() = prefs.getString(KEY_TERMINAL_THEME, "remote") ?: "remote"
    /**
     * "system" | "dark" | "light". The product is designed dark, so that is the
     * default; the setting still switches to the light palette or follows the
     * system when the user asks.
     */
    val appTheme: String get() = prefs.getString(KEY_APP_THEME, "dark") ?: "dark"
    val keepAwake: Boolean get() = prefs.getBoolean(KEY_KEEP_AWAKE, true)
    val scrollbackLines: Int get() = (prefs.getString(KEY_SCROLLBACK, "5000")?.toIntOrNull() ?: 5000).coerceIn(500, 50000)

    // Interaction
    val haptics: Boolean get() = prefs.getBoolean(KEY_HAPTICS, true)
    val bell: String get() = prefs.getString(KEY_BELL, "vibrate") ?: "vibrate"
    val osc52Clipboard: Boolean get() = prefs.getBoolean(KEY_OSC52, true)
    val pasteConfirmLines: Int get() = (prefs.getString(KEY_PASTE_CONFIRM, "3")?.toIntOrNull() ?: 3)
    /** A horizontal swipe across the grid moves to the next/previous tab. */
    val swipeSwitchTabs: Boolean get() = prefs.getBoolean(KEY_SWIPE_TABS, true)
    var commandBar: Boolean
        get() = prefs.getBoolean(KEY_COMMAND_BAR, true)
        set(v) { prefs.edit().putBoolean(KEY_COMMAND_BAR, v).apply() }
    val extraKeysRow1: String get() = prefs.getString(KEY_KEYS_ROW1, DEFAULT_ROW1) ?: DEFAULT_ROW1
    val extraKeysRow2: String get() = prefs.getString(KEY_KEYS_ROW2, DEFAULT_ROW2) ?: DEFAULT_ROW2
    val extraKeysRow3: String get() = prefs.getString(KEY_KEYS_ROW3, DEFAULT_ROW3) ?: DEFAULT_ROW3

    // Notifications
    val notifyAgentOffline: Boolean get() = prefs.getBoolean(KEY_NOTIFY_OFFLINE, true)
    val notifyBell: Boolean get() = prefs.getBoolean(KEY_NOTIFY_BELL, false)
    val notifyExit: Boolean get() = prefs.getBoolean(KEY_NOTIFY_EXIT, true)

    // Device
    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, "") ?: ""
        set(v) { prefs.edit().putString(KEY_DEVICE_NAME, v).apply() }

    /** User-defined command shortcuts (label → text sent with a trailing CR). */
    var commandShortcuts: List<Pair<String, String>>
        get() {
            val raw = prefs.getString(KEY_COMMANDS, null) ?: return DEFAULT_COMMANDS
            return try {
                val arr = JSONArray(raw)
                List(arr.length()) { val o = arr.getJSONObject(it); o.getString("label") to o.getString("command") }
            } catch (_: Exception) { DEFAULT_COMMANDS }
        }
        set(v) {
            val arr = JSONArray()
            v.forEach { arr.put(JSONObject().put("label", it.first).put("command", it.second)) }
            prefs.edit().putString(KEY_COMMANDS, arr.toString()).apply()
        }

    /** Whether the extra-keys grid is shown under the terminal. */
    var showExtraKeys: Boolean
        get() = prefs.getBoolean(KEY_SHOW_EXTRA_KEYS, true)
        set(v) { prefs.edit().putBoolean(KEY_SHOW_EXTRA_KEYS, v).apply() }

    /** "bundled" (the shipped mono face) or "system" (the platform monospace). */
    var terminalFontFamily: String
        get() = prefs.getString(KEY_FONT_FAMILY, FONT_BUNDLED) ?: FONT_BUNDLED
        set(v) { prefs.edit().putString(KEY_FONT_FAMILY, v).apply() }

    /** App lock: the app asks for the device biometric/credential before showing anything. */
    var biometricLock: Boolean
        get() = prefs.getBoolean(KEY_BIOMETRIC_LOCK, false)
        set(v) { prefs.edit().putBoolean(KEY_BIOMETRIC_LOCK, v).apply() }

    /** How machines are ordered on the Machines screen ("status" | "name" | "recent"). */
    var machineSort: String
        get() = prefs.getString(KEY_MACHINE_SORT, SORT_STATUS) ?: SORT_STATUS
        set(v) { prefs.edit().putString(KEY_MACHINE_SORT, v).apply() }

    // Per-agent memory
    fun lastShell(agentId: String): String? = prefs.getString("last_shell.$agentId", null)
    fun setLastShell(agentId: String, shellId: String) = prefs.edit().putString("last_shell.$agentId", shellId).apply()

    /* ------------------------- favourites and pins ------------------------- */

    /** Machines the user starred; they sort first and feed the Home count. */
    var favouriteMachines: Set<String>
        get() = prefs.getStringSet(KEY_FAVOURITE_MACHINES, emptySet()) ?: emptySet()
        set(v) { prefs.edit().putStringSet(KEY_FAVOURITE_MACHINES, v).apply() }

    fun isFavouriteMachine(agentId: String) = agentId in favouriteMachines

    fun toggleFavouriteMachine(agentId: String): Boolean {
        val next = favouriteMachines.toMutableSet()
        val added = next.add(agentId)
        if (!added) next.remove(agentId)
        favouriteMachines = next
        return added
    }

    /** Pinned terminals, stored as "agentId|sessionId". */
    var pinnedTerminals: Set<String>
        get() = prefs.getStringSet(KEY_PINNED_TERMINALS, emptySet()) ?: emptySet()
        set(v) { prefs.edit().putStringSet(KEY_PINNED_TERMINALS, v).apply() }

    fun isPinnedTerminal(agentId: String, sessionId: String) = "$agentId|$sessionId" in pinnedTerminals

    fun togglePinnedTerminal(agentId: String, sessionId: String): Boolean {
        val key = "$agentId|$sessionId"
        val next = pinnedTerminals.toMutableSet()
        val added = next.add(key)
        if (!added) next.remove(key)
        pinnedTerminals = next
        return added
    }

    /* --------------------------- per-machine ------------------------------ */

    /** Re-attach this machine's terminals automatically after a drop (default on). */
    fun autoReconnect(agentId: String): Boolean = prefs.getBoolean("auto_reconnect.$agentId", true)
    fun setAutoReconnect(agentId: String, value: Boolean) = prefs.edit().putBoolean("auto_reconnect.$agentId", value).apply()

    /** Hold the relay socket open for this machine while the app is backgrounded. */
    fun keepAlive(agentId: String): Boolean = prefs.getBoolean("keep_alive.$agentId", true)
    fun setKeepAlive(agentId: String, value: Boolean) = prefs.edit().putBoolean("keep_alive.$agentId", value).apply()

    /** Raise a notification when this specific machine drops off. */
    fun connectionAlerts(agentId: String): Boolean = prefs.getBoolean("alerts.$agentId", false)
    fun setConnectionAlerts(agentId: String, value: Boolean) = prefs.edit().putBoolean("alerts.$agentId", value).apply()

    /** Working directories the user has started terminals in, most recent first. */
    fun recentDirectories(agentId: String): List<String> {
        val raw = prefs.getString("dirs.$agentId", null) ?: return emptyList()
        return try { val a = JSONArray(raw); List(a.length()) { a.getString(it) } } catch (_: Exception) { emptyList() }
    }

    fun noteDirectory(agentId: String, dir: String) {
        if (dir.isBlank()) return
        val next = (listOf(dir) + recentDirectories(agentId).filterNot { it == dir }).take(MAX_RECENT_DIRECTORIES)
        prefs.edit().putString("dirs.$agentId", JSONArray(next).toString()).apply()
    }

    /* -------------------------- per-terminal ------------------------------ */

    /** "Restore on reconnect" for one session (default on: that is the product's promise). */
    fun restoreOnReconnect(sessionKey: String): Boolean = prefs.getBoolean("restore.$sessionKey", true)
    fun setRestoreOnReconnect(sessionKey: String, value: Boolean) = prefs.edit().putBoolean("restore.$sessionKey", value).apply()

    /** "Notify when a long command finishes" for one session. */
    fun notifyOnFinish(sessionKey: String): Boolean = prefs.getBoolean("notify_finish.$sessionKey", notifyExit)
    fun setNotifyOnFinish(sessionKey: String, value: Boolean) = prefs.edit().putBoolean("notify_finish.$sessionKey", value).apply()

    /**
     * Colour scheme for one terminal, or null when it follows the app-wide
     * setting. Kept per session so a production shell can stay visibly
     * different from a scratch one.
     */
    fun terminalTheme(sessionKey: String): String? = prefs.getString("theme.$sessionKey", null)

    fun setTerminalTheme(sessionKey: String, themeId: String?) = prefs.edit()
        .apply { if (themeId == null) remove("theme.$sessionKey") else putString("theme.$sessionKey", themeId) }
        .apply()

    fun forgetSessionPrefs(sessionKey: String) = prefs.edit()
        .remove("restore.$sessionKey")
        .remove("notify_finish.$sessionKey")
        .remove("theme.$sessionKey")
        .apply()

    /* ------------------------- terminal presets --------------------------- */

    /** Saved ways to start a terminal, in the order the user arranged them. */
    var terminalPresets: List<TerminalPreset>
        get() = prefs.getString(KEY_PRESETS, null)?.let { TerminalPreset.listFromJson(it) } ?: emptyList()
        set(v) { prefs.edit().putString(KEY_PRESETS, TerminalPreset.listToJson(v)).apply() }

    fun preset(id: String): TerminalPreset? = terminalPresets.firstOrNull { it.id == id }

    /** Presets that can start on [agentId]: its own, plus the machine-agnostic ones. */
    fun presetsFor(agentId: String): List<TerminalPreset> =
        terminalPresets.filter { it.agentId == null || it.agentId == agentId }

    /** Insert, or replace the one carrying the same id. */
    fun savePreset(preset: TerminalPreset) {
        val current = terminalPresets
        terminalPresets =
            if (current.any { it.id == preset.id }) current.map { if (it.id == preset.id) preset else it }
            else current + preset
    }

    fun deletePreset(id: String) {
        terminalPresets = terminalPresets.filterNot { it.id == id }
    }

    /* ------------------------- command history ---------------------------- */

    /** Commands sent from the command bar, newest first, capped at [COMMAND_HISTORY_MAX]. */
    var commandHistory: List<String>
        get() {
            val raw = prefs.getString(KEY_COMMAND_HISTORY, null) ?: return emptyList()
            return try { val a = JSONArray(raw); List(a.length()) { a.getString(it) } } catch (_: Exception) { emptyList() }
        }
        set(v) { prefs.edit().putString(KEY_COMMAND_HISTORY, JSONArray(v.take(COMMAND_HISTORY_MAX)).toString()).apply() }

    fun noteCommand(command: String) {
        val trimmed = command.trim()
        if (trimmed.isEmpty()) return
        commandHistory = listOf(trimmed) + commandHistory.filterNot { it == trimmed }
    }

    fun clearCommandHistory() = prefs.edit().remove(KEY_COMMAND_HISTORY).apply()

    fun openTabs(agentId: String): List<String> {
        val raw = prefs.getString("tabs.$agentId", null) ?: return emptyList()
        return try { val a = JSONArray(raw); List(a.length()) { a.getString(it) } } catch (_: Exception) { emptyList() }
    }
    fun setOpenTabs(agentId: String, sessionIds: List<String>) =
        prefs.edit().putString("tabs.$agentId", JSONArray(sessionIds).toString()).apply()
    fun activeTab(agentId: String): String? = prefs.getString("active.$agentId", null)
    fun setActiveTab(agentId: String, sessionId: String?) = prefs.edit().putString("active.$agentId", sessionId).apply()

    companion object {
        const val NAME = "rt_settings"
        const val KEY_FONT_SIZE = "font_size"
        const val KEY_LINE_SPACING = "line_spacing"
        const val KEY_CURSOR_STYLE = "cursor_style"
        const val KEY_CURSOR_BLINK = "cursor_blink"
        const val KEY_TERMINAL_THEME = "terminal_theme"
        const val KEY_APP_THEME = "app_theme"
        const val KEY_KEEP_AWAKE = "keep_awake"
        const val KEY_SCROLLBACK = "scrollback_lines"
        const val KEY_HAPTICS = "haptics"
        const val KEY_BELL = "bell"
        const val KEY_OSC52 = "osc52_clipboard"
        const val KEY_PASTE_CONFIRM = "paste_confirm_lines"
        const val KEY_COMMAND_BAR = "command_bar"
        const val KEY_KEYS_ROW1 = "extra_keys_row1"
        const val KEY_KEYS_ROW2 = "extra_keys_row2"
        const val KEY_KEYS_ROW3 = "extra_keys_row3"
        const val KEY_NOTIFY_OFFLINE = "notify_agent_offline"
        const val KEY_NOTIFY_BELL = "notify_bell"
        const val KEY_NOTIFY_EXIT = "notify_exit"
        const val KEY_DEVICE_NAME = "device_name"
        const val KEY_COMMANDS = "command_shortcuts"
        const val KEY_BIOMETRIC_LOCK = "biometric_lock"
        const val KEY_SHOW_EXTRA_KEYS = "show_extra_keys"
        const val KEY_FONT_FAMILY = "terminal_font_family"
        const val FONT_BUNDLED = "bundled"
        const val FONT_SYSTEM = "system"
        const val KEY_MACHINE_SORT = "machine_sort"
        const val KEY_FAVOURITE_MACHINES = "favourite_machines"
        const val KEY_PINNED_TERMINALS = "pinned_terminals"
        const val KEY_COMMAND_HISTORY = "command_history"
        const val KEY_SWIPE_TABS = "swipe_switch_tabs"
        const val KEY_PRESETS = "terminal_presets"

        const val SORT_STATUS = "status"
        const val SORT_NAME = "name"
        const val SORT_RECENT = "recent"

        /** The settings screen advertises this number, so it lives next to the store. */
        const val COMMAND_HISTORY_MAX = 500
        private const val MAX_RECENT_DIRECTORIES = 8

        // Extra-keys rows: tokens separated by spaces; `a|b` gives long-press alternates.
        const val DEFAULT_ROW1 = "ESC CTRL ALT TAB UP DOWN LEFT RIGHT HOME END PGUP PGDN INS DEL"
        const val DEFAULT_ROW2 = "-|_ /|\\ ~|` ||& :|; \"|' [|{ ]|} (|) <|> =|+ *|# \$|@ ?|! ,|."
        const val DEFAULT_ROW3 = "F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12"
        val DEFAULT_COMMANDS: List<Pair<String, String>> = listOf(
            "ls -la" to "ls -la", "pwd" to "pwd", "clear" to "clear", "git status" to "git status",
            "git pull" to "git pull", "docker ps" to "docker ps",
        )
    }
}
