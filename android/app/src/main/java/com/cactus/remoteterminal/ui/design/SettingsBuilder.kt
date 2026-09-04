package com.cactus.remoteterminal.ui.design

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.ColorRes
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.ItemSettingsRowBinding

/**
 * Builds the settings screens: a group label, a card, and rows that either
 * open something or toggle something. Screens describe what they want; the
 * spacing, dividers and colours are decided here once.
 */
class SettingsBuilder(
    private val container: LinearLayout,
    /** When set, only rows whose title or description contain it are built. */
    private val query: String = "",
) {

    private val context: Context = container.context
    private val inflater = LayoutInflater.from(context)
    private var card: LinearLayout? = null
    private var rowsInCard = 0
    private var pendingSection: View? = null
    private val needle = query.trim().lowercase()

    /** True when nothing survived the current filter. */
    var isEmpty = true
        private set

    fun clear() {
        container.removeAllViews()
        card = null
        rowsInCard = 0
        pendingSection = null
        isEmpty = true
    }

    private fun matches(vararg text: CharSequence?): Boolean {
        if (needle.isEmpty()) return true
        return text.any { it != null && it.toString().lowercase().contains(needle) }
    }

    /** A section whose rows were all filtered out leaves nothing behind. */
    private fun dropEmptySection() {
        if (rowsInCard > 0) return
        pendingSection?.let { container.removeView(it) }
        card?.let { container.removeView(it) }
        pendingSection = null
        card = null
    }

    /** Start a new section with an uppercase group label above its card. */
    fun section(title: CharSequence): SettingsBuilder {
        dropEmptySection()
        val label = TextView(context)
        label.setTextAppearance(R.style.RtText_GroupLabel)
        label.text = title
        label.setTextColor(Design.color(context, R.color.rt_text_muted))
        label.textSize = 8.5f
        label.setPadding(Design.dp(context, 2f), 0, 0, 0)
        container.addView(
            label,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Design.dp(context, if (container.childCount == 0) 12f else 26f)
                bottomMargin = Design.dp(context, 10f)
            }
        )
        val next = LinearLayout(context)
        next.orientation = LinearLayout.VERTICAL
        next.background = ContextCompat.getDrawable(context, R.drawable.rt_card)
        next.setPadding(0, Design.dp(context, 5f), 0, Design.dp(context, 5f))
        container.addView(
            next,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )
        card = next
        pendingSection = label
        rowsInCard = 0
        return this
    }

    /** Call after the last section so a trailing empty group is not left behind. */
    fun finish(): SettingsBuilder {
        dropEmptySection()
        return this
    }

    /** A row that opens something: trailing value plus a chevron. */
    fun row(
        @DrawableRes icon: Int,
        @ColorRes tint: Int,
        title: CharSequence,
        subtitle: CharSequence? = null,
        value: CharSequence? = null,
        enabled: Boolean = true,
        onClick: (View) -> Unit,
    ): SettingsBuilder {
        if (!matches(title, subtitle, value)) return this
        val binding = newRow(icon, tint, title, subtitle)
        binding.rowValue.setTextOrHide(value)
        binding.rowChevron.visible = true
        binding.rowSwitch.visible = false
        binding.settingsRow.isEnabled = enabled
        binding.settingsRow.alpha = if (enabled) 1f else 0.45f
        binding.settingsRow.setOnClickListener { if (enabled) onClick(it) }
        binding.settingsRow.contentDescription = buildString {
            append(title)
            subtitle?.let { append(". ").append(it) }
            value?.let { append(". ").append(it) }
        }
        return this
    }

    /** A row that toggles something. The whole row is the target. */
    fun toggle(
        @DrawableRes icon: Int,
        @ColorRes tint: Int,
        title: CharSequence,
        subtitle: CharSequence? = null,
        checked: Boolean,
        enabled: Boolean = true,
        onChange: (Boolean) -> Unit,
    ): SettingsBuilder {
        if (!matches(title, subtitle)) return this
        val binding = newRow(icon, tint, title, subtitle)
        binding.rowValue.visible = false
        binding.rowChevron.visible = false
        binding.rowSwitch.visible = true
        binding.rowSwitch.isChecked = checked
        binding.settingsRow.isEnabled = enabled
        binding.settingsRow.alpha = if (enabled) 1f else 0.45f
        binding.settingsRow.setOnClickListener {
            if (!enabled) return@setOnClickListener
            val next = !binding.rowSwitch.isChecked
            binding.rowSwitch.isChecked = next
            onChange(next)
        }
        binding.settingsRow.contentDescription = buildString {
            append(title)
            subtitle?.let { append(". ").append(it) }
        }
        return this
    }

    /** Centred footnote under the last card (version, protocol). */
    fun footnote(text: CharSequence) {
        dropEmptySection()
        if (needle.isNotEmpty()) return
        val view = TextView(context)
        view.setTextAppearance(R.style.RtText)
        view.text = text
        view.textSize = 8.5f
        view.setTextColor(Design.color(context, R.color.rt_text_dim))
        view.gravity = android.view.Gravity.CENTER
        container.addView(
            view,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Design.dp(context, 34f)
                bottomMargin = Design.dp(context, 12f)
            }
        )
    }

    private fun newRow(
        @DrawableRes icon: Int,
        @ColorRes tint: Int,
        title: CharSequence,
        subtitle: CharSequence?,
    ): ItemSettingsRowBinding {
        val parent = card ?: error("call section() before adding rows")
        if (rowsInCard > 0) {
            val divider = View(context)
            divider.setBackgroundColor(Design.color(context, R.color.rt_divider))
            parent.addView(
                divider,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
                    marginStart = Design.dp(context, 13f)
                    marginEnd = Design.dp(context, 13f)
                }
            )
        }
        val binding = ItemSettingsRowBinding.inflate(inflater, parent, false)
        binding.rowIcon.setImageResource(icon)
        val colour = Design.color(context, tint)
        Design.tintColor(binding.rowIcon, colour)
        binding.rowIconWell.background =
            Design.tintedBackground(context, R.drawable.rt_settings_icon_well, Design.withAlpha(colour, 0.094f))
        binding.rowTitle.text = title
        binding.rowSubtitle.setTextOrHide(subtitle)
        parent.addView(binding.root)
        rowsInCard++
        isEmpty = false
        return binding
    }
}
