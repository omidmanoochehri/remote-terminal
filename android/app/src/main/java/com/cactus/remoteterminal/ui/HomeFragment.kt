package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentHomeBinding
import com.cactus.remoteterminal.databinding.ItemMachineHomeBinding
import com.cactus.remoteterminal.databinding.ItemQuickTileBinding
import com.cactus.remoteterminal.databinding.ItemTerminalRowBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.SessionInfo
import com.cactus.remoteterminal.ui.design.BottomNavView
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.bind
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Home. Shows the machines you actually use (favourites first, then the ones
 * with running terminals), the terminals you left behind, and four counts that
 * lead into the rest of the app. Everything here is live account state; there
 * is no separate cache to go stale.
 */
class HomeFragment : Fragment(), RtScreen {
    override val showsBottomNav = true
    override val navDestination = BottomNavView.Destination.HOME

    private var _binding: FragmentHomeBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    /** Home never becomes a wall of cards; the Machines tab is one tap away. */
    private val maxMachines = 3
    private val maxTerminals = 3

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.scroll.padForNavigationBar()

        binding.headerBar.bind(
            title = getString(R.string.app_name),
            subtitle = getString(R.string.app_tagline),
            onSearch = { host.openMachines() },
            onRefresh = { refresh() },
            onOverflow = { anchor -> overflow(anchor) },
        )

        binding.addMachineButton.setOnClickListener { host.openAddMachine() }
        binding.viewAllTerminals.setOnClickListener { host.openTerminalsTab() }
        binding.tipsCard.setOnClickListener {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.tips_help_title)
                .setMessage(R.string.tips_help_body)
                .setPositiveButton(R.string.ok, null)
                .show()
        }
        binding.tipsIconWell.background =
            Design.tintedBackground(requireContext(), R.drawable.rt_circle_soft, Design.withAlpha(Design.color(requireContext(), R.color.rt_amber), 0.10f))

        bindQuickTile(binding.tileMachines, R.drawable.ic_rt_server_cog, R.color.rt_purple, R.string.nav_machines) { host.openMachines() }
        bindQuickTile(binding.tileTerminals, R.drawable.ic_rt_terminal_square, R.color.rt_accent, R.string.nav_terminals) { host.openTerminalsTab() }
        bindQuickTile(binding.tileRecent, R.drawable.ic_rt_clock, R.color.rt_amber, R.string.quick_recent) { host.openTerminalsTab() }
        bindQuickTile(binding.tileFavourites, R.drawable.ic_rt_heart, R.color.rt_danger, R.string.quick_favourites) { host.openMachines() }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents
                    .combine(app.client.state) { agents, state -> agents to state }
                    .combine(app.settings.version) { pair, _ -> pair }
                    .collect { (agents, state) -> render(agents, state) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Cheap and idempotent: makes Home correct straight after a cold start.
        if (app.client.isConnected) app.agents.refresh()
    }

    private fun refresh() {
        app.agents.refresh()
        app.client.reconnectNow("user")
    }

    private fun overflow(anchor: View) {
        val menu = android.widget.PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.setting_paired_phones)
        menu.menu.add(0, 2, 1, R.string.nav_settings)
        menu.menu.add(0, 3, 2, R.string.machines_empty_action)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> host.openDevices()
                2 -> host.openSettings()
                3 -> showAgentHelp()
            }
            true
        }
        menu.show()
    }

    private fun showAgentHelp() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.machines_empty_action)
            .setMessage(R.string.machines_help)
            .setPositiveButton(R.string.ok, null)
            .show()
    }

    /* ------------------------------ rendering ----------------------------- */

    private fun render(agents: List<AgentInfo>, state: RelayClient.ConnectionState) {
        val b = _binding ?: return
        b.banner.bind(state) { refresh() }

        val favourites = app.settings.favouriteMachines
        val ordered = agents.sortedWith(
            compareByDescending<AgentInfo> { it.agentId in favourites }
                .thenByDescending { it.online }
                .thenByDescending { it.runningSessions }
                .thenBy { it.name.lowercase() }
        )

        renderMachines(ordered.take(maxMachines), state)
        renderRecentTerminals(agents)
        renderQuickAccess(agents, favourites)

        val empty = agents.isEmpty()
        b.machinesEmpty.root.visible = empty
        if (empty) {
            if (state is RelayClient.ConnectionState.Connected) {
                b.machinesEmpty.show(
                    icon = R.drawable.ic_rt_monitor,
                    title = getString(R.string.empty_machines_title),
                    body = getString(R.string.empty_machines_body),
                    actionLabel = R.string.machines_add_new,
                ) { host.openAddMachine() }
            } else {
                b.machinesEmpty.show(
                    icon = R.drawable.ic_rt_wifi_off,
                    title = getString(R.string.offline_title),
                    body = getString(R.string.offline_body),
                    actionLabel = R.string.retry_now,
                    actionIcon = R.drawable.ic_rt_refresh,
                ) { refresh() }
            }
        } else {
            b.machinesEmpty.hide()
        }
    }

    private fun renderMachines(machines: List<AgentInfo>, state: RelayClient.ConnectionState) {
        val list = binding.machineList
        list.removeAllViews()
        list.visible = machines.isNotEmpty()
        val inflater = layoutInflater
        for ((index, agent) in machines.withIndex()) {
            val card = ItemMachineHomeBinding.inflate(inflater, list, false)
            bindMachineCard(card, agent, state)
            (card.root.layoutParams as ViewGroup.MarginLayoutParams).topMargin =
                if (index == 0) 0 else Design.dp(requireContext(), 12f)
            list.addView(card.root)
        }
    }

    private fun bindMachineCard(card: ItemMachineHomeBinding, agent: AgentInfo, state: RelayClient.ConnectionState) {
        val context = requireContext()
        card.machineName.text = agent.name.ifEmpty { agent.hostname }
        card.machineSubtitle.text = Format.machineSubtitleFull(agent)
        card.machineIcon.setImageResource(if (agent.isWindows) R.drawable.ic_rt_monitor else R.drawable.ic_rt_terminal_square)
        Design.tint(card.machineIcon, if (agent.online) R.color.rt_primary else R.color.rt_text_muted)
        card.favouriteMark.visible = app.settings.isFavouriteMachine(agent.agentId)

        val (label, colour) = Format.presence(context, agent, state)
        card.statusText.text = label
        card.statusText.setTextColor(Design.color(context, colour))
        card.statusDot.backgroundTintList = Design.stateList(context, colour)

        val running = agent.runningSessions
        card.terminalCount.text =
            if (running > 0) resources.getQuantityString(R.plurals.machine_sessions, running, running) else ""
        card.terminalCount.visible = running > 0
        card.metaDivider.visible = running > 0

        card.identity.setOnClickListener { host.openMachine(agent.agentId) }
        card.machineMenu.setOnClickListener { machineMenu(it, agent) }

        bindQuickAction(card.actionConnect, R.drawable.ic_rt_terminal_square, R.string.action_connect, agent.online) {
            openMostRecentTerminal(agent)
        }
        bindQuickAction(card.actionTerminals, R.drawable.ic_rt_panel_top, R.string.action_terminals, true) {
            host.openMachine(agent.agentId, MachineFragment.Tab.TERMINALS)
        }
        bindQuickAction(card.actionDetails, R.drawable.ic_rt_info, R.string.action_details, true) {
            host.openMachine(agent.agentId, MachineFragment.Tab.DETAILS)
        }
        bindQuickAction(card.actionSettings, R.drawable.ic_rt_settings, R.string.action_settings, true) {
            host.openMachineSettings(agent.agentId)
        }
    }

    private fun bindQuickAction(
        action: com.cactus.remoteterminal.databinding.ViewQuickActionBinding,
        icon: Int,
        label: Int,
        enabled: Boolean,
        onClick: () -> Unit,
    ) {
        action.quickIcon.setImageResource(icon)
        action.quickLabel.setText(label)
        Design.tint(action.quickIcon, if (enabled) R.color.rt_primary else R.color.rt_text_muted)
        action.root.isEnabled = enabled
        action.root.alpha = if (enabled) 1f else 0.45f
        action.root.contentDescription = getString(label)
        action.root.setOnClickListener { if (enabled) onClick() }
    }

    /** "Connect" opens the terminal you used last, or starts one if there is none. */
    private fun openMostRecentTerminal(agent: AgentInfo) {
        val session = agent.sessions.filter { it.isRunning }.maxByOrNull { it.lastActiveAt }
        if (session != null) host.openTerminal(agent.agentId, session.sessionId)
        else host.openNewTerminal(agent.agentId)
    }

    private fun machineMenu(anchor: View, agent: AgentInfo) {
        val favourite = app.settings.isFavouriteMachine(agent.agentId)
        val menu = android.widget.PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, if (favourite) R.string.action_unfavourite else R.string.action_favourite)
        menu.menu.add(0, 2, 1, R.string.action_details)
        menu.menu.add(0, 3, 2, R.string.action_settings)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> app.settings.toggleFavouriteMachine(agent.agentId)
                2 -> host.openMachine(agent.agentId, MachineFragment.Tab.DETAILS)
                3 -> host.openMachineSettings(agent.agentId)
            }
            true
        }
        menu.show()
    }

    private fun renderRecentTerminals(agents: List<AgentInfo>) {
        val card = binding.recentCard
        card.removeAllViews()
        val pinned = app.settings.pinnedTerminals
        val recent = agents
            .flatMap { agent -> agent.sessions.map { agent to it } }
            .sortedWith(
                compareByDescending<Pair<AgentInfo, SessionInfo>> { "${it.first.agentId}|${it.second.sessionId}" in pinned }
                    .thenByDescending { maxOf(it.second.lastActiveAt, it.second.createdAt) }
            )
            .take(maxTerminals)

        binding.recentSection.visible = true
        card.visible = recent.isNotEmpty()
        binding.recentEmpty.visible = recent.isEmpty() && agents.isNotEmpty()

        for ((index, pair) in recent.withIndex()) {
            val (agent, session) = pair
            if (index > 0) {
                val divider = View(requireContext())
                divider.setBackgroundColor(Design.color(requireContext(), R.color.rt_divider))
                card.addView(divider, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
                (divider.layoutParams as ViewGroup.MarginLayoutParams).apply {
                    marginStart = Design.dp(requireContext(), 13f)
                    marginEnd = Design.dp(requireContext(), 13f)
                }
            }
            val row = ItemTerminalRowBinding.inflate(layoutInflater, card, false)
            bindTerminalRow(row, agent, session)
            card.addView(row.root)
        }
    }

    private fun bindTerminalRow(row: ItemTerminalRowBinding, agent: AgentInfo, session: SessionInfo) {
        val context = requireContext()
        row.terminalName.text = Format.terminalTitle(context, session)
        row.terminalMeta.text = Format.terminalMeta(context, session)
        row.pinnedMark.visible = app.settings.isPinnedTerminal(agent.agentId, session.sessionId)

        val open = app.sessions.find(agent.agentId, session.sessionId) != null
        row.terminalBadge.visible = open || session.attached > 0
        row.terminalBadge.setText(if (session.attached > 0) R.string.badge_active else R.string.badge_new)

        row.resumeButton.visible = agent.online && session.isRunning
        row.resumeButton.setOnClickListener { host.openTerminal(agent.agentId, session.sessionId) }
        row.row.setOnClickListener { host.openTerminal(agent.agentId, session.sessionId) }
        row.row.contentDescription = "${row.terminalName.text}, ${agent.name}"
        row.terminalMenu.setOnClickListener { TerminalActions.menu(this, it, agent, session) }
    }

    private fun renderQuickAccess(agents: List<AgentInfo>, favourites: Set<String>) {
        val terminals = agents.sumOf { it.runningSessions }
        val recent = agents.sumOf { agent ->
            agent.sessions.count { System.currentTimeMillis() - maxOf(it.lastActiveAt, it.createdAt) < RECENT_WINDOW_MS }
        }
        val counts = java.text.NumberFormat.getIntegerInstance()
        binding.tileMachines.quickTileValue.text = counts.format(agents.size)
        binding.tileTerminals.quickTileValue.text = counts.format(terminals)
        binding.tileRecent.quickTileValue.text = counts.format(recent)
        binding.tileFavourites.quickTileValue.text = counts.format(favourites.size)
    }

    private fun bindQuickTile(
        tile: ItemQuickTileBinding,
        icon: Int,
        colour: Int,
        label: Int,
        onClick: () -> Unit,
    ) {
        tile.quickTileIcon.setImageResource(icon)
        Design.tint(tile.quickTileIcon, colour)
        tile.quickTileLabel.setText(label)
        tile.root.setOnClickListener { onClick() }
        tile.root.contentDescription = getString(label)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private companion object {
        /** "Recent" on the quick-access row means "used in the last day". */
        const val RECENT_WINDOW_MS = 24 * 60 * 60 * 1000L
    }
}
