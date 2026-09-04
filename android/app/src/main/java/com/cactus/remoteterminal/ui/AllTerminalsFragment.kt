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
import com.cactus.remoteterminal.databinding.FragmentAllTerminalsBinding
import com.cactus.remoteterminal.databinding.ItemNoteFooterBinding
import com.cactus.remoteterminal.databinding.ItemTerminalGroupBinding
import com.cactus.remoteterminal.databinding.ItemTerminalGroupHeaderBinding
import com.cactus.remoteterminal.databinding.ItemTerminalRowBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.SessionInfo
import com.cactus.remoteterminal.ui.design.BottomNavView
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.FilterChips
import com.cactus.remoteterminal.ui.design.bind
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Every terminal on the account, grouped by machine. Sessions live on the
 * agents, so this list is what the relay reports plus the tabs this phone
 * happens to have open — nothing is invented locally.
 */
class AllTerminalsFragment : Fragment(), RtScreen {
    override val showsBottomNav = true
    override val navDestination = BottomNavView.Destination.TERMINALS

    private var _binding: FragmentAllTerminalsBinding? = null
    private val binding get() = _binding!!
    internal val app get() = requireActivity().application as App
    internal val host get() = requireActivity() as MainActivity

    private lateinit var adapter: GroupAdapter
    private var query = ""
    private var filter = FILTER_ALL
    private var agents: List<AgentInfo> = emptyList()
    private var connection: RelayClient.ConnectionState = RelayClient.ConnectionState.Disconnected

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentAllTerminalsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.list.padForNavigationBar()
        Design.excludeFromAutofill(view)

        binding.headerBar.bind(
            title = getString(R.string.nav_terminals),
            subtitle = getString(R.string.terminals_subtitle),
            onSearch = { focusSearch() },
            onRefresh = { refresh() },
            onOverflow = { anchor -> overflow(anchor) },
        )

        binding.searchBar.searchInput.hint = getString(R.string.terminals_search_hint)
        binding.searchBar.searchInput.doAfterTextChanged { text ->
            query = text?.toString().orEmpty()
            binding.searchBar.searchClear.visible = query.isNotEmpty()
            render()
        }
        binding.searchBar.searchInput.setOnEditorActionListener { v, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) { v.clearFocus(); true } else false
        }
        binding.searchBar.searchClear.setOnClickListener { binding.searchBar.searchInput.setText("") }

        adapter = GroupAdapter(this)
        binding.list.layoutManager = LinearLayoutManager(requireContext())
        binding.list.adapter = adapter
        binding.list.itemAnimator = null

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents
                    .combine(app.client.state) { list, state -> list to state }
                    .combine(app.settings.version) { pair, _ -> pair }
                    .collect { (list, state) ->
                        agents = list
                        connection = state
                        binding.banner.bind(state) { refresh() }
                        renderFilters()
                        render()
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
        requireContext().getSystemService(android.view.inputmethod.InputMethodManager::class.java)
            ?.showSoftInput(binding.searchBar.searchInput, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
    }

    private fun overflow(anchor: View) {
        val menu = android.widget.PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.new_terminal)
        menu.menu.add(0, 2, 1, R.string.nav_machines)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> host.openNewTerminal(null)
                2 -> host.openMachines()
            }
            true
        }
        menu.show()
    }

    private fun renderFilters() {
        val all = agents.flatMap { it.sessions }
        val active = all.count { it.isRunning && it.attached > 0 }
        val detached = all.count { it.isRunning && it.attached == 0 }
        FilterChips.render(
            row = binding.filterRow,
            chips = listOf(
                FilterChips.Chip(FILTER_ALL, getString(R.string.filter_all), all.size),
                FilterChips.Chip(FILTER_ACTIVE, getString(R.string.filter_active), active),
                FilterChips.Chip(FILTER_DETACHED, getString(R.string.filter_detached), detached),
                FilterChips.Chip(FILTER_PINNED, getString(R.string.filter_pinned)),
            ),
            selectedId = filter,
            onSelect = { id -> filter = id; renderFilters(); render() },
        )
    }

    /* ------------------------------ grouping ------------------------------ */

    sealed class Row {
        data class Header(val agent: AgentInfo) : Row()
        data class Group(val agent: AgentInfo, val sessions: List<SessionInfo>) : Row()
        data class Note(val secure: Boolean) : Row()
    }

    private fun buildRows(): List<Row> {
        val needle = query.trim().lowercase()
        val pinned = app.settings.pinnedTerminals
        val rows = ArrayList<Row>()
        for (agent in agents.sortedWith(compareByDescending<AgentInfo> { it.online }.thenBy { it.name.lowercase() })) {
            var sessions = agent.sessions
            if (needle.isNotEmpty()) {
                sessions = sessions.filter {
                    it.title.lowercase().contains(needle) ||
                        it.shell.lowercase().contains(needle) ||
                        agent.name.lowercase().contains(needle)
                }
            }
            sessions = when (filter) {
                FILTER_ACTIVE -> sessions.filter { it.isRunning && it.attached > 0 }
                FILTER_DETACHED -> sessions.filter { it.isRunning && it.attached == 0 }
                FILTER_PINNED -> sessions.filter { "${agent.agentId}|${it.sessionId}" in pinned }
                else -> sessions
            }
            if (sessions.isEmpty()) continue
            rows.add(Row.Header(agent))
            rows.add(
                Row.Group(
                    agent,
                    sessions.sortedWith(
                        compareByDescending<SessionInfo> { "${agent.agentId}|${it.sessionId}" in pinned }
                            .thenByDescending { maxOf(it.lastActiveAt, it.createdAt) }
                    )
                )
            )
        }
        if (rows.isNotEmpty()) rows.add(Row.Note(Format.isSecureRelay(app.credentials.relayUrl)))
        return rows
    }

    private fun render() {
        val b = _binding ?: return
        val rows = buildRows()
        adapter.submit(rows, connection)
        b.list.visible = rows.isNotEmpty()

        val anySession = agents.any { it.sessions.isNotEmpty() }
        when {
            rows.isNotEmpty() -> b.stateBlock.hide()
            query.isNotEmpty() -> b.stateBlock.show(
                icon = R.drawable.ic_rt_search,
                title = getString(R.string.empty_search_title),
                body = getString(R.string.empty_search_body, query),
                actionLabel = R.string.clear_search,
                actionIcon = R.drawable.ic_rt_close,
            ) { b.searchBar.searchInput.setText("") }
            anySession -> b.stateBlock.show(
                icon = R.drawable.ic_rt_sliders,
                title = getString(R.string.empty_filter_title),
                body = getString(R.string.empty_filter_body),
                actionLabel = R.string.filter_all,
                actionIcon = R.drawable.ic_rt_check,
            ) { filter = FILTER_ALL; renderFilters(); render() }
            connection !is RelayClient.ConnectionState.Connected -> b.stateBlock.show(
                icon = R.drawable.ic_rt_wifi_off,
                title = getString(R.string.offline_title),
                body = getString(R.string.offline_body),
                actionLabel = R.string.retry_now,
                actionIcon = R.drawable.ic_rt_refresh,
            ) { refresh() }
            else -> b.stateBlock.show(
                icon = R.drawable.ic_rt_terminal_square,
                title = getString(R.string.empty_terminals_title),
                body = getString(R.string.empty_terminals_body),
                actionLabel = R.string.new_terminal,
            ) { host.openNewTerminal(null) }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    /* ------------------------------- adapter ------------------------------ */

    class GroupAdapter(private val fragment: AllTerminalsFragment) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        private var rows: List<Row> = emptyList()
        private var connection: RelayClient.ConnectionState = RelayClient.ConnectionState.Disconnected

        class HeaderVH(val b: ItemTerminalGroupHeaderBinding) : RecyclerView.ViewHolder(b.root)
        class GroupVH(val b: ItemTerminalGroupBinding) : RecyclerView.ViewHolder(b.root)
        class NoteVH(val b: ItemNoteFooterBinding) : RecyclerView.ViewHolder(b.root)

        fun submit(list: List<Row>, state: RelayClient.ConnectionState) {
            rows = list
            connection = state
            notifyDataSetChanged()
        }

        override fun getItemCount() = rows.size

        override fun getItemViewType(position: Int) = when (rows[position]) {
            is Row.Header -> TYPE_HEADER
            is Row.Group -> TYPE_GROUP
            is Row.Note -> TYPE_NOTE
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            val inflater = LayoutInflater.from(parent.context)
            return when (viewType) {
                TYPE_HEADER -> HeaderVH(ItemTerminalGroupHeaderBinding.inflate(inflater, parent, false))
                TYPE_GROUP -> GroupVH(ItemTerminalGroupBinding.inflate(inflater, parent, false))
                else -> NoteVH(ItemNoteFooterBinding.inflate(inflater, parent, false))
            }
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            when (val row = rows[position]) {
                is Row.Header -> {
                    val b = (holder as HeaderVH).b
                    val context = b.root.context
                    b.groupName.text = row.agent.name.ifEmpty { row.agent.hostname }
                    val (label, colour) = Format.presence(context, row.agent, connection)
                    b.groupStatus.text = label
                    b.groupStatus.setTextColor(Design.color(context, colour))
                    (b.root.layoutParams as ViewGroup.MarginLayoutParams).topMargin =
                        if (position == 0) 0 else Design.dp(context, 18f)
                    b.root.setOnClickListener { fragment.host.openMachine(row.agent.agentId) }
                    b.root.contentDescription = "${b.groupName.text}, ${b.groupStatus.text}"
                }
                is Row.Group -> {
                    val b = (holder as GroupVH).b
                    val context = b.root.context
                    b.groupCard.removeAllViews()
                    for ((index, session) in row.sessions.withIndex()) {
                        if (index > 0) {
                            val divider = View(context)
                            divider.setBackgroundColor(Design.color(context, R.color.rt_divider))
                            b.groupCard.addView(
                                divider,
                                ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
                                    marginStart = Design.dp(context, 13f)
                                    marginEnd = Design.dp(context, 13f)
                                }
                            )
                        }
                        val rowBinding = ItemTerminalRowBinding.inflate(
                            LayoutInflater.from(context), b.groupCard, false
                        )
                        fragment.bindRow(rowBinding, row.agent, session)
                        b.groupCard.addView(rowBinding.root)
                    }
                }
                is Row.Note -> {
                    val b = (holder as NoteVH).b
                    val context = b.root.context
                    if (row.secure) {
                        b.note.noteIcon.setImageResource(R.drawable.ic_rt_shield)
                        Design.tint(b.note.noteIcon, R.color.rt_primary)
                        b.note.noteIconWell.backgroundTintList = Design.stateList(context, R.color.rt_primary_edge)
                        b.note.noteTitle.setText(R.string.terminals_encrypted_title)
                        b.note.noteBody.setText(R.string.terminals_encrypted_body)
                    } else {
                        b.note.noteIcon.setImageResource(R.drawable.ic_rt_alert)
                        Design.tint(b.note.noteIcon, R.color.rt_status_warn)
                        b.note.noteIconWell.backgroundTintList = Design.stateList(context, R.color.rt_status_warn)
                        b.note.noteTitle.setText(R.string.terminals_insecure_title)
                        b.note.noteBody.setText(R.string.terminals_insecure_body)
                    }
                }
            }
        }

        private companion object {
            const val TYPE_HEADER = 0
            const val TYPE_GROUP = 1
            const val TYPE_NOTE = 2
        }
    }

    internal fun bindRow(row: ItemTerminalRowBinding, agent: AgentInfo, session: SessionInfo) {
        val context = requireContext()
        row.terminalName.text = Format.terminalTitle(context, session)
        row.terminalMeta.text = Format.terminalMeta(context, session)
        row.pinnedMark.visible = app.settings.isPinnedTerminal(agent.agentId, session.sessionId)
        row.terminalBadge.visible = session.attached > 0
        row.terminalBadge.setText(R.string.badge_active)
        row.resumeButton.visible = agent.online && session.isRunning
        row.resumeButton.setOnClickListener { host.openTerminal(agent.agentId, session.sessionId) }
        row.row.setOnClickListener { host.openTerminal(agent.agentId, session.sessionId) }
        row.row.contentDescription = "${row.terminalName.text}, ${row.terminalMeta.text}"
        row.terminalMenu.setOnClickListener { TerminalActions.menu(this, it, agent, session) }
    }

    companion object {
        private const val FILTER_ALL = "all"
        private const val FILTER_ACTIVE = "active"
        private const val FILTER_DETACHED = "detached"
        private const val FILTER_PINNED = "pinned"
    }
}
