package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.databinding.FragmentMachinesBinding
import com.cactus.remoteterminal.databinding.ItemAddMachineFooterBinding
import com.cactus.remoteterminal.databinding.ItemMachineBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.ui.design.BottomNavView
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.FilterChips
import com.cactus.remoteterminal.ui.design.bind
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The machines list: search, presence filters, and one card per machine
 * carrying the facts that decide whether you can work on it right now
 * (terminals, agent version, latency) plus a single primary action.
 */
class MachinesFragment : Fragment(), RtScreen {
    override val showsBottomNav = true
    override val navDestination = BottomNavView.Destination.MACHINES

    private var _binding: FragmentMachinesBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    private lateinit var adapter: MachineAdapter
    private var query: String = ""
    private var filter: String = FILTER_ALL
    private var agents: List<AgentInfo> = emptyList()
    private var connection: RelayClient.ConnectionState = RelayClient.ConnectionState.Disconnected
    private var everLoaded = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentMachinesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.list.padForNavigationBar()
        Design.excludeFromAutofill(view)

        binding.headerBar.bind(
            title = getString(R.string.nav_machines),
            subtitle = getString(R.string.machines_subtitle),
            onSearch = { focusSearch() },
            onRefresh = { refresh() },
            onOverflow = { anchor -> overflow(anchor) },
        )

        binding.searchBar.searchInput.hint = getString(R.string.machines_search_hint)
        binding.searchBar.searchInput.doAfterTextChanged { text ->
            query = text?.toString().orEmpty()
            binding.searchBar.searchClear.visible = query.isNotEmpty()
            renderList()
        }
        binding.searchBar.searchInput.setOnEditorActionListener { v, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) { v.clearFocus(); hideKeyboard(v); true } else false
        }
        binding.searchBar.searchClear.setOnClickListener {
            binding.searchBar.searchInput.setText("")
        }

        adapter = MachineAdapter(
            onOpen = { host.openMachine(it.agentId) },
            onPrimary = { connect(it) },
            onMenu = { agent, anchor -> machineMenu(anchor, agent) },
            onAdd = { host.openAddMachine() },
            latency = { app.client.latencyMs.value },
            isFavourite = { app.settings.isFavouriteMachine(it) },
        )
        binding.list.layoutManager = LinearLayoutManager(requireContext())
        binding.list.adapter = adapter
        binding.list.itemAnimator = null

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents
                    .combine(app.client.state) { list, state -> list to state }
                    .combine(app.settings.version) { pair, _ -> pair }
                    .combine(app.client.latencyMs) { pair, _ -> pair }
                    .collect { (list, state) ->
                        agents = list
                        connection = state
                        if (state is RelayClient.ConnectionState.Connected) everLoaded = true
                        binding.banner.bind(state) { refresh() }
                        renderFilters()
                        renderList()
                    }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (app.client.isConnected) app.agents.refresh()
    }

    private fun refresh() {
        app.agents.refresh()
        app.client.reconnectNow("user")
    }

    private fun focusSearch() {
        binding.searchBar.searchInput.requestFocus()
        val imm = requireContext().getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        imm?.showSoftInput(binding.searchBar.searchInput, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideKeyboard(view: View) {
        val imm = requireContext().getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        imm?.hideSoftInputFromWindow(view.windowToken, 0)
    }

    /* ------------------------------- filters ------------------------------ */

    private fun renderFilters() {
        val online = agents.count { it.online }
        FilterChips.render(
            row = binding.filterRow,
            chips = listOf(
                FilterChips.Chip(FILTER_ALL, getString(R.string.filter_all), agents.size),
                FilterChips.Chip(FILTER_ONLINE, getString(R.string.filter_online), online),
                FilterChips.Chip(FILTER_OFFLINE, getString(R.string.filter_offline), agents.size - online),
                FilterChips.Chip(FILTER_SORT, getString(R.string.filter_filters), icon = R.drawable.ic_rt_sliders),
            ),
            selectedId = filter,
            onSelect = { id -> filter = id; renderFilters(); renderList() },
            onAction = { _, anchor -> sortMenu(anchor) },
        )
    }

    private fun sortMenu(anchor: View) {
        val menu = android.widget.PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.sort_status)
        menu.menu.add(0, 2, 1, R.string.sort_name)
        menu.menu.add(0, 3, 2, R.string.sort_recent)
        menu.menu.setGroupCheckable(0, true, true)
        val current = app.settings.machineSort
        menu.menu.getItem(
            when (current) { Settings.SORT_NAME -> 1; Settings.SORT_RECENT -> 2; else -> 0 }
        ).isChecked = true
        menu.setOnMenuItemClickListener { item ->
            app.settings.machineSort = when (item.itemId) {
                2 -> Settings.SORT_NAME
                3 -> Settings.SORT_RECENT
                else -> Settings.SORT_STATUS
            }
            renderList()
            true
        }
        menu.show()
    }

    private fun overflow(anchor: View) {
        val menu = android.widget.PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.machines_add_new)
        menu.menu.add(0, 2, 1, R.string.setting_paired_phones)
        menu.menu.add(0, 3, 2, R.string.machines_empty_action)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> host.openAddMachine()
                2 -> host.openDevices()
                3 -> MaterialAlertDialogBuilder(requireContext())
                    .setTitle(R.string.machines_empty_action)
                    .setMessage(R.string.machines_help)
                    .setPositiveButton(R.string.ok, null)
                    .show()
            }
            true
        }
        menu.show()
    }

    /* -------------------------------- list -------------------------------- */

    private fun visibleMachines(): List<AgentInfo> {
        val needle = query.trim().lowercase()
        val favourites = app.settings.favouriteMachines
        var list = agents
        if (needle.isNotEmpty()) {
            list = list.filter { agent ->
                agent.name.lowercase().contains(needle) ||
                    agent.hostname.lowercase().contains(needle) ||
                    agent.os.lowercase().contains(needle) ||
                    agent.platform.lowercase().contains(needle)
            }
        }
        list = when (filter) {
            FILTER_ONLINE -> list.filter { it.online }
            FILTER_OFFLINE -> list.filterNot { it.online }
            else -> list
        }
        val comparator = when (app.settings.machineSort) {
            Settings.SORT_NAME -> compareBy<AgentInfo> { it.name.lowercase() }
            Settings.SORT_RECENT -> compareByDescending { it.lastSeen ?: 0L }
            else -> compareByDescending<AgentInfo> { it.online }.thenBy { it.name.lowercase() }
        }
        return list.sortedWith(compareByDescending<AgentInfo> { it.agentId in favourites }.then(comparator))
    }

    private fun renderList() {
        val b = _binding ?: return
        val list = visibleMachines()
        adapter.connection = connection
        adapter.submit(list)

        val loading = agents.isEmpty() && !everLoaded &&
            (connection is RelayClient.ConnectionState.Connecting || connection is RelayClient.ConnectionState.Disconnected)
        b.loadingBlock.visible = loading
        b.list.visible = !loading && list.isNotEmpty()

        when {
            loading -> b.stateBlock.hide()
            list.isNotEmpty() -> b.stateBlock.hide()
            query.isNotEmpty() -> b.stateBlock.show(
                icon = R.drawable.ic_rt_search,
                title = getString(R.string.empty_search_title),
                body = getString(R.string.empty_search_body, query),
                actionLabel = R.string.clear_search,
                actionIcon = R.drawable.ic_rt_close,
            ) { b.searchBar.searchInput.setText("") }
            agents.isNotEmpty() -> b.stateBlock.show(
                icon = R.drawable.ic_rt_sliders,
                title = getString(R.string.empty_filter_title),
                body = getString(R.string.empty_filter_body),
                actionLabel = R.string.filter_all,
                actionIcon = R.drawable.ic_rt_check,
            ) { filter = FILTER_ALL; renderFilters(); renderList() }
            connection !is RelayClient.ConnectionState.Connected -> b.stateBlock.show(
                icon = R.drawable.ic_rt_wifi_off,
                title = getString(R.string.offline_title),
                body = getString(R.string.offline_body),
                actionLabel = R.string.retry_now,
                actionIcon = R.drawable.ic_rt_refresh,
            ) { refresh() }
            else -> b.stateBlock.show(
                icon = R.drawable.ic_rt_monitor,
                title = getString(R.string.empty_machines_title),
                body = getString(R.string.empty_machines_body),
                actionLabel = R.string.machines_add_new,
            ) { host.openAddMachine() }
        }
    }

    /** The primary action: resume the newest terminal, or start the first one. */
    private fun connect(agent: AgentInfo) {
        if (!agent.online) return
        val session = agent.sessions.filter { it.isRunning }.maxByOrNull { it.lastActiveAt }
        if (session != null) host.openTerminal(agent.agentId, session.sessionId)
        else host.openNewTerminal(agent.agentId)
    }

    private fun machineMenu(anchor: View, agent: AgentInfo) {
        MachineActions.menu(this, anchor, agent)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    /* ------------------------------- adapter ------------------------------ */

    class MachineAdapter(
        private val onOpen: (AgentInfo) -> Unit,
        private val onPrimary: (AgentInfo) -> Unit,
        private val onMenu: (AgentInfo, View) -> Unit,
        private val onAdd: () -> Unit,
        private val latency: () -> Int?,
        private val isFavourite: (String) -> Boolean,
    ) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

        private var items: List<AgentInfo> = emptyList()
        var connection: RelayClient.ConnectionState = RelayClient.ConnectionState.Disconnected

        class MachineVH(val b: ItemMachineBinding) : RecyclerView.ViewHolder(b.root)
        class FooterVH(val b: ItemAddMachineFooterBinding) : RecyclerView.ViewHolder(b.root)

        fun submit(list: List<AgentInfo>) {
            items = list
            notifyDataSetChanged()
        }

        override fun getItemCount() = if (items.isEmpty()) 0 else items.size + 1

        override fun getItemViewType(position: Int) = if (position == items.size) TYPE_FOOTER else TYPE_MACHINE

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            val inflater = LayoutInflater.from(parent.context)
            return if (viewType == TYPE_FOOTER) FooterVH(ItemAddMachineFooterBinding.inflate(inflater, parent, false))
            else MachineVH(ItemMachineBinding.inflate(inflater, parent, false))
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            if (holder is FooterVH) {
                holder.b.addMachineButton.setOnClickListener { onAdd() }
                return
            }
            val vh = holder as MachineVH
            val b = vh.b
            val context = b.root.context
            val agent = items[position]

            val margin = Design.dp(context, 16f)
            (b.root.layoutParams as ViewGroup.MarginLayoutParams).apply {
                marginStart = margin
                marginEnd = margin
                topMargin = if (position == 0) 0 else Design.dp(context, 13f)
            }

            b.machineName.text = agent.name.ifEmpty { agent.hostname }
            b.machineSubtitle.text = Format.machineSubtitleFull(agent)
            b.machineIcon.setImageResource(if (agent.isWindows) R.drawable.ic_rt_monitor else R.drawable.ic_rt_server)
            Design.tint(b.machineIcon, if (agent.online) R.color.rt_primary else R.color.rt_text_muted)
            b.favouriteMark.visible = isFavourite(agent.agentId)

            val (label, colour) = Format.presenceDetail(context, agent, connection)
            b.statusText.text = label
            b.statusText.setTextColor(Design.color(context, colour))
            b.statusDot.backgroundTintList = Design.stateList(context, colour)

            b.statTerminals.statCaption.setText(R.string.stat_terminals)
            b.statTerminals.statValue.text = context.resources.getQuantityString(R.plurals.stat_active_count, agent.runningSessions, agent.runningSessions)
            b.statTerminals.statValue.setTextColor(Design.color(context, R.color.rt_text))

            b.statAgent.statCaption.setText(R.string.stat_agent)
            b.statAgent.statValue.text =
                if (agent.agentVersion.isNotEmpty()) context.getString(R.string.stat_version, agent.agentVersion)
                else context.getString(R.string.value_unknown)
            b.statAgent.statValue.setTextColor(Design.color(context, R.color.rt_text))

            // Online machines show the measured relay round-trip; offline ones
            // show uptime when the agent reports it, and a dash when it does not.
            if (agent.online) {
                val ms = latency()
                b.statThird.statCaption.setText(R.string.stat_latency)
                b.statThird.statValue.text =
                    if (ms != null) context.getString(R.string.stat_latency_ms, ms) else context.getString(R.string.value_unknown)
                b.statThird.statValue.setTextColor(Design.color(context, if (ms != null) R.color.rt_primary else R.color.rt_text_muted))
            } else {
                b.statThird.statCaption.setText(R.string.stat_uptime)
                val uptime = agent.metrics.uptimeSec
                b.statThird.statValue.text =
                    if (uptime != null) Format.duration(context, uptime) else context.getString(R.string.value_unknown)
                b.statThird.statValue.setTextColor(Design.color(context, R.color.rt_text))
            }

            if (agent.online) {
                b.primaryAction.isEnabled = true
                b.primaryAction.background = androidx.core.content.ContextCompat.getDrawable(context, R.drawable.rt_cta_bg)
                b.primaryActionIcon.setImageResource(R.drawable.ic_rt_terminal_square)
                Design.tint(b.primaryActionIcon, R.color.rt_on_primary)
                b.primaryActionLabel.setText(R.string.action_connect)
                b.primaryActionLabel.setTextColor(Design.color(context, R.color.rt_on_primary))
                b.primaryAction.setOnClickListener { onPrimary(agent) }
            } else {
                b.primaryAction.isEnabled = false
                b.primaryAction.background = androidx.core.content.ContextCompat.getDrawable(context, R.drawable.rt_button_disabled_flat)
                b.primaryActionIcon.setImageResource(R.drawable.ic_rt_wifi_off)
                Design.tint(b.primaryActionIcon, R.color.rt_text_muted)
                b.primaryActionLabel.setText(R.string.action_unavailable)
                b.primaryActionLabel.setTextColor(Design.color(context, R.color.rt_text_muted))
                b.primaryAction.setOnClickListener(null)
            }
            b.primaryAction.contentDescription = "${b.primaryActionLabel.text}, ${b.machineName.text}"

            b.identity.setOnClickListener { onOpen(agent) }
            b.machineMenu.setOnClickListener { onMenu(agent, it) }
        }

        private companion object {
            const val TYPE_MACHINE = 0
            const val TYPE_FOOTER = 1
        }
    }

    companion object {
        private const val FILTER_ALL = "all"
        private const val FILTER_ONLINE = "online"
        private const val FILTER_OFFLINE = "offline"
        private const val FILTER_SORT = "sort"
    }
}
