package com.cactus.remoteterminal

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** A saved connection target. `token`/`pair` are used by the v2 auth path. */
data class Profile(
    val name: String,
    val server: String,
    val room: String,
    val token: String = "",
    val pair: String = "",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("name", name).put("server", server).put("room", room)
        .put("token", token).put("pair", pair)

    /** Build the phone WebSocket URL, carrying auth when present. */
    fun url(): String {
        val base = server.trim().removeSuffix("/")
        val sb = StringBuilder("$base/?role=phone&room=${enc(room.ifEmpty { "demo" })}")
        if (token.isNotEmpty()) sb.append("&token=").append(enc(token))
        if (pair.isNotEmpty()) sb.append("&pair=").append(enc(pair))
        sb.append("&caps=color,replay,ping")
        return sb.toString()
    }

    companion object {
        private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
        fun fromJson(o: JSONObject) = Profile(
            o.optString("name"), o.optString("server"), o.optString("room"),
            o.optString("token"), o.optString("pair"),
        )
    }
}

/** Thin SharedPreferences wrapper for profiles and UI settings. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("remote_terminal", Context.MODE_PRIVATE)

    fun profiles(): MutableList<Profile> {
        val raw = sp.getString(KEY_PROFILES, null) ?: return defaultProfiles()
        return try {
            val arr = JSONArray(raw)
            MutableList(arr.length()) { Profile.fromJson(arr.getJSONObject(it)) }
        } catch (_: Exception) { defaultProfiles() }
    }

    fun saveProfiles(list: List<Profile>) {
        val arr = JSONArray()
        list.forEach { arr.put(it.toJson()) }
        sp.edit().putString(KEY_PROFILES, arr.toString()).apply()
    }

    fun upsert(profile: Profile) {
        val list = profiles()
        val i = list.indexOfFirst { it.name == profile.name }
        if (i >= 0) list[i] = profile else list.add(profile)
        saveProfiles(list)
    }

    fun remove(name: String) = saveProfiles(profiles().filterNot { it.name == name })

    var lastProfile: String
        get() = sp.getString(KEY_LAST, "") ?: ""
        set(v) { sp.edit().putString(KEY_LAST, v).apply() }

    var fontSizeSp: Float
        get() = sp.getFloat(KEY_FONT, 13f)
        set(v) { sp.edit().putFloat(KEY_FONT, v).apply() }

    private fun defaultProfiles() = mutableListOf(
        Profile("Emulator", "ws://10.0.2.2:8080", "demo"),
    )

    companion object {
        private const val KEY_PROFILES = "profiles"
        private const val KEY_LAST = "last_profile"
        private const val KEY_FONT = "font_sp"
    }
}
