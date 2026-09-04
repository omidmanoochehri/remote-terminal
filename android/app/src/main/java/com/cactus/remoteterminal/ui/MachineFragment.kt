package com.cactus.remoteterminal.ui

import android.graphics.Typeface
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
import com.cactus.remoteterminal.databinding.FragmentMachineBinding
import com.cactus.remoteterminal.databinding.ItemTerminalCardBinding
import com.cactus.remoteterminal.databinding.ViewInfoRowBinding
import com.cactus.remoteterminal.databinding.ViewMetricTileBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.SessionInfo
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.FilterChips
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * One machine, with its terminals and its details behind a segmented control.
 * The third segment (Settings) is a page of its own in the design, so it
 * pushes [MachineSettingsFragment] and springs back to the previous segment.
 */
class MachineFragment : Fragment(), RtScreen {

    enum class Tab { TERMINALS, DETAILS }

    private var _binding: FragmentMachineBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!

    private var tab: Tab = Tab.TERMINALS
    private var agent: AgentInfo? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentMachineBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.terminalsScroll.padForNavigationBar()
        binding.detailsScroll.padForNavigationBar()
        binding.newTerminalButton.padForNavigationBar()

        tab = savedInstanceState?.getString(STATE_TAB)?.let { Tab.valueOf(it) }
            ?: requireArguments().getString(ARG_TAB)?.let { Tab.valueOf(it) }
            ?: Tab.TERMINALS

        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        binding.headerBar.headerOverflow.setOnClickListener { anchor ->
            agent?.let { MachineActions.menu(this, anchor, it) }
        }
        binding.headerBar.headerAction.visible = true
        binding.headerBar.headerAction.setOnClickListener { toggleFavourite() }

        binding.tabs.tabTerminals.setOnClickListener { selectTab(Tab.TERMINALS) }
        binding.tabs.tabDetails.setOnClickListener { selectTab(Tab.DETAILS) }
        binding.tabs.tabSettings.setOnClickListener {
            // Machine settings is its own screen; the segment bounces back so
            // returning here does not leave a segment selected that shows nothing.
            renderTabs()
            host.openMachineSettings(agentId)
        }

        binding.newTerminalButton.setOnClickListener { host.openNewTerminal(agentId) }
        binding.heroCard.root.setOnClickListener { selectTab(Tab.DETAILS) }

        selectTab(tab)

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents
                    .combine(app.client.state) { agents, state -> agents.firstOrNull { it.agentId == agentId } to state }
                    .combine(app.settings.version) { pair, _ -> pair }
                    .combine(app.client.latencyMs) { pair, _ -> pair }
                    .collect { (found, state) ->
                        if (found == null) {
                            // Removed elsewhere (another phone, or the relay): do not linger on a dead screen.
                            host.onBackPressedDispatcher.onBackPressed()
                            return@collect
                        }
                        agent = found
                        render(found, state)
                    }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_TAB, tab.name)
    }

    private fun toggleFavourite() {
        val added = app.settings.toggleFavouriteMachine(agentId)
        binding.headerBar.headerAction.contentDescription =
            getString(if (added) R.string.action_unfavourite else R.string.action_favourite)
        renderFavourite()
    }

    /**
     * Terminals is "the machine"; Details is "Machine details" with the machine
     * as its subtitle, matching the two reference screens.
     */
    private fun renderHeader() {
        val a = agent ?: return
        val name = a.name.ifEmpty { a.hostname }
        if (tab == Tab.DETAILS) {
            binding.headerBar.headerTitle.setText(R.string.machine_details_title)
            binding.headerBar.headerSubtitle.text = name
        } else {
            binding.headerBar.headerTitle.text = name
            binding.headerBar.headerSubtitle.text = Format.machineSubtitle(a)
        }
    }

    private fun renderFavourite() {
        val favourite = app.settings.isFavouriteMachine(agentId)
        binding.headerBar.headerAction.imageTintList =
            Design.stateList(requireContext(), if (favourite) R.color.rt_amber else R.color.rt_text_secondary)
        binding.headerBar.headerAction.contentDescription =
            getString(if (favourite) R.string.action_unfavourite else R.string.action_favourite)
    }

    private fun selectTab(next: Tab) {
        tab = next
        renderTabs()
        renderHeader()
        binding.terminalsScroll.visible = next == Tab.TERMINALS
        binding.detailsScroll.visible = next == Tab.DETAILS
        binding.newTerminalButton.visible = next == Tab.TERMINALS
    }

    private fun renderTabs() {
        val items = listOf(
            binding.tabs.tabTerminals to (tab == Tab.TERMINALS),
            binding.tabs.tabDetails to (tab == Tab.DETAILS),
            binding.tabs.tabSettings to false,
        )
        for ((view, active) in items) {
            view.isSelected = active
            view.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            view.setTextColor(Design.color(requireContext(), if (active) R.color.rt_primary else R.color.rt_text_muted))
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                view.stateDescription =
                    getString(if (active) R.string.a11y_selected else R.string.a11y_not_selected)
            }
        }
    }

    /* ------------------------------ rendering ----------------------------- */

    private fun render(agent: AgentInfo, state: RelayClient.ConnectionState) {
        val context = requireContext()
        renderHeader()
        renderFavourite()

        val hero = binding.heroCard
        val (label, colour) = Format.presence(context, agent, state)
        hero.heroStatus.text = label
        hero.heroStatus.setTextColor(Design.color(context, colour))
        hero.heroDot.backgroundTintList = Design.stateList(context, colour)
        hero.heroName.text = agent.hostname.ifEmpty { agent.name }
        hero.heroOs.text = listOf(agent.os, agent.arch).filter { it.isNotEmpty() }.joinToString("  •  ")
        hero.heroAgent.text =
            if (agent.agentVersion.isNotEmpty()) getString(R.string.agent_version_short, agent.agentVersion) else ""
        hero.heroIcon.setImageResource(if (agent.isWindows) R.drawable.ic_rt_monitor else R.drawable.ic_rt_server)
        Design.tint(hero.heroIcon, if (agent.online) R.color.rt_primary else R.color.rt_text_muted)

        renderPresets(agent)
        renderTerminals(agent)
        renderDetails(agent, state)

        binding.newTerminalButton.isEnabled = agent.online
        binding.newTerminalButton.alpha = if (agent.online) 1f else 0.5f
    }

    /**
     * The presets that can run here, as chips above the list. The last chip
     * opens the presets screen, so this row is also how they are managed.
     */
    private fun renderPresets(agent: AgentInfo) {
        val presets = app.settings.presetsFor(agent.agentId)
        binding.presetScroll.visible = presets.isNotEmpty()
        if (presets.isEmpty()) return
        val chips = presets.map { FilterChips.Chip(id = it.id, label = it.name, icon = R.drawable.ic_rt_bookmark) } +
            FilterChips.Chip(id = CHIP_MANAGE, label = getString(R.string.presets_manage), icon = R.drawable.ic_rt_settings)
        FilterChips.render(
            row = binding.presetRow,
            chips = chips,
            selectedId = "",
            onSelect = { },
            onAction = { id, _ ->
                if (id == CHIP_MANAGE) host.openTerminalPresets()
                else app.settings.preset(id)?.let { TerminalStarter.launch(this, it, agent.agentId) }
            },
        )
    }

    private fun renderTerminals(agent: AgentInfo) {
        val list = binding.terminalList
        list.removeAllViews()
        val sessions = agent.sessions.sortedByDescending { maxOf(it.lastActiveAt, it.createdAt) }

        for ((index, session) in sessions.withIndex()) {
            val card = ItemTerminalCardBinding.inflate(layoutInflater, list, false)
            bindTerminalCard(card, agent, session)
            (card.root.layoutParams as ViewGroup.MarginLayoutParams).topMargin =
                if (index == 0) 0 else Design.dp(requireContext(), 10f)
            list.addView(card.root)
        }

        val running = agent.runningSessions
        binding.sessionsNoteHolder.visible = sessions.isNotEmpty()
        if (sessions.isNotEmpty()) {
            val note = binding.sessionsNote
            note.noteIcon.setImageResource(R.drawable.ic_rt_command)
            Design.tint(note.noteIcon, R.color.rt_accent)
            note.noteIconWell.backgroundTintList = Design.stateList(requireContext(), R.color.rt_accent)
            note.noteTitle.text = resources.getQuantityString(R.plurals.machine_sessions_note_title, running, running)
            note.noteBody.setText(R.string.machine_sessions_note_body)
        }

        if (sessions.isEmpty()) {
            if (agent.online) {
                binding.terminalsEmpty.show(
                    icon = R.drawable.ic_rt_terminal_square,
                    title = getString(R.string.empty_terminals_title),
                    body = getString(R.string.empty_terminals_body),
                )
            } else {
                binding.terminalsEmpty.show(
                    icon = R.drawable.ic_rt_wifi_off,
                    title = getString(R.string.machine_offline),
                    body = getString(R.string.agent_offline_hint),
                )
            }
        } else {
            binding.terminalsEmpty.hide()
        }
    }

    private fun bindTerminalCard(card: ItemTerminalCardBinding, agent: AgentInfo, session: SessionInfo) {
        val context = requireContext()
        card.terminalName.text = Format.terminalTitle(context, session)
        card.terminalMeta.text = Format.terminalMeta(context, session)
        card.pinnedMark.visible = app.settings.isPinnedTerminal(agent.agentId, session.sessionId)
        val open = app.sessions.find(agent.agentId, session.sessionId) != null
        card.terminalBadge.visible = open || session.attached > 0
        card.terminalBadge.setText(if (session.attached > 0) R.string.badge_active else R.string.badge_new)
        card.card.setOnClickListener { host.openTerminal(agent.agentId, session.sessionId) }
        card.card.contentDescription = "${card.terminalName.text}, ${card.terminalMeta.text}"
        card.terminalMenu.setOnClickListener { TerminalActions.menu(this, it, agent, session) }
    }

    private fun renderDetails(agent: AgentInfo, state: RelayClient.ConnectionState) {
        val context = requireContext()
        val metrics = agent.metrics

        bindMetric(
            binding.metricCpu, R.string.metric_cpu, R.drawable.ic_rt_cpu, R.color.rt_primary,
            value = metrics.cpuLoad?.let { Format.percent(it) },
            progress = metrics.cpuLoad ?: -1f,
        )
        bindMetric(
            binding.metricMemory, R.string.metric_memory, R.drawable.ic_rt_memory, R.color.rt_accent,
            value = metrics.memoryUsedBytes?.let { Format.bytes(it) },
            progress = metrics.memoryFraction ?: -1f,
        )
        bindMetric(
            binding.metricStorage, R.string.metric_storage, R.drawable.ic_rt_hard_drive, R.color.rt_amber,
            value = metrics.storageFraction?.let { Format.percent(it) },
            progress = metrics.storageFraction ?: -1f,
        )
        bindMetric(
            binding.metricUptime, R.string.metric_uptime, R.drawable.ic_rt_clock, R.color.rt_purple,
            value = metrics.uptimeSec?.let { Format.duration(context, it) },
            // A week of uptime fills the meter; longer simply stays full.
            progress = metrics.uptimeSec?.let { (it.toFloat() / (7 * 86_400f)).coerceIn(0f, 1f) } ?: -1f,
        )
        binding.metricsNote.visible = !metrics.hasAny

        val card = binding.infoCard
        card.removeAllViews()
        val latency = app.client.latencyMs
        addInfoRow(
            card, R.drawable.ic_rt_monitor_cog, getString(R.string.info_operating_system),
            listOf(agent.os, agent.arch).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { getString(R.string.value_unknown) },
        )
        addDivider(card)
        addInfoRow(
            card, R.drawable.ic_rt_package, getString(R.string.info_agent_version),
            if (agent.agentVersion.isNotEmpty()) getString(R.string.agent_up_to_date, agent.agentVersion)
            else getString(R.string.value_unknown),
            badge = if (agent.agentVersion.isNotEmpty()) getString(R.string.badge_latest) else null,
        )
        addDivider(card)
        val relay = Format.relayHost(app.credentials.relayUrl)
        val ms = latency.value
        addInfoRow(
            card, R.drawable.ic_rt_network, getString(R.string.info_connection),
            if (ms != null && state is RelayClient.ConnectionState.Connected)
                getString(R.string.connection_with_latency, relay, ms) else relay,
        )
        addDivider(card)
        addInfoRow(
            card, R.drawable.ic_rt_fingerprint, getString(R.string.info_machine_id), agent.agentId,
            onClick = { MachineActions.copy(context, agent.agentId) },
        )
        if (agent.shells.isNotEmpty()) {
            addDivider(card)
            addInfoRow(
                card, R.drawable.ic_rt_terminal, getString(R.string.info_shells),
                agent.shells.joinToString(", ") { it.label },
            )
        }
    }

    private fun bindMetric(
        tile: ViewMetricTileBinding,
        caption: Int,
        icon: Int,
        colour: Int,
        value: String?,
        progress: Float,
    ) {
        val context = requireContext()
        tile.metricCaption.setText(caption)
        tile.metricIcon.setImageResource(icon)
        Design.tint(tile.metricIcon, if (value != null) colour else R.color.rt_text_muted)
        tile.metricValue.text = value ?: getString(R.string.value_unknown)
        tile.metricValue.setTextColor(Design.color(context, if (value != null) R.color.rt_text else R.color.rt_text_muted))
        tile.metricMeter.setFillColor(Design.color(context, colour))
        tile.metricMeter.setTrackColor(Design.color(context, R.color.rt_surface_flat))
        tile.metricMeter.progress = progress
        tile.root.contentDescription = "${getString(caption)}: ${tile.metricValue.text}"
    }

    private fun addInfoRow(
        parent: ViewGroup,
        icon: Int,
        label: String,
        value: String,
        badge: String? = null,
        onClick: (() -> Unit)? = null,
    ) {
        val row = ViewInfoRowBinding.inflate(layoutInflater, parent, false)
        row.infoIcon.setImageResource(icon)
        row.infoLabel.text = label
        row.infoValue.text = value
        row.infoBadge.visible = badge != null
        badge?.let { row.infoBadge.text = it }
        row.infoRow.contentDescription = "$label: $value"
        if (onClick != null) {
            row.infoRow.setOnClickListener { onClick() }
        } else {
            row.infoRow.isClickable = false
            row.infoRow.background = null
        }
        parent.addView(row.root)
    }

    private fun addDivider(parent: ViewGroup) {
        val divider = View(requireContext())
        divider.setBackgroundColor(Design.color(requireContext(), R.color.rt_divider))
        parent.addView(
            divider,
            ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
                marginStart = Design.dp(requireContext(), 13f)
                marginEnd = Design.dp(requireContext(), 13f)
            }
        )
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        private const val ARG_AGENT = "agent"
        private const val ARG_TAB = "tab"
        private const val STATE_TAB = "state_tab"
        /** Chip id of the "Manage" affordance at the end of the preset row. */
        private const val CHIP_MANAGE = "__manage"

        fun newInstance(agentId: String, tab: Tab) = MachineFragment().apply {
            arguments = Bundle().apply {
                putString(ARG_AGENT, agentId)
                putString(ARG_TAB, tab.name)
            }
        }
    }
}
