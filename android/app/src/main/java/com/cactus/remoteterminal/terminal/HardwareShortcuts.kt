package com.cactus.remoteterminal.terminal

import android.view.KeyEvent

/**
 * App shortcuts on a hardware keyboard in the terminal. They are taken before
 * the key encoder sees the key; every other combination still goes to the
 * shell (Ctrl+C stays an interrupt — copying is Ctrl+Shift+C). Snippets are
 * Ctrl+Shift+E, as on the desktop, where Ctrl+Shift+S saves a transcript.
 */
object HardwareShortcuts {

    enum class Action {
        NEW_TERMINAL, CLOSE_TAB, NEXT_TAB, PREVIOUS_TAB, COPY, PASTE, SEARCH, PALETTE, SNIPPETS, ZOOM_IN, ZOOM_OUT, ZOOM_RESET,
    }

    /** The keys, as the Settings list shows them, in the order it shows them. */
    val KEYS: List<Pair<String, Action>> = listOf(
        "Ctrl+Shift+T" to Action.NEW_TERMINAL,
        "Ctrl+Shift+W" to Action.CLOSE_TAB,
        "Ctrl+Tab" to Action.NEXT_TAB,
        "Ctrl+Shift+Tab" to Action.PREVIOUS_TAB,
        "Ctrl+Shift+C" to Action.COPY,
        "Ctrl+Shift+V" to Action.PASTE,
        "Ctrl+Shift+F" to Action.SEARCH,
        "Ctrl+Shift+P" to Action.PALETTE,
        "Ctrl+Shift+E" to Action.SNIPPETS,
        "Ctrl+=" to Action.ZOOM_IN,
        "Ctrl+-" to Action.ZOOM_OUT,
        "Ctrl+0" to Action.ZOOM_RESET,
    )

    fun match(keyCode: Int, ctrl: Boolean, shift: Boolean, alt: Boolean): Action? {
        if (!ctrl || alt) return null
        if (shift) {
            when (keyCode) {
                KeyEvent.KEYCODE_T -> return Action.NEW_TERMINAL
                KeyEvent.KEYCODE_W -> return Action.CLOSE_TAB
                KeyEvent.KEYCODE_TAB -> return Action.PREVIOUS_TAB
                KeyEvent.KEYCODE_C -> return Action.COPY
                KeyEvent.KEYCODE_V -> return Action.PASTE
                KeyEvent.KEYCODE_F -> return Action.SEARCH
                KeyEvent.KEYCODE_P -> return Action.PALETTE
                KeyEvent.KEYCODE_E -> return Action.SNIPPETS
                // Ctrl+Shift+= is Ctrl++ on most layouts.
                KeyEvent.KEYCODE_EQUALS, KeyEvent.KEYCODE_PLUS -> return Action.ZOOM_IN
            }
            return null
        }
        return when (keyCode) {
            KeyEvent.KEYCODE_TAB -> Action.NEXT_TAB
            KeyEvent.KEYCODE_EQUALS, KeyEvent.KEYCODE_PLUS, KeyEvent.KEYCODE_NUMPAD_ADD -> Action.ZOOM_IN
            KeyEvent.KEYCODE_MINUS, KeyEvent.KEYCODE_NUMPAD_SUBTRACT -> Action.ZOOM_OUT
            KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_NUMPAD_0 -> Action.ZOOM_RESET
            else -> null
        }
    }
}
