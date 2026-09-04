package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.PopupMenu
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.TerminalPreset
import com.cactus.remoteterminal.databinding.FragmentTerminalPresetsBinding
import com.cactus.remoteterminal.databinding.ItemPresetBinding
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/**
 * Saved terminals: a name, where to start and what to run. Tapping one starts
 * it straight away; a preset without a machine asks which one to use.
 */
class TerminalPresetsFragment : Fragment(), RtScreen {

    private var _binding: FragmentTerminalPresetsBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private lateinit var adapter: PresetAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentTerminalPresetsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.newPresetButton.padForNavigationBar()

        binding.headerBar.headerTitle.setText(R.string.presets_title)
        binding.headerBar.headerSubtitle.setText(R.string.presets_subtitle)
        binding.headerBar.headerOverflow.visible = false
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }

        adapter = PresetAdapter(
            machineName = { agentId -> machineName(agentId) },
            onStart = { preset -> start(preset) },
            onMenu = { preset, anchor -> rowMenu(preset, anchor) },
        )
        binding.list.layoutManager = LinearLayoutManager(requireContext())
        binding.list.adapter = adapter

        binding.newPresetButton.setOnClickListener { host.openPresetEditor(null, null) }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.settings.version.collect { render() }
            }
        }
        render()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val b = _binding ?: return
        val presets = app.settings.terminalPresets
        adapter.submit(presets)
        b.list.visible = presets.isNotEmpty()
        if (presets.isEmpty()) {
            b.stateBlock.show(
                icon = R.drawable.ic_rt_bookmark,
                title = getString(R.string.presets_empty_title),
                body = getString(R.string.presets_empty_body),
            )
        } else {
            b.stateBlock.hide()
        }
    }

    /** The label under a preset: its machine, or "any machine" when it floats. */
    private fun machineName(agentId: String?): String {
        if (agentId == null) return getString(R.string.preset_any_machine)
        val agent = app.agents.agents.value.firstOrNull { it.agentId == agentId }
            ?: return getString(R.string.preset_machine_gone)
        return agent.name.ifEmpty { agent.hostname }
    }

    /** Start a preset, asking for a machine first when it does not name one. */
    private fun start(preset: TerminalPreset) {
        if (preset.agentId != null) { TerminalStarter.launch(this, preset); return }
        val machines = app.agents.agents.value
        when {
            machines.isEmpty() -> host.openAddMachine()
            machines.size == 1 -> TerminalStarter.launch(this, preset, machines.first().agentId)
            else -> {
                val labels = machines.map { m ->
                    val name = m.name.ifEmpty { m.hostname }
                    if (m.online) name else "$name  (${getString(R.string.machine_offline)})"
                }.toTypedArray<CharSequence>()
                MaterialAlertDialogBuilder(requireContext())
                    .setTitle(R.string.choose_machine)
                    .setItems(labels) { _, which -> TerminalStarter.launch(this, preset, machines[which].agentId) }
                    .setNegativeButton(R.string.cancel, null)
                    .show()
            }
        }
    }

    private fun rowMenu(preset: TerminalPreset, anchor: View) {
        val menu = PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.preset_start)
        menu.menu.add(0, 2, 1, R.string.edit)
        menu.menu.add(0, 3, 2, R.string.delete)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> start(preset)
                2 -> host.openPresetEditor(preset.id, preset.agentId)
                3 -> confirmDelete(preset)
            }
            true
        }
        menu.show()
    }

    private fun confirmDelete(preset: TerminalPreset) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.preset_delete_title, preset.name))
            .setMessage(R.string.preset_delete_body)
            .setPositiveButton(R.string.delete) { _, _ ->
                app.settings.deletePreset(preset.id)
                render()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    class PresetAdapter(
        private val machineName: (String?) -> String,
        private val onStart: (TerminalPreset) -> Unit,
        private val onMenu: (TerminalPreset, View) -> Unit,
    ) : RecyclerView.Adapter<PresetAdapter.VH>() {
        private var items: List<TerminalPreset> = emptyList()

        class VH(val b: ItemPresetBinding) : RecyclerView.ViewHolder(b.root)

        fun submit(list: List<TerminalPreset>) {
            items = list
            notifyDataSetChanged()
        }

        override fun getItemCount() = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemPresetBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val context = holder.b.root.context
            val preset = items[position]
            holder.b.presetName.text = preset.name
            holder.b.presetPath.text = preset.directory.ifEmpty { context.getString(R.string.preset_no_directory) }
            holder.b.presetPath.visible = true
            // The start-up command reads as the line the shell will run.
            holder.b.presetCommand.text = context.getString(R.string.preset_command_line, preset.command)
            holder.b.presetCommand.visible = preset.command.isNotEmpty()
            holder.b.presetMachine.text = listOfNotNull(
                machineName(preset.agentId),
                preset.shellId?.takeIf { it.isNotEmpty() },
            ).joinToString("  •  ")
            holder.b.row.contentDescription = listOf(
                preset.name,
                holder.b.presetPath.text.toString(),
                preset.command.ifEmpty { context.getString(R.string.preset_no_command) },
                holder.b.presetMachine.text.toString(),
            ).joinToString(", ")
            holder.b.row.setOnClickListener { onStart(preset) }
            holder.b.presetMenu.setOnClickListener { onMenu(preset, it) }
        }
    }
}
