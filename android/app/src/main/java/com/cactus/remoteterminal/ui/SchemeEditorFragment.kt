package com.cactus.remoteterminal.ui

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentToolScreenBinding
import com.cactus.remoteterminal.terminal.ColorSchemes
import com.cactus.remoteterminal.terminal.TerminalEmulator
import com.cactus.remoteterminal.terminal.TerminalTheme
import com.cactus.remoteterminal.terminal.TerminalView
import com.cactus.remoteterminal.ui.Forms.text
import com.cactus.remoteterminal.ui.design.Design
import com.google.android.material.textfield.TextInputLayout

/**
 * Edit a user colour scheme: its name and every colour as a hex field with a
 * swatch, over a live terminal preview that repaints as the fields change.
 */
class SchemeEditorFragment : Fragment(), RtScreen {
    private var _binding: FragmentToolScreenBinding? = null
    private val app get() = requireActivity().application as App

    private lateinit var working: TerminalTheme
    private var preview: TerminalView? = null
    private val fields = LinkedHashMap<String, TextInputLayout>()
    private val swatches = HashMap<String, View>()
    private var nameField: TextInputLayout? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentToolScreenBinding.inflate(inflater, container, false)
        return _binding!!.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = _binding!!
        val args = requireArguments()
        val editing = args.getString(ARG_ID)?.let { id -> app.settings.customSchemes.firstOrNull { it.id == id } }
        working = editing ?: run {
            val from = TerminalTheme.byId(args.getString(ARG_FROM))
            ColorSchemes.copyOf(from, getString(R.string.scheme_copy_name, from.name))
        }
        ToolScreen.setUp(
            this, b,
            getString(if (editing != null) R.string.scheme_edit_title else R.string.schemes_new),
            working.name,
            ctaLabel = getString(R.string.scheme_save), ctaIcon = R.drawable.ic_rt_save, onCta = { save() },
        )
        build(b.content)
    }

    private fun build(content: LinearLayout) {
        val context = requireContext()
        content.removeAllViews()
        content.addView(label(getString(R.string.scheme_preview)))
        val term = TerminalView(context)
        term.setFontSizeSp(11f, notify = false)
        term.linksEnabled = false
        term.swipeTabsEnabled = false
        term.blinkEnabled = false
        term.onInput = null
        term.emulator = sampleScreen()
        term.theme = working
        preview = term
        val frame = android.widget.FrameLayout(context).apply {
            background = GradientDrawable().apply {
                cornerRadius = Design.dp(context, 12f).toFloat()
                setColor(working.background)
            }
            setPadding(Design.dp(context, 8f), Design.dp(context, 8f), Design.dp(context, 8f), Design.dp(context, 8f))
            clipToOutline = true
        }
        frame.addView(term, android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Design.dp(context, 150f)))
        content.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        content.addView(label(getString(R.string.scheme_name)))
        val name = Forms.input(context, getString(R.string.scheme_name), working.name)
        name.editText?.doAfterTextChanged { _binding?.headerBar?.headerSubtitle?.text = it?.toString().orEmpty() }
        nameField = name
        content.addView(name)

        content.addView(label(getString(R.string.scheme_colours)))
        colourRow(content, "background", getString(R.string.scheme_background), working.background)
        colourRow(content, "foreground", getString(R.string.scheme_foreground), working.foreground)
        colourRow(content, "cursor", getString(R.string.scheme_cursor), working.cursor)
        colourRow(content, "selection", getString(R.string.scheme_selection), working.selection)
        content.addView(label(getString(R.string.scheme_ansi)))
        val names = resources.getStringArray(R.array.scheme_ansi_names)
        for (i in 0 until 16) colourRow(content, i.toString(), names[i], working.ansi[i])
    }

    private fun label(text: String) = TextView(requireContext()).apply {
        setTextAppearance(R.style.RtText_GroupLabel)
        textSize = 8.5f
        setTextColor(Design.color(context, R.color.rt_text_muted))
        this.text = text
        setPadding(Design.dp(context, 2f), Design.dp(context, 20f), 0, Design.dp(context, 4f))
    }

    private fun colourRow(parent: LinearLayout, slot: String, title: String, colour: Int) {
        val context = requireContext()
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val swatch = View(context)
        swatch.background = swatchDrawable(colour)
        row.addView(swatch, LinearLayout.LayoutParams(Design.dp(context, 30f), Design.dp(context, 30f)).apply {
            marginEnd = Design.dp(context, 12f); topMargin = Design.dp(context, 8f)
        })
        val field = Forms.input(
            context, title, ColorSchemes.toHex(colour), mono = true,
            type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS,
        )
        field.editText?.doAfterTextChanged { onColour(slot, it?.toString().orEmpty()) }
        row.addView(field, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        fields[slot] = field
        swatches[slot] = swatch
        parent.addView(row)
    }

    private fun swatchDrawable(colour: Int) = GradientDrawable().apply {
        cornerRadius = Design.dp(requireContext(), 8f).toFloat()
        setColor(colour or (0xFF shl 24))
        setStroke(Design.dp(requireContext(), 1f), Design.color(requireContext(), R.color.rt_divider))
    }

    private fun onColour(slot: String, text: String) {
        val field = fields[slot] ?: return
        val c = ColorSchemes.parseHex(text)
        if (c == null) { field.error = getString(R.string.scheme_invalid_hex); return }
        field.error = null
        working = ColorSchemes.withColour(working, slot, c)
        swatches[slot]?.background = swatchDrawable(c)
        preview?.let { p ->
            p.theme = working
            ((p.parent as? View)?.background as? GradientDrawable)?.setColor(working.background)
        }
    }

    private fun save() {
        val name = nameField?.text?.trim().orEmpty()
        nameField?.error = null
        if (name.isEmpty()) { nameField?.error = getString(R.string.scheme_name_required); return }
        if (fields.values.any { it.error != null }) {
            Toast.makeText(requireContext(), R.string.scheme_fix_colours, Toast.LENGTH_SHORT).show()
            return
        }
        app.settings.saveScheme(ColorSchemes.renamed(working, name))
        Toast.makeText(requireContext(), getString(R.string.scheme_saved, name), Toast.LENGTH_SHORT).show()
        ToolScreen.hideKeyboard(this)
        requireActivity().onBackPressedDispatcher.onBackPressed()
    }

    /** A few lines that use every colour: a prompt, a listing, the 16 ANSI blocks. */
    private fun sampleScreen(): TerminalEmulator {
        val e = TerminalEmulator(44, 8, 0)
        e.muteResponses = true
        val sb = StringBuilder()
        sb.append("\u001B[32muser@host\u001B[0m:\u001B[34m~/app\u001B[0m$ ls -la\r\n")
        sb.append("\u001B[34mbin\u001B[0m  \u001B[32mbuild.sh\u001B[0m  \u001B[31merror.log\u001B[0m  \u001B[33mREADME\u001B[0m\r\n")
        sb.append("\u001B[35mmagenta\u001B[0m \u001B[36mcyan\u001B[0m \u001B[1mbold\u001B[0m \u001B[2mdim\u001B[0m\r\n")
        for (i in 0 until 8) sb.append("\u001B[4${i}m   ")
        sb.append("\u001B[0m\r\n")
        for (i in 0 until 8) sb.append("\u001B[10${i}m   ")
        sb.append("\u001B[0m\r\n")
        sb.append("\u001B[32muser@host\u001B[0m:\u001B[34m~/app\u001B[0m$ ")
        e.feed(sb)
        return e
    }

    override fun onDestroyView() {
        super.onDestroyView()
        preview = null
        fields.clear()
        swatches.clear()
        _binding = null
    }

    companion object {
        private const val ARG_ID = "id"
        private const val ARG_FROM = "from"

        fun newInstance(schemeId: String?, fromId: String?) = SchemeEditorFragment().apply {
            arguments = Bundle().apply { putString(ARG_ID, schemeId); putString(ARG_FROM, fromId) }
        }
    }
}
