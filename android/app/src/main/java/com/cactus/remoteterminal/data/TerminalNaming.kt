package com.cactus.remoteterminal.data

/**
 * Naming for terminals the app creates from an existing one. Duplicating
 * "deploy" gives "deploy (2)", duplicating that gives "deploy (3)" rather than
 * "deploy (2) (2)", so a machine full of copies still reads as a list.
 */
object TerminalNaming {

    private val COPY_SUFFIX = Regex("""\s*\((\d+)\)$""")

    /** The title for a copy of [title], avoiding every name in [taken]. */
    fun copyTitle(title: String, taken: Collection<String>): String {
        val base = COPY_SUFFIX.replace(title.trim(), "").trim().ifEmpty { return "" }
        val used = taken.map { it.trim() }.toSet()
        var n = 2
        while ("$base ($n)" in used) n++
        return "$base ($n)"
    }
}
