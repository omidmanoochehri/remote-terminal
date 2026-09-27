package com.cactus.remoteterminal.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.PopupMenu
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.protocol.AgentCaps
import com.cactus.remoteterminal.protocol.AgentInfo
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/**
 * The machine overflow menu, shared by Home, Machines and the machine screen,
 * so "remove" always warns about the same consequences wherever it is tapped.
 */
object MachineActions {

    fun menu(fragment: Fragment, anchor: View, agent: AgentInfo) {
        val context = fragment.requireContext()
        val app = fragment.requireActivity().application as App
        val host = fragment.requireActivity() as MainActivity
        val favourite = app.settings.isFavouriteMachine(agent.agentId)

        val menu = PopupMenu(context, anchor)
        menu.menu.add(0, ID_FAVOURITE, 0, if (favourite) R.string.action_unfavourite else R.string.action_favourite)
        menu.menu.add(0, ID_TERMINALS, 1, R.string.action_terminals)
        menu.menu.add(0, ID_NEW_TERMINAL, 2, R.string.new_terminal)
        menu.menu.add(0, ID_DETAILS, 3, R.string.action_details)
        menu.menu.add(0, ID_FILES, 3, R.string.tool_files)
        menu.menu.add(0, ID_PROCESSES, 3, R.string.tool_processes)
        menu.menu.add(0, ID_SETTINGS, 4, R.string.action_settings)
        menu.menu.add(0, ID_RENAME, 5, R.string.rename_machine)
        menu.menu.add(0, ID_COPY_HOST, 6, R.string.copy_hostname)
        menu.menu.add(0, ID_REMOVE, 7, R.string.remove_machine)

        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                ID_FAVOURITE -> app.settings.toggleFavouriteMachine(agent.agentId)
                ID_TERMINALS -> host.openMachine(agent.agentId, MachineFragment.Tab.TERMINALS)
                ID_NEW_TERMINAL -> host.openNewTerminal(agent.agentId)
                ID_DETAILS -> host.openMachine(agent.agentId, MachineFragment.Tab.DETAILS)
                ID_FILES -> openFiles(fragment, agent)
                ID_PROCESSES -> openProcesses(fragment, agent)
                ID_SETTINGS -> host.openMachineSettings(agent.agentId)
                ID_RENAME -> rename(fragment, agent)
                ID_COPY_HOST -> copy(context, agent.hostname.ifEmpty { agent.name })
                ID_REMOVE -> confirmRemove(fragment, agent)
            }
            true
        }
        menu.show()
    }

    /**
     * Why a machine tool cannot be opened right now — the machine is offline,
     * or its agent (or the relay) predates it — or null when it can.
     */
    fun toolUnavailable(context: Context, relayCaps: List<String>, agent: AgentInfo, files: Boolean): String? = when {
        !agent.online -> context.getString(R.string.tool_machine_offline, agent.name.ifEmpty { agent.hostname })
        files && !AgentCaps.files(relayCaps, agent) -> context.getString(R.string.tool_files_unsupported)
        !files && !AgentCaps.processes(relayCaps, agent) -> context.getString(R.string.tool_processes_unsupported)
        else -> null
    }

    fun openFiles(fragment: Fragment, agent: AgentInfo, path: String? = null, sessionId: String? = null) {
        val app = fragment.requireActivity().application as App
        val why = toolUnavailable(fragment.requireContext(), app.client.relayCaps, agent, files = true)
        if (why != null) { Toast.makeText(fragment.requireContext(), why, Toast.LENGTH_LONG).show(); return }
        (fragment.requireActivity() as MainActivity).openFiles(agent.agentId, path, sessionId)
    }

    fun openProcesses(fragment: Fragment, agent: AgentInfo) {
        val app = fragment.requireActivity().application as App
        val why = toolUnavailable(fragment.requireContext(), app.client.relayCaps, agent, files = false)
        if (why != null) { Toast.makeText(fragment.requireContext(), why, Toast.LENGTH_LONG).show(); return }
        (fragment.requireActivity() as MainActivity).openProcesses(agent.agentId)
    }

    fun rename(fragment: Fragment, agent: AgentInfo) {
        val context = fragment.requireContext()
        val app = fragment.requireActivity().application as App
        val input = EditText(context).apply {
            setText(agent.name)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            setSelection(text.length)
        }
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.rename_machine)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) app.agents.renameAgent(agent.agentId, name)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    fun confirmRemove(fragment: Fragment, agent: AgentInfo, onRemoved: (() -> Unit)? = null) {
        val context = fragment.requireContext()
        val app = fragment.requireActivity().application as App
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.remove_machine)
            .setMessage(context.getString(R.string.remove_machine_confirm, agent.name))
            .setPositiveButton(R.string.remove) { _, _ ->
                app.settings.favouriteMachines = app.settings.favouriteMachines - agent.agentId
                app.agents.removeAgent(agent.agentId)
                onRemoved?.invoke()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    fun copy(context: Context, text: String) {
        if (text.isEmpty()) return
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("remote-terminal", text))
        Toast.makeText(context, R.string.copied, Toast.LENGTH_SHORT).show()
    }

    private const val ID_FAVOURITE = 1
    private const val ID_TERMINALS = 2
    private const val ID_NEW_TERMINAL = 3
    private const val ID_DETAILS = 4
    private const val ID_SETTINGS = 5
    private const val ID_RENAME = 6
    private const val ID_COPY_HOST = 7
    private const val ID_REMOVE = 8
    private const val ID_FILES = 9
    private const val ID_PROCESSES = 10
}
