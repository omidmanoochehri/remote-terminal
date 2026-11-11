package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.RemoteError
import com.cactus.remoteterminal.databinding.FragmentToolScreenBinding
import com.cactus.remoteterminal.protocol.AgentCaps
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.ListeningPort
import com.cactus.remoteterminal.protocol.PortList
import com.cactus.remoteterminal.protocol.SysInfo
import com.cactus.remoteterminal.ui.design.SettingsBuilder
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * A machine's System view (agent requests `sys.info` and `net.ports`): what
 * the machine is, its network interfaces, and what listens on it. Asked once
 * on opening and again on refresh — nothing polls. A fresh answer also
 * remembers the machine's MAC for Wake-on-LAN.
 */
class SystemFragment : Fragment(), RtScreen {
    private var _binding: FragmentToolScreenBinding? = null
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!

    private var info: SysInfo? = null
    private var infoError: String? = null
    private var ports: PortList? = null
    private var portsError: String? = null
    private var filter = ""
    private var loaded = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentToolScreenBinding.inflate(inflater, container, false)
        return _binding!!.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = _binding!!
        ToolScreen.setUp(
            this, b, getString(R.string.system_title), machineName(),
            searchHint = getString(R.string.system_ports_filter_hint), onSearch = { filter = it; render() },
        )
        b.headerBar.headerAction.visible = true
        b.headerBar.headerAction.setImageResource(R.drawable.ic_rt_refresh)
        b.headerBar.headerAction.contentDescription = getString(R.string.refresh)
        b.headerBar.headerAction.setOnClickListener { viewLifecycleOwner.lifecycleScope.launch { refresh() } }
        b.loading.visible = true

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.collect { agents ->
                    val agent = agents.firstOrNull { it.agentId == agentId }
                    if (agent == null) { requireActivity().onBackPressedDispatcher.onBackPressed(); return@collect }
                    _binding?.headerBar?.headerSubtitle?.text = machineName(agent)
                }
            }
        }
        viewLifecycleOwner.lifecycleScope.launch { refresh() }
    }

    private fun agent(): AgentInfo? = app.agents.agent(agentId)
    private fun machineName(a: AgentInfo? = agent()) = a?.let { it.name.ifEmpty { it.hostname } } ?: ""

    private suspend fun refresh() {
        val a = agent()
        val caps = app.client.relayCaps
        val offline = a == null || !a.online
        coroutineScope {
            val sys = async {
                when {
                    offline -> Result.failure(RemoteError("offline", getString(R.string.tool_machine_offline, machineName(a))))
                    !AgentCaps.system(caps, a!!) -> Result.failure(RemoteError("unsupported", getString(R.string.system_sys_unsupported)))
                    else -> runCatching { app.remote.systemInfo(agentId) }
                }
            }
            val net = async {
                when {
                    offline -> Result.failure(RemoteError("offline", getString(R.string.tool_machine_offline, machineName(a))))
                    !AgentCaps.ports(caps, a!!) -> Result.failure(RemoteError("unsupported", getString(R.string.system_ports_unsupported)))
                    else -> runCatching { app.remote.listeningPorts(agentId) }
                }
            }
            sys.await().onSuccess { info = it; infoError = null; app.settings.noteSysInfo(agentId, it) }
                .onFailure { infoError = it.message ?: getString(R.string.error_generic, "") }
            net.await().onSuccess { ports = it; portsError = null }
                .onFailure { portsError = it.message ?: getString(R.string.error_generic, "") }
        }
        loaded = true
        render()
    }

    private fun render() {
        val b = _binding ?: return
        if (!loaded) return
        b.loading.visible = false
        val builder = SettingsBuilder(b.content)
        builder.clear()
        val notReported = getString(R.string.system_not_reported)

        builder.section(getString(R.string.system_machine))
        val i = info
        if (i == null) {
            builder.row(R.drawable.ic_rt_alert, R.color.rt_amber, getString(R.string.system_error_title), infoError) { }
        } else {
            fun fact(icon: Int, label: Int, value: String?) {
                builder.row(icon, R.color.rt_primary, getString(label), value ?: notReported) {
                    if (value != null) MachineActions.copy(requireContext(), value)
                }
            }
            fact(R.drawable.ic_rt_server, R.string.system_hostname, i.hostname.ifEmpty { null })
            fact(R.drawable.ic_rt_monitor_cog, R.string.system_os, i.os ?: i.platform.ifEmpty { null })
            fact(R.drawable.ic_rt_package, R.string.system_kernel, i.release)
            fact(R.drawable.ic_rt_cpu, R.string.system_arch, i.arch)
            fact(
                R.drawable.ic_rt_cpu, R.string.system_cpu,
                when {
                    i.cpuModel != null && i.cpus != null -> getString(R.string.system_cpu_value, i.cpuModel, i.cpus)
                    else -> i.cpuModel ?: i.cpus?.toString()
                },
            )
            fact(R.drawable.ic_rt_memory, R.string.system_memory, i.memoryTotal?.let { Format.bytes(it) })
            fact(R.drawable.ic_rt_clock, R.string.system_uptime, i.uptimeSec?.let { Format.duration(requireContext(), it) })
            fact(R.drawable.ic_rt_globe, R.string.system_timezone, i.timezone)
            fact(R.drawable.ic_rt_fingerprint, R.string.system_user, i.user)
            fact(R.drawable.ic_rt_package, R.string.system_agent, i.agentVersion)
            fact(R.drawable.ic_rt_activity, R.string.system_agent_uptime, i.agentUptimeSec?.let { Format.duration(requireContext(), it) })
            fact(R.drawable.ic_rt_terminal, R.string.system_node, i.nodeVersion)
        }

        builder.section(getString(R.string.system_network))
        when {
            i == null -> builder.row(R.drawable.ic_rt_alert, R.color.rt_amber, getString(R.string.system_error_title), infoError) { }
            i.interfaces.isEmpty() -> builder.row(R.drawable.ic_rt_network, R.color.rt_text_muted, getString(R.string.system_no_interfaces), null) { }
            else -> for (iface in i.interfaces) {
                builder.row(
                    R.drawable.ic_rt_network, R.color.rt_accent, iface.name,
                    iface.mac?.let { getString(R.string.system_mac, it) } ?: notReported,
                ) { iface.mac?.let { MachineActions.copy(requireContext(), it) } }
                for (addr in iface.addresses) {
                    builder.row(R.drawable.ic_rt_globe, R.color.rt_text_muted, addr.cidr ?: addr.address, addr.family) {
                        MachineActions.copy(requireContext(), addr.address)
                    }
                }
            }
        }

        builder.section(getString(R.string.system_ports))
        val p = ports
        if (p == null) {
            builder.row(R.drawable.ic_rt_alert, R.color.rt_amber, getString(R.string.system_error_title), portsError) { }
        } else {
            val shown = PortList.filter(p.ports, filter)
            when {
                p.ports.isEmpty() -> builder.row(R.drawable.ic_rt_network, R.color.rt_text_muted, getString(R.string.system_ports_none), null) { }
                shown.isEmpty() -> builder.row(R.drawable.ic_rt_search, R.color.rt_text_muted, getString(R.string.system_ports_no_match, filter.trim()), null) { }
                else -> for (port in shown.take(MAX_ROWS)) {
                    builder.row(
                        R.drawable.ic_rt_link, if (port.proto == "tcp") R.color.rt_primary else R.color.rt_purple,
                        "${port.port}/${port.proto}", "${port.address}  ·  ${processLabel(port)}",
                    ) { portActions(port) }
                }
            }
            if (shown.size > MAX_ROWS) builder.note(getString(R.string.system_ports_shown, MAX_ROWS, shown.size))
            if (p.truncated) builder.note(getString(R.string.system_ports_truncated))
            if (p.sampledAt > 0) builder.note(getString(R.string.system_sampled, DateUtils.formatDateTime(requireContext(), p.sampledAt, DateUtils.FORMAT_SHOW_TIME)))
        }
        builder.finish()

        // Nothing at all could be asked: say why in the shared block rather than three failed sections.
        if (info == null && ports == null && infoError != null && portsError != null && (agent()?.online != true)) {
            b.content.removeAllViews()
            b.stateBlock.show(
                icon = R.drawable.ic_rt_wifi_off, title = getString(R.string.system_error_title), body = infoError ?: "",
                actionLabel = R.string.retry_now, actionIcon = R.drawable.ic_rt_refresh, iconTint = R.color.rt_amber,
            ) { viewLifecycleOwner.lifecycleScope.launch { refresh() } }
        } else b.stateBlock.hide()
    }

    private fun processLabel(p: ListeningPort): String = when {
        p.process != null && p.pid != null -> getString(R.string.system_port_process, p.process, p.pid)
        p.process != null -> p.process
        p.pid != null -> "PID ${p.pid}"
        else -> getString(R.string.system_port_no_process)
    }

    private fun portActions(p: ListeningPort) {
        val a = agent()
        val canShow = a != null && AgentCaps.processes(app.client.relayCaps, a) && p.pid != null
        ActionSheet.show(
            requireContext(), "${p.port}/${p.proto}", "${p.endpoint}  ·  ${processLabel(p)}",
            listOf(
                ActionSheet.Item(getString(R.string.system_copy_endpoint), R.drawable.ic_rt_copy) { MachineActions.copy(requireContext(), p.endpoint) },
                ActionSheet.Item(
                    getString(R.string.system_show_process), R.drawable.ic_rt_activity,
                    disabledReason = when {
                        p.pid == null -> getString(R.string.system_port_no_process)
                        !canShow -> getString(R.string.tool_processes_unsupported)
                        else -> null
                    },
                ) { host.openProcesses(agentId, p.pid.toString()) },
            ),
        )
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        private const val ARG_AGENT = "agent"
        /** Rows built at most; a busy server's thousand sockets are reached through the filter. */
        private const val MAX_ROWS = 300

        fun newInstance(agentId: String) = SystemFragment().apply {
            arguments = Bundle().apply { putString(ARG_AGENT, agentId) }
        }
    }
}
