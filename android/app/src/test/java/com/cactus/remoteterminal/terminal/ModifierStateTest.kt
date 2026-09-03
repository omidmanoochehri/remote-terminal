package com.cactus.remoteterminal.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModifierStateTest {
    @Test fun tapIsOneShotDoubleTapLocksTapAgainReleases() {
        val m = ModifierState()
        var changes = 0
        m.onChanged = { changes++ }
        assertEquals(ModifierState.Mode.ONESHOT, m.tap(ModifierState.Which.CTRL, 1000))
        assertTrue(m.mods().ctrl)
        assertEquals(ModifierState.Mode.LOCKED, m.tap(ModifierState.Which.CTRL, 1200))
        m.consume()
        assertTrue("locked survives a key", m.mods().ctrl)
        assertEquals(ModifierState.Mode.OFF, m.tap(ModifierState.Which.CTRL, 5000))
        assertFalse(m.mods().ctrl)
        assertEquals(3, changes)
    }

    @Test fun oneShotReleasesAfterOneKeyAndSlowSecondTapTurnsOff() {
        val m = ModifierState()
        m.tap(ModifierState.Which.ALT, 0)
        m.consume()
        assertFalse(m.mods().alt)
        m.tap(ModifierState.Which.ALT, 10_000)
        assertEquals(ModifierState.Mode.OFF, m.tap(ModifierState.Which.ALT, 20_000))
    }

    @Test fun modifiersAreIndependentAndClearResetsAll() {
        val m = ModifierState()
        m.tap(ModifierState.Which.CTRL, 0)
        m.tap(ModifierState.Which.SHIFT, 0)
        val mods = m.mods()
        assertTrue(mods.ctrl && mods.shift && !mods.alt)
        assertTrue(m.anyActive)
        m.clear()
        assertFalse(m.anyActive)
    }

    @Test fun extraKeyRowsParseTokensAndAlternates() {
        val row = ExtraKeysView.parseRow("ESC CTRL -|_ ||& F5 hello")
        assertEquals(6, row.size)
        assertEquals(ExtraKeysView.Action.Special(KeyEncoder.Key.ESCAPE), row[0].action)
        assertEquals(ExtraKeysView.Action.Modifier(ModifierState.Which.CTRL), row[1].action)
        assertEquals(ExtraKeysView.Action.Text("-"), row[2].action)
        assertEquals("_", row[2].alternates.single().label)
        assertEquals(ExtraKeysView.Action.Text("|"), row[3].action)
        assertEquals("&", row[3].alternates.single().label)
        assertEquals(ExtraKeysView.Action.Special(KeyEncoder.Key.F5), row[4].action)
        assertEquals(ExtraKeysView.Action.Text("hello"), row[5].action)
    }
}
