package com.cactus.remoteterminal.ui

import android.view.View
import android.view.ViewGroup
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

private val View.baseBottomMargin: Int
    get() {
        var m = getTag(M_TAG) as? Int
        if (m == null) { m = (layoutParams as? ViewGroup.MarginLayoutParams)?.bottomMargin ?: 0; setTag(M_TAG, m) }
        return m
    }

private val M_TAG = com.cactus.remoteterminal.R.id.tag_base_margin

/**
 * Ask for insets once the view is in a window. A screen's views are made in
 * onViewCreated, before the fragment is attached, and a request made then is
 * dropped — so a screen pushed after the first frame would never be told
 * where the bars are, and would draw under them.
 */
private fun View.requestInsetsWhenAttached() {
    if (isAttachedToWindow) {
        ViewCompat.requestApplyInsets(this)
    } else {
        addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {
                v.removeOnAttachStateChangeListener(this)
                ViewCompat.requestApplyInsets(v)
            }
            override fun onViewDetachedFromWindow(v: View) = Unit
        })
    }
}

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
    requestInsetsWhenAttached()
}

/** Top chrome (toolbars): clear of the status bar and cutout. */
fun View.padForStatusBar(sides: Boolean = true) = applyInsets(top = true, bottom = false, sides = sides, ime = false)

/** Bottom chrome (key bars, buttons, lists): clear of the navigation bar and, optionally, the keyboard. */
fun View.padForNavigationBar(ime: Boolean = false, sides: Boolean = true) = applyInsets(top = false, bottom = true, sides = sides, ime = ime)

/**
 * A fixed-height button pinned to the bottom: lifted clear of the navigation
 * bar by its margin. Padding would squeeze its label out of a fixed height.
 */
fun View.marginForNavigationBar() {
    val base = baseBottomMargin
    ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        val lp = v.layoutParams as? ViewGroup.MarginLayoutParams
        if (lp != null && lp.bottomMargin != base + bars.bottom) {
            lp.bottomMargin = base + bars.bottom
            v.layoutParams = lp
        }
        insets
    }
    requestInsetsWhenAttached()
}

/** Content between the bars (the terminal): only avoid a side cutout. */
fun View.padForSideCutouts() = applyInsets(top = false, bottom = false, sides = true, ime = false)

/** Scrollable full-screen content: clear on every side. */
fun View.padForAllBars(ime: Boolean = true) = applyInsets(top = true, bottom = true, sides = true, ime = ime)
