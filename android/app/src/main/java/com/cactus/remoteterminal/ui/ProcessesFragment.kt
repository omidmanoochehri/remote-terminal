package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.RemoteError
import com.cactus.remoteterminal.databinding.FragmentProcessesBinding
import com.cactus.remoteterminal.databinding.ItemProcessRowBinding
import com.cactus.remoteterminal.protocol.AgentCaps
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.ProcessInfo
import com.cactus.remoteterminal.protocol.ProcessList
import com.cactus.remoteterminal.protocol.Processes
import com.cactus.remoteterminal.ui.design.FilterChips
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What is running on a machine (agent requests `proc.*`), busiest first, with
 * a way to end a process. The list refreshes every few seconds only while the
 * screen is in front; the machine is not asked anything once you leave.
 */
class ProcessesFragment : Fragment(), RtScreen {

    private var _binding: FragmentProcessesBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!

    private var list: ProcessList? = null
    private var sort = Processes.Sort.CPU
    private var filter = ""
    private var error: String? = null
    private lateinit var adapter: Adapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentProcessesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding
        b.headerBar.root.padForStatusBar()
        b.list.padForNavigationBar()
        savedInstanceState?.getString(STATE_SORT)?.let { sort = Processes.Sort.valueOf(it) }

        b.headerBar.headerTitle.setText(R.string.processes_title)
        b.headerBar.backButton.setOnClickListener { requireActivity().onBackPressedDispatcher.onBackPressed() }
        b.headerBar.headerAction.visible = true
        b.headerBar.headerAction.setImageResource(R.drawable.ic_rt_refresh)
        b.headerBar.headerAction.contentDescription = getString(R.string.refresh)
        b.headerBar.headerAction.setOnClickListener { viewLifecycleOwner.lifecycleScope.launch { refresh() } }
        b.headerBar.headerOverflow.visible = false

        b.searchBar.searchInput.setHint(R.string.processes_filter_hint)
        b.searchBar.searchInput.doAfterTextChanged {
            filter = it?.toString() ?: ""
            b.searchBar.searchClear.visible = filter.isNotEmpty()
            render()
        }
        b.searchBar.searchClear.setOnClickListener { b.searchBar.searchInput.setText("") }

        adapter = Adapter { showProcess(it) }
        b.list.layoutManager = LinearLayoutManager(requireContext())
        b.list.adapter = adapter
        b.loading.visible = true
        renderSort()

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.collect { agents ->
                    val agent = agents.firstOrNull { it.agentId == agentId }
                    if (agent == null) { requireActivity().onBackPressedDispatcher.onBackPressed(); return@collect }
                    b.headerBar.headerSubtitle.text = machineName(agent)
                }
            }
        }
        // Poll only while the screen is actually in front.
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (true) {
                    refresh()
                    delay(REFRESH_MS)
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_SORT, sort.name)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private fun agent(): AgentInfo? = app.agents.agent(agentId)
    private fun machineName(a: AgentInfo? = agent()) = a?.let { it.name.ifEmpty { it.hostname } } ?: ""

    private suspend fun refresh() {
        val a = agent()
        error = when {
            a == null || !a.online -> getString(R.string.tool_machine_offline, machineName(a))
            !AgentCaps.processes(app.client.relayCaps, a) -> getString(R.string.tool_processes_unsupported)
            else -> null
        }
        if (error == null) {
            try {
                list = app.remote.processes(agentId)
            } catch (e: RemoteError) {
                error = e.message ?: e.code
            }
        }
        _binding?.loading?.visible = false
        render()
    }

    private fun renderSort() {
        val b = _binding ?: return
        val chips = listOf(
            FilterChips.Chip(Processes.Sort.CPU.name, getString(R.string.processes_sort_cpu)),
            FilterChips.Chip(Processes.Sort.MEMORY.name, getString(R.string.processes_sort_memory)),
            FilterChips.Chip(Processes.Sort.NAME.name, getString(R.string.processes_sort_name)),
        )
        FilterChips.render(b.sortRow, chips, sort.name, onSelect = { id -> sort = Processes.Sort.valueOf(id); renderSort(); render() })
    }

    private fun render() {
        val b = _binding ?: return
        val l = list
        val err = error
        if (err != null && l == null) {
            adapter.submit(emptyList())
            b.countLabel.text = ""
            b.stateBlock.show(
                icon = R.drawable.ic_rt_alert, title = getString(R.string.processes_error_title), body = err,
                actionLabel = R.string.retry_now, actionIcon = R.drawable.ic_rt_refresh, iconTint = R.color.rt_amber,
            ) { viewLifecycleOwner.lifecycleScope.launch { refresh() } }
            return
        }
        if (l == null) return
        val shown = Processes.arrange(l.processes, sort, filter)
        adapter.submit(shown)
        b.countLabel.text = resources.getQuantityString(R.plurals.processes_count, l.total, l.total)
        if (shown.isEmpty() && filter.isNotBlank()) {
            b.stateBlock.show(icon = R.drawable.ic_rt_search, title = getString(R.string.processes_none, filter.trim()), body = "")
        } else b.stateBlock.hide()
    }

    private fun showProcess(p: ProcessInfo) {
        val l = list ?: return
        val refusal = l.refusal(p)?.let {
            when (it) {
                is ProcessList.Refusal.TurnedOff -> getString(R.string.process_kill_off)
                is ProcessList.Refusal.NotOwn -> getString(R.string.process_kill_not_own, it.owner)
            }
        }
        val details = ArrayList<Pair<String, String>>()
        details += getString(R.string.process_pid) to p.pid.toString()
        p.ppid?.let { details += getString(R.string.process_ppid) to it.toString() }
        if (p.user.isNotEmpty()) details += getString(R.string.process_user) to p.user
        details += getString(R.string.process_cpu) to Processes.cpuLabel(p.cpu)
        details += getString(R.string.process_memory) to Format.bytes(p.mem)
        if (p.cmd.isNotEmpty()) details += getString(R.string.process_command) to p.cmd
        ActionSheet.show(
            requireContext(), p.name, null,
            listOf(
                ActionSheet.Item(getString(R.string.process_end), R.drawable.ic_rt_close, danger = true, disabledReason = refusal) { confirmKill(p, force = false) },
                ActionSheet.Item(getString(R.string.process_force_end), R.drawable.ic_rt_alert, danger = true, disabledReason = refusal) { confirmKill(p, force = true) },
            ),
            details,
        )
    }

    private fun confirmKill(p: ProcessInfo, force: Boolean) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.process_end_title, p.name, p.pid))
            .setMessage(if (force) R.string.process_force_body else R.string.process_end_body)
            .setPositiveButton(if (force) R.string.process_force_end else R.string.process_end) { _, _ ->
                viewLifecycleOwner.lifecycleScope.launch {
                    try {
                        app.remote.kill(agentId, p.pid, force)
                        toast(getString(if (force) R.string.process_force_ended else R.string.process_ended, p.name))
                    } catch (e: RemoteError) {
                        toast(e.message ?: e.code)
                    }
                    refresh()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun toast(text: String) {
        val c = context ?: return
        Toast.makeText(c, text, Toast.LENGTH_LONG).show()
    }

    private class Adapter(private val onOpen: (ProcessInfo) -> Unit) : RecyclerView.Adapter<Adapter.VH>() {
        private var items: List<ProcessInfo> = emptyList()

        class VH(val b: ItemProcessRowBinding) : RecyclerView.ViewHolder(b.root)

        fun submit(list: List<ProcessInfo>) { items = list; notifyDataSetChanged() }

        override fun getItemCount() = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemProcessRowBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val p = items[position]
            val ctx = holder.b.root.context
            holder.b.procName.text = p.name
            holder.b.procMeta.text = ctx.getString(R.string.process_meta, p.pid, p.user.ifEmpty { "—" })
            holder.b.procCpu.text = Processes.cpuLabel(p.cpu)
            holder.b.procMem.text = Format.bytes(p.mem)
            holder.b.root.contentDescription = "${p.name}, ${holder.b.procMeta.text}, CPU ${holder.b.procCpu.text}, ${holder.b.procMem.text}"
            holder.b.row.setOnClickListener { onOpen(p) }
        }
    }

    companion object {
        private const val ARG_AGENT = "agent"
        private const val STATE_SORT = "sort"
        private const val REFRESH_MS = 3_000L

        fun newInstance(agentId: String) = ProcessesFragment().apply {
            arguments = Bundle().apply { putString(ARG_AGENT, agentId) }
        }
    }
}
