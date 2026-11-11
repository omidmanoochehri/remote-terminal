package com.cactus.remoteterminal.terminal

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * User colour schemes: stored, imported and exported in the Windows Terminal
 * scheme form (`name, background, foreground, cursorColor,
 * selectionBackground, black … brightWhite` as `#RRGGBB`), which is also this
 * app's own export form. Our stored copy adds an `id`.
 *
 * Kept identical to the desktop's scheme import.
 */
object ColorSchemes {
    const val USER_PREFIX = "user:"

    /** Windows Terminal's names for ANSI 0..15. */
    val ANSI_KEYS = listOf(
        "black", "red", "green", "yellow", "blue", "purple", "cyan", "white",
        "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightPurple", "brightCyan", "brightWhite",
    )
    private val ALIASES = mapOf("purple" to "magenta", "brightPurple" to "brightMagenta")

    /** Alpha given to a selection colour that came without one. */
    private const val SELECTION_ALPHA = 0x66

    fun newId(): String = USER_PREFIX + UUID.randomUUID().toString().replace("-", "").take(10)

    /** `#RGB`, `#RRGGBB` or `#RRGGBBAA` (the `#` optional) → ARGB, or null. */
    fun parseHex(value: String?): Int? {
        val s = value?.trim()?.removePrefix("#") ?: return null
        if (s.isEmpty() || !s.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null
        return when (s.length) {
            3 -> {
                val r = s[0].digitToInt(16) * 17; val g = s[1].digitToInt(16) * 17; val b = s[2].digitToInt(16) * 17
                (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            }
            6 -> (0xFF shl 24) or s.toInt(16)
            8 -> {
                val rgb = s.substring(0, 6).toInt(16)
                val a = s.substring(6, 8).toInt(16)
                (a shl 24) or rgb
            }
            else -> null
        }
    }

    /** ARGB → `#RRGGBB` (alpha dropped). */
    fun toHex(color: Int): String = String.format(java.util.Locale.ROOT, "#%06X", color and 0xFFFFFF)

    private fun luminance(color: Int): Double {
        val r = (color shr 16 and 0xFF) / 255.0
        val g = (color shr 8 and 0xFF) / 255.0
        val b = (color and 0xFF) / 255.0
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    fun isLightBackground(color: Int): Boolean = luminance(color) > 0.5

    /**
     * One scheme from a JSON object, or an error message. [id] is kept when the
     * object carries one of ours, otherwise a new one is made.
     */
    fun fromJson(o: JSONObject, keepId: Boolean = true): Result<TerminalTheme> {
        val name = (o.opt("name") as? String)?.trim().orEmpty()
        if (name.isEmpty()) return Result.failure(IllegalArgumentException("A scheme needs a name."))
        fun colour(key: String): Int? = parseHex(o.opt(key) as? String)
        val bg = colour("background") ?: return Result.failure(IllegalArgumentException("“$name” has no valid background colour."))
        val fg = colour("foreground") ?: return Result.failure(IllegalArgumentException("“$name” has no valid foreground colour."))
        val ansi = IntArray(16)
        for ((i, key) in ANSI_KEYS.withIndex()) {
            val c = colour(key) ?: ALIASES[key]?.let { colour(it) }
                ?: return Result.failure(IllegalArgumentException("“$name” has no valid “$key” colour."))
            ansi[i] = c or (0xFF shl 24)
        }
        val cursor = (colour("cursorColor") ?: colour("cursor") ?: fg) or (0xFF shl 24)
        val selectionRaw = (o.opt("selectionBackground") as? String) ?: (o.opt("selection") as? String)
        val selection = parseHex(selectionRaw)?.let { c ->
            val hex = selectionRaw!!.trim().removePrefix("#")
            if (hex.length == 8) c else (c and 0xFFFFFF) or (SELECTION_ALPHA shl 24)
        } ?: ((ansi[12] and 0xFFFFFF) or (SELECTION_ALPHA shl 24)) // the desktop falls back to bright blue too
        val id = (o.opt("id") as? String)?.takeIf { keepId && it.startsWith(USER_PREFIX) && it.length > USER_PREFIX.length } ?: newId()
        return Result.success(
            TerminalTheme(
                id = id, name = name,
                background = bg or (0xFF shl 24), foreground = fg or (0xFF shl 24),
                cursor = cursor, selection = selection, ansi = ansi,
                isLight = isLightBackground(bg),
            )
        )
    }

    /** The Windows Terminal form; with [withId] our stored form (adds `id`). */
    fun toJson(t: TerminalTheme, withId: Boolean = false): JSONObject {
        val o = JSONObject()
        if (withId) o.put("id", t.id)
        o.put("name", t.name)
        o.put("background", toHex(t.background))
        o.put("foreground", toHex(t.foreground))
        o.put("cursorColor", toHex(t.cursor))
        o.put("selectionBackground", toHex(t.selection))
        for ((i, key) in ANSI_KEYS.withIndex()) o.put(key, toHex(t.ansi[i]))
        return o
    }

    /**
     * Schemes pasted by the user: one scheme object, an array of them, or a
     * Windows Terminal settings file with a `schemes` array. Imported schemes
     * always get new ids. Throws [IllegalArgumentException] with a message for
     * the user when nothing usable is found.
     */
    fun import(text: String): List<TerminalTheme> {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) throw IllegalArgumentException("Paste a colour scheme in JSON.")
        val items: List<JSONObject> = try {
            when {
                trimmed.startsWith("[") -> JSONArray(trimmed).let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? JSONObject } }
                else -> {
                    val o = JSONObject(trimmed)
                    val schemes = o.optJSONArray("schemes")
                    if (schemes != null) (0 until schemes.length()).mapNotNull { schemes.opt(it) as? JSONObject } else listOf(o)
                }
            }
        } catch (_: Exception) {
            throw IllegalArgumentException("That is not valid JSON.")
        }
        if (items.isEmpty()) throw IllegalArgumentException("No colour scheme found.")
        val out = ArrayList<TerminalTheme>()
        var firstError: String? = null
        for (o in items) {
            fromJson(o, keepId = false).onSuccess { out += it }.onFailure { if (firstError == null) firstError = it.message }
        }
        if (out.isEmpty()) throw IllegalArgumentException(firstError ?: "No colour scheme found.")
        return out
    }

    fun listFromJson(raw: String?): List<TerminalTheme> {
        if (raw.isNullOrEmpty()) return emptyList()
        return try { listFromJson(JSONArray(raw)) } catch (_: Exception) { emptyList() }
    }

    fun listFromJson(a: JSONArray): List<TerminalTheme> =
        (0 until a.length()).mapNotNull { (a.opt(it) as? JSONObject)?.let { o -> fromJson(o, keepId = true).getOrNull() } }

    fun listToJson(list: List<TerminalTheme>): JSONArray = JSONArray().also { a -> list.forEach { a.put(toJson(it, withId = true)) } }

    /** A copy of [from] under a new id and name, ready to edit. */
    fun copyOf(from: TerminalTheme, name: String, id: String = newId()): TerminalTheme =
        TerminalTheme(id, name, from.background, from.foreground, from.cursor, from.selection, from.ansi.copyOf(), from.isLight)

    /** [t] with one colour changed; [slot] is "background", "foreground", "cursor", "selection" or 0..15 as a string. */
    fun withColour(t: TerminalTheme, slot: String, color: Int): TerminalTheme {
        val ansi = t.ansi.copyOf()
        var bg = t.background; var fg = t.foreground; var cursor = t.cursor; var sel = t.selection
        when (slot) {
            "background" -> bg = color or (0xFF shl 24)
            "foreground" -> fg = color or (0xFF shl 24)
            "cursor" -> cursor = color or (0xFF shl 24)
            "selection" -> sel = (color and 0xFFFFFF) or (SELECTION_ALPHA shl 24)
            else -> slot.toIntOrNull()?.takeIf { it in 0..15 }?.let { ansi[it] = color or (0xFF shl 24) }
        }
        return TerminalTheme(t.id, t.name, bg, fg, cursor, sel, ansi, isLightBackground(bg))
    }

    fun renamed(t: TerminalTheme, name: String): TerminalTheme =
        TerminalTheme(t.id, name, t.background, t.foreground, t.cursor, t.selection, t.ansi.copyOf(), t.isLight)
}
