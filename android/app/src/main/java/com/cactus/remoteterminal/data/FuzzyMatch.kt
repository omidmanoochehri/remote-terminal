package com.cactus.remoteterminal.data

/**
 * The command palette's matcher: the query's characters must appear in the
 * text in order (case-insensitive); contiguous runs and matches at the start
 * of a word score higher, so "nt" ranks "New terminal" above "Print".
 *
 * A port of the desktop's `ui/js/core/fuzzy.js`; keep the two identical.
 */
object FuzzyMatch {
    private val WORD_BREAK = Regex("[\\s\\-_:./\\\\()\\[\\]]")

    /** A score for [text] against [query], or null when it does not match. Empty queries score 0. */
    fun score(query: String, text: String): Double? {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return 0.0
        val lower = text.lowercase()
        var score = 0.0
        var ti = 0
        var prev = -2
        var run = 0
        for (qi in q.indices) {
            val ch = q[qi]
            if (ch == ' ') continue // spaces in the query only separate words
            // Prefer the next occurrence that starts a word, if one is close by; otherwise the nearest.
            var found = lower.indexOf(ch, ti)
            if (found < 0) return null
            if (found != prev + 1) {
                var k = found
                while (k < lower.length) {
                    // Only jump when the rest of the query still fits after the jump.
                    if (lower[k] == ch && isWordStart(text, k) && isSubsequence(q, qi + 1, lower, k + 1)) { found = k; break }
                    if (k - found > 24) break
                    k++
                }
            }
            val contiguous = found == prev + 1
            run = if (contiguous) run + 1 else 1
            score += 1
            if (contiguous) score += 4 + run
            if (isWordStart(text, found)) score += 8
            if (found == 0) score += 6
            score -= minOf(3.0, (found - ti) * 0.05)
            prev = found
            ti = found + 1
        }
        // Shorter labels win ties: "Paste" before "Paste image" for "paste".
        score -= text.length * 0.01
        if (lower.startsWith(q)) score += 10
        return score
    }

    private fun isSubsequence(q: String, from: Int, lower: String, start: Int): Boolean {
        var ti = start
        for (i in from until q.length) {
            if (q[i] == ' ') continue
            val f = lower.indexOf(q[i], ti)
            if (f < 0) return false
            ti = f + 1
        }
        return true
    }

    private fun isWordStart(text: String, i: Int): Boolean {
        if (i == 0) return true
        val before = text[i - 1]
        if (WORD_BREAK.matches(before.toString())) return true
        // camelCase: a capital after a lower-case letter.
        val c = text[i]
        return c in 'A'..'Z' && before in 'a'..'z'
    }

    /** Items matching [query], best first (stable for equal scores), at most [limit]. An empty query keeps the order. */
    fun <T> rank(items: List<T>, query: String, limit: Int = 50, label: (T) -> String): List<T> {
        if (query.isBlank()) return items.take(limit)
        return items.mapIndexedNotNull { i, item -> score(query, label(item))?.let { Triple(item, it, i) } }
            .sortedWith(compareByDescending<Triple<T, Double, Int>> { it.second }.thenBy { it.third })
            .take(limit)
            .map { it.first }
    }
}
