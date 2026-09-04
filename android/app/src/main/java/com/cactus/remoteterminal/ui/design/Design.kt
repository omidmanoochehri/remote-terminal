package com.cactus.remoteterminal.ui.design

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.drawable.Drawable
import android.provider.Settings
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.annotation.ColorInt
import androidx.annotation.ColorRes
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.DrawableCompat
import com.cactus.remoteterminal.R

/**
 * Small helpers shared by every screen so the design tokens are applied the
 * same way everywhere: colour lookup, icon tinting, and the two runtime
 * questions the design system asks (does the user want animation, and how
 * wide is this screen).
 */
object Design {

    fun dp(context: Context, value: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, context.resources.displayMetrics).toInt()

    @ColorInt
    fun color(context: Context, @ColorRes id: Int): Int = ContextCompat.getColor(context, id)

    fun stateList(context: Context, @ColorRes id: Int): ColorStateList =
        ColorStateList.valueOf(color(context, id))

    /** Tint an icon without mutating the shared drawable cache entry. */
    fun tint(view: ImageView, @ColorRes id: Int) {
        view.imageTintList = stateList(view.context, id)
    }

    fun tintColor(view: ImageView, @ColorInt argb: Int) {
        view.imageTintList = ColorStateList.valueOf(argb)
    }

    /** A background drawable tinted to [argb]; used for the soft circles behind hint icons. */
    fun tintedBackground(context: Context, @DrawableRes id: Int, @ColorInt argb: Int): Drawable {
        val d = DrawableCompat.wrap(ContextCompat.getDrawable(context, id)!!.mutate())
        DrawableCompat.setTint(d, argb)
        return d
    }

    /** [argb] with [alpha] (0..1) applied to its alpha channel. */
    @ColorInt
    fun withAlpha(@ColorInt argb: Int, alpha: Float): Int =
        (argb and 0x00FFFFFF) or (((alpha.coerceIn(0f, 1f) * 255).toInt()) shl 24)

    /**
     * True when the user asked the system for less motion. Every animation in
     * the app is skipped (state applied instantly) when this returns true.
     */
    fun reducedMotion(context: Context): Boolean {
        val scale = try {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        } catch (_: Throwable) {
            1f
        }
        return scale == 0f
    }

    /** Motion duration honouring the reduced-motion preference. */
    fun duration(context: Context, ms: Long): Long = if (reducedMotion(context)) 0L else ms

    /** Screen width in dp, for the responsive rules (compact / medium / expanded). */
    fun screenWidthDp(context: Context): Int = context.resources.configuration.screenWidthDp

    fun isWide(context: Context): Boolean = screenWidthDp(context) >= 600

    fun isLandscape(context: Context): Boolean =
        context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    /**
     * Keep a whole screen out of autofill. Relay URLs, pairing codes, terminal
     * names and shell commands are not credentials the platform should offer to
     * remember; one call on a fragment root covers every field it contains.
     */
    fun excludeFromAutofill(root: View) {
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            root.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
    }

    /** Presence colour for a machine/terminal dot; the label always says the same thing in words. */
    @ColorRes
    fun presenceColor(online: Boolean): Int =
        if (online) R.color.rt_status_online else R.color.rt_status_offline
}

/** Show or hide without the `isVisible` import dance, keeping layout weight stable. */
var View.visible: Boolean
    get() = visibility == View.VISIBLE
    set(value) {
        visibility = if (value) View.VISIBLE else View.GONE
    }

/** Set text and hide the view when the text is blank. */
fun TextView.setTextOrHide(text: CharSequence?) {
    this.text = text ?: ""
    visible = !text.isNullOrBlank()
}

/** Iterate a ViewGroup children without allocating. */
inline fun ViewGroup.forEachChild(action: (View) -> Unit) {
    for (i in 0 until childCount) action(getChildAt(i))
}
