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
    val terminalTheme: String get() = prefs.getString(KEY_TERMINAL_THEME, "dark") ?: "dark"
    val appTheme: String get() = prefs.getString(KEY_APP_THEME, "system") ?: "system"
    val keepAwake: Boolean get() = prefs.getBoolean(KEY_KEEP_AWAKE, true)
    val scrollbackLines: Int get() = (prefs.getString(KEY_SCROLLBACK, "5000")?.toIntOrNull() ?: 5000).coerceIn(500, 50000)

    // Interaction
    val haptics: Boolean get() = prefs.getBoolean(KEY_HAPTICS, true)
    val bell: String get() = prefs.getString(KEY_BELL, "vibrate") ?: "vibrate"
    val osc52Clipboard: Boolean get() = prefs.getBoolean(KEY_OSC52, true)
    val pasteConfirmLines: Int get() = (prefs.getString(KEY_PASTE_CONFIRM, "3")?.toIntOrNull() ?: 3)
    var commandBar: Boolean
        get() = prefs.getBoolean(KEY_COMMAND_BAR, false)
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

    // Per-agent memory
    fun lastShell(agentId: String): String? = prefs.getString("last_shell.$agentId", null)
    fun setLastShell(agentId: String, shellId: String) = prefs.edit().putString("last_shell.$agentId", shellId).apply()

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
