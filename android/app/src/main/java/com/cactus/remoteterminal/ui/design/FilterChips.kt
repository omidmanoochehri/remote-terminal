package com.cactus.remoteterminal.ui.design

import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.appcompat.widget.AppCompatTextView
import androidx.core.content.ContextCompat
import com.cactus.remoteterminal.R

/**
 * The filter row shared by the Machines and Terminals screens. Chips are built
 * in code because the set and the counts depend on live data; the look comes
 * entirely from the shared chip style and drawable.
 */
object FilterChips {

    data class Chip(
        val id: String,
        val label: String,
        val count: Int? = null,
        @DrawableRes val icon: Int? = null,
    )

    /**
     * Fill [row] with [chips], marking [selectedId]. [onSelect] fires for a
     * normal chip; a chip carrying an [Chip.icon] (the "Filters" affordance)
     * is routed to [onAction] instead so it can open a sheet.
     */
    fun render(
        row: LinearLayout,
        chips: List<Chip>,
        selectedId: String,
        onSelect: (String) -> Unit,
        onAction: ((String, View) -> Unit)? = null,
    ) {
        val context = row.context
        row.removeAllViews()
        for ((index, chip) in chips.withIndex()) {
            val view = build(context, chip, chip.id == selectedId)
            if (index > 0) {
                (view.layoutParams as LinearLayout.LayoutParams).marginStart = Design.dp(context, 7f)
            }
            view.setOnClickListener {
                if (chip.icon != null && onAction != null) onAction(chip.id, it) else onSelect(chip.id)
            }
            row.addView(view)
        }
    }

    private fun build(context: Context, chip: Chip, selected: Boolean): TextView {
        val view = AppCompatTextView(context)
        view.setTextAppearance(R.style.RtText)
        view.background = ContextCompat.getDrawable(context, R.drawable.rt_chip)
        view.gravity = Gravity.CENTER
        view.textSize = 9.5f
        view.setPadding(Design.dp(context, 14f), 0, Design.dp(context, 14f), 0)
        view.isSingleLine = true
        view.isClickable = true
        view.isFocusable = true
        view.isSelected = selected
        view.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
        view.setTextColor(Design.color(context, if (selected) R.color.rt_primary else R.color.rt_text_muted))
        view.text = when {
            chip.count != null -> context.getString(R.string.filter_count, chip.label, chip.count)
            else -> chip.label
        }
        if (chip.icon != null) {
            val icon = ContextCompat.getDrawable(context, chip.icon)?.mutate()
            icon?.setBounds(0, 0, Design.dp(context, 14f), Design.dp(context, 14f))
            icon?.setTint(Design.color(context, R.color.rt_text_muted))
            view.setCompoundDrawables(icon, null, null, null)
            view.compoundDrawablePadding = Design.dp(context, 6f)
        }
        // TalkBack should hear the state, not infer it from the green wash.
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            view.stateDescription =
                context.getString(if (selected) R.string.a11y_selected else R.string.a11y_not_selected)
        }
        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            context.resources.getDimensionPixelSize(R.dimen.rt_chip_height)
        )
        view.layoutParams = params
        return view
    }
}
