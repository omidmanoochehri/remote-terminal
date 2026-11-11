package com.cactus.remoteterminal.data

import com.cactus.remoteterminal.terminal.KeyEncoder
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * A saved piece of text to type into a terminal. [folder] groups snippets in
 * the manager ("" = none); [run] sends a carriage return after the last line.
 * The body may hold placeholders — `{{name}}` or `{{name:default}}` — that are
 * asked for before sending; `{{{{` is a literal `{{`.
 *
 * Kept identical to the desktop's `ui/js/core/snippets.js`.
 */
data class Snippet(
    val id: String,
    val name: String,
    val folder: String = "",
    val body: String = "",
    val run: Boolean = true,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("folder", folder).put("body", body).put("run", run)

    companion object {
        fun fromJson(o: JSONObject): Snippet? {
            val id = o.optString("id").ifEmpty { return null }
            val name = o.optString("name").ifEmpty { return null }
            val body = o.opt("body") as? String ?: return null
            return Snippet(
                id = id,
                name = name,
                folder = (o.opt("folder") as? String ?: "").trim(),
                body = body,
                run = o.opt("run") as? Boolean ?: true,
            )
        }

        fun listFromJson(raw: String?): List<Snippet> {
            if (raw.isNullOrEmpty()) return emptyList()
            return try { listFromJson(JSONArray(raw)) } catch (_: Exception) { emptyList() }
        }

        fun listFromJson(array: JSONArray): List<Snippet> =
            (0 until array.length()).mapNotNull { i -> (array.opt(i) as? JSONObject)?.let { fromJson(it) } }

        fun listToJson(list: List<Snippet>): JSONArray = JSONArray().also { a -> list.forEach { a.put(it.toJson()) } }

        fun newId(): String = UUID.randomUUID().toString().replace("-", "").take(12)
    }
}

object Snippets {

    sealed class Token {
        data class Text(val text: String) : Token()
        data class Placeholder(val name: String, val default: String?) : Token()
    }

    /** One field of the fill-in form: the first default any occurrence gave. */
    data class Field(val name: String, val default: String)

    private val NAME = Regex("[A-Za-z_][A-Za-z0-9_ -]{0,31}")

    /** Split a body into literal text and placeholders, in order. */
    fun parse(body: String): List<Token> {
        val out = ArrayList<Token>()
        val text = StringBuilder()
        var i = 0
        while (i < body.length) {
            if (body.startsWith("{{{{", i)) { text.append("{{"); i += 4; continue }
            if (body.startsWith("{{", i)) {
                val end = body.indexOf("}}", i + 2)
                if (end >= 0) {
                    val inner = body.substring(i + 2, end)
                    val colon = inner.indexOf(':')
                    val name = (if (colon >= 0) inner.substring(0, colon) else inner).trim()
                    if (NAME.matches(name) && !inner.contains('{') && !inner.contains('\n')) {
                        if (text.isNotEmpty()) { out += Token.Text(text.toString()); text.setLength(0) }
                        out += Token.Placeholder(name, if (colon >= 0) inner.substring(colon + 1) else null)
                        i = end + 2
                        continue
                    }
                }
            }
            text.append(body[i]); i++
        }
        if (text.isNotEmpty()) out += Token.Text(text.toString())
        return out
    }

    /** The distinct placeholders, in order of first appearance. */
    fun fields(body: String): List<Field> {
        val order = LinkedHashMap<String, String?>()
        for (t in parse(body)) if (t is Token.Placeholder) {
            if (!order.containsKey(t.name) || (order[t.name] == null && t.default != null)) order[t.name] = t.default
        }
        return order.map { (name, default) -> Field(name, default ?: "") }
    }

    fun hasPlaceholders(body: String): Boolean = parse(body).any { it is Token.Placeholder }

    /** The body with every placeholder replaced: the given value, else its default, else nothing. */
    fun fill(body: String, values: Map<String, String>): String {
        val defaults = fields(body).associate { it.name to it.default }
        return parse(body).joinToString("") { t ->
            when (t) {
                is Token.Text -> t.text
                is Token.Placeholder -> values[t.name] ?: defaults[t.name] ?: ""
            }
        }
    }

    /**
     * What goes to the shell: lines joined with CR like a paste (wrapped in
     * bracketed-paste markers when the terminal asked for them), then one CR
     * when the snippet runs.
     */
    fun toInput(text: String, run: Boolean, bracketed: Boolean): String {
        val body = text.trimEnd('\r', '\n')
        val multiLine = body.contains('\n') || body.contains('\r')
        val sent = KeyEncoder.paste(body, bracketed && multiLine)
        return if (run) "$sent\r" else sent
    }

    /** Snippets grouped by folder: folders A→Z with the unfiled ones first, names A→Z within. */
    fun grouped(list: List<Snippet>): List<Pair<String, List<Snippet>>> =
        list.groupBy { it.folder.trim() }
            .toSortedMap(compareBy<String> { it.isNotEmpty() }.thenBy(String.CASE_INSENSITIVE_ORDER) { it })
            .map { (folder, items) -> folder to items.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name }) }

    /** Case-insensitive search over name, folder and body. */
    fun search(list: List<Snippet>, query: String): List<Snippet> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return list
        return list.filter { it.name.lowercase().contains(q) || it.folder.lowercase().contains(q) || it.body.lowercase().contains(q) }
    }
}
