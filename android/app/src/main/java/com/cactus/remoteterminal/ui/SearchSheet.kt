package com.cactus.remoteterminal.ui

import android.content.Context
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import androidx.core.widget.doAfterTextChanged
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.ui.design.Design
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * A bottom sheet with a search field over a list that answers it: the
 * command palette and the snippet picker. Enter (on the keyboard or a
 * hardware one) runs the first result; a tap runs that one.
 */
object SearchSheet {

    data class Entry(
        val label: String,
        val detail: String? = null,
        @DrawableRes val icon: Int? = null,
        val run: () -> Unit,
    )

    fun show(
        context: Context,
        hint: String,
        emptyText: (String) -> String,
        results: (String) -> List<Entry>,
        footer: Entry? = null,
    ): BottomSheetDialog {
        val dialog = BottomSheetDialog(context)
        val pad = Design.dp(context, 16f)
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, Design.dp(context, 14f), 0, Design.dp(context, 10f))
        }
        val field = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = ContextCompat.getDrawable(context, R.drawable.rt_field)
            setPadding(Design.dp(context, 14f), 0, Design.dp(context, 8f), 0)
        }
        field.addView(ImageView(context).apply {
            setImageResource(R.drawable.ic_rt_search)
            Design.tint(this, R.color.rt_text_muted)
        }, LinearLayout.LayoutParams(Design.dp(context, 20f), Design.dp(context, 20f)))
        val input = EditText(context).apply {
            setHint(hint)
            background = null
            textSize = 13f
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_GO
            setTextColor(Design.color(context, R.color.rt_text))
            setHintTextColor(Design.color(context, R.color.rt_text_muted))
        }
        field.addView(input, LinearLayout.LayoutParams(0, Design.dp(context, 46f), 1f).apply { marginStart = Design.dp(context, 6f) })
        root.addView(field, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            marginStart = pad; marginEnd = pad; bottomMargin = Design.dp(context, 8f)
        })

        val list = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(context).apply { addView(list); isFillViewport = false }
        val height = (context.resources.displayMetrics.heightPixels * 0.5f).toInt()
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height))

        var current: List<Entry> = emptyList()
        fun render() {
            val q = input.text?.toString().orEmpty()
            current = results(q)
            list.removeAllViews()
            if (current.isEmpty()) {
                list.addView(TextView(context).apply {
                    setTextAppearance(R.style.RtText_RowMeta)
                    text = emptyText(q.trim())
                    setPadding(pad, Design.dp(context, 18f), pad, Design.dp(context, 18f))
                })
            }
            for (e in current) list.addView(row(context, e) { dialog.dismiss(); e.run() })
            footer?.let { f -> list.addView(row(context, f) { dialog.dismiss(); f.run() }) }
        }
        input.doAfterTextChanged { render() }
        input.setOnEditorActionListener { _, actionId, event ->
            val enter = actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            if (enter) {
                current.firstOrNull()?.let { dialog.dismiss(); it.run() }
                true
            } else false
        }
        render()

        dialog.setContentView(root)
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.behavior.skipCollapsed = true
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        dialog.setOnShowListener { input.requestFocus() }
        dialog.show()
        return dialog
    }

    private fun row(context: Context, e: Entry, onClick: () -> Unit): View {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = Design.dp(context, 48f)
            setPadding(Design.dp(context, 16f), Design.dp(context, 6f), Design.dp(context, 16f), Design.dp(context, 6f))
            val ta = context.obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackground))
            background = ta.getDrawable(0)
            ta.recycle()
            isClickable = true
            isFocusable = true
            contentDescription = e.label + (e.detail?.let { ", $it" } ?: "")
            setOnClickListener { onClick() }
        }
        if (e.icon != null) {
            row.addView(ImageView(context).apply {
                setImageResource(e.icon)
                Design.tint(this, R.color.rt_text_secondary)
            }, LinearLayout.LayoutParams(Design.dp(context, 18f), Design.dp(context, 18f)).apply { marginEnd = Design.dp(context, 14f) })
        }
        val texts = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(TextView(context).apply {
            setTextAppearance(R.style.RtText)
            textSize = 13f
            text = e.label
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        })
        e.detail?.takeIf { it.isNotEmpty() }?.let { d ->
            texts.addView(TextView(context).apply {
                setTextAppearance(R.style.RtText_RowMeta)
                text = d
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
        }
        row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }
}
