package com.cactus.remoteterminal.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.PopupMenu
import android.widget.Toast
import androidx.activity.addCallback
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.TerminalSession
import com.cactus.remoteterminal.databinding.FragmentTerminalBinding
import com.cactus.remoteterminal.databinding.ItemTabBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.SessionStream
import com.cactus.remoteterminal.terminal.ExtraKeysView
import com.cactus.remoteterminal.terminal.KeyEncoder
import com.cactus.remoteterminal.terminal.ModifierState
import com.cactus.remoteterminal.terminal.TerminalEmulator
import com.cactus.remoteterminal.terminal.TerminalTheme
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The terminal screen for one machine: scrollable tabs (one per open
 * terminal), the terminal view, status banner, "new lines" chip, search bar,
 * extra-keys bar and the optional command bar.
 */
class TerminalFragment : Fragment() {
    private var _binding: FragmentTerminalBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!
    private val modifiers = ModifierState()
    private lateinit var tabAdapter: TabAdapter
    private var current: TerminalSession? = null
    private var tabs: List<TerminalSession> = emptyList()
    private var creating = false
    private var uploadLabel: String? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentTerminalBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val host = requireActivity() as MainActivity
        val b = binding
        val term = b.terminal

        // Safe area: chrome clears the system bars, the terminal only avoids a side cutout,
        // and the bottom bar rises above the keyboard so the grid shrinks instead of hiding.
        b.topBar.padForStatusBar()
        b.bottomBar.padForNavigationBar(ime = true)
        b.terminalFrame.padForSideCutouts()

        b.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        b.searchButton.setOnClickListener { toggleSearch(!b.searchBar.isVisible) }
        b.keyboardButton.setOnClickListener { showKeyboard() }
        b.moreButton.setOnClickListener { moreMenu(it) }
        b.newLinesChip.setOnClickListener { term.scrollToBottom() }

        // Terminal view wiring
        term.modifiers = modifiers
        term.onInput = { data -> sendInput(data) }
        term.onGeometryChanged = { cols, rows -> current?.let { app.sessions.resize(it, cols, rows); ensureAttached(it) } }
        term.onTap = { showKeyboard() }
        term.onFollowChanged = { following, newRows ->
            b.newLinesChip.isVisible = !following && newRows > 0
            b.newLinesChip.text = if (newRows == 1) getString(R.string.new_lines_one) else getString(R.string.new_lines, newRows)
        }
        term.onFontSizeChanged = { sp -> app.settings.fontSizeSp = sp }
        term.onCopy = { text -> copy(text) }
        term.onPasteRequest = { paste() }
        term.onSearchResult = { cur, total ->
            b.searchCount.text = if (total == 0) getString(R.string.search_none) else getString(R.string.search_count, cur, total)
        }

        // Extra keys
        b.extraKeys.modifiers = modifiers
        b.extraKeys.onKey = { spec ->
            when (val a = spec.action) {
                is ExtraKeysView.Action.Special -> term.sendKey(a.key)
                is ExtraKeysView.Action.Text -> term.typeText(a.text)
                else -> {}
            }
        }

        // Search bar
        b.searchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) { term.search(b.searchInput.text.toString()); true } else false
        }
        b.searchNext.setOnClickListener { term.searchNext(true) }
        b.searchPrev.setOnClickListener { term.searchNext(false) }
        b.searchClose.setOnClickListener { toggleSearch(false) }

        // Command bar
        b.sendButton.setOnClickListener { sendCommandLine() }
        b.commandInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) { sendCommandLine(); true } else false
        }

        // Tabs
        tabAdapter = TabAdapter(onSelect = { selectTab(it) }, onClose = { confirmClose(it) }, onNew = { newTerminal() })
        b.tabs.layoutManager = LinearLayoutManager(requireContext(), RecyclerView.HORIZONTAL, false)
        b.tabs.adapter = tabAdapter

        requireActivity().onBackPressedDispatcher.addCallback(viewLifecycleOwner) {
            when {
                b.searchBar.isVisible -> toggleSearch(false)
                term.hasSelection() -> term.clearSelection()
                else -> { isEnabled = false; requireActivity().onBackPressedDispatcher.onBackPressed() }
            }
        }

        applySettings()
        applyOrientation(resources.configuration)

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { app.settings.version.collect { applySettings() } }
                launch {
                    app.agents.agents.combine(app.client.state) { agents, state -> agents.firstOrNull { it.agentId == agentId } to state }
                        .collect { (agent, state) ->
                            if (agent == null) { host.onBackPressedDispatcher.onBackPressed(); return@collect }
                            b.machineName.text = agent.name
                            val (label, color) = Format.presence(requireContext(), agent, state)
                            b.machineStatus.text = label
                            b.machineStatus.setTextColor(ContextCompat.getColor(requireContext(), color))
                            b.machineDot.backgroundTintList = ContextCompat.getColorStateList(requireContext(), color)
                            updateBanner()
                        }
                }
                launch {
                    app.sessions.tabs(agentId).collect { list ->
                        tabs = list
                        for (s in list) bindSession(s)
                        tabAdapter.submit(list, current)
                        if (current == null || current !in list) chooseInitialTab()
                    }
                }
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyOrientation(newConfig)
    }

    private fun applyOrientation(config: Configuration) {
        val land = config.orientation == Configuration.ORIENTATION_LANDSCAPE
        binding.extraKeys.compact = land
        binding.commandBar.isVisible = !land && app.settings.commandBar
        binding.machineStatus.isVisible = !land
    }

    private fun applySettings() {
        val s = app.settings
        val term = binding.terminal
        term.setFontSizeSp(s.fontSizeSp, notify = false)
        term.setLineSpacing(s.lineSpacing)
        term.theme = TerminalTheme.byId(s.terminalTheme)
        term.cursorStyleSetting = when (s.cursorStyle) { "underline" -> TerminalEmulator.CURSOR_UNDERLINE; "bar" -> TerminalEmulator.CURSOR_BAR; else -> TerminalEmulator.CURSOR_BLOCK }
        term.blinkEnabled = s.cursorBlink
        term.hapticsEnabled = s.haptics
        term.keepScreenOn = s.keepAwake
        binding.extraKeys.hapticsEnabled = s.haptics
        binding.extraKeys.setRows(listOf(s.extraKeysRow1, s.extraKeysRow2, s.extraKeysRow3))
        binding.commandBar.isVisible = s.commandBar && resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
        binding.terminalFrame.setBackgroundColor(term.theme.background)
    }

    /* -------------------------------- tabs -------------------------------- */

    private fun chooseInitialTab() {
        val requested = requireArguments().getString(ARG_SESSION)
        if (requested != null && requested.startsWith(NEW_SESSION_PREFIX)) {
            requireArguments().remove(ARG_SESSION)
            createSession(requested.removePrefix(NEW_SESSION_PREFIX).ifEmpty { null })
            return
        }
        val byArg = requested?.let { id -> tabs.firstOrNull { it.sessionId == id } ?: app.sessions.get(agentId, id) }
        val pick = byArg ?: tabs.firstOrNull { it.sessionId == app.settings.activeTab(agentId) } ?: tabs.firstOrNull()
        if (pick != null) selectTab(pick)
        else if (!creating) {
            val agent = app.agents.agent(agentId)
            if (agent != null && agent.online) newTerminal() else updateBanner()
        }
    }

    private fun bindSession(s: TerminalSession) {
        s.onOutput = {
            if (s === current) binding.terminal.notifyUpdated()
            else { s.unreadRows++; tabAdapter.notifyTab(s) }
        }
    }

    private fun selectTab(s: TerminalSession) {
        current = s
        s.unreadRows = 0
        app.settings.setActiveTab(agentId, s.sessionId)
        val term = binding.terminal
        term.emulator = s.emulator
        term.pushGeometry()
        ensureAttached(s)
        tabAdapter.submit(tabs, s)
        binding.tabs.scrollToPosition(tabs.indexOf(s).coerceAtLeast(0))
        updateBanner()
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) { s.version.collect { if (s === current) { updateBanner(); tabAdapter.notifyTab(s) } } }
        }
    }

    private fun ensureAttached(s: TerminalSession) {
        if (s.stream.state == SessionStream.State.DETACHED && s.isRunning && app.client.isConnected) {
            app.sessions.attach(s, binding.terminal.cols, binding.terminal.rows)
        }
    }

    private fun newTerminal() {
        val agent = app.agents.agent(agentId) ?: return
        if (!agent.online) { Toast.makeText(requireContext(), R.string.agent_offline_hint, Toast.LENGTH_SHORT).show(); return }
        ShellChooser.show(requireContext(), agent, app.settings.lastShell(agentId)) { createSession(it) }
    }

    private fun createSession(shell: String?) {
        if (creating) return
        creating = true
        binding.banner.text = getString(R.string.creating_terminal)
        binding.banner.isVisible = true
        viewLifecycleOwner.lifecycleScope.launch {
            val term = binding.terminal
            val r = app.sessions.create(agentId, shell, term.cols, term.rows, null)
            creating = false
            r.onSuccess { selectTab(it) }
            r.onFailure { e ->
                updateBanner()
                Toast.makeText(requireContext(), e.message ?: getString(R.string.error_generic, ""), Toast.LENGTH_LONG).show()
                if (tabs.isEmpty()) (requireActivity() as MainActivity).onBackPressedDispatcher.onBackPressed()
            }
        }
    }

    private fun confirmClose(s: TerminalSession) {
        if (!s.isRunning) { app.sessions.closeTab(s, terminate = false); return }
        val items = arrayOf(
            getString(R.string.tab_keep_running) + "\n" + getString(R.string.tab_keep_running_desc),
            getString(R.string.tab_terminate) + "\n" + getString(R.string.tab_terminate_desc),
        )
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.tab_close_title, s.displayTitle))
            .setItems(items) { _, which -> app.sessions.closeTab(s, terminate = which == 1) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /* ------------------------------- status ------------------------------- */

    private fun updateBanner() {
        val b = _binding ?: return
        val s = current
        val agent = app.agents.agent(agentId)
        val state = app.client.state.value
        val text: String? = when {
            uploadLabel != null -> uploadLabel
            creating -> getString(R.string.creating_terminal)
            state !is RelayClient.ConnectionState.Connected -> Format.connectionLabel(requireContext(), state)
            agent != null && !agent.online -> getString(R.string.terminal_offline)
            s == null -> null
            s.state == "exited" -> getString(R.string.terminal_exited)
            s.state == "closed" -> if (s.closedReason == "gone" || s.closedReason == "removed") getString(R.string.terminal_gone) else getString(R.string.terminal_closed)
            s.attachError != null -> s.attachError
            s.stream.state == SessionStream.State.ATTACHING -> getString(R.string.terminal_attaching)
            else -> null
        }
        b.banner.text = text ?: ""
        b.banner.isVisible = text != null
        b.terminal.alpha = if (s != null && s.stream.state == SessionStream.State.ATTACHED) 1f else 0.85f
    }

    /* -------------------------------- input ------------------------------- */

    private fun sendInput(data: String) {
        val s = current ?: return
        if (!app.sessions.input(s, data)) {
            if (s.state != "running") Toast.makeText(requireContext(), R.string.terminal_exited, Toast.LENGTH_SHORT).show()
            else ensureAttached(s)
        }
    }

    private fun sendCommandLine() {
        val line = binding.commandInput.text.toString()
        binding.commandInput.setText("")
        binding.terminal.sendRaw(line + "\r")
    }

    private fun showKeyboard() {
        val term = binding.terminal
        term.requestFocus()
        (requireContext().getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(term, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun toggleSearch(show: Boolean) {
        binding.searchBar.isVisible = show
        if (show) {
            binding.searchInput.requestFocus()
            (requireContext().getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(binding.searchInput, InputMethodManager.SHOW_IMPLICIT)
        } else {
            binding.terminal.clearSearch()
            binding.searchInput.setText("")
        }
    }

    private fun copy(text: String) {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("terminal", text))
        Toast.makeText(requireContext(), R.string.copied, Toast.LENGTH_SHORT).show()
    }

    private fun paste() {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        // An image on the clipboard is uploaded to the machine instead of being typed.
        if (clipboardImage(cm) != null) { pasteImage(explicit = false); return }
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(requireContext())?.toString() ?: return
        if (text.isEmpty()) return
        val lines = text.trimEnd('\n', '\r').count { it == '\n' } + 1
        val term = binding.terminal
        if (lines >= app.settings.pasteConfirmLines && !term.emulator.bracketedPaste) {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(getString(R.string.paste_confirm_title, lines))
                .setMessage(R.string.paste_confirm_text)
                .setPositiveButton(R.string.paste_confirm_ok) { _, _ -> term.paste(text) }
                .setNegativeButton(R.string.cancel, null)
                .show()
        } else term.paste(text)
    }

    /* ----------------------------- paste image ---------------------------- */

    /** The first clipboard item that is an image, if any. */
    private fun clipboardImage(cm: ClipboardManager): Pair<Uri, String>? {
        val clip = cm.primaryClip ?: return null
        val cr = requireContext().contentResolver
        for (i in 0 until clip.itemCount) {
            val uri = clip.getItemAt(i).uri ?: continue
            val mime = try { cr.getType(uri) } catch (_: Exception) { null } ?: continue
            if (mime.startsWith("image/")) return uri to mime
        }
        return null
    }

    /**
     * Upload a pasted image to the machine and type its path at the cursor, so
     * the user can do whatever they like with the file. Nothing is executed.
     */
    private fun pasteImage(explicit: Boolean) {
        val s = current ?: return
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val found = clipboardImage(cm)
        if (found == null) { if (explicit) toast(getString(R.string.paste_image_none)); return }
        if (app.agents.agent(agentId)?.caps?.contains("files") != true) { toast(getString(R.string.paste_image_unsupported)); return }
        if (s.stream.state != SessionStream.State.ATTACHED) { toast(getString(R.string.terminal_not_connected)); return }
        val (uri, mime) = found

        viewLifecycleOwner.lifecycleScope.launch {
            uploadLabel = getString(R.string.paste_image_uploading)
            updateBanner()
            val loaded = withContext(Dispatchers.IO) { runCatching { readImage(uri, mime) } }
            val payload = loaded.getOrNull()
            if (payload == null) {
                uploadLabel = null; updateBanner()
                toast(getString(R.string.paste_image_failed, loaded.exceptionOrNull()?.message ?: "unreadable"))
                return@launch
            }
            val result = app.sessions.sendFile(s, payload.first, mime, payload.second)
            uploadLabel = null
            updateBanner()
            result.onSuccess { path ->
                binding.terminal.sendRaw(shellQuote(path))
                toast(getString(R.string.paste_image_done, path))
            }.onFailure { e -> toast(getString(R.string.paste_image_failed, e.message ?: "failed")) }
        }
    }

    /** @return display name and bytes; throws when the image is unreadable or too large. */
    private fun readImage(uri: Uri, mime: String): Pair<String, ByteArray> {
        val cr = requireContext().contentResolver
        val declared = try { cr.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L } catch (_: Exception) { -1L }
        if (declared > MAX_UPLOAD_BYTES) throw IllegalStateException(getString(R.string.paste_image_too_large, MAX_UPLOAD_BYTES / (1024 * 1024)))
        val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: throw IllegalStateException("cannot read image")
        if (bytes.size > MAX_UPLOAD_BYTES) throw IllegalStateException(getString(R.string.paste_image_too_large, MAX_UPLOAD_BYTES / (1024 * 1024)))
        var name = try {
            cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
            }
        } catch (_: Exception) { null }
        if (name.isNullOrBlank()) {
            val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "png"
            name = "pasted.$ext"
        }
        return name to bytes
    }

    /** Quote a path for a shell only when it needs it (agent-side names are already tame). */
    private fun shellQuote(path: String): String =
        if (path.matches(Regex("^[A-Za-z0-9._/@:+-]+$"))) path else "'" + path.replace("'", "'\\''") + "'"

    private fun toast(text: String) = Toast.makeText(requireContext(), text, Toast.LENGTH_LONG).show()

    private fun moreMenu(anchor: View) {
        val menu = PopupMenu(requireContext(), anchor)
        menu.menuInflater.inflate(R.menu.menu_terminal, menu.menu)
        menu.menu.findItem(R.id.action_command_bar).isChecked = binding.commandBar.isVisible
        menu.setOnMenuItemClickListener { item ->
            val term = binding.terminal
            when (item.itemId) {
                R.id.action_new_terminal -> newTerminal()
                R.id.action_rename -> current?.let { renameTab(it) }
                R.id.action_shortcuts -> ShortcutsSheet().show(childFragmentManager, "shortcuts")
                R.id.action_paste -> paste()
                R.id.action_paste_image -> pasteImage(explicit = true)
                R.id.action_select_all -> term.selectAll()
                R.id.action_clear -> { term.emulator.clearScreen(); term.notifyUpdated() }
                R.id.action_command_bar -> { val v = !binding.commandBar.isVisible; app.settings.commandBar = v; binding.commandBar.isVisible = v }
                R.id.action_close_tab -> current?.let { confirmClose(it) }
                else -> return@setOnMenuItemClickListener false
            }
            true
        }
        menu.show()
    }

    private fun renameTab(s: TerminalSession) {
        val input = EditText(requireContext()).apply { setText(s.title); inputType = InputType.TYPE_CLASS_TEXT; setSelection(text.length) }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.rename_terminal)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ -> input.text.toString().trim().takeIf { it.isNotEmpty() }?.let { app.sessions.rename(s, it) } }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Called by the shortcuts sheet. */
    fun sendShortcut(bytes: String) = binding.terminal.sendRaw(bytes)
    fun sendCommand(command: String) = binding.terminal.sendRaw(command + "\r")

    override fun onDestroyView() {
        for (s in tabs) if (s.onOutput != null) s.onOutput = { s.unreadRows++ }
        super.onDestroyView()
        _binding = null
    }

    /* --------------------------------- tabs ------------------------------- */

    class TabAdapter(
        private val onSelect: (TerminalSession) -> Unit,
        private val onClose: (TerminalSession) -> Unit,
        private val onNew: () -> Unit,
    ) : RecyclerView.Adapter<TabAdapter.VH>() {
        private var items: List<TerminalSession> = emptyList()
        private var selected: TerminalSession? = null

        class VH(val b: ItemTabBinding) : RecyclerView.ViewHolder(b.root)

        fun submit(list: List<TerminalSession>, current: TerminalSession?) { items = list; selected = current; notifyDataSetChanged() }
        fun notifyTab(s: TerminalSession) { val i = items.indexOf(s); if (i >= 0) notifyItemChanged(i) }

        override fun getItemCount() = items.size + 1

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemTabBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val ctx = holder.b.root.context
            val pad = (12 * ctx.resources.displayMetrics.density).toInt()
            if (position == items.size) {
                // The "+" chip: symmetric padding, nothing else inside it.
                holder.b.tabTitle.text = "+"
                holder.b.tabTitle.textSize = 18f
                holder.b.tabTitle.setTextColor(color(holder, com.google.android.material.R.attr.colorOnSurfaceVariant))
                holder.b.root.contentDescription = ctx.getString(R.string.new_terminal)
                holder.b.root.setPadding(pad, 0, pad, 0)
                holder.b.tabClose.isVisible = false
                holder.b.tabBadge.isVisible = false
                holder.b.root.isSelected = false
                holder.b.root.alpha = 1f
                holder.b.root.setOnClickListener { onNew() }
                return
            }
            val s = items[position]
            val active = s === selected
            holder.b.tabTitle.textSize = 14f
            holder.b.tabTitle.text = if (s.isRunning) s.displayTitle else "${'$'}{s.displayTitle} ·"
            holder.b.root.contentDescription = s.displayTitle
            holder.b.root.setPadding(pad, 0, (pad * 2 / 3), 0)
            holder.b.tabClose.isVisible = true
            holder.b.tabClose.contentDescription = ctx.getString(R.string.tab_close)
            holder.b.tabBadge.isVisible = s.unreadRows > 0 && !active
            holder.b.tabBadge.text = if (s.unreadRows > 99) "99+" else s.unreadRows.toString()
            holder.b.root.isSelected = active
            val fg = if (active) color(holder, com.google.android.material.R.attr.colorOnPrimaryContainer)
                     else color(holder, com.google.android.material.R.attr.colorOnSurfaceVariant)
            holder.b.tabTitle.setTextColor(fg)
            holder.b.tabClose.imageTintList = android.content.res.ColorStateList.valueOf(fg)
            holder.b.root.alpha = if (s.isRunning) 1f else 0.65f
            holder.b.root.setOnClickListener { onSelect(s) }
            holder.b.tabClose.setOnClickListener { onClose(s) }
        }

        private fun color(holder: VH, attr: Int): Int =
            com.google.android.material.color.MaterialColors.getColor(holder.b.root, attr)
    }

    companion object {
        private const val ARG_AGENT = "agent"
        private const val ARG_SESSION = "session"
        /** Matches the agent's default upload cap; larger images are refused before sending. */
        private const val MAX_UPLOAD_BYTES = 16 * 1024 * 1024
        /** Session argument prefix meaning "create a new terminal with this shell id". */
        const val NEW_SESSION_PREFIX = "new:"
        fun newInstance(agentId: String, sessionId: String?) = TerminalFragment().apply {
            arguments = Bundle().apply { putString(ARG_AGENT, agentId); putString(ARG_SESSION, sessionId) }
        }
    }
}
