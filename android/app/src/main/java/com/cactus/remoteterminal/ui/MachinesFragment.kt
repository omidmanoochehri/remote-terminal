package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
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
import com.cactus.remoteterminal.databinding.FragmentMachinesBinding
import com.cactus.remoteterminal.databinding.ItemMachineBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** The machines list: presence, hostname · OS, terminal count, last seen. */
class MachinesFragment : Fragment() {
    private var _binding: FragmentMachinesBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private lateinit var adapter: MachineAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentMachinesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val host = requireActivity() as MainActivity
        binding.toolbar.padForStatusBar()
        binding.list.padForNavigationBar()
        binding.emptyView.padForNavigationBar()
        adapter = MachineAdapter { agent -> host.openAgent(agent.agentId) }
        binding.list.layoutManager = LinearLayoutManager(requireContext())
        binding.list.adapter = adapter
        binding.toolbar.inflateMenu(R.menu.menu_machines)
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_refresh -> { app.agents.refresh(); app.client.reconnectNow("user"); true }
                R.id.action_devices -> { host.openDevices(); true }
                R.id.action_settings -> { host.openSettings(); true }
                R.id.action_help -> { showHelp(); true }
                else -> false
            }
        }
        binding.retryButton.setOnClickListener { app.client.reconnectNow("user") }
        binding.helpButton.setOnClickListener { showHelp() }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.combine(app.client.state) { agents, state -> agents to state }.collect { (agents, state) ->
                    adapter.connection = state
                    adapter.submitList(agents)
                    binding.emptyView.isVisible = agents.isEmpty()
                    binding.list.isVisible = agents.isNotEmpty()
                    renderStatus(state)
                }
            }
        }
    }

    private fun renderStatus(state: RelayClient.ConnectionState) {
        val connected = state is RelayClient.ConnectionState.Connected
        binding.statusBar.isVisible = !connected
        binding.statusText.text = Format.connectionLabel(requireContext(), state)
        binding.statusDot.backgroundTintList = ContextCompat.getColorStateList(requireContext(), Format.connectionColor(state))
        binding.retryButton.isVisible = state is RelayClient.ConnectionState.Reconnecting || state is RelayClient.ConnectionState.Disconnected
    }

    private fun showHelp() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.machines_empty_action)
            .setMessage(R.string.machines_help)
            .setPositiveButton(R.string.ok, null)
            .show()
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }

    /* -------------------------------- list -------------------------------- */

    class MachineAdapter(private val onClick: (AgentInfo) -> Unit) : ListAdapter<AgentInfo, MachineAdapter.VH>(DIFF) {
        var connection: RelayClient.ConnectionState = RelayClient.ConnectionState.Disconnected

        class VH(val b: ItemMachineBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemMachineBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val a = getItem(position)
            val ctx = holder.b.root.context
            holder.b.name.text = a.name
            holder.b.subtitle.text = Format.machineSubtitle(a)
            val (label, color) = Format.presence(ctx, a, connection)
            holder.b.status.text = label
            holder.b.status.setTextColor(ContextCompat.getColor(ctx, color))
            holder.b.dot.backgroundTintList = ContextCompat.getColorStateList(ctx, color)
            val n = a.sessions.count { it.isRunning }
            holder.b.sessions.text = if (a.online && n > 0) ctx.resources.getQuantityString(R.plurals.machine_sessions, n, n) else ""
            holder.b.sessions.isVisible = holder.b.sessions.text.isNotEmpty()
            holder.b.platformIcon.setImageResource(if (a.isWindows) R.drawable.ic_computer else R.drawable.ic_terminal)
            holder.b.platformIcon.contentDescription = a.platform
            holder.b.root.alpha = if (a.online) 1f else 0.72f
            holder.b.root.setOnClickListener { onClick(a) }
        }

        companion object {
            val DIFF = object : DiffUtil.ItemCallback<AgentInfo>() {
                override fun areItemsTheSame(a: AgentInfo, b: AgentInfo) = a.agentId == b.agentId
                override fun areContentsTheSame(a: AgentInfo, b: AgentInfo) = a == b
            }
        }
    }
}
