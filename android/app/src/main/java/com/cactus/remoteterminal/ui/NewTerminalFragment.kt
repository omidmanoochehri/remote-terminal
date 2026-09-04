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
import com.cactus.remoteterminal.databinding.ViewToggleRowBinding
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.ShellInfo
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.visible
import kotlinx.coroutines.launch

/**
 * Start a terminal. The relay only takes a shell, a size and a title, so the
 * working directory and the optional start-up command are sent as the first
 * input to the new shell — visible in the scrollback, nothing hidden.
 */
class NewTerminalFragment : Fragment(), RtScreen {

    private var _binding: FragmentNewTerminalBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    private var agentId: String? = null
    private var shell: ShellInfo? = null
    private var creating = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentNewTerminalBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.scroll.padForNavigationBar(ime = true)
        Design.excludeFromAutofill(view)

        binding.headerBar.headerTitle.setText(R.string.new_terminal_title)
        binding.headerBar.headerSubtitle.setText(R.string.new_terminal_subtitle)
        binding.headerBar.headerOverflow.visible = false
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }

        agentId = savedInstanceState?.getString(STATE_AGENT)
            ?: requireArguments().getString(ARG_AGENT)
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
        binding.createButton.setOnClickListener { create() }
        binding.advancedToggle.setOnClickListener { toggleAdvanced() }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.collect { render() }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        agentId?.let { outState.putString(STATE_AGENT, it) }
    }

    private fun defaultAgent(): AgentInfo? =
        app.agents.agents.value.firstOrNull { it.online } ?: app.agents.agents.value.firstOrNull()

    private fun agent(): AgentInfo? = agentId?.let { id -> app.agents.agents.value.firstOrNull { it.agentId == id } }

    /* ------------------------------ rendering ----------------------------- */

    private fun render() {
        val b = _binding ?: return
        val context = requireContext()
        val agent = agent()

        if (agent == null) {
            b.machineName.setText(R.string.choose_machine)
            b.machineStatus.setText(R.string.no_online_machines)
            b.machineStatus.setTextColor(Design.color(context, R.color.rt_text_muted))
            b.machineDot.backgroundTintList = Design.stateList(context, R.color.rt_status_offline)
            b.createButton.isEnabled = false
            b.createButton.alpha = 0.5f
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

        // Keep the chosen shell valid for the chosen machine.
        if (shell == null || agent.shells.none { it.id == shell?.id }) {
            shell = agent.shells.firstOrNull { it.id == app.settings.lastShell(agent.agentId) }
                ?: agent.shells.firstOrNull { it.isDefault }
                ?: agent.shells.firstOrNull()
        }
        b.shellField.fieldInput.setText(shell?.label ?: getString(R.string.value_unknown))
        b.shellField.fieldTrailing.text = shell?.id ?: ""
        b.shellField.fieldTrailing.visible = shell != null && shell?.id != shell?.label

        b.createButton.isEnabled = agent.online && !creating
        b.createButton.alpha = if (b.createButton.isEnabled) 1f else 0.5f
        b.createLabel.setText(if (creating) R.string.creating_terminal else R.string.create_terminal)
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
        if (machines.isEmpty()) { host.openAddMachine(); return }
        val menu = PopupMenu(requireContext(), anchor)
        for ((index, m) in machines.withIndex()) {
            val suffix = if (m.online) "" else "  (${getString(R.string.machine_offline)})"
            menu.menu.add(0, index, index, m.name.ifEmpty { m.hostname } + suffix)
        }
        menu.setOnMenuItemClickListener { item ->
            agentId = machines[item.itemId].agentId
            shell = null
            render()
            true
        }
        menu.show()
    }

    private fun chooseShell(anchor: View) {
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
        val agent = agent() ?: return
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
        private const val STATE_AGENT = "state_agent"

        fun newInstance(agentId: String?) = NewTerminalFragment().apply {
            arguments = Bundle().apply { putString(ARG_AGENT, agentId) }
        }
    }
}
