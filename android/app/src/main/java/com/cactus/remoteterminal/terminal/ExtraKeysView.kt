package com.cactus.remoteterminal.terminal

import android.content.Context
import android.content.res.ColorStateList
import android.os.SystemClock
import android.util.AttributeSet
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import androidx.appcompat.widget.TooltipCompat
import androidx.core.content.ContextCompat
import com.cactus.remoteterminal.R
import com.google.android.material.button.MaterialButton

/**
 * The terminal's extra-keys bar: configurable rows of special keys, sticky
 * Ctrl/Alt/Shift with one-shot / locked states, a symbol row that can be
 * swapped for an alternate row, and long-press alternates (`-|_`).
 *
 * Row definitions are space-separated tokens (see [parseRow]); they come from
 * Settings so users can customise them.
 */
class ExtraKeysView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : LinearLayout(context, attrs) {

    sealed class Action {
        data class Special(val key: KeyEncoder.Key) : Action()
        data class Modifier(val which: ModifierState.Which) : Action()
        data class Text(val text: String) : Action()
        object SwapRow : Action()
    }

    data class KeySpec(val label: String, val action: Action, val alternates: List<KeySpec> = emptyList())

    /** Host callback: a key was chosen (special keys and text already respect modifiers in the host). */
    var onKey: ((KeySpec) -> Unit)? = null
    var modifiers: ModifierState = ModifierState()
        set(value) { field = value; value.onChanged = { refreshModifierButtons() }; refreshModifierButtons() }
    var hapticsEnabled = true

    /** Compact (landscape): one visible row, the swap button cycles through all rows. */
    var compact = false
        set(value) { if (field != value) { field = value; rebuild() } }

    private var rowSpecs: List<List<KeySpec>> = emptyList()
    private var alternateIndex = 0   // which of rows[1..] is shown as the second row
    private var compactIndex = 0
    private val modifierButtons = ArrayList<Pair<ModifierState.Which, MaterialButton>>()

    init {
        orientation = VERTICAL
        setBackgroundColor(ContextCompat.getColor(context, R.color.app_bar))
        modifiers.onChanged = { refreshModifierButtons() }
    }

    /** Configure from row definition strings (first row = navigation, others alternate). */
    fun setRows(rows: List<String>) {
        rowSpecs = rows.map { parseRow(it) }.filter { it.isNotEmpty() }
        alternateIndex = 0; compactIndex = 0
        rebuild()
    }

    private fun rebuild() {
        removeAllViews()
        modifierButtons.clear()
        if (rowSpecs.isEmpty()) return
        if (compact) {
            addView(buildRow(rowSpecs[compactIndex % rowSpecs.size], swap = rowSpecs.size > 1))
        } else {
            addView(buildRow(rowSpecs[0], swap = false))
            if (rowSpecs.size > 1) addView(buildRow(rowSpecs[1 + alternateIndex % (rowSpecs.size - 1)], swap = rowSpecs.size > 2))
        }
        refreshModifierButtons()
    }

    private fun buildRow(specs: List<KeySpec>, swap: Boolean): View {
        val scroll = HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; overScrollMode = OVER_SCROLL_NEVER }
        val row = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(4), dp(2), dp(4), dp(2)) }
        if (swap) row.addView(makeButton(KeySpec("⇄", Action.SwapRow)).apply { contentDescription = context.getString(R.string.toggle_symbol_row) })
        for (spec in specs) row.addView(makeButton(spec))
        scroll.addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        return scroll
    }

    private fun makeButton(spec: KeySpec): MaterialButton {
        val b = MaterialButton(context, null, com.google.android.material.R.attr.materialButtonStyle).apply {
            text = spec.label
            isAllCaps = false
            textSize = 13f
            typeface = androidx.core.content.res.ResourcesCompat.getFont(context, R.font.terminal_mono)
                ?: android.graphics.Typeface.MONOSPACE
            minWidth = dp(44); minimumWidth = dp(44)
            minHeight = dp(40); minimumHeight = dp(40)
            insetTop = 0; insetBottom = 0
            cornerRadius = dp(8)
            setPadding(dp(10), 0, dp(10), 0)
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, dp(40)).apply { marginStart = dp(3); marginEnd = dp(3) }
            paintNormal(this)
        }
        when (val a = spec.action) {
            is Action.Modifier -> {
                modifierButtons.add(a.which to b)
                b.contentDescription = when (a.which) {
                    ModifierState.Which.CTRL -> context.getString(R.string.modifier_ctrl)
                    ModifierState.Which.ALT -> context.getString(R.string.modifier_alt)
                    ModifierState.Which.SHIFT -> "Shift"
                }
                b.setOnClickListener { haptic(b); modifiers.tap(a.which, SystemClock.uptimeMillis()); refreshModifierButtons() }
            }
            is Action.SwapRow -> b.setOnClickListener {
                haptic(b)
                if (compact) compactIndex = (compactIndex + 1) % rowSpecs.size else alternateIndex = (alternateIndex + 1) % maxOf(1, rowSpecs.size - 1)
                rebuild()
            }
            else -> {
                b.setOnClickListener { haptic(b); onKey?.invoke(spec) }
                if (spec.alternates.isNotEmpty()) {
                    val alt = spec.alternates.first()
                    TooltipCompat.setTooltipText(b, context.getString(R.string.key_alternates, alt.label))
                    b.setOnLongClickListener { haptic(b); onKey?.invoke(alt); true }
                } else {
                    b.contentDescription = describe(spec)
                }
            }
        }
        return b
    }

    private fun describe(spec: KeySpec): String = when (val a = spec.action) {
        is Action.Special -> a.key.name.lowercase().replace('_', ' ')
        is Action.Text -> spec.label
        else -> spec.label
    }

    private fun haptic(v: View) { if (hapticsEnabled) v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }

    private fun paintNormal(b: MaterialButton) {
        b.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.key_bg))
        b.setTextColor(ContextCompat.getColor(context, R.color.key_fg))
        b.rippleColor = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.app_on_surface_muted))
    }

    private fun refreshModifierButtons() {
        for ((which, b) in modifierButtons) {
            when (modifiers.mode(which)) {
                ModifierState.Mode.OFF -> { paintNormal(b); b.text = b.text.toString().removeSuffix(" ●").removeSuffix(" 🔒") }
                ModifierState.Mode.ONESHOT -> {
                    b.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.key_active_bg))
                    b.setTextColor(ContextCompat.getColor(context, R.color.key_active_fg))
                    b.text = baseLabel(which) + " ●"
                }
                ModifierState.Mode.LOCKED -> {
                    b.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.key_locked_bg))
                    b.setTextColor(ContextCompat.getColor(context, R.color.key_active_fg))
                    b.text = baseLabel(which) + " 🔒"
                }
            }
        }
    }

    private fun baseLabel(which: ModifierState.Which) = when (which) {
        ModifierState.Which.CTRL -> "Ctrl"; ModifierState.Which.ALT -> "Alt"; ModifierState.Which.SHIFT -> "Shift"
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private val SPECIAL = mapOf(
            "ESC" to KeyEncoder.Key.ESCAPE, "TAB" to KeyEncoder.Key.TAB, "ENTER" to KeyEncoder.Key.ENTER, "BKSP" to KeyEncoder.Key.BACKSPACE,
            "UP" to KeyEncoder.Key.UP, "DOWN" to KeyEncoder.Key.DOWN, "LEFT" to KeyEncoder.Key.LEFT, "RIGHT" to KeyEncoder.Key.RIGHT,
            "HOME" to KeyEncoder.Key.HOME, "END" to KeyEncoder.Key.END, "PGUP" to KeyEncoder.Key.PAGE_UP, "PGDN" to KeyEncoder.Key.PAGE_DOWN,
            "INS" to KeyEncoder.Key.INSERT, "DEL" to KeyEncoder.Key.DELETE,
            "F1" to KeyEncoder.Key.F1, "F2" to KeyEncoder.Key.F2, "F3" to KeyEncoder.Key.F3, "F4" to KeyEncoder.Key.F4,
            "F5" to KeyEncoder.Key.F5, "F6" to KeyEncoder.Key.F6, "F7" to KeyEncoder.Key.F7, "F8" to KeyEncoder.Key.F8,
            "F9" to KeyEncoder.Key.F9, "F10" to KeyEncoder.Key.F10, "F11" to KeyEncoder.Key.F11, "F12" to KeyEncoder.Key.F12,
        )
        private val LABELS = mapOf(
            "ESC" to "Esc", "TAB" to "Tab", "ENTER" to "⏎", "BKSP" to "⌫", "UP" to "↑", "DOWN" to "↓", "LEFT" to "←", "RIGHT" to "→",
            "HOME" to "Home", "END" to "End", "PGUP" to "PgUp", "PGDN" to "PgDn", "INS" to "Ins", "DEL" to "Del",
        )

        /** One token → key spec. `a|b|c` = key a with long-press alternates b, c. Unknown tokens are typed literally. */
        fun parseToken(token: String): KeySpec? {
            if (token.isEmpty()) return null
            // Split on '|' unless the token IS the pipe character (or starts with it, e.g. "||&").
            val parts = if (token.startsWith("|")) listOf("|") + token.drop(1).split('|').filter { it.isNotEmpty() } else token.split('|').filter { it.isNotEmpty() }
            if (parts.isEmpty()) return null
            val alternates = parts.drop(1).mapNotNull { single(it) }
            return single(parts[0])?.copy(alternates = alternates)
        }

        private fun single(t: String): KeySpec? {
            val up = t.uppercase()
            SPECIAL[up]?.let { return KeySpec(LABELS[up] ?: up, Action.Special(it)) }
            return when (up) {
                "CTRL" -> KeySpec("Ctrl", Action.Modifier(ModifierState.Which.CTRL))
                "ALT" -> KeySpec("Alt", Action.Modifier(ModifierState.Which.ALT))
                "SHIFT" -> KeySpec("Shift", Action.Modifier(ModifierState.Which.SHIFT))
                "SWAP" -> KeySpec("⇄", Action.SwapRow)
                else -> KeySpec(t, Action.Text(t))
            }
        }

        fun parseRow(def: String): List<KeySpec> = def.trim().split(Regex("\\s+")).mapNotNull { parseToken(it) }
    }
}
