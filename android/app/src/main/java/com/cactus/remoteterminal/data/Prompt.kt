package com.cactus.remoteterminal.data

/**
 * The prompt composer's text — the desktop's `core/prompt.js` is a port of it.
 *
 * A prompt is written in a proper text box rather than at the cursor, with
 * files beside it; when it is sent the files are uploaded to the machine first
 * and their paths go in after the text, the way a program such as a coding
 * assistant expects to be told about a file. Nothing here touches the screen.
 */
object Prompt {

    /**
     * What is typed into the terminal: the text without trailing blank space,
     * then each uploaded path, quoted where it needs it, after a space.
     */
    fun text(body: String, paths: List<String?> = emptyList()): String {
        val clean = body.replace("\r\n", "\n").replace('\r', '\n').trimEnd()
        val list = paths.filterNotNull().filter { it.isNotEmpty() }.joinToString(" ") { shellQuote(it) }
        if (list.isEmpty()) return clean
        return if (clean.isEmpty()) list else "$clean $list"
    }

    /**
     * Quote a path only when it needs it. A Windows path takes double quotes,
     * which PowerShell and Command Prompt both understand; POSIX single quotes
     * would be taken literally by Command Prompt.
     */
    fun shellQuote(path: String): String {
        if (path.matches(Regex("^[A-Za-z0-9._/~@:+-]+$"))) return path
        if ('\\' in path || path.matches(Regex("^[A-Za-z]:.*"))) return "\"" + path.replace("\"", "") + "\""
        return "'" + path.replace("'", "'\\''") + "'"
    }
}
