package com.cactus.remoteterminal.terminal

/**
 * Sticky modifier keys for the on-screen bar, shared by the terminal view and
 * the extra-keys bar so both agree on what the next key means.
 *
 *  tap      OFF → ONESHOT (applies to the next key, then releases)
 *  tap ×2   ONESHOT → LOCKED (stays on until tapped again)
 *  tap      LOCKED → OFF
 *
 * Pure Kotlin: the caller passes timestamps so it is testable.
 */
class ModifierState {
    enum class Which { CTRL, ALT, SHIFT }
    enum class Mode { OFF, ONESHOT, LOCKED }

    var doubleTapMs: Long = 450
    var onChanged: (() -> Unit)? = null

    private val modes = arrayOf(Mode.OFF, Mode.OFF, Mode.OFF)
    private val lastTap = longArrayOf(0, 0, 0)

    fun mode(which: Which): Mode = modes[which.ordinal]
    fun isActive(which: Which): Boolean = modes[which.ordinal] != Mode.OFF

    /** A tap on a modifier button; returns the new mode. */
    fun tap(which: Which, now: Long): Mode {
        val i = which.ordinal
        val next = when (modes[i]) {
            Mode.OFF -> Mode.ONESHOT
            Mode.ONESHOT -> if (now - lastTap[i] <= doubleTapMs) Mode.LOCKED else Mode.OFF
            Mode.LOCKED -> Mode.OFF
        }
        lastTap[i] = now
        set(i, next)
        return next
    }

    fun set(which: Which, mode: Mode) = set(which.ordinal, mode)

    private fun set(i: Int, mode: Mode) {
        if (modes[i] == mode) return
        modes[i] = mode
        onChanged?.invoke()
    }

    /** The modifiers to apply to the next key. */
    fun mods(): KeyEncoder.Mods = KeyEncoder.Mods(
        ctrl = modes[0] != Mode.OFF, alt = modes[1] != Mode.OFF, shift = modes[2] != Mode.OFF,
    )

    /** A key was sent: release one-shot modifiers, keep locked ones. */
    fun consume() {
        var changed = false
        for (i in modes.indices) if (modes[i] == Mode.ONESHOT) { modes[i] = Mode.OFF; changed = true }
        if (changed) onChanged?.invoke()
    }

    fun clear() {
        var changed = false
        for (i in modes.indices) if (modes[i] != Mode.OFF) { modes[i] = Mode.OFF; changed = true }
        if (changed) onChanged?.invoke()
    }

    val anyActive: Boolean get() = modes.any { it != Mode.OFF }
}
