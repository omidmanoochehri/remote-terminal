package com.cactus.remoteterminal.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * A saved way to start a terminal: a name, optionally a machine and a shell, a
 * working directory and a first command. Presets live on this phone only —
 * launching one produces exactly the traffic that filling in the New terminal
 * form by hand would, so nothing about the protocol changes.
 */
data class TerminalPreset(
    val id: String,
    val name: String,
    /** null: start on whichever machine the preset is launched from. */
    val agentId: String? = null,
    /** null: the machine's default shell. */
    val shellId: String? = null,
    val directory: String = "",
    val command: String = "",
) {
    /** What the row under the name says: the directory, or the command, or the shell. */
    val summary: String
        get() = listOf(directory, command).firstOrNull { it.isNotEmpty() } ?: ""

    fun toJson(): JSONObject {
        val o = JSONObject()
        o.put("id", id)
        o.put("name", name)
        agentId?.let { o.put("agentId", it) }
        shellId?.let { o.put("shellId", it) }
        if (directory.isNotEmpty()) o.put("directory", directory)
        if (command.isNotEmpty()) o.put("command", command)
        return o
    }

    companion object {
        fun fromJson(o: JSONObject): TerminalPreset? {
            val id = o.optString("id").ifEmpty { return null }
            val name = o.optString("name").ifEmpty { return null }
            fun optional(key: String): String? =
                if (o.isNull(key)) null else o.optString(key).ifEmpty { null }
            return TerminalPreset(
                id = id,
                name = name,
                agentId = optional("agentId"),
                shellId = optional("shellId"),
                directory = optional("directory") ?: "",
                command = optional("command") ?: "",
            )
        }

        fun listFromJson(raw: String): List<TerminalPreset> = try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { fromJson(array.getJSONObject(it)) }
        } catch (_: Exception) {
            emptyList()
        }

        fun listToJson(presets: List<TerminalPreset>): String {
            val array = JSONArray()
            presets.forEach { array.put(it.toJson()) }
            return array.toString()
        }

        fun newId(): String = UUID.randomUUID().toString().replace("-", "").take(12)
    }
}
