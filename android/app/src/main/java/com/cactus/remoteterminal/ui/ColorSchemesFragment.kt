package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.databinding.FragmentToolScreenBinding
import com.cactus.remoteterminal.terminal.ColorSchemes
import com.cactus.remoteterminal.terminal.TerminalTheme
import com.cactus.remoteterminal.ui.Forms.text
import com.cactus.remoteterminal.ui.Forms.validateOnPositive
import com.cactus.remoteterminal.ui.design.SettingsBuilder
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/**
 * Settings → Terminal → Colour schemes: the built-in schemes and the user's
 * own. A user scheme is used exactly where a built-in one is — app-wide and
 * in each terminal's own chooser.
 */
class ColorSchemesFragment : Fragment(), RtScreen {
    private var _binding: FragmentToolScreenBinding? = null
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentToolScreenBinding.inflate(inflater, container, false)
        return _binding!!.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = _binding!!
        ToolScreen.setUp(
            this, b, getString(R.string.schemes_title), getString(R.string.schemes_subtitle),
            ctaLabel = getString(R.string.schemes_new), ctaIcon = R.drawable.ic_rt_plus, onCta = { chooseBase() },
        )
        b.headerBar.headerAction.visible = true
        b.headerBar.headerAction.setImageResource(R.drawable.ic_rt_download)
        b.headerBar.headerAction.contentDescription = getString(R.string.schemes_import)
        b.headerBar.headerAction.setOnClickListener { importDialog() }
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.settings.version.collect { render() }
            }
        }
    }

    private fun render() {
        val b = _binding ?: return
        val inUse = app.settings.terminalTheme
        val builder = SettingsBuilder(b.content)
        builder.clear()
        builder.section(getString(R.string.schemes_builtin))
        for (t in TerminalTheme.ALL) row(builder, t, inUse)
        val mine = app.settings.customSchemes
        if (mine.isNotEmpty()) {
            builder.section(getString(R.string.schemes_mine))
            for (t in mine) row(builder, t, inUse)
        }
        builder.finish()
    }

    private fun row(builder: SettingsBuilder, t: TerminalTheme, inUse: String) {
        builder.row(
            R.drawable.ic_rt_moon_star, if (t.isLight) R.color.rt_amber else R.color.rt_primary,
            t.name, ColorSchemes.toHex(t.background) + "  ·  " + ColorSchemes.toHex(t.foreground),
            value = if (t.id == inUse) getString(R.string.schemes_in_use) else null,
        ) { actions(t) }
    }

    private fun actions(t: TerminalTheme) {
        val custom = TerminalTheme.isCustom(t.id)
        val items = ArrayList<ActionSheet.Item>()
        items += ActionSheet.Item(getString(R.string.scheme_use), R.drawable.ic_rt_check) {
            app.settings.raw.edit().putString(Settings.KEY_TERMINAL_THEME, t.id).apply()
        }
        if (custom) items += ActionSheet.Item(getString(R.string.scheme_edit), R.drawable.ic_rt_sliders) { host.openSchemeEditor(t.id, null) }
        items += ActionSheet.Item(getString(R.string.scheme_copy_new), R.drawable.ic_rt_plus) { host.openSchemeEditor(null, t.id) }
        items += ActionSheet.Item(getString(R.string.scheme_copy_json), R.drawable.ic_rt_copy) {
            MachineActions.copy(requireContext(), ColorSchemes.toJson(t).toString(2))
        }
        if (custom) items += ActionSheet.Item(getString(R.string.scheme_delete), R.drawable.ic_rt_trash, danger = true) { confirmDelete(t) }
        ActionSheet.show(requireContext(), t.name, null, items)
    }

    /** "New scheme" starts as a copy of one that exists, so every colour has a value. */
    private fun chooseBase() {
        val all = TerminalTheme.all()
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.scheme_new_from)
            .setItems(all.map { it.name }.toTypedArray<CharSequence>()) { _, which -> host.openSchemeEditor(null, all[which].id) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun importDialog() {
        val context = requireContext()
        val box = Forms.column(context)
        val input = Forms.input(context, getString(R.string.schemes_import_hint), multiLine = true, mono = true)
        box.addView(input)
        val dialog = MaterialAlertDialogBuilder(context)
            .setTitle(R.string.schemes_import)
            .setView(box)
            .setPositiveButton(R.string.schemes_import, null)
            .setNegativeButton(R.string.cancel, null)
            .show()
        dialog.validateOnPositive {
            try {
                val schemes = ColorSchemes.import(input.text)
                app.settings.customSchemes = app.settings.customSchemes + schemes
                Toast.makeText(context, resources.getQuantityString(R.plurals.schemes_imported, schemes.size, schemes.size), Toast.LENGTH_SHORT).show()
                true
            } catch (e: IllegalArgumentException) {
                input.error = e.message
                false
            }
        }
    }

    private fun confirmDelete(t: TerminalTheme) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.scheme_delete_title, t.name))
            .setMessage(R.string.scheme_delete_body)
            .setPositiveButton(R.string.delete) { _, _ -> app.settings.deleteScheme(t.id) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
