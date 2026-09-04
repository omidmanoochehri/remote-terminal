package com.cactus.remoteterminal.terminal

/**
 * Terminal colour schemes: background, foreground, cursor, selection and the
 * 16 ANSI colours. Indices 16..255 are the standard xterm cube/greys shared
 * by every scheme.
 */
class TerminalTheme(
    val id: String,
    val name: String,
    val background: Int,
    val foreground: Int,
    val cursor: Int,
    val selection: Int,
    ansi: IntArray,
    val isLight: Boolean = false,
) {
    /** ARGB colours for palette indices 0..255. */
    val palette: IntArray = IntArray(256).also { p ->
        for (i in 0 until 16) p[i] = ansi[i] or 0xFF000000.toInt()
        val steps = intArrayOf(0, 95, 135, 175, 215, 255)
        var idx = 16
        for (r in 0 until 6) for (g in 0 until 6) for (b in 0 until 6) {
            p[idx++] = 0xFF000000.toInt() or (steps[r] shl 16) or (steps[g] shl 8) or steps[b]
        }
        for (i in 0 until 24) { val v = 8 + i * 10; p[232 + i] = 0xFF000000.toInt() or (v shl 16) or (v shl 8) or v }
    }

    companion object {
        private fun rgb(vararg v: Int) = IntArray(v.size) { 0xFF000000.toInt() or v[it] }

        /**
         * The scheme the product is designed around: the same near-black navy
         * as the app surfaces, with the design system's green, blue, amber and
         * violet as the bright ANSI colours so terminal output sits inside the
         * app rather than on top of it.
         */
        val REMOTE = TerminalTheme(
            "remote", "Remote Terminal", 0xFF040E19.toInt(), 0xFFD9E3EF.toInt(), 0xFF39E56D.toInt(), 0x6635A8FF,
            rgb(0x0A131E, 0xFF6374, 0x39E56D, 0xFFBD36, 0x35A8FF, 0xBF77FF, 0x4FD6E8, 0xCDD6DF,
                0x52627A, 0xFF8A96, 0x6FF39A, 0xFFD277, 0x74C4FF, 0xD6A6FF, 0x86E8F5, 0xF3F7FB),
        )
        val DARK = TerminalTheme(
            "dark", "Default Dark", 0xFF0C0C0C.toInt(), 0xFFE6E6E6.toInt(), 0xFFE6E6E6.toInt(), 0x663B82F6,
            rgb(0x000000, 0xE5484D, 0x46A758, 0xE5C24D, 0x3B82F6, 0xB56CE0, 0x22B8CF, 0xD4D4D4,
                0x6B6B6B, 0xFF6369, 0x5FD068, 0xFFD866, 0x6FA8FF, 0xD48CF0, 0x4FD6E8, 0xFFFFFF),
        )
        val AMOLED = TerminalTheme(
            "amoled", "AMOLED", 0xFF000000.toInt(), 0xFFF2F2F2.toInt(), 0xFFF2F2F2.toInt(), 0x664F8CFF,
            rgb(0x000000, 0xFF5555, 0x50FA7B, 0xF1FA8C, 0x6C8CFF, 0xFF79C6, 0x8BE9FD, 0xE0E0E0,
                0x555555, 0xFF7B7B, 0x7DFF9E, 0xFFFFA5, 0x8FA8FF, 0xFF92D0, 0xA4F0FF, 0xFFFFFF),
        )
        val LIGHT = TerminalTheme(
            "light", "Light", 0xFFFCFCFC.toInt(), 0xFF1E1E1E.toInt(), 0xFF1E1E1E.toInt(), 0x552563EB,
            rgb(0x000000, 0xC0392B, 0x1E8449, 0xB7770D, 0x1F5FBF, 0x8E44AD, 0x148F9A, 0x5F5F5F,
                0x8A8A8A, 0xE74C3C, 0x27AE60, 0xD68910, 0x2E86DE, 0xA569BD, 0x17A2B8, 0x000000),
            isLight = true,
        )
        val SOLARIZED_DARK = TerminalTheme(
            "solarized_dark", "Solarized Dark", 0xFF002B36.toInt(), 0xFF839496.toInt(), 0xFF93A1A1.toInt(), 0x66268BD2,
            rgb(0x073642, 0xDC322F, 0x859900, 0xB58900, 0x268BD2, 0xD33682, 0x2AA198, 0xEEE8D5,
                0x002B36, 0xCB4B16, 0x586E75, 0x657B83, 0x839496, 0x6C71C4, 0x93A1A1, 0xFDF6E3),
        )
        val GRUVBOX = TerminalTheme(
            "gruvbox", "Gruvbox Dark", 0xFF282828.toInt(), 0xFFEBDBB2.toInt(), 0xFFEBDBB2.toInt(), 0x66458588,
            rgb(0x282828, 0xCC241D, 0x98971A, 0xD79921, 0x458588, 0xB16286, 0x689D6A, 0xA89984,
                0x928374, 0xFB4934, 0xB8BB26, 0xFABD2F, 0x83A598, 0xD3869B, 0x8EC07C, 0xEBDBB2),
        )

        val ALL: List<TerminalTheme> = listOf(REMOTE, DARK, AMOLED, LIGHT, SOLARIZED_DARK, GRUVBOX)

        fun byId(id: String?): TerminalTheme = ALL.firstOrNull { it.id == id } ?: REMOTE
    }
}
