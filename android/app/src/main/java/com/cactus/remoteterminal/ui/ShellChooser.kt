package com.cactus.remoteterminal.ui

import android.content.Context
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.protocol.AgentInfo
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** "New terminal" shell picker; skips the dialog when there is nothing to choose. */
object ShellChooser {
    fun show(context: Context, agent: AgentInfo, lastShell: String?, onChosen: (shellId: String?) -> Unit) {
        val shells = agent.shells
        if (shells.size <= 1) { onChosen(shells.firstOrNull()?.id); return }
        val labels = shells.map { s ->
            if (s.isDefault) "${s.label}  (${context.getString(R.string.shell_default)})" else s.label
        }.toTypedArray()
        var selected = shells.indexOfFirst { it.id == lastShell }.takeIf { it >= 0 } ?: shells.indexOfFirst { it.isDefault }.coerceAtLeast(0)
        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.choose_shell)
            .setSingleChoiceItems(labels, selected) { _, which -> selected = which }
            .setPositiveButton(R.string.new_terminal) { _, _ -> onChosen(shells[selected].id) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
