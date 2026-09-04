package com.cactus.remoteterminal.ui.design

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.annotation.ColorInt
import com.cactus.remoteterminal.R

/**
 * The thin rounded progress meter under a metric tile (CPU, memory, storage,
 * uptime) and inside the machine cards. Draws a track and a tinted fill; a
 * negative [progress] means "not reported" and leaves only the track.
 */
class MeterView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Design.color(context, R.color.rt_surface_flat)
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Design.color(context, R.color.rt_primary)
    }
    private val rect = RectF()

    /** 0f..1f, or a negative value when the value is unknown. */
    var progress: Float = -1f
        set(value) {
            field = value
            invalidate()
        }

    fun setFillColor(@ColorInt argb: Int) {
        fillPaint.color = argb
        invalidate()
    }

    fun setTrackColor(@ColorInt argb: Int) {
        trackPaint.color = argb
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val h = height.toFloat()
        val r = h / 2f
        rect.set(0f, 0f, width.toFloat(), h)
        canvas.drawRoundRect(rect, r, r, trackPaint)
        val p = progress
        if (p <= 0f) return
        // Never render a sliver narrower than the cap radius: it would look broken.
        val w = (width * p.coerceAtMost(1f)).coerceAtLeast(h)
        rect.set(0f, 0f, w, h)
        canvas.drawRoundRect(rect, r, r, fillPaint)
    }
}
