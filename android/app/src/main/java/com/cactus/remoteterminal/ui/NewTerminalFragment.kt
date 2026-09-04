package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.PopupMenu
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentNewTerminalBinding
import com.cactus.remoteterminal.data.TerminalPreset
import com.cactus.remoteterminal.databinding.ViewToggleRowBinding
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.ShellInfo
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/**
 * Start a terminal. The relay only takes a shell, a size and a title, so the
 * working directory and the optional start-up command are sent as the first
 * input to the new shell — visible in the scrollback, nothing hidden.
 *
 * The same form doubles as the preset editor ([forPreset]): the fields are
 * identical, so a preset is simply this screen's answers kept for later.
 */
class NewTerminalFragment : Fragment(), RtScreen {

    private var _binding: FragmentNewTerminalBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    private var agentId: String? = null
    private var shell: ShellInfo? = null
    private var creating = false

    /** Preset mode: the form saves a preset instead of starting a terminal. */
    private val presetMode: Boolean get() = requireArguments().getBoolean(ARG_PRESET_MODE, false)
    private val presetId: String? get() = requireArguments().getString(ARG_PRESET)
    /** In preset mode the machine may deliberately be "any machine". */
    private var anyMachine = false
    /** Shell id carried by the preset being edited, until the machine offers it. */
    private var pendingShellId: String? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentNewTerminalBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.scroll.padForNavigationBar(ime = true)
        Design.excludeFromAutofill(view)

        val editing = presetId?.let { app.settings.preset(it) }
        binding.headerBar.headerTitle.setText(
            when {
                !presetMode -> R.string.new_terminal_title
                editing != null -> R.string.preset_edit_title
                else -> R.string.preset_new
            }
        )
        binding.headerBar.headerSubtitle.setText(
            if (presetMode) R.string.preset_subtitle else R.string.new_terminal_subtitle
        )
        binding.headerBar.headerOverflow.visible = false
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }

        anyMachine = savedInstanceState?.getBoolean(STATE_ANY_MACHINE)
            ?: (presetMode && editing != null && editing.agentId == null)
        agentId = savedInstanceState?.getString(STATE_AGENT)
            ?: editing?.agentId
            ?: requireArguments().getString(ARG_AGENT).takeUnless { anyMachine }
            ?: defaultAgent()?.agentId

        with(binding.nameField) {
            fieldLabel.setText(R.string.field_terminal_name)
            fieldIcon.setImageResource(R.drawable.ic_rt_tag)
            fieldInput.inputType = InputType.TYPE_CLASS_TEXT
            fieldInput.hint = getString(R.string.field_terminal_name_hint)
            fieldInput.contentDescription = getString(R.string.field_terminal_name)
        }
        with(binding.shellField) {
            fieldLabel.setText(R.string.field_shell)
            fieldIcon.setImageResource(R.drawable.ic_rt_terminal_square)
            fieldInput.isFocusable = false
            fieldInput.isClickable = true
            fieldInput.contentDescription = getString(R.string.field_shell)
            fieldTrailing.visible = true
            fieldTrailingIcon.visible = true
            fieldTrailingIcon.setImageResource(R.drawable.ic_rt_chevron_down)
            fieldInput.setOnClickListener { chooseShell(it) }
            fieldWell.setOnClickListener { chooseShell(it) }
        }
        with(binding.directoryField) {
            fieldLabel.setText(R.string.field_working_directory)
            fieldIcon.setImageResource(R.drawable.ic_rt_folder_open)
            fieldInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            fieldInput.hint = getString(R.string.working_directory_hint)
            fieldInput.contentDescription = getString(R.string.field_working_directory)
            fieldTrailing.setText(R.string.recent_directories)
            fieldTrailing.setTextColor(Design.color(requireContext(), R.color.rt_primary))
            fieldTrailing.isClickable = true
            fieldTrailing.setOnClickListener { chooseDirectory(it) }
        }
        with(binding.commandField) {
            fieldLabel.setText(R.string.field_initial_command)
            fieldIcon.setImageResource(R.drawable.ic_rt_command)
            fieldInput.inputType = InputType.TYPE_CLASS_TEXT
            fieldInput.hint = getString(R.string.field_initial_command_hint)
            fieldInput.contentDescription = getString(R.string.field_initial_command)
        }
        with(binding.scrollbackField) {
            fieldLabel.setText(R.string.field_scrollback)
            fieldIcon.setImageResource(R.drawable.ic_rt_history)
            fieldInput.inputType = InputType.TYPE_CLASS_NUMBER
            fieldInput.setText(java.text.NumberFormat.getIntegerInstance().format(app.settings.scrollbackLines))
            fieldInput.contentDescription = getString(R.string.field_scrollback)
        }

        bindToggle(
            binding.toggleRestore, R.drawable.ic_rt_rotate_ccw, R.color.rt_primary,
            R.string.toggle_restore, R.string.toggle_restore_desc, true,
        )
        bindToggle(
            binding.toggleNotify, R.drawable.ic_rt_bell, R.color.rt_accent,
            R.string.toggle_notify, R.string.toggle_notify_desc, app.settings.notifyExit,
        )

        binding.machineCard.setOnClickListener { chooseMachine(it) }
        binding.createButton.setOnClickListener { if (presetMode) savePreset() else create() }
        binding.advancedToggle.setOnClickListener { toggleAdvanced() }
        binding.savePresetButton.setOnClickListener { saveFormAsPreset() }

        // Preset mode keeps the fields and drops everything that only makes
        // sense for a session that is starting right now.
        binding.savePresetButton.visible = !presetMode
        binding.behaviourCard.visible = !presetMode
        binding.scrollbackField.root.visible = !presetMode
        if (presetMode) {
            binding.createIcon.setImageResource(R.drawable.ic_rt_bookmark)
            binding.nameField.fieldInput.hint = getString(R.string.preset_name_hint)
        }
        if (editing != null) pendingShellId = editing.shellId
        if (savedInstanceState == null && editing != null) {
            binding.nameField.fieldInput.setText(editing.name)
            binding.directoryField.fieldInput.setText(editing.directory)
            binding.commandField.fieldInput.setText(editing.command)
            if (editing.command.isNotEmpty()) toggleAdvanced()
        }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.collect { render() }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        agentId?.let { outState.putString(STATE_AGENT, it) }
        outState.putBoolean(STATE_ANY_MACHINE, anyMachine)
    }

    private fun defaultAgent(): AgentInfo? =
        app.agents.agents.value.firstOrNull { it.online } ?: app.agents.agents.value.firstOrNull()

    private fun agent(): AgentInfo? = agentId?.let { id -> app.agents.agents.value.firstOrNull { it.agentId == id } }

    /* ------------------------------ rendering ----------------------------- */

    private fun render() {
        val b = _binding ?: return
        val context = requireContext()
        val agent = agent()

        if (anyMachine) {
            b.machineName.setText(R.string.preset_any_machine)
            b.machineStatus.setText(R.string.preset_any_machine_desc)
            b.machineStatus.setTextColor(Design.color(context, R.color.rt_text_muted))
            b.machineDot.backgroundTintList = Design.stateList(context, R.color.rt_text_muted)
            b.machineIcon.setImageResource(R.drawable.ic_rt_server)
            b.shellField.fieldInput.setText(getString(R.string.preset_default_shell))
            b.shellField.fieldTrailing.visible = false
            b.machineCard.contentDescription = "${b.machineName.text}, ${b.machineStatus.text}"
            b.createButton.isEnabled = true
            b.createButton.alpha = 1f
            b.createLabel.setText(R.string.preset_save)
            return
        }

        if (agent == null) {
            b.machineName.setText(R.string.choose_machine)
            b.machineStatus.setText(R.string.no_online_machines)
            b.machineStatus.setTextColor(Design.color(context, R.color.rt_text_muted))
            b.machineDot.backgroundTintList = Design.stateList(context, R.color.rt_status_offline)
            b.createButton.isEnabled = false
            b.createButton.alpha = 0.5f
            b.createLabel.setText(if (presetMode) R.string.preset_save else R.string.create_terminal)
            return
        }

        b.machineName.text = agent.name.ifEmpty { agent.hostname }
        val (label, colour) = Format.presence(context, agent, app.client.state.value)
        val os = agent.os.ifEmpty { agent.platform }
        b.machineStatus.text = if (os.isEmpty()) label else "$label · $os"
        b.machineStatus.setTextColor(Design.color(context, colour))
        b.machineDot.backgroundTintList = Design.stateList(context, colour)
        b.machineIcon.setImageResource(if (agent.isWindows) R.drawable.ic_rt_monitor else R.drawable.ic_rt_server)
        b.machineCard.contentDescription = "${b.machineName.text}, ${b.machineStatus.text}"

        // Keep the chosen shell valid for the chosen machine; a preset being
        // edited gets its own shell back as soon as the machine reports it.
        if (shell == null || agent.shells.none { it.id == shell?.id }) {
            shell = pendingShellId?.let { id -> agent.shells.firstOrNull { it.id == id } }
                ?: agent.shells.firstOrNull { it.id == app.settings.lastShell(agent.agentId) }
                ?: agent.shells.firstOrNull { it.isDefault }
                ?: agent.shells.firstOrNull()
            if (shell?.id == pendingShellId) pendingShellId = null
        }
        b.shellField.fieldInput.setText(shell?.label ?: getString(R.string.value_unknown))
        b.shellField.fieldTrailing.text = shell?.id ?: ""
        b.shellField.fieldTrailing.visible = shell != null && shell?.id != shell?.label

        // A preset can be written down for a machine that is not up yet.
        b.createButton.isEnabled = presetMode || (agent.online && !creating)
        b.createButton.alpha = if (b.createButton.isEnabled) 1f else 0.5f
        b.createLabel.setText(
            when {
                presetMode -> R.string.preset_save
                creating -> R.string.creating_terminal
                else -> R.string.create_terminal
            }
        )
    }

    private fun toggleAdvanced() {
        val open = !binding.advancedPanel.visible
        binding.advancedPanel.visible = open
        binding.advancedChevron.setImageResource(
            if (open) R.drawable.ic_rt_chevron_up else R.drawable.ic_rt_chevron_down
        )
        binding.advancedToggle.contentDescription = getString(R.string.advanced_options)
    }

    private fun bindToggle(
        row: ViewToggleRowBinding,
        icon: Int,
        colour: Int,
        title: Int,
        description: Int,
        initial: Boolean,
    ) {
        row.toggleIcon.setImageResource(icon)
        Design.tint(row.toggleIcon, colour)
        row.toggleTitle.setText(title)
        row.toggleDesc.setText(description)
        row.toggleSwitch.isChecked = initial
        row.toggleRow.contentDescription = "${getString(title)}. ${getString(description)}"
        row.toggleRow.setOnClickListener { row.toggleSwitch.isChecked = !row.toggleSwitch.isChecked }
    }

    /* ------------------------------- pickers ------------------------------ */

    private fun chooseMachine(anchor: View) {
        val machines = app.agents.agents.value
        if (machines.isEmpty() && !presetMode) { host.openAddMachine(); return }
        val menu = PopupMenu(requireContext(), anchor)
        for ((index, m) in machines.withIndex()) {
            val suffix = if (m.online) "" else "  (${getString(R.string.machine_offline)})"
            menu.menu.add(0, index, index, m.name.ifEmpty { m.hostname } + suffix)
        }
        // A preset does not have to name a machine; then it asks when it runs.
        if (presetMode) menu.menu.add(0, machines.size, machines.size, getString(R.string.preset_any_machine))
        menu.setOnMenuItemClickListener { item ->
            if (presetMode && item.itemId == machines.size) {
                anyMachine = true
            } else {
                anyMachine = false
                agentId = machines[item.itemId].agentId
                shell = null
            }
            render()
            true
        }
        menu.show()
    }

    private fun chooseShell(anchor: View) {
        if (anyMachine) return
        val agent = agent() ?: return
        if (agent.shells.isEmpty()) return
        val menu = PopupMenu(requireContext(), anchor)
        for ((index, s) in agent.shells.withIndex()) {
            val label = if (s.isDefault) "${s.label}  (${getString(R.string.shell_default)})" else s.label
            menu.menu.add(0, index, index, label)
        }
        menu.setOnMenuItemClickListener { item ->
            shell = agent.shells[item.itemId]
            render()
            true
        }
        menu.show()
    }

    private fun chooseDirectory(anchor: View) {
        val agent = agent()
        if (agent == null) { Toast.makeText(requireContext(), R.string.working_directory_help, Toast.LENGTH_SHORT).show(); return }
        val recent = app.settings.recentDirectories(agent.agentId)
        if (recent.isEmpty()) {
            Toast.makeText(requireContext(), R.string.working_directory_help, Toast.LENGTH_SHORT).show()
            return
        }
        val menu = PopupMenu(requireContext(), anchor)
        for ((index, dir) in recent.withIndex()) menu.menu.add(0, index, index, dir)
        menu.setOnMenuItemClickListener { item ->
            binding.directoryField.fieldInput.setText(recent[item.itemId])
            true
        }
        menu.show()
    }

    /* ------------------------------- presets ------------------------------ */

    /** Read the form; null when it cannot make a preset yet. */
    private fun formPreset(name: String): TerminalPreset = TerminalPreset(
        id = presetId ?: TerminalPreset.newId(),
        name = name,
        agentId = if (anyMachine) null else agentId,
        shellId = if (anyMachine) null else shell?.id,
        directory = binding.directoryField.fieldInput.text.toString().trim(),
        command = binding.commandField.fieldInput.text.toString().trim(),
    )

    /** Preset mode: the main action saves and goes back. */
    private fun savePreset() {
        val name = binding.nameField.fieldInput.text.toString().trim()
        if (name.isEmpty()) {
            Toast.makeText(requireContext(), R.string.preset_needs_name, Toast.LENGTH_SHORT).show()
            binding.nameField.fieldInput.requestFocus()
            return
        }
        app.settings.savePreset(formPreset(name))
        Toast.makeText(requireContext(), getString(R.string.preset_saved, name), Toast.LENGTH_SHORT).show()
        host.onBackPressedDispatcher.onBackPressed()
    }

    /** Normal mode: keep this form as a preset without leaving the screen. */
    private fun saveFormAsPreset() {
        val typed = binding.nameField.fieldInput.text.toString().trim()
        if (typed.isNotEmpty()) { storePreset(typed); return }
        val input = android.widget.EditText(requireContext()).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            hint = getString(R.string.preset_name_hint)
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.preset_save_as)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isEmpty()) Toast.makeText(requireContext(), R.string.preset_needs_name, Toast.LENGTH_SHORT).show()
                else storePreset(name)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun storePreset(name: String) {
        app.settings.savePreset(formPreset(name))
        Toast.makeText(requireContext(), getString(R.string.preset_saved, name), Toast.LENGTH_SHORT).show()
    }

    /* ------------------------------- create ------------------------------- */

    private fun create() {
        if (creating) return
        val agent = agent() ?: return
        if (!agent.online) {
            Toast.makeText(requireContext(), R.string.agent_offline_hint, Toast.LENGTH_LONG).show()
            return
        }
        val title = binding.nameField.fieldInput.text.toString().trim().ifEmpty { null }
        val directory = binding.directoryField.fieldInput.text.toString().trim()
        val command = binding.commandField.fieldInput.text.toString().trim()
        val scrollback = binding.scrollbackField.fieldInput.text.toString().toIntOrNull()

        creating = true
        render()
        viewLifecycleOwner.lifecycleScope.launch {
            // 80x24 is the protocol default; the terminal view resizes the PTY
            // to the real grid the moment it attaches.
            val result = app.sessions.create(agent.agentId, shell?.id, 80, 24, title)
            creating = false
            result.onSuccess { session ->
                val key = session.key
                app.settings.setRestoreOnReconnect(key, binding.toggleRestore.toggleSwitch.isChecked)
                app.settings.setNotifyOnFinish(key, binding.toggleNotify.toggleSwitch.isChecked)
                if (scrollback != null && scrollback in 500..50_000) {
                    session.emulator.maxScrollback = scrollback
                }
                // The shell is not attached yet, so the start-up lines are
                // queued and flushed by the session layer once it is.
                val startup = StringBuilder()
                if (directory.isNotEmpty()) {
                    app.settings.noteDirectory(agent.agentId, directory)
                    startup.append("cd ").append(shellQuote(directory)).append('\r')
                }
                if (command.isNotEmpty()) {
                    app.settings.noteCommand(command)
                    startup.append(command).append('\r')
                }
                if (startup.isNotEmpty()) app.sessions.queueStartupInput(session, startup.toString())
                host.openTerminal(agent.agentId, session.sessionId)
            }.onFailure { e ->
                render()
                Toast.makeText(requireContext(), e.message ?: getString(R.string.error_title), Toast.LENGTH_LONG).show()
            }
        }
    }

    /** Quote a path for a shell only when it needs it. */
    private fun shellQuote(path: String): String =
        if (path.matches(Regex("^[A-Za-z0-9._/~@:+-]+$"))) path else "'" + path.replace("'", "'\\''") + "'"

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        private const val ARG_AGENT = "agent"
        private const val ARG_PRESET = "preset"
        private const val ARG_PRESET_MODE = "presetMode"
        private const val STATE_AGENT = "state_agent"
        private const val STATE_ANY_MACHINE = "state_any_machine"

        fun newInstance(agentId: String?) = NewTerminalFragment().apply {
            arguments = Bundle().apply { putString(ARG_AGENT, agentId) }
        }

        /** The same form as an editor: [presetId] null writes a new preset. */
        fun forPreset(presetId: String?, agentId: String?) = NewTerminalFragment().apply {
            arguments = Bundle().apply {
                putString(ARG_AGENT, agentId)
                putString(ARG_PRESET, presetId)
                putBoolean(ARG_PRESET_MODE, true)
            }
        }
    }
}
