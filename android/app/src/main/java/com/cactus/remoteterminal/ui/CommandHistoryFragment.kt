package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentCommandHistoryBinding
import com.cactus.remoteterminal.databinding.ItemCommandHistoryBinding
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/**
 * The commands sent from the command bar, kept on this phone only. Tapping one
 * copies it so it can be pasted into any terminal; the overflow clears the lot.
 */
class CommandHistoryFragment : Fragment(), RtScreen {

    private var _binding: FragmentCommandHistoryBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private lateinit var adapter: HistoryAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentCommandHistoryBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.list.padForNavigationBar()

        binding.headerBar.headerTitle.setText(R.string.command_history_title)
        binding.headerBar.headerSubtitle.visible = false
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        binding.headerBar.headerOverflow.setOnClickListener { anchor ->
            val menu = android.widget.PopupMenu(requireContext(), anchor)
            menu.menu.add(0, 1, 0, R.string.command_history_clear)
            menu.setOnMenuItemClickListener {
                confirmClear()
                true
            }
            menu.show()
        }

        adapter = HistoryAdapter(
            onCopy = { command -> MachineActions.copy(requireContext(), command) },
            onMenu = { command, anchor -> rowMenu(command, anchor) },
        )
        binding.list.layoutManager = LinearLayoutManager(requireContext())
        binding.list.adapter = adapter
        render()
    }

    private fun render() {
        val history = app.settings.commandHistory
        adapter.submit(history)
        binding.list.visible = history.isNotEmpty()
        if (history.isEmpty()) {
            binding.stateBlock.show(
                icon = R.drawable.ic_rt_history,
                title = getString(R.string.command_history_title),
                body = getString(R.string.command_history_empty),
            )
        } else {
            binding.stateBlock.hide()
        }
    }

    private fun rowMenu(command: String, anchor: View) {
        val menu = android.widget.PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.copy)
        menu.menu.add(0, 2, 1, R.string.delete)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> MachineActions.copy(requireContext(), command)
                2 -> {
                    app.settings.commandHistory = app.settings.commandHistory.filterNot { it == command }
                    render()
                }
            }
            true
        }
        menu.show()
    }

    private fun confirmClear() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.command_history_clear)
            .setMessage(R.string.command_history_empty)
            .setPositiveButton(R.string.delete) { _, _ ->
                app.settings.clearCommandHistory()
                render()
                Toast.makeText(requireContext(), R.string.command_history_cleared, Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    class HistoryAdapter(
        private val onCopy: (String) -> Unit,
        private val onMenu: (String, View) -> Unit,
    ) : RecyclerView.Adapter<HistoryAdapter.VH>() {
        private var items: List<String> = emptyList()

        class VH(val b: ItemCommandHistoryBinding) : RecyclerView.ViewHolder(b.root)

        fun submit(list: List<String>) {
            items = list
            notifyDataSetChanged()
        }

        override fun getItemCount() = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemCommandHistoryBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val command = items[position]
            holder.b.commandText.text = command
            holder.b.row.setOnClickListener { onCopy(command) }
            holder.b.row.contentDescription = command
            holder.b.commandMenu.setOnClickListener { onMenu(command, it) }
        }
    }
}
