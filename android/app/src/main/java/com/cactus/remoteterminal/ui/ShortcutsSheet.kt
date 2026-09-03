package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.databinding.SheetShortcutsBinding
import com.cactus.remoteterminal.terminal.KeyEncoder
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.google.android.material.chip.Chip

/**
 * Bottom sheet with common control shortcuts (Ctrl+C …) and the user's own
 * command shortcuts. Every entry needs a deliberate tap; nothing is sent on
 * open or by accident.
 */
class ShortcutsSheet : BottomSheetDialogFragment() {
    private var _binding: SheetShortcutsBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = SheetShortcutsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val host = parentFragment as? TerminalFragment
        val app = requireActivity().application as App
        for (spec in KEYS) {
            val bytes = KeyEncoder.shortcut(spec) ?: continue
            binding.keysGroup.addView(Chip(requireContext()).apply {
                text = spec
                isCheckable = false
                setOnClickListener { host?.sendShortcut(bytes); dismiss() }
            })
        }
        for ((label, command) in app.settings.commandShortcuts) {
            binding.commandsGroup.addView(Chip(requireContext()).apply {
                text = label
                isCheckable = false
                setOnClickListener { host?.sendCommand(command); dismiss() }
            })
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }

    companion object {
        val KEYS = listOf("Ctrl+C", "Ctrl+D", "Ctrl+Z", "Ctrl+L", "Ctrl+A", "Ctrl+E", "Ctrl+R", "Ctrl+W", "Ctrl+U", "Ctrl+K", "Alt+B", "Alt+F", "Shift+Tab")
    }
}
