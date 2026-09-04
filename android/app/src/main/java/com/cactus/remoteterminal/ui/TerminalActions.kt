package com.cactus.remoteterminal.ui

import android.text.InputType
import android.view.View
import android.widget.PopupMenu
import androidx.fragment.app.Fragment
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.Outgoing
import com.cactus.remoteterminal.protocol.SessionInfo
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/**
 * The actions a terminal row offers, in one place: Home, All terminals and the
 * machine screen all show the same menu with the same confirmations, so the
 * meaning of "disconnect" versus "terminate" never differs between screens.
 */
object TerminalActions {

    fun menu(fragment: Fragment, anchor: View, agent: AgentInfo, session: SessionInfo) {
        val context = fragment.requireContext()
        val app = fragment.requireActivity().application as App
        val host = fragment.requireActivity() as MainActivity
        val pinned = app.settings.isPinnedTerminal(agent.agentId, session.sessionId)
        val openLocally = app.sessions.find(agent.agentId, session.sessionId) != null

        val menu = PopupMenu(context, anchor)
        menu.menu.add(0, ID_OPEN, 0, R.string.a11y_open_terminal)
        if (agent.online) menu.menu.add(0, ID_DUPLICATE, 1, R.string.action_duplicate)
        menu.menu.add(0, ID_RENAME, 2, R.string.rename_terminal)
        menu.menu.add(0, ID_PIN, 3, if (pinned) R.string.action_unpin else R.string.action_pin)
        if (openLocally) menu.menu.add(0, ID_DISCONNECT, 4, R.string.confirm_disconnect_action)
        if (session.isRunning) menu.menu.add(0, ID_TERMINATE, 5, R.string.tab_terminate)

        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                ID_OPEN -> host.openTerminal(agent.agentId, session.sessionId)
                ID_DUPLICATE -> duplicate(fragment, agent, session)
                ID_RENAME -> rename(fragment, agent, session)
                ID_PIN -> app.settings.togglePinnedTerminal(agent.agentId, session.sessionId)
                ID_DISCONNECT -> confirmDisconnect(fragment, agent, session)
                ID_TERMINATE -> confirmTerminate(fragment, agent, session)
            }
            true
        }
        menu.show()
    }

    /**
     * Another terminal like this one. The open tab knows the freshest directory
     * (a shell that reports one keeps it live), so prefer it over the copy the
     * relay is holding.
     */
    fun duplicate(fragment: Fragment, agent: AgentInfo, session: SessionInfo) {
        val app = fragment.requireActivity().application as App
        val cwd = app.sessions.find(agent.agentId, session.sessionId)?.cwd?.takeIf { it.isNotEmpty() } ?: session.cwd
        TerminalStarter.duplicate(fragment, agent.agentId, session, cwd)
    }

    fun rename(fragment: Fragment, agent: AgentInfo, session: SessionInfo) {
        val context = fragment.requireContext()
        val app = fragment.requireActivity().application as App
        val input = android.widget.EditText(context).apply {
            setText(session.title)
            inputType = InputType.TYPE_CLASS_TEXT
            setSelection(text.length)
        }
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.rename_terminal)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val title = input.text.toString().trim()
                if (title.isEmpty()) return@setPositiveButton
                app.sessions.find(agent.agentId, session.sessionId)
                    ?.let { app.sessions.rename(it, title) }
                    ?: app.client.send(Outgoing.sessionRename(agent.agentId, session.sessionId, title))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Close the local tab; the shell keeps running on the machine. */
    private fun confirmDisconnect(fragment: Fragment, agent: AgentInfo, session: SessionInfo) {
        val context = fragment.requireContext()
        val app = fragment.requireActivity().application as App
        MaterialAlertDialogBuilder(context)
            .setTitle(context.getString(R.string.confirm_disconnect_title, Format.terminalTitle(context, session)))
            .setMessage(R.string.confirm_disconnect_body)
            .setPositiveButton(R.string.confirm_disconnect_action) { _, _ ->
                app.sessions.find(agent.agentId, session.sessionId)?.let { app.sessions.closeTab(it, terminate = false) }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Kill the shell process and everything running in it. */
    fun confirmTerminate(fragment: Fragment, agent: AgentInfo, session: SessionInfo) {
        val context = fragment.requireContext()
        val app = fragment.requireActivity().application as App
        MaterialAlertDialogBuilder(context)
            .setTitle(context.getString(R.string.tab_close_title, Format.terminalTitle(context, session)))
            .setMessage(R.string.tab_terminate_desc)
            .setPositiveButton(R.string.tab_terminate) { _, _ ->
                app.settings.forgetSessionPrefs("${agent.agentId}|${session.sessionId}")
                app.sessions.find(agent.agentId, session.sessionId)
                    ?.let { app.sessions.closeTab(it, terminate = true) }
                    ?: app.client.send(Outgoing.sessionClose(agent.agentId, session.sessionId))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private const val ID_OPEN = 1
    private const val ID_RENAME = 2
    private const val ID_PIN = 3
    private const val ID_DISCONNECT = 4
    private const val ID_TERMINATE = 5
    private const val ID_DUPLICATE = 6
}
