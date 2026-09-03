package com.cactus.remoteterminal.ui

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

/**
 * Safe-area helpers. The app draws edge to edge (required on Android 15), so
 * every screen pads its own chrome out of the status bar, the navigation bar,
 * a display cutout and the on-screen keyboard. Terminal content keeps the full
 * window; only the bars around it move.
 */
private val View.basePadding: IntArray
    get() {
        var p = getTag(R_TAG) as? IntArray
        if (p == null) { p = intArrayOf(paddingLeft, paddingTop, paddingRight, paddingBottom); setTag(R_TAG, p) }
        return p
    }

private val R_TAG = com.cactus.remoteterminal.R.id.tag_base_padding

private fun View.applyInsets(top: Boolean, bottom: Boolean, sides: Boolean, ime: Boolean) {
    val base = basePadding
    ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
        v.setPadding(
            base[0] + if (sides) bars.left else 0,
            base[1] + if (top) bars.top else 0,
            base[2] + if (sides) bars.right else 0,
            base[3] + if (bottom) max(bars.bottom, if (ime) keyboard.bottom else 0) else 0,
        )
        insets
    }
    ViewCompat.requestApplyInsets(this)
}

/** Top chrome (toolbars): clear of the status bar and cutout. */
fun View.padForStatusBar(sides: Boolean = true) = applyInsets(top = true, bottom = false, sides = sides, ime = false)

/** Bottom chrome (key bars, buttons, lists): clear of the navigation bar and, optionally, the keyboard. */
fun View.padForNavigationBar(ime: Boolean = false, sides: Boolean = true) = applyInsets(top = false, bottom = true, sides = sides, ime = ime)

/** Content between the bars (the terminal): only avoid a side cutout. */
fun View.padForSideCutouts() = applyInsets(top = false, bottom = false, sides = true, ime = false)

/** Scrollable full-screen content: clear on every side. */
fun View.padForAllBars(ime: Boolean = true) = applyInsets(top = true, bottom = true, sides = true, ime = ime)
