package com.cactus.remoteterminal.ui

import android.content.Context
import android.graphics.Typeface
import android.text.InputType
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.ui.design.Design
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/**
 * Small dialog forms built in code (snippet editor, placeholder form, watch,
 * Wake-on-LAN): outlined Material fields that can show an error under
 * themselves, in a padded column.
 */
object Forms {

    fun column(context: Context): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        val pad = Design.dp(context, 20f)
        setPadding(pad, Design.dp(context, 8f), pad, 0)
    }

    fun input(
        context: Context,
        label: String,
        value: String = "",
        helper: String? = null,
        multiLine: Boolean = false,
        mono: Boolean = false,
        type: Int = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
    ): TextInputLayout {
        val layout = TextInputLayout(context, null, com.google.android.material.R.attr.textInputOutlinedStyle)
        layout.hint = label
        if (helper != null) layout.helperText = helper
        val edit = TextInputEditText(layout.context)
        edit.inputType = if (multiLine) type or InputType.TYPE_TEXT_FLAG_MULTI_LINE else type
        if (multiLine) { edit.minLines = 3; edit.maxLines = 8; edit.isSingleLine = false } else edit.isSingleLine = true
        if (mono) edit.typeface = Typeface.MONOSPACE
        edit.setText(value)
        layout.addView(edit, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        layout.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = Design.dp(context, 8f)
        }
        return layout
    }

    fun checkBox(context: Context, label: String, checked: Boolean): CheckBox = CheckBox(context).apply {
        text = label
        isChecked = checked
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = Design.dp(context, 6f)
        }
    }

    fun note(context: Context, text: String, warning: Boolean = false): TextView = TextView(context).apply {
        setTextAppearance(R.style.RtText_RowMeta)
        this.text = text
        if (warning) setTextColor(Design.color(context, R.color.rt_amber))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = Design.dp(context, 8f)
        }
    }

    val TextInputLayout.text: String get() = editText?.text?.toString().orEmpty()

    /**
     * Keep the dialog open when [onPositive] returns false (a field shows an
     * error instead). Call after `show()`.
     */
    fun AlertDialog.validateOnPositive(onPositive: () -> Boolean) {
        getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { if (onPositive()) dismiss() }
    }
}
