package com.cactus.remoteterminal.ui

import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.DrawableRes
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.ui.design.Design
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * A bottom sheet of actions about one thing — a file, a process, a link —
 * with that thing named at the top. Built in code: the rows depend on what the
 * thing is and what the machine allows, and a disabled row says why.
 */
object ActionSheet {

    data class Item(
        val label: String,
        @DrawableRes val icon: Int? = null,
        val danger: Boolean = false,
        /** When set, the row is shown greyed out with this as its explanation. */
        val disabledReason: String? = null,
        val onClick: () -> Unit,
    )

    /** [details] are label/value lines shown under the title (process facts, a full path). */
    fun show(context: Context, title: String, subtitle: String?, items: List<Item>, details: List<Pair<String, String>> = emptyList()) {
        val dialog = BottomSheetDialog(context)
        val pad = Design.dp(context, 16f)
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, Design.dp(context, 14f), 0, Design.dp(context, 18f))
        }

        root.addView(TextView(context).apply {
            setTextAppearance(R.style.RtText_CardTitle)
            text = title
            maxLines = 2
            setPadding(pad, 0, pad, 0)
        })
        if (!subtitle.isNullOrEmpty()) {
            root.addView(TextView(context).apply {
                setTextAppearance(R.style.RtText_RowMeta)
                text = subtitle
                setTextIsSelectable(true)
                setPadding(pad, Design.dp(context, 4f), pad, 0)
            })
        }
        if (details.isNotEmpty()) {
            val box = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, Design.dp(context, 10f), pad, Design.dp(context, 4f))
            }
            for ((label, value) in details) {
                box.addView(TextView(context).apply {
                    setTextAppearance(R.style.RtText_RowMeta)
                    text = label
                    setPadding(0, Design.dp(context, 6f), 0, 0)
                })
                box.addView(TextView(context).apply {
                    setTextAppearance(R.style.RtText_Mono)
                    textSize = 11f
                    text = value
                    setTextIsSelectable(true)
                })
            }
            root.addView(box)
        }
        root.addView(android.view.View(context).apply {
            setBackgroundColor(Design.color(context, R.color.rt_divider))
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply { topMargin = Design.dp(context, 12f); bottomMargin = Design.dp(context, 4f) })

        for (item in items) root.addView(row(context, item) { dialog.dismiss() })

        dialog.setContentView(root)
        dialog.show()
    }

    private fun row(context: Context, item: Item, dismiss: () -> Unit): LinearLayout {
        val enabled = item.disabledReason == null
        val tone = when {
            !enabled -> R.color.rt_text_muted
            item.danger -> R.color.rt_danger
            else -> R.color.rt_text
        }
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = Design.dp(context, 50f)
            setPadding(Design.dp(context, 16f), Design.dp(context, 6f), Design.dp(context, 16f), Design.dp(context, 6f))
            val ta = context.obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackground))
            background = ta.getDrawable(0)
            ta.recycle()
            isClickable = true
            isFocusable = true
            contentDescription = item.label + (item.disabledReason?.let { ", $it" } ?: "")
            setOnClickListener {
                if (!enabled) return@setOnClickListener
                dismiss()
                item.onClick()
            }
        }
        if (item.icon != null) {
            row.addView(ImageView(context).apply {
                setImageResource(item.icon)
                Design.tint(this, tone)
            }, LinearLayout.LayoutParams(Design.dp(context, 20f), Design.dp(context, 20f)).apply { marginEnd = Design.dp(context, 14f) })
        }
        val texts = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(TextView(context).apply {
            setTextAppearance(R.style.RtText)
            textSize = 13f
            text = item.label
            setTypeface(typeface, if (item.danger && enabled) Typeface.BOLD else Typeface.NORMAL)
            setTextColor(Design.color(context, tone))
        })
        item.disabledReason?.let { reason ->
            texts.addView(TextView(context).apply {
                setTextAppearance(R.style.RtText_RowMeta)
                text = reason
            })
        }
        row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }
}
