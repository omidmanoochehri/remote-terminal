package com.cactus.remoteterminal.ui

import android.graphics.Typeface
import android.os.Bundle
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.res.ResourcesCompat
import androidx.fragment.app.Fragment
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.databinding.FragmentTerminalFontBinding
import com.cactus.remoteterminal.terminal.TerminalTheme
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.SettingsBuilder
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/**
 * Terminal typography and cursor. Split out of the settings list because the
 * choices only make sense next to a live preview.
 */
class TerminalFontFragment : Fragment(), RtScreen {

    private var _binding: FragmentTerminalFontBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentTerminalFontBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.scroll.padForNavigationBar()
        Design.excludeFromAutofill(view)
        binding.headerBar.headerTitle.setText(R.string.terminal_font_title)
        binding.headerBar.headerSubtitle.visible = false
        binding.headerBar.headerOverflow.visible = false
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        build()
    }

    private fun build() {
        val b = _binding ?: return
        val s = app.settings
        renderPreview()

        val builder = SettingsBuilder(b.sections)
        builder.clear()
        builder.section(getString(R.string.setting_terminal_font))
            .row(
                R.drawable.ic_rt_font, R.color.rt_accent,
                getString(R.string.font_family_label), null,
                value = fontLabel(s.terminalFontFamily),
            ) { chooseFont() }
            .row(
                R.drawable.ic_rt_font, R.color.rt_primary,
                getString(R.string.font_size_label), null,
                value = trimFloat(s.fontSizeSp),
            ) { choose(R.string.font_size_label, R.array.font_size_entries, R.array.font_size_values, trimFloat(s.fontSizeSp) + ".0") { value ->
                s.raw.edit().putString(Settings.KEY_FONT_SIZE, value).apply()
            } }
            .row(
                R.drawable.ic_rt_panel_top, R.color.rt_purple,
                getString(R.string.line_spacing_label), null,
                value = labelFor(R.array.line_spacing_entries, R.array.line_spacing_values, s.lineSpacing.toString()),
            ) { choose(R.string.line_spacing_label, R.array.line_spacing_entries, R.array.line_spacing_values, s.lineSpacing.toString()) { value ->
                s.raw.edit().putString(Settings.KEY_LINE_SPACING, value).apply()
            } }

        builder.section(getString(R.string.setting_terminal_colours))
            .row(
                R.drawable.ic_rt_moon_star, R.color.rt_primary,
                getString(R.string.setting_terminal_colours), null,
                value = labelFor(R.array.terminal_theme_entries, R.array.terminal_theme_values, s.terminalTheme),
            ) { choose(R.string.setting_terminal_colours, R.array.terminal_theme_entries, R.array.terminal_theme_values, s.terminalTheme) { value ->
                s.raw.edit().putString(Settings.KEY_TERMINAL_THEME, value).apply()
            } }
            .row(
                R.drawable.ic_rt_command, R.color.rt_accent,
                getString(R.string.setting_cursor), null,
                value = labelFor(R.array.cursor_style_entries, R.array.cursor_style_values, s.cursorStyle),
            ) { choose(R.string.setting_cursor, R.array.cursor_style_entries, R.array.cursor_style_values, s.cursorStyle) { value ->
                s.raw.edit().putString(Settings.KEY_CURSOR_STYLE, value).apply()
            } }
            .toggle(
                R.drawable.ic_rt_activity, R.color.rt_amber,
                getString(R.string.cursor_blink_label), null,
                checked = s.cursorBlink,
            ) { value -> s.raw.edit().putBoolean(Settings.KEY_CURSOR_BLINK, value).apply(); build() }
    }

    private fun renderPreview() {
        val s = app.settings
        val preview = binding.preview
        preview.typeface = typefaceFor(s.terminalFontFamily)
        preview.setTextSize(TypedValue.COMPLEX_UNIT_SP, s.fontSizeSp)
        preview.setLineSpacing(0f, s.lineSpacing)
        val theme = TerminalTheme.byId(s.terminalTheme)
        preview.setTextColor(theme.foreground)
        preview.setBackgroundColor(theme.background)
    }

    private fun typefaceFor(family: String): Typeface =
        if (family == Settings.FONT_SYSTEM) Typeface.MONOSPACE
        else runCatching { ResourcesCompat.getFont(requireContext(), R.font.terminal_mono) }.getOrNull() ?: Typeface.MONOSPACE

    private fun fontLabel(value: String): String =
        getString(if (value == Settings.FONT_SYSTEM) R.string.font_system else R.string.font_bundled)

    private fun chooseFont() {
        val labels = arrayOf(getString(R.string.font_bundled), getString(R.string.font_system))
        val values = arrayOf(Settings.FONT_BUNDLED, Settings.FONT_SYSTEM)
        val current = values.indexOf(app.settings.terminalFontFamily).coerceAtLeast(0)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.font_family_label)
            .setSingleChoiceItems(labels, current) { dialog, which ->
                app.settings.terminalFontFamily = values[which]
                dialog.dismiss()
                build()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun choose(title: Int, entries: Int, values: Int, current: String, onPick: (String) -> Unit) {
        val e = resources.getStringArray(entries)
        val v = resources.getStringArray(values)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(title)
            .setSingleChoiceItems(e, v.indexOf(current).coerceAtLeast(0)) { dialog, which ->
                onPick(v[which])
                dialog.dismiss()
                build()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun labelFor(entries: Int, values: Int, value: String): String {
        val e = resources.getStringArray(entries)
        val v = resources.getStringArray(values)
        val index = v.indexOf(value)
        return if (index >= 0) e[index] else value
    }

    private fun trimFloat(value: Float): String =
        if (value % 1f == 0f) value.toInt().toString() else value.toString()

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
