package com.cactus.remoteterminal.ui

import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.TerminalNaming
import com.cactus.remoteterminal.data.TerminalPreset
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.SessionInfo
import kotlinx.coroutines.launch

/**
 * Starts terminals that are described rather than typed: a saved preset, or a
 * copy of one that is already running.
 *
 * The relay only takes a shell, a size and a title, so the working directory
 * and the first command are sent as the first input to the new shell — exactly
 * what the New terminal screen does, visible in the scrollback rather than
 * hidden, and no protocol special case.
 */
object TerminalStarter {

    /**
     * @param preferredAgent the machine to use when the preset does not name
     *   one (the machine the user launched it from).
     */
    fun launch(fragment: Fragment, preset: TerminalPreset, preferredAgent: String? = null) {
        val agent = resolve(fragment, preset.agentId ?: preferredAgent) ?: return
        // The shell the preset names, if this machine still has it.
        val shellId = preset.shellId?.takeIf { id -> agent.shells.any { it.id == id } }
        start(fragment, agent, shellId, preset.name, preset.directory, preset.command)
    }

    /**
     * Another terminal like this one: same machine, same shell, and the same
     * directory when we know where the shell is. When we do not, the copy
     * starts wherever a fresh shell would and says so, rather than pretending.
     */
    fun duplicate(fragment: Fragment, agentId: String, session: SessionInfo, cwd: String) {
        val agent = resolve(fragment, agentId) ?: return
        val context = fragment.requireContext()
        val taken = agent.sessions.map { it.title }
        val title = TerminalNaming.copyTitle(session.title, taken)
        val shellId = session.shell.takeIf { id -> agent.shells.any { it.id == id } }
        if (cwd.isEmpty()) {
            Toast.makeText(context, R.string.duplicate_no_path, Toast.LENGTH_SHORT).show()
        }
        start(fragment, agent, shellId, title, cwd, "")
    }

    /** Resolve and vet the machine a start is aimed at. */
    private fun resolve(fragment: Fragment, agentId: String?): AgentInfo? {
        val app = fragment.requireActivity().application as App
        val context = fragment.requireContext()
        val agent = agentId?.let { id -> app.agents.agents.value.firstOrNull { it.agentId == id } }
        if (agent == null) {
            Toast.makeText(context, R.string.preset_no_machine, Toast.LENGTH_LONG).show()
            return null
        }
        if (!agent.online) {
            Toast.makeText(context, R.string.agent_offline_hint, Toast.LENGTH_LONG).show()
            return null
        }
        return agent
    }

    /** Create the session, queue the directory and command, then open it. */
    private fun start(
        fragment: Fragment,
        agent: AgentInfo,
        shellId: String?,
        title: String,
        directory: String,
        command: String,
    ) {
        val activity = fragment.requireActivity()
        val app = activity.application as App
        val host = activity as MainActivity
        val context = fragment.requireContext()

        fragment.viewLifecycleOwner.lifecycleScope.launch {
            // 80x24 is the protocol default; the terminal view resizes the PTY
            // to the real grid the moment it attaches.
            val result = app.sessions.create(agent.agentId, shellId, 80, 24, title.ifEmpty { null })
            result.onSuccess { session ->
                val startup = StringBuilder()
                if (directory.isNotEmpty()) {
                    app.settings.noteDirectory(agent.agentId, directory)
                    // The shell has not run yet, so the tab already knows where
                    // it is about to be even on platforms that cannot report it.
                    session.noteDirectory(directory)
                    startup.append("cd ").append(shellQuote(directory)).append('\r')
                }
                if (command.isNotEmpty()) {
                    app.settings.noteCommand(command)
                    startup.append(command).append('\r')
                }
                if (startup.isNotEmpty()) app.sessions.queueStartupInput(session, startup.toString())
                host.openTerminal(agent.agentId, session.sessionId)
            }.onFailure { e ->
                Toast.makeText(context, e.message ?: context.getString(R.string.error_title), Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * Quote a path for a shell only when it needs it. Windows paths take double
     * quotes, which both PowerShell and Command Prompt understand; the POSIX
     * single quotes below would be taken literally by Command Prompt.
     */
    fun shellQuote(path: String): String = when {
        path.matches(Regex("^[A-Za-z0-9._/~@:+-]+$")) -> path
        path.contains('\\') || path.matches(Regex("^[A-Za-z]:.*")) -> "\"" + path.replace("\"", "") + "\""
        else -> "'" + path.replace("'", "'\\''") + "'"
    }
}
