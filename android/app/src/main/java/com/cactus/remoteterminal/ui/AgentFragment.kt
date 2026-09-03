package com.cactus.remoteterminal.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.PopupMenu
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentAgentBinding
import com.cactus.remoteterminal.databinding.ItemSessionBinding
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.Outgoing
import com.cactus.remoteterminal.protocol.SessionInfo
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** One machine: status, facts, its terminals, and the actions on it. */
class AgentFragment : Fragment() {
    private var _binding: FragmentAgentBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!
    private var agent: AgentInfo? = null
    private lateinit var adapter: SessionAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentAgentBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val host = requireActivity() as MainActivity
        binding.toolbar.padForStatusBar()
        binding.newTerminalButton.padForNavigationBar()
        binding.toolbar.setNavigationOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        binding.toolbar.inflateMenu(R.menu.menu_agent)
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_rename -> { rename(); true }
                R.id.action_copy_hostname -> { copyHostname(); true }
                R.id.action_info -> { info(); true }
                R.id.action_remove -> { remove(); true }
                else -> false
            }
        }
        adapter = SessionAdapter(
            isOpen = { app.sessions.find(agentId, it) != null },
            onOpen = { host.openTerminal(agentId, it.sessionId) },
            onMenu = { s, anchor -> sessionMenu(s, anchor) },
        )
        binding.list.layoutManager = LinearLayoutManager(requireContext())
        binding.list.adapter = adapter
        binding.newTerminalButton.setOnClickListener { newTerminal() }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.combine(app.client.state) { agents, state -> agents.firstOrNull { it.agentId == agentId } to state }
                    .collect { (a, state) ->
                        if (a == null) { host.onBackPressedDispatcher.onBackPressed(); return@collect }
                        agent = a
                        binding.toolbar.title = a.name
                        val (label, color) = Format.presence(requireContext(), a, state)
                        binding.statusText.text = label
                        binding.statusText.setTextColor(ContextCompat.getColor(requireContext(), color))
                        binding.statusDot.backgroundTintList = ContextCompat.getColorStateList(requireContext(), color)
                        binding.infoText.text = listOf(a.hostname, a.os, a.arch).filter { it.isNotEmpty() }.joinToString(" · ")
                        binding.versionText.text = if (a.agentVersion.isNotEmpty()) getString(R.string.agent_version, a.agentVersion) else ""
                        binding.offlineHint.isVisible = !a.online
                        binding.newTerminalButton.isEnabled = a.online
                        val sessions = a.sessions.sortedByDescending { it.lastActiveAt }
                        adapter.submitList(sessions)
                        binding.emptyText.isVisible = sessions.isEmpty()
                    }
            }
        }
    }

    private fun newTerminal() {
        val a = agent ?: return
        ShellChooser.show(requireContext(), a, app.settings.lastShell(agentId)) { shell ->
            (requireActivity() as MainActivity).openTerminal(agentId, TerminalFragment.NEW_SESSION_PREFIX + (shell ?: ""))
        }
    }

    private fun rename() {
        val a = agent ?: return
        val input = EditText(requireContext()).apply { setText(a.name); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS; setSelection(text.length) }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.rename_machine)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) app.agents.renameAgent(agentId, name)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun copyHostname() {
        val a = agent ?: return
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("hostname", a.hostname))
        Toast.makeText(requireContext(), R.string.copied, Toast.LENGTH_SHORT).show()
    }

    private fun info() {
        val a = agent ?: return
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.agent_info)
            .setMessage(getString(R.string.agent_info_text, a.name, a.hostname, a.platform, a.os, a.arch, a.agentVersion,
                a.shells.joinToString(", ") { it.label }, a.agentId))
            .setPositiveButton(R.string.ok, null)
            .show()
    }

    private fun remove() {
        val a = agent ?: return
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.remove_machine)
            .setMessage(getString(R.string.remove_machine_confirm, a.name))
            .setPositiveButton(R.string.remove) { _, _ -> app.agents.removeAgent(agentId) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun sessionMenu(s: SessionInfo, anchor: View) {
        val menu = PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.rename_terminal)
        menu.menu.add(0, 2, 1, R.string.tab_terminate)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> {
                    val input = EditText(requireContext()).apply { setText(s.title); setSelection(text.length) }
                    MaterialAlertDialogBuilder(requireContext()).setTitle(R.string.rename_terminal).setView(input)
                        .setPositiveButton(R.string.save) { _, _ ->
                            val t = input.text.toString().trim()
                            if (t.isNotEmpty()) {
                                app.sessions.find(agentId, s.sessionId)?.let { app.sessions.rename(it, t) }
                                    ?: app.client.send(Outgoing.sessionRename(agentId, s.sessionId, t))
                            }
                        }.setNegativeButton(R.string.cancel, null).show()
                }
                2 -> MaterialAlertDialogBuilder(requireContext()).setTitle(getString(R.string.tab_close_title, s.title))
                    .setMessage(R.string.tab_terminate_desc)
                    .setPositiveButton(R.string.tab_terminate) { _, _ ->
                        app.sessions.find(agentId, s.sessionId)?.let { app.sessions.closeTab(it, terminate = true) }
                            ?: app.client.send(Outgoing.sessionClose(agentId, s.sessionId))
                    }.setNegativeButton(R.string.cancel, null).show()
            }
            true
        }
        menu.show()
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }

    /* -------------------------------- list -------------------------------- */

    class SessionAdapter(
        private val isOpen: (String) -> Boolean,
        private val onOpen: (SessionInfo) -> Unit,
        private val onMenu: (SessionInfo, View) -> Unit,
    ) : ListAdapter<SessionInfo, SessionAdapter.VH>(DIFF) {
        class VH(val b: ItemSessionBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemSessionBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val s = getItem(position)
            val ctx = holder.b.root.context
            holder.b.title.text = s.title.ifEmpty { s.shell.ifEmpty { ctx.getString(R.string.terminal) } }
            val state = when {
                !s.isRunning -> ctx.getString(R.string.session_state_exited, s.exitCode ?: 0)
                s.attached > 0 -> ctx.getString(R.string.session_state_running)
                else -> ctx.getString(R.string.session_state_detached)
            }
            val age = Format.relativeTime(ctx, if (s.lastActiveAt > 0) s.lastActiveAt else s.createdAt)
            holder.b.subtitle.text = listOf(s.shell, state, age).filter { it.isNotEmpty() }.joinToString(" · ")
            holder.b.openBadge.isVisible = isOpen(s.sessionId)
            holder.b.root.setOnClickListener { onOpen(s) }
            holder.b.menuButton.setOnClickListener { onMenu(s, it) }
        }

        companion object {
            val DIFF = object : DiffUtil.ItemCallback<SessionInfo>() {
                override fun areItemsTheSame(a: SessionInfo, b: SessionInfo) = a.sessionId == b.sessionId
                override fun areContentsTheSame(a: SessionInfo, b: SessionInfo) = a == b
            }
        }
    }

    companion object {
        private const val ARG_AGENT = "agent"
        fun newInstance(agentId: String) = AgentFragment().apply { arguments = Bundle().apply { putString(ARG_AGENT, agentId) } }
    }
}
