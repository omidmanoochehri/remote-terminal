package com.cactus.remoteterminal.data

import com.cactus.remoteterminal.terminal.ColorSchemes
import com.cactus.remoteterminal.terminal.TerminalTheme
import org.json.JSONArray
import org.json.JSONObject

/**
 * Backup & restore: presets, snippets, colour schemes, command shortcuts and
 * the portable appearance/terminal/keyboard settings, in one JSON file that
 * both apps read and write — a phone backup imports on the desktop and back.
 *
 * Never included: credentials, device ids, the relay, tokens, the app lock,
 * favourites, pins, or anything per machine or per terminal.
 */
object Backup {
    const val FORMAT = "remote-terminal-backup"
    const val VERSION = 1

    /** How a setting is kept in this app's preferences. */
    enum class Kind { FLOAT, INT, BOOL, STRING }

    /** The portable settings and their types; the keys are the preference keys. */
    val SETTINGS: Map<String, Kind> = linkedMapOf(
        Settings.KEY_FONT_SIZE to Kind.FLOAT,
        Settings.KEY_LINE_SPACING to Kind.FLOAT,
        Settings.KEY_CURSOR_STYLE to Kind.STRING,
        Settings.KEY_CURSOR_BLINK to Kind.BOOL,
        Settings.KEY_TERMINAL_THEME to Kind.STRING,
        Settings.KEY_FONT_FAMILY to Kind.STRING,
        Settings.KEY_SCROLLBACK to Kind.INT,
        Settings.KEY_BELL to Kind.STRING,
        Settings.KEY_HAPTICS to Kind.BOOL,
        Settings.KEY_OSC52 to Kind.BOOL,
        Settings.KEY_PASTE_CONFIRM to Kind.INT,
        Settings.KEY_COMMAND_BAR to Kind.BOOL,
        Settings.KEY_KEYS_ROW1 to Kind.STRING,
        Settings.KEY_KEYS_ROW2 to Kind.STRING,
        Settings.KEY_KEYS_ROW3 to Kind.STRING,
        Settings.KEY_CLICKABLE_LINKS to Kind.BOOL,
        Settings.KEY_SWIPE_TABS to Kind.BOOL,
        Settings.KEY_SHOW_EXTRA_KEYS to Kind.BOOL,
    )

    data class Data(
        val presets: List<TerminalPreset> = emptyList(),
        val snippets: List<Snippet> = emptyList(),
        val schemes: List<TerminalTheme> = emptyList(),
        val commandShortcuts: List<Pair<String, String>> = emptyList(),
        /** Setting key → Double / Int / Boolean / String, per [SETTINGS]. */
        val settings: Map<String, Any> = emptyMap(),
    )

    data class Summary(val presets: Int, val snippets: Int, val schemes: Int, val shortcuts: Int, val settings: Int) {
        val isEmpty: Boolean get() = presets + snippets + schemes + shortcuts + settings == 0
    }

    fun summary(d: Data) = Summary(d.presets.size, d.snippets.size, d.schemes.size, d.commandShortcuts.size, d.settings.size)

    /** The desktop's name for a setting that means the same thing here. */
    private val ALIASES = mapOf("wheel_switch_tabs" to Settings.KEY_SWIPE_TABS)

    /**
     * A value this app can use for [key], or null: the right type (numbers may
     * come as strings, as the phone keeps them) and inside the range or set
     * the setting allows. Kept in step with the desktop's `PORTABLE_SETTINGS`.
     */
    fun value(key: String, raw: Any?): Any? {
        val kind = SETTINGS[key] ?: return null
        val v = coerce(kind, raw) ?: return null
        fun inRange(lo: Double, hi: Double) = v.takeIf { (it as Number).toDouble() in lo..hi }
        return when (key) {
            Settings.KEY_FONT_SIZE -> inRange(8.0, 32.0)
            Settings.KEY_LINE_SPACING -> inRange(0.8, 2.0)
            Settings.KEY_SCROLLBACK -> inRange(500.0, 50000.0)
            Settings.KEY_PASTE_CONFIRM -> inRange(1.0, 100000.0)
            Settings.KEY_CURSOR_STYLE -> v.takeIf { it in setOf("block", "underline", "bar") }
            Settings.KEY_FONT_FAMILY -> v.takeIf { it == Settings.FONT_BUNDLED || it == Settings.FONT_SYSTEM }
            // The desktop rings a tone where the phone vibrates.
            Settings.KEY_BELL -> when (v) { "sound", "vibrate" -> "vibrate"; "none" -> "none"; else -> null }
            else -> v
        }
    }

    /** A value of the right type for [kind], or null when it cannot be one. */
    fun coerce(kind: Kind, value: Any?): Any? = when (kind) {
        Kind.FLOAT -> when (value) {
            is Number -> value.toDouble().takeIf { it.isFinite() }
            is String -> value.trim().toDoubleOrNull()?.takeIf { it.isFinite() }
            else -> null
        }
        Kind.INT -> when (value) {
            is Number -> value.toDouble().takeIf { it.isFinite() && it == Math.floor(it) }?.toInt()
            is String -> value.trim().toIntOrNull()
            else -> null
        }
        Kind.BOOL -> when (value) { is Boolean -> value; "true" -> true; "false" -> false; else -> null }
        Kind.STRING -> value as? String
    }

    fun build(d: Data, app: String, appVersion: String, exportedAt: Long): JSONObject {
        val o = JSONObject()
        o.put("format", FORMAT)
        o.put("version", VERSION)
        o.put("exportedAt", exportedAt)
        o.put("app", app)
        o.put("appVersion", appVersion)
        o.put("presets", JSONArray().also { a -> d.presets.forEach { a.put(it.toJson()) } })
        o.put("snippets", Snippet.listToJson(d.snippets))
        o.put("customSchemes", ColorSchemes.listToJson(d.schemes))
        o.put("commandShortcuts", JSONArray().also { a ->
            d.commandShortcuts.forEach { a.put(JSONObject().put("label", it.first).put("command", it.second)) }
        })
        val s = JSONObject()
        for (key in SETTINGS.keys) value(key, d.settings[key])?.let { s.put(key, it) }
        o.put("settings", s)
        return o
    }

    /**
     * Read a backup. Unknown keys are ignored and entries of the wrong type
     * skipped; a file that is not a backup, or from a newer format, throws
     * [IllegalArgumentException] with a message for the user.
     */
    fun parse(text: String): Data {
        val o = try { JSONObject(text.trim()) } catch (_: Exception) {
            throw IllegalArgumentException("This file is not a Remote Terminal backup.")
        }
        if (o.opt("format") != FORMAT) throw IllegalArgumentException("This file is not a Remote Terminal backup.")
        val version = (o.opt("version") as? Number)?.toInt()
            ?: throw IllegalArgumentException("This backup has no version.")
        if (version > VERSION) throw IllegalArgumentException("This backup was made by a newer version of the app. Update the app to import it.")
        if (version < 1) throw IllegalArgumentException("This backup has an unknown version.")

        val presets = (o.opt("presets") as? JSONArray)?.let { a ->
            (0 until a.length()).mapNotNull { (a.opt(it) as? JSONObject)?.let { p -> TerminalPreset.fromJson(p) } }
        } ?: emptyList()
        val snippets = (o.opt("snippets") as? JSONArray)?.let { Snippet.listFromJson(it) } ?: emptyList()
        val schemes = (o.opt("customSchemes") as? JSONArray)?.let { ColorSchemes.listFromJson(it) } ?: emptyList()
        val shortcuts = (o.opt("commandShortcuts") as? JSONArray)?.let { a ->
            (0 until a.length()).mapNotNull { i ->
                val c = a.opt(i) as? JSONObject ?: return@mapNotNull null
                val label = c.opt("label") as? String ?: return@mapNotNull null
                val command = c.opt("command") as? String ?: return@mapNotNull null
                if (label.isBlank() && command.isBlank()) null else label to command
            }
        } ?: emptyList()
        val settings = LinkedHashMap<String, Any>()
        (o.opt("settings") as? JSONObject)?.let { s ->
            for ((alias, key) in ALIASES) if (!s.has(key) && s.has(alias)) value(key, s.opt(alias))?.let { settings[key] = it }
            for (key in SETTINGS.keys) if (s.has(key)) value(key, s.opt(key))?.let { settings[key] = it }
        }
        return Data(presets, snippets, schemes, shortcuts, settings)
    }

    private fun <T> mergeBy(current: List<T>, incoming: List<T>, key: (T) -> String): List<T> {
        val byKey = incoming.associateBy(key)
        val kept = current.map { byKey[key(it)] ?: it }
        val known = current.map(key).toSet()
        return kept + incoming.filter { key(it) !in known }
    }

    /** Merge: entries with the same id (shortcuts: the same label) are replaced by the incoming ones; the rest are added. */
    fun merge(current: Data, incoming: Data) = Data(
        presets = mergeBy(current.presets, incoming.presets) { it.id },
        snippets = mergeBy(current.snippets, incoming.snippets) { it.id },
        schemes = mergeBy(current.schemes, incoming.schemes) { it.id },
        commandShortcuts = mergeBy(current.commandShortcuts, incoming.commandShortcuts) { it.first },
        settings = current.settings + incoming.settings,
    )

    /** Replace: the lists become the incoming ones; incoming settings are applied over the current ones. */
    fun replace(current: Data, incoming: Data) = Data(
        presets = incoming.presets,
        snippets = incoming.snippets,
        schemes = incoming.schemes,
        commandShortcuts = incoming.commandShortcuts,
        settings = current.settings + incoming.settings,
    )

    fun fileName(nowMs: Long): String {
        val c = java.util.Calendar.getInstance().apply { timeInMillis = nowMs }
        return String.format(
            java.util.Locale.ROOT, "remote-terminal-backup-%04d-%02d-%02d.json",
            c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH) + 1, c.get(java.util.Calendar.DAY_OF_MONTH),
        )
    }
}
