package com.cactus.remoteterminal.terminal

import android.view.KeyEvent
import com.cactus.remoteterminal.terminal.HardwareShortcuts.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HardwareShortcutsTest {
    private fun m(code: Int, ctrl: Boolean = true, shift: Boolean = false, alt: Boolean = false) = HardwareShortcuts.match(code, ctrl, shift, alt)

    @Test fun appShortcuts() {
        assertEquals(Action.NEW_TERMINAL, m(KeyEvent.KEYCODE_T, shift = true))
        assertEquals(Action.CLOSE_TAB, m(KeyEvent.KEYCODE_W, shift = true))
        assertEquals(Action.NEXT_TAB, m(KeyEvent.KEYCODE_TAB))
        assertEquals(Action.PREVIOUS_TAB, m(KeyEvent.KEYCODE_TAB, shift = true))
        assertEquals(Action.COPY, m(KeyEvent.KEYCODE_C, shift = true))
        assertEquals(Action.PASTE, m(KeyEvent.KEYCODE_V, shift = true))
        assertEquals(Action.SEARCH, m(KeyEvent.KEYCODE_F, shift = true))
        assertEquals(Action.PALETTE, m(KeyEvent.KEYCODE_P, shift = true))
        assertEquals(Action.SNIPPETS, m(KeyEvent.KEYCODE_E, shift = true))
        assertNull(m(KeyEvent.KEYCODE_S, shift = true))
        assertEquals(Action.ZOOM_IN, m(KeyEvent.KEYCODE_EQUALS))
        assertEquals(Action.ZOOM_IN, m(KeyEvent.KEYCODE_EQUALS, shift = true))
        assertEquals(Action.ZOOM_OUT, m(KeyEvent.KEYCODE_MINUS))
        assertEquals(Action.ZOOM_RESET, m(KeyEvent.KEYCODE_0))
    }

    @Test fun shellKeysAreLeftAlone() {
        assertNull(m(KeyEvent.KEYCODE_C))                       // Ctrl+C interrupts
        assertNull(m(KeyEvent.KEYCODE_W))                       // Ctrl+W deletes a word
        assertNull(m(KeyEvent.KEYCODE_T, ctrl = false, shift = true))
        assertNull(m(KeyEvent.KEYCODE_T, shift = true, alt = true))
        assertNull(m(KeyEvent.KEYCODE_TAB, ctrl = false))
    }

    @Test fun everyListedShortcutHasAnAction() {
        assertEquals(Action.values().toSet(), HardwareShortcuts.KEYS.map { it.second }.toSet())
    }
}
