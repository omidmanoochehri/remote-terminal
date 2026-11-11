package com.cactus.remoteterminal.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.MimeTypeMap
import android.widget.EditText
import android.widget.PopupMenu
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.FuzzyMatch
import com.cactus.remoteterminal.data.OutputWatch
import com.cactus.remoteterminal.data.Prompt
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.data.Snippets
import com.cactus.remoteterminal.data.TerminalPreset
import com.cactus.remoteterminal.terminal.HardwareShortcuts
import com.cactus.remoteterminal.ui.Forms.text
import com.cactus.remoteterminal.ui.Forms.validateOnPositive
import com.cactus.remoteterminal.data.TerminalSession
import com.cactus.remoteterminal.databinding.FragmentTerminalBinding
import com.cactus.remoteterminal.databinding.ItemTabBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.protocol.SessionStream
import com.cactus.remoteterminal.terminal.ExtraKeysView
import com.cactus.remoteterminal.terminal.TerminalEmulator
import com.cactus.remoteterminal.terminal.TerminalTheme
import com.cactus.remoteterminal.terminal.Transcript
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.visible
import androidx.core.view.ViewCompat
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The terminal screen for one machine: the tab strip, the grid in its well,
 * the command bar, the extra-keys grid, and a status footer that says in words
 * what the connection is doing.
 */
class TerminalFragment : Fragment(), RtScreen {
    private var _binding: FragmentTerminalBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!
    private val modifiers = com.cactus.remoteterminal.terminal.ModifierState()
    private lateinit var tabAdapter: TabAdapter
    private var current: TerminalSession? = null
    private var tabs: List<TerminalSession> = emptyList()
    private var creating = false
    private var uploadLabel: String? = null
    /** Collector for the visible tab's metadata; replaced on every tab switch. */
    private var tabWatcher: Job? = null

    /** "Attach file" picker: anything the phone can open, uploaded to the machine. */
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) uploadUri(uri, null)
    }

    /** Prompts written but not sent yet, by terminal, so a cancelled one is there next time. */
    private val promptDrafts = HashMap<String, PromptDraft>()
    /** The open prompt composer's way to take picked files; null while it is closed. */
    private var promptFilesPicked: ((List<Uri>) -> Unit)? = null
    private val pickPromptFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) promptFilesPicked?.invoke(uris)
    }

    /** "Save transcript": the text captured when the menu was used, waiting for the system picker. */
    private var pendingTranscript: String? = null
    private val saveTranscript = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val text = pendingTranscript
        pendingTranscript = null
        if (uri != null && text != null) writeTranscript(uri, text)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentTerminalBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding
        val term = b.terminal

        // Safe area: chrome clears the system bars, the terminal only avoids a side cutout,
        // and the bottom bar rises above the keyboard so the grid shrinks instead of hiding.
        b.topBar.padForStatusBar()
        b.bottomBar.padForNavigationBar(ime = true)
        b.terminalFrame.padForSideCutouts()
        // Round the grid to the well; the XML attribute needs API 31, the call does not.
        b.terminalFrame.clipToOutline = true
        Design.excludeFromAutofill(view)

        b.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        b.promptButton.setOnClickListener { current?.let { writePrompt(it) } ?: toast(getString(R.string.prompt_no_terminal)) }
        b.searchButton.setOnClickListener { toggleSearch(!b.searchBar.visible) }
        b.keyboardButton.setOnClickListener { toggleKeyboard() }
        b.moreButton.setOnClickListener { moreMenu(it) }
        b.newLinesChip.setOnClickListener { term.scrollToBottom() }
        b.footerSettings.setOnClickListener { host.openTerminalFontSettings() }

        // Terminal view wiring
        term.modifiers = modifiers
        term.onInput = { data -> sendInput(data) }
        term.onGeometryChanged = { cols, rows -> current?.let { app.sessions.resize(it, cols, rows); ensureAttached(it) } }
        term.onTap = { showKeyboard() }
        term.onFollowChanged = { following, newRows ->
            b.newLinesChip.visible = !following && newRows > 0
            b.newLinesText.text =
                if (newRows == 1) getString(R.string.new_lines_one) else getString(R.string.new_lines, newRows)
        }
        term.onFontSizeChanged = { sp -> app.settings.fontSizeSp = sp }
        term.onCopy = { text -> copy(text) }
        term.onPasteRequest = { paste() }
        term.onSwipeTab = { forward -> swipeToTab(forward) }
        term.onLinkTap = { url -> showLink(url) }
        b.recBadge.setOnClickListener { current?.let { toggleRecording(it) } }
        b.broadcastStop.setOnClickListener { current?.let { app.sessions.stopBroadcast(it) }; updateStatus() }
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
                b.searchBar.visible -> toggleSearch(false)
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
                            b.machineName.text = agent.name.ifEmpty { agent.hostname }
                            val (label, colour) = Format.presence(requireContext(), agent, state)
                            val host = listOf(agent.hostname, agent.os).filter { it.isNotEmpty() }.joinToString("  •  ")
                            b.machineStatus.text = host.ifEmpty { label }
                            b.machineDot.backgroundTintList = Design.stateList(requireContext(), colour)
                            updateStatus(state, label, colour)
                        }
                }
                // The footer clock has to move on its own; nothing else ticks.
                launch {
                    while (true) {
                        kotlinx.coroutines.delay(30_000)
                        updateStatus()
                    }
                }
                launch {
                    app.sessions.tabs(agentId).collect { list ->
                        tabs = list
                        for (s in list) bindSession(s)
                        tabAdapter.submit(list, current)
                        val active = current
                        when {
                            active == null || active !in list -> chooseInitialTab()
                            // Coming back from another screen the fragment is
                            // the same but its view is new, so the grid is a
                            // fresh empty emulator until the tab is bound again.
                            binding.terminal.emulator !== active.emulator -> selectTab(active)
                        }
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
        binding.commandBar.visible = !land && app.settings.commandBar
        // Landscape gives the grid every row it can get.
        binding.statusFooter.visible = !land
    }

    private fun applySettings() {
        val s = app.settings
        val term = binding.terminal
        term.setFontSizeSp(s.fontSizeSp, notify = false)
        term.setLineSpacing(s.lineSpacing)
        term.setPreferSystemFont(s.terminalFontFamily == Settings.FONT_SYSTEM)
        term.swipeTabsEnabled = s.swipeSwitchTabs
        term.linksEnabled = s.clickableLinks
        term.cursorStyleSetting = when (s.cursorStyle) {
            "underline" -> TerminalEmulator.CURSOR_UNDERLINE
            "bar" -> TerminalEmulator.CURSOR_BAR
            else -> TerminalEmulator.CURSOR_BLOCK
        }
        term.blinkEnabled = s.cursorBlink
        term.hapticsEnabled = s.haptics
        term.keepScreenOn = s.keepAwake
        binding.extraKeys.hapticsEnabled = s.haptics
        binding.extraKeys.setRows(listOf(s.extraKeysRow1, s.extraKeysRow2, s.extraKeysRow3))
        binding.extraKeys.visible = s.showExtraKeys
        binding.commandBar.visible = s.commandBar && resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
        applyTheme()
    }

    /**
     * The visible tab's own colour scheme when it has one, otherwise the
     * app-wide setting. The well keeps the design outline; its fill follows the
     * scheme so a light terminal does not sit in a black frame.
     */
    private fun themeForCurrent(): TerminalTheme {
        val override = current?.let { app.settings.terminalTheme(it.key) }
        return TerminalTheme.byId(override ?: app.settings.terminalTheme)
    }

    private fun applyTheme() {
        val b = _binding ?: return
        val theme = themeForCurrent()
        b.terminal.theme = theme
        b.terminalFrame.backgroundTintList = android.content.res.ColorStateList.valueOf(theme.background)
    }

    private fun chooseTheme() {
        val s = current ?: return
        val themes = TerminalTheme.all()
        val appDefault = TerminalTheme.byId(app.settings.terminalTheme)
        val labels = (listOf(getString(R.string.terminal_theme_default, appDefault.name)) + themes.map { it.name })
            .toTypedArray<CharSequence>()
        val chosen = app.settings.terminalTheme(s.key)
        val checked = if (chosen == null) 0 else themes.indexOfFirst { it.id == chosen } + 1
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.terminal_theme_title)
            .setSingleChoiceItems(labels, checked.coerceAtLeast(0)) { dialog, which ->
                app.settings.setTerminalTheme(s.key, if (which == 0) null else themes[which - 1].id)
                applyTheme()
                dialog.dismiss()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
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
            if (agent != null && agent.online) newTerminal() else updateStatus()
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
        applyTheme()
        ensureAttached(s)
        tabAdapter.submit(tabs, s)
        binding.tabs.scrollToPosition(tabs.indexOf(s).coerceAtLeast(0))
        updateStatus()
        // One collector at a time: switching tabs is cheap and frequent now
        // that a swipe does it.
        tabWatcher?.cancel()
        tabWatcher = viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                s.version.collect { if (s === current) { updateStatus(); tabAdapter.notifyTab(s) } }
            }
        }
    }

    /** Sideways swipe across the grid: the neighbouring tab, nothing at the ends. */
    private fun swipeToTab(forward: Boolean) {
        if (tabs.size < 2) return
        val index = tabs.indexOf(current)
        if (index < 0) return
        val next = index + if (forward) 1 else -1
        if (next !in tabs.indices) return
        selectTab(tabs[next])
    }

    private fun ensureAttached(s: TerminalSession) {
        if (s.stream.state == SessionStream.State.DETACHED && s.isRunning && app.client.isConnected) {
            app.sessions.attach(s, binding.terminal.cols, binding.terminal.rows)
        }
    }

    private fun newTerminal() {
        val agent = app.agents.agent(agentId) ?: return
        if (!agent.online) {
            Toast.makeText(requireContext(), R.string.agent_offline_hint, Toast.LENGTH_SHORT).show()
            return
        }
        // The full form is a screen of its own; go there rather than stacking dialogs.
        host.openNewTerminal(agentId)
    }

    private fun createSession(shell: String?) {
        if (creating) return
        creating = true
        updateStatus()
        viewLifecycleOwner.lifecycleScope.launch {
            val term = binding.terminal
            val r = app.sessions.create(agentId, shell, term.cols, term.rows, null)
            creating = false
            r.onSuccess { selectTab(it) }
            r.onFailure { e ->
                updateStatus()
                Toast.makeText(requireContext(), e.message ?: getString(R.string.error_generic, ""), Toast.LENGTH_LONG).show()
                if (tabs.isEmpty()) host.onBackPressedDispatcher.onBackPressed()
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
            .setItems(items) { _, which ->
                if (which == 1) app.settings.forgetSessionPrefs(s.key)
                app.sessions.closeTab(s, terminate = which == 1)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /* ------------------------------- status ------------------------------- */

    private fun updateStatus(
        state: RelayClient.ConnectionState = app.client.state.value,
        presenceLabel: String? = null,
        presenceColour: Int? = null,
    ) {
        val b = _binding ?: return
        val context = requireContext()
        val s = current
        val agent = app.agents.agent(agentId)

        // The banner only speaks up when something is wrong or in progress.
        val banner: String? = when {
            uploadLabel != null -> uploadLabel
            creating -> getString(R.string.creating_terminal)
            state !is RelayClient.ConnectionState.Connected -> Format.connectionLabel(context, state)
            agent != null && !agent.online -> getString(R.string.terminal_offline)
            s == null -> null
            s.state == "exited" -> getString(R.string.terminal_exited)
            s.state == "closed" ->
                if (s.closedReason == "gone" || s.closedReason == "removed") getString(R.string.terminal_gone)
                else getString(R.string.terminal_closed)
            s.attachError != null -> s.attachError
            s.stream.state == SessionStream.State.ATTACHING -> getString(R.string.terminal_attaching)
            else -> null
        }
        b.banner.text = banner ?: ""
        b.banner.visible = banner != null
        b.terminal.alpha = if (s != null && s.stream.state == SessionStream.State.ATTACHED) 1f else 0.85f

        // Footer: state in words, the shell, and how long the session has run.
        val attached = s != null && s.stream.state == SessionStream.State.ATTACHED
        val footerLabel: String
        val footerColour: Int
        when {
            state !is RelayClient.ConnectionState.Connected -> {
                footerLabel = Format.connectionLabel(context, state)
                footerColour = Format.connectionColor(state)
            }
            agent != null && !agent.online -> {
                footerLabel = presenceLabel ?: getString(R.string.machine_offline)
                footerColour = presenceColour ?: R.color.rt_status_offline
            }
            s != null && !s.isRunning -> {
                footerLabel = getString(R.string.terminal_exited)
                footerColour = R.color.rt_status_warn
            }
            attached -> {
                footerLabel = getString(R.string.state_connected)
                footerColour = R.color.rt_status_online
            }
            else -> {
                footerLabel = getString(R.string.terminal_attaching)
                footerColour = R.color.rt_status_warn
            }
        }
        b.footerState.text = footerLabel
        b.footerState.setTextColor(Design.color(context, footerColour))
        b.footerDot.backgroundTintList = Design.stateList(context, footerColour)

        val info = s?.let { app.agents.session(agentId, it.sessionId) }
        b.footerTransport.text = s?.shell?.ifEmpty { getString(R.string.terminal) } ?: getString(R.string.terminal)
        // Prefer the machine's own start time; fall back to when this phone opened the tab.
        val startedAt = info?.createdAt?.takeIf { it > 0 } ?: s?.openedAt ?: 0L
        b.footerUptime.text =
            if (startedAt > 0) Format.duration(context, (System.currentTimeMillis() - startedAt) / 1000)
            else getString(R.string.value_unknown)
        b.statusFooter.contentDescription = "$footerLabel, ${b.footerTransport.text}, ${b.footerUptime.text}"
        b.recBadge.visible = s?.isRecording == true
        renderBroadcast()
    }

    /** The banner that says typing here also types elsewhere, and how many elsewheres. */
    private fun renderBroadcast() {
        val b = _binding ?: return
        val s = current
        val n = if (s == null) 0 else app.sessions.broadcastTargets(s).size
        if (s != null && n == 0 && s.broadcastTo.isNotEmpty()) app.sessions.stopBroadcast(s)
        b.broadcastBar.visible = n > 0
        b.broadcastText.text = if (n == 1) getString(R.string.broadcast_banner_one) else getString(R.string.broadcast_banner, n)
    }

    /* -------------------------------- input ------------------------------- */

    private fun sendInput(data: String) {
        val s = current ?: return
        if (!app.sessions.inputWithBroadcast(s, data)) {
            if (s.state != "running") Toast.makeText(requireContext(), R.string.terminal_exited, Toast.LENGTH_SHORT).show()
            else ensureAttached(s)
        }
    }

    private fun sendCommandLine() {
        val line = binding.commandInput.text.toString()
        if (line.isBlank()) return
        binding.commandInput.setText("")
        app.settings.noteCommand(line)
        binding.terminal.sendRaw(line + "\r")
    }

    private fun showKeyboard() {
        val term = binding.terminal
        term.requestFocus()
        (requireContext().getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .showSoftInput(term, InputMethodManager.SHOW_IMPLICIT)
    }

    /** The header key toggles: tapping it again puts the rows back. */
    private fun toggleKeyboard() {
        val imm = requireContext().getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        val term = binding.terminal
        term.requestFocus()
        imm.toggleSoftInput(InputMethodManager.SHOW_IMPLICIT, InputMethodManager.HIDE_IMPLICIT_ONLY)
    }

    private fun toggleSearch(show: Boolean) {
        binding.searchBar.visible = show
        if (show) {
            binding.searchInput.requestFocus()
            (requireContext().getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                .showSoftInput(binding.searchInput, InputMethodManager.SHOW_IMPLICIT)
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
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(requireContext())?.toString() ?: ""
        // A file on the clipboard is uploaded to the machine instead of being
        // typed — unless the agent cannot take files and there is text to fall
        // back to, which is better than refusing the paste outright.
        val filesSupported = app.agents.agent(agentId)?.caps?.contains("files") == true
        if (clipboardFile(cm) != null && (filesSupported || text.isEmpty())) { pasteFile(explicit = false); return }
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

    /* ------------------------------ paste file ---------------------------- */

    /** The first clipboard item that is a file this phone can read, if any. */
    private fun clipboardFile(cm: ClipboardManager): Pair<Uri, String>? {
        val clip = cm.primaryClip ?: return null
        val cr = requireContext().contentResolver
        for (i in 0 until clip.itemCount) {
            val uri = clip.getItemAt(i).uri ?: continue
            // Only real files: an http:// link on the clipboard is text, not an upload.
            if (uri.scheme != ContentResolver.SCHEME_CONTENT && uri.scheme != ContentResolver.SCHEME_FILE) continue
            val mime = try { cr.getType(uri) } catch (_: Exception) { null } ?: DEFAULT_MIME
            return uri to mime
        }
        return null
    }

    /** Menu action: upload whatever file is on the clipboard. */
    private fun pasteFile(explicit: Boolean) {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val found = clipboardFile(cm)
        if (found == null) { if (explicit) toast(getString(R.string.paste_file_none)); return }
        uploadUri(found.first, found.second)
    }

    /** Menu action: pick any file on the phone and upload that. */
    private fun attachFile() {
        if (!canUpload()) return
        try {
            pickFile.launch(arrayOf("*/*"))
        } catch (_: Exception) {
            toast(getString(R.string.attach_file_unavailable))
        }
    }

    /** Both upload paths need an attached session on a machine that takes files. */
    private fun canUpload(): Boolean {
        val s = current
        if (app.agents.agent(agentId)?.caps?.contains("files") != true) {
            toast(getString(R.string.paste_file_unsupported)); return false
        }
        if (s == null || s.stream.state != SessionStream.State.ATTACHED) {
            toast(getString(R.string.terminal_not_connected)); return false
        }
        return true
    }

    /**
     * Upload a file to the machine and type its path at the cursor, so the user
     * can do whatever they like with it. Nothing is executed.
     */
    private fun uploadUri(uri: Uri, mimeHint: String?) {
        if (!canUpload()) return
        val s = current ?: return
        val cr = requireContext().contentResolver
        val mime = mimeHint ?: try { cr.getType(uri) } catch (_: Exception) { null } ?: DEFAULT_MIME

        viewLifecycleOwner.lifecycleScope.launch {
            uploadLabel = getString(R.string.paste_file_uploading)
            updateStatus()
            val loaded = withContext(Dispatchers.IO) { runCatching { readFile(uri, mime) } }
            val payload = loaded.getOrNull()
            if (payload == null) {
                uploadLabel = null; updateStatus()
                toast(getString(R.string.paste_file_failed, loaded.exceptionOrNull()?.message ?: "unreadable"))
                return@launch
            }
            val result = app.sessions.sendFile(s, payload.first, mime, payload.second)
            uploadLabel = null
            updateStatus()
            result.onSuccess { path ->
                binding.terminal.sendRaw(shellQuote(path))
                toast(getString(R.string.paste_file_done, path))
            }.onFailure { e -> toast(getString(R.string.paste_file_failed, e.message ?: "failed")) }
        }
    }

    /** @return display name and bytes; throws when the file is unreadable or too large. */
    private fun readFile(uri: Uri, mime: String): Pair<String, ByteArray> {
        val cr = requireContext().contentResolver
        val declared = try { cr.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L } catch (_: Exception) { -1L }
        if (declared > MAX_UPLOAD_BYTES) throw IllegalStateException(getString(R.string.paste_file_too_large, MAX_UPLOAD_BYTES / (1024 * 1024)))
        val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: throw IllegalStateException("cannot read file")
        if (bytes.size > MAX_UPLOAD_BYTES) throw IllegalStateException(getString(R.string.paste_file_too_large, MAX_UPLOAD_BYTES / (1024 * 1024)))
        var name = try {
            cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
            }
        } catch (_: Exception) { null }
        if (name.isNullOrBlank()) name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() && '.' in it }
        if (name.isNullOrBlank()) {
            val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
            name = if (ext != null) "pasted.$ext" else "pasted"
        }
        return name to bytes
    }

    /* ------------------------------- prompt ------------------------------- */

    /** A prompt being written for one terminal; files are read when attached, while access to them is fresh. */
    private class PromptDraft(var text: String = "", var enter: Boolean = true) {
        val files = ArrayList<PromptFile>()
    }

    /** [remotePath] is set once uploaded, so a retry after a failed upload does not send it twice. */
    private class PromptFile(val name: String, val mime: String, val bytes: ByteArray) {
        var remotePath: String? = null
    }

    /**
     * The prompt composer: write a prompt in a proper text box, attach files,
     * and on Send upload the files, type the text and their paths into [s] as
     * one paste, then press Enter if asked. Made for programs that take a
     * prompt — a coding assistant, a chat, a REPL — where the cursor is a
     * cramped place to compose one. A broadcast does not get it: the paths are
     * of files uploaded for this terminal.
     */
    private fun writePrompt(s: TerminalSession, error: String? = null) {
        val context = requireContext()
        val filesOk = app.agents.agent(agentId)?.caps?.contains("files") == true
        val draft = promptDrafts.getOrPut(s.key) { PromptDraft(enter = app.settings.promptEnter) }

        val box = Forms.column(context)
        box.addView(Forms.note(context, getString(R.string.prompt_body)))
        val input = Forms.input(
            context, getString(R.string.prompt_hint), value = draft.text, multiLine = true,
            type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
        )
        if (error != null) input.error = error
        box.addView(input)
        val chips = ChipGroup(context).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = Design.dp(context, 8f) }
        }
        box.addView(Forms.note(context, getString(R.string.prompt_files_hint)))
        box.addView(chips)
        val enter = Forms.checkBox(context, getString(R.string.prompt_enter), draft.enter)
        box.addView(enter)

        fun render() {
            chips.removeAllViews()
            for (f in draft.files) {
                chips.addView(Chip(context).apply {
                    text = f.name
                    isCheckable = false
                    isCloseIconVisible = true
                    closeIconContentDescription = getString(R.string.prompt_remove_file, f.name)
                    setOnCloseIconClickListener { draft.files.remove(f); render() }
                })
            }
            chips.addView(Chip(context).apply {
                text = getString(R.string.attach_file)
                isCheckable = false
                setOnClickListener {
                    if (!filesOk) { input.error = getString(R.string.paste_file_unsupported); return@setOnClickListener }
                    try { pickPromptFiles.launch(arrayOf("*/*")) } catch (_: Exception) { toast(getString(R.string.attach_file_unavailable)) }
                }
            })
            chips.addView(Chip(context).apply {
                text = getString(R.string.prompt_paste_file)
                isCheckable = false
                setOnClickListener {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val found = clipboardFile(cm)
                    if (found == null) toast(getString(R.string.paste_file_none)) else addPromptFiles(draft, listOf(found.first), filesOk, input) { render() }
                }
            })
        }

        promptFilesPicked = { uris -> addPromptFiles(draft, uris, filesOk, input) { render() } }
        // A picture pasted into the box, or sent by the keyboard, arrives as
        // content rather than text: attach it instead of losing it.
        input.editText?.let { edit ->
            ViewCompat.setOnReceiveContentListener(edit, arrayOf("image/*", "video/*", "application/pdf")) { _, payload ->
                val split = payload.partition { it.uri != null }
                val withUri = split.first
                if (withUri != null) {
                    val clip = withUri.clip
                    addPromptFiles(draft, (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }, filesOk, input) { render() }
                }
                split.second
            }
        }
        render()

        val dialog = MaterialAlertDialogBuilder(context)
            .setTitle(R.string.prompt_title)
            .setView(android.widget.ScrollView(context).apply { addView(box) })
            .setPositiveButton(R.string.send, null)
            .setNegativeButton(R.string.cancel, null)
            .setOnDismissListener {
                promptFilesPicked = null
                draft.text = input.text
                draft.enter = enter.isChecked
                app.settings.promptEnter = enter.isChecked
            }
            .show()
        dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        input.editText?.let { it.requestFocus(); it.setSelection(it.text?.length ?: 0) }
        dialog.validateOnPositive {
            input.error = null
            draft.text = input.text
            draft.enter = enter.isChecked
            if (draft.text.isBlank() && draft.files.isEmpty()) {
                input.error = getString(R.string.prompt_empty)
                return@validateOnPositive false
            }
            sendPrompt(s, draft)
            true
        }
    }

    /** Read [uris] now, while this app may, and attach them to [draft]. */
    private fun addPromptFiles(
        draft: PromptDraft, uris: List<Uri>, filesOk: Boolean,
        input: com.google.android.material.textfield.TextInputLayout, done: () -> Unit,
    ) {
        if (!filesOk) { input.error = getString(R.string.paste_file_unsupported); return }
        val cr = requireContext().contentResolver
        viewLifecycleOwner.lifecycleScope.launch {
            for (uri in uris) {
                val mime = try { cr.getType(uri) } catch (_: Exception) { null } ?: DEFAULT_MIME
                val loaded = withContext(Dispatchers.IO) { runCatching { readFile(uri, mime) } }
                loaded.onSuccess { (name, bytes) -> draft.files.add(PromptFile(name, mime, bytes)) }
                    .onFailure { toast(getString(R.string.paste_file_failed, it.message ?: "unreadable")) }
            }
            done()
        }
    }

    /** Upload what is not uploaded yet, then type the prompt; a failure brings the composer back. */
    private fun sendPrompt(s: TerminalSession, draft: PromptDraft) {
        viewLifecycleOwner.lifecycleScope.launch {
            if (s.stream.state != SessionStream.State.ATTACHED) {
                writePrompt(s, getString(R.string.terminal_not_connected)); return@launch
            }
            val todo = draft.files.filter { it.remotePath == null }
            for ((index, f) in todo.withIndex()) {
                uploadLabel = getString(R.string.prompt_uploading, index + 1, todo.size)
                updateStatus()
                val result = app.sessions.sendFile(s, f.name, f.mime, f.bytes)
                val path = result.getOrNull()
                if (path == null) {
                    uploadLabel = null
                    updateStatus()
                    val why = "${f.name}: ${result.exceptionOrNull()?.message ?: "failed"}"
                    writePrompt(s, getString(R.string.paste_file_failed, why))
                    return@launch
                }
                f.remotePath = path
            }
            uploadLabel = null
            updateStatus()

            val text = Prompt.text(draft.text, draft.files.map { it.remotePath })
            val bracketed = s.emulator.bracketedPaste
            val type = {
                if (!app.sessions.input(s, Snippets.toInput(text, false, bracketed))) {
                    writePrompt(s, getString(R.string.terminal_not_connected))
                } else {
                    promptDrafts.remove(s.key)
                    // Enter on its own, a moment later, so a program reading the
                    // paste takes it as a key and not as part of what was pasted.
                    if (draft.enter) viewLifecycleOwner.lifecycleScope.launch { delay(PROMPT_ENTER_DELAY_MS); app.sessions.input(s, "\r") }
                }
            }
            // Without bracketed paste every line would run on its own, as with any paste.
            val lines = text.count { it == '\n' } + 1
            if (lines > 1 && !bracketed) {
                MaterialAlertDialogBuilder(requireContext())
                    .setTitle(getString(R.string.paste_confirm_title, lines))
                    .setMessage(R.string.paste_confirm_text)
                    .setPositiveButton(R.string.paste_confirm_ok) { _, _ -> type() }
                    .setNegativeButton(R.string.cancel) { _, _ -> writePrompt(s) }
                    .show()
            } else type()
        }
    }

    /** Quote a path for a shell only when it needs it (agent-side names are already tame). */
    private fun shellQuote(path: String): String =
        if (path.matches(Regex("^[A-Za-z0-9._/@:+-]+$"))) path else "'" + path.replace("'", "'\\''") + "'"

    private fun toast(text: String) = Toast.makeText(requireContext(), text, Toast.LENGTH_LONG).show()

    /** The terminal menu with every title and visibility matching the visible tab. */
    private fun prepareMenu(menu: android.view.Menu) {
        menu.findItem(R.id.action_command_bar).isChecked = binding.commandBar.visible
        menu.findItem(R.id.action_extra_keys).isChecked = binding.extraKeys.visible
        val s = current
        menu.findItem(R.id.action_pin).title =
            getString(if (s != null && app.settings.isPinnedTerminal(agentId, s.sessionId)) R.string.action_unpin else R.string.action_pin)
        menu.findItem(R.id.action_preset).isVisible = app.settings.presetsFor(agentId).isNotEmpty()
        menu.findItem(R.id.action_broadcast).title =
            getString(if (s != null && s.broadcastTo.isNotEmpty()) R.string.action_broadcast_stop else R.string.action_broadcast)
        menu.findItem(R.id.action_watch).title = getString(
            when {
                s?.watch?.isTrigger == true -> R.string.action_trigger_stop
                s?.watch != null -> R.string.action_watch_stop
                else -> R.string.action_watch
            }
        )
        menu.findItem(R.id.action_quiet).title = getString(if (s?.quietAlert == true) R.string.action_quiet_stop else R.string.action_quiet)
        menu.findItem(R.id.action_record).title = getString(if (s?.isRecording == true) R.string.recording_stop else R.string.recording_start)
    }

    private fun moreMenu(anchor: View) {
        val menu = PopupMenu(requireContext(), anchor)
        menu.menuInflater.inflate(R.menu.menu_terminal, menu.menu)
        prepareMenu(menu.menu)
        menu.setOnMenuItemClickListener { item -> runMenuAction(item.itemId, anchor) }
        menu.show()
    }

    /** One terminal-menu action, from the menu itself or from the command palette. */
    private fun runMenuAction(id: Int, anchor: View): Boolean {
        val term = binding.terminal
        when (id) {
            R.id.action_palette -> openPalette()
            R.id.action_snippets -> openSnippets()
            R.id.action_prompt -> current?.let { writePrompt(it) } ?: toast(getString(R.string.prompt_no_terminal))
            R.id.action_record -> current?.let { toggleRecording(it) }
            R.id.action_new_terminal -> newTerminal()
            R.id.action_duplicate -> duplicateCurrent()
            R.id.action_preset -> choosePreset(anchor)
            R.id.action_save_preset -> current?.let { saveAsPreset(it) }
            R.id.action_rename -> current?.let { renameTab(it) }
            R.id.action_pin -> current?.let { app.settings.togglePinnedTerminal(agentId, it.sessionId) }
            R.id.action_shortcuts -> ShortcutsSheet().show(childFragmentManager, "shortcuts")
            R.id.action_paste -> paste()
            R.id.action_paste_file -> pasteFile(explicit = true)
            R.id.action_attach_file -> attachFile()
            R.id.action_browse_files -> browseFilesHere()
            R.id.action_broadcast -> current?.let { if (it.broadcastTo.isNotEmpty()) { app.sessions.stopBroadcast(it); updateStatus() } else chooseBroadcast(it) }
            R.id.action_watch -> current?.let { if (it.watch != null) app.sessions.clearWatch(it) else chooseWatch(it) }
            R.id.action_quiet -> current?.let { s ->
                val on = !s.quietAlert
                app.sessions.setQuietAlert(s, on)
                if (on) { host.ensureNotificationPermission(); toast(getString(R.string.quiet_armed)) }
            }
            R.id.action_save_transcript -> current?.let { startSaveTranscript(it) }
            R.id.action_share_transcript -> current?.let { shareTranscript(it) }
            R.id.action_theme -> chooseTheme()
            R.id.action_select_all -> term.selectAll()
            R.id.action_clear -> { term.emulator.clearScreen(); term.notifyUpdated() }
            R.id.action_command_bar -> { val v = !binding.commandBar.visible; app.settings.commandBar = v; binding.commandBar.visible = v }
            R.id.action_extra_keys -> { val v = !binding.extraKeys.visible; app.settings.showExtraKeys = v; binding.extraKeys.visible = v }
            R.id.action_close_tab -> current?.let { confirmClose(it) }
            else -> return false
        }
        return true
    }

    /**
     * Another terminal beside this one, in the same directory. The open tab is
     * the freshest source for where the shell is; the relay's copy is the
     * fallback for a tab this phone only just restored.
     */
    private fun duplicateCurrent() {
        val s = current ?: return
        val info = app.agents.session(agentId, s.sessionId)
            ?: com.cactus.remoteterminal.protocol.SessionInfo(
                sessionId = s.sessionId, title = s.title, shell = s.shell, state = s.state,
                createdAt = 0L, lastActiveAt = 0L, cols = 0, rows = 0, seq = 0L, attached = 0,
                exitCode = s.exitCode,
            )
        TerminalStarter.duplicate(this, agentId, info, s.cwd.ifEmpty { info.cwd })
    }

    /** Start one of the saved presets on this machine, without leaving the terminal. */
    private fun choosePreset(anchor: View) {
        val presets = app.settings.presetsFor(agentId)
        if (presets.isEmpty()) { host.openTerminalPresets(); return }
        val menu = PopupMenu(requireContext(), anchor)
        for ((index, preset) in presets.withIndex()) menu.menu.add(0, index, index, preset.name)
        menu.menu.add(0, presets.size, presets.size, getString(R.string.presets_manage))
        menu.setOnMenuItemClickListener { item ->
            if (item.itemId == presets.size) host.openTerminalPresets()
            else TerminalStarter.launch(this, presets[item.itemId], agentId)
            true
        }
        menu.show()
    }

    /**
     * Keep this terminal as a preset: its name, its machine, its shell, where
     * it is **now** and what it last ran. Starting the preset later reproduces
     * this terminal rather than a bare shell, which is the point of saving it
     * from here rather than filling the form in again.
     */
    private fun saveAsPreset(s: TerminalSession) {
        val context = requireContext()
        val directory = s.cwd
        val command = s.command
        val input = EditText(context).apply {
            setText(s.displayTitle); inputType = InputType.TYPE_CLASS_TEXT; setSelection(text.length)
        }
        val detail = listOfNotNull(
            directory.ifEmpty { null }?.let { getString(R.string.preset_from_terminal_dir, it) },
            command.ifEmpty { null }?.let { getString(R.string.preset_from_terminal_command, it) },
        ).joinToString("\n").ifEmpty { getString(R.string.preset_from_terminal_plain) }

        fun preset(name: String) = TerminalPreset(
            id = TerminalPreset.newId(),
            name = name,
            agentId = agentId,
            shellId = s.shell.ifEmpty { null },
            directory = directory,
            command = command,
        )

        MaterialAlertDialogBuilder(context)
            .setTitle(R.string.preset_save_as)
            .setMessage(detail)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isEmpty()) {
                    Toast.makeText(context, R.string.preset_needs_name, Toast.LENGTH_SHORT).show()
                } else {
                    app.settings.savePreset(preset(name))
                    Toast.makeText(context, getString(R.string.preset_saved, name), Toast.LENGTH_SHORT).show()
                }
            }
            // "Edit…" opens the full form with the same values, for a preset
            // that should differ from this terminal in some way.
            .setNeutralButton(R.string.edit) { _, _ ->
                val name = input.text.toString().trim().ifEmpty { s.displayTitle }
                host.openPresetDraft(preset(name))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun renameTab(s: TerminalSession) {
        val input = EditText(requireContext()).apply {
            setText(s.title); inputType = InputType.TYPE_CLASS_TEXT; setSelection(text.length)
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.rename_terminal)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                input.text.toString().trim().takeIf { it.isNotEmpty() }?.let { app.sessions.rename(s, it) }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /* ------------------------------- extras ------------------------------- */

    /** A link in the output was tapped: open it or copy it, never either by surprise. */
    private fun showLink(url: String) {
        val items = ArrayList<ActionSheet.Item>()
        // A file:// link names a file on the machine, not on this phone.
        if (!url.startsWith("file:", ignoreCase = true)) {
            items += ActionSheet.Item(getString(R.string.link_open), R.drawable.ic_rt_globe) {
                try {
                    startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (_: Exception) { toast(getString(R.string.link_cannot_open)) }
            }
        }
        items += ActionSheet.Item(getString(R.string.link_copy), R.drawable.ic_rt_copy) { copy(url) }
        ActionSheet.show(requireContext(), url, null, items)
    }

    /** The file browser at this terminal's directory, with "Insert path" typing into it. */
    private fun browseFilesHere() {
        val agent = app.agents.agent(agentId) ?: return
        val s = current
        MachineActions.openFiles(this, agent, s?.cwd?.ifEmpty { null }, s?.sessionId)
    }

    private fun startSaveTranscript(s: TerminalSession) {
        val text = Transcript.of(s.emulator)
        if (text.isEmpty()) { toast(getString(R.string.transcript_empty)); return }
        pendingTranscript = text
        try { saveTranscript.launch(Transcript.fileName(s.displayTitle)) } catch (_: Exception) {
            pendingTranscript = null
            toast(getString(R.string.attach_file_unavailable))
        }
    }

    private fun writeTranscript(uri: Uri, text: String) {
        val cr = requireContext().contentResolver
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { cr.openOutputStream(uri, "w")?.use { it.write(text.toByteArray(Charsets.UTF_8)) } != null }.getOrDefault(false)
            }
            toast(getString(if (ok) R.string.transcript_saved else R.string.files_cannot_read))
        }
    }

    /** Short transcripts travel as text; long ones as a file, which every target app can take. */
    private fun shareTranscript(s: TerminalSession) {
        val text = Transcript.of(s.emulator)
        if (text.isEmpty()) { toast(getString(R.string.transcript_empty)); return }
        val subject = s.displayTitle
        if (text.length <= SHARE_AS_TEXT_MAX) { Sharing.shareText(requireContext(), text, subject); return }
        val context = requireContext()
        viewLifecycleOwner.lifecycleScope.launch {
            val file = withContext(Dispatchers.IO) {
                Sharing.stagingFile(context, Transcript.fileName(subject)).also { it.writeText(text) }
            }
            Sharing.shareFile(context, file, "text/plain", subject)
        }
    }

    /** Pick the other open terminals that should receive a copy of what is typed here. */
    private fun chooseBroadcast(s: TerminalSession) {
        val candidates = app.sessions.allTabs().filter { it !== s && it.isRunning }
        if (candidates.isEmpty()) { toast(getString(R.string.broadcast_none)); return }
        val multiMachine = candidates.any { it.agentId != agentId }
        val labels = candidates.map { t ->
            val machine = app.agents.agent(t.agentId)?.let { it.name.ifEmpty { it.hostname } } ?: ""
            if (multiMachine) "${t.displayTitle} — $machine" else t.displayTitle
        }.toTypedArray<CharSequence>()
        val checked = BooleanArray(candidates.size) { true }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.broadcast_title)
            .setMultiChoiceItems(labels, checked) { _, which, isChecked -> checked[which] = isChecked }
            .setPositiveButton(R.string.broadcast_start) { _, _ ->
                app.sessions.startBroadcast(s, candidates.filterIndexed { i, _ -> checked[i] })
                updateStatus()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /**
     * "Watch for text…": the text (or a regular expression) and, optionally, a
     * reply typed into this terminal whenever it appears — which makes it a
     * trigger.
     */
    private fun chooseWatch(s: TerminalSession) {
        val context = requireContext()
        val box = Forms.column(context)
        val input = Forms.input(context, getString(R.string.watch_hint))
        val regex = Forms.checkBox(context, getString(R.string.watch_regex), false)
        val keep = Forms.checkBox(context, getString(R.string.watch_keep), false)
        val reply = Forms.input(context, getString(R.string.watch_reply_hint), helper = getString(R.string.watch_reply_help))
        box.addView(input); box.addView(regex); box.addView(keep); box.addView(reply)
        box.addView(Forms.note(context, getString(R.string.watch_reply_warning), warning = true))
        val dialog = MaterialAlertDialogBuilder(context)
            .setTitle(R.string.watch_title)
            .setView(android.widget.ScrollView(context).apply { addView(box) })
            .setPositiveButton(R.string.save, null)
            .setNegativeButton(R.string.cancel, null)
            .show()
        dialog.validateOnPositive {
            val text = input.text
            input.error = null
            if (text.isBlank()) return@validateOnPositive false
            if (regex.isChecked) {
                OutputWatch.regexError(text)?.let { input.error = getString(R.string.watch_regex_invalid, it); return@validateOnPositive false }
            }
            val replyText = reply.text
            app.sessions.setWatch(s, text, keep.isChecked, regex.isChecked, replyText)
            if (replyText.isEmpty()) {
                host.ensureNotificationPermission()
                toast(getString(R.string.watch_armed, text))
            } else toast(getString(R.string.trigger_armed, text))
            true
        }
    }

    /* ------------------------ snippets and palette ------------------------ */

    private fun openSnippets() {
        if (current == null) { toast(getString(R.string.snippet_open_terminal_first)); return }
        SnippetUi.pick(requireContext()) { sendSnippet(it) }
    }

    /** Type a snippet into the visible terminal, asking for its placeholders first. */
    private fun sendSnippet(snippet: com.cactus.remoteterminal.data.Snippet) {
        if (current == null) { toast(getString(R.string.snippet_open_terminal_first)); return }
        SnippetUi.fill(requireContext(), snippet) { text ->
            val b = _binding ?: return@fill
            b.terminal.sendRaw(Snippets.toInput(text, snippet.run, b.terminal.emulator.bracketedPaste))
        }
    }

    /**
     * One search over everything this screen can do: the terminal menu, the
     * snippets, the presets for this machine, the open terminals and the
     * machines.
     */
    private fun openPalette() {
        val context = requireContext()
        val b = _binding ?: return
        val popup = PopupMenu(context, b.moreButton)
        popup.menuInflater.inflate(R.menu.menu_terminal, popup.menu)
        val menu = popup.menu
        prepareMenu(menu)
        val entries = ArrayList<SearchSheet.Entry>()
        for (i in 0 until menu.size()) {
            val item = menu.getItem(i)
            if (!item.isVisible || item.itemId == R.id.action_palette) continue
            val id = item.itemId
            entries += SearchSheet.Entry(item.title.toString(), null, R.drawable.ic_rt_command) {
                _binding?.let { runMenuAction(id, it.moreButton) }
            }
        }
        for (sn in app.settings.snippets) {
            entries += SearchSheet.Entry(getString(R.string.palette_snippet, sn.name), SnippetUi.preview(sn), R.drawable.ic_rt_command) { sendSnippet(sn) }
        }
        for (p in app.settings.presetsFor(agentId)) {
            entries += SearchSheet.Entry(getString(R.string.palette_preset, p.name), p.directory.ifEmpty { null }, R.drawable.ic_rt_bookmark) {
                TerminalStarter.launch(this, p, agentId)
            }
        }
        for (t in app.sessions.allTabs()) {
            if (t === current) continue
            val machine = app.agents.agent(t.agentId)?.let { it.name.ifEmpty { it.hostname } }
            entries += SearchSheet.Entry(getString(R.string.palette_switch, t.displayTitle), machine, R.drawable.ic_rt_terminal_square) {
                if (t.agentId == agentId && t in tabs) selectTab(t) else host.openTerminal(t.agentId, t.sessionId)
            }
        }
        for (m in app.agents.agents.value) {
            val name = m.name.ifEmpty { m.hostname }
            entries += SearchSheet.Entry(getString(R.string.palette_machine, name), Format.machineSubtitle(m), R.drawable.ic_rt_server) {
                host.openMachine(m.agentId)
            }
        }
        SearchSheet.show(
            context,
            hint = getString(R.string.palette_hint),
            emptyText = { getString(R.string.palette_none) },
            results = { q -> FuzzyMatch.rank(entries, q) { it.label } },
        )
    }

    /* ------------------------------ recording ----------------------------- */

    private fun toggleRecording(s: TerminalSession) {
        if (s.isRecording) {
            val meta = app.sessions.stopRecording(s)
            updateStatus()
            if (meta != null) toast(getString(R.string.recording_saved, meta.title))
            return
        }
        val machine = app.agents.agent(agentId)?.let { it.name.ifEmpty { it.hostname } }.orEmpty()
        val recorder = try {
            app.recordings.start(s.displayTitle, machine, s.emulator.cols, s.emulator.rows)
        } catch (e: Exception) {
            toast(e.message ?: getString(R.string.error_generic, "")); return
        }
        app.sessions.startRecording(s, recorder)
        updateStatus()
        toast(getString(R.string.recording_started))
    }

    /* -------------------------- keyboard shortcuts ------------------------ */

    /** A hardware-keyboard shortcut for this screen; false leaves the key to the shell. */
    fun handleHardwareShortcut(event: android.view.KeyEvent): Boolean {
        val b = _binding ?: return false
        val action = HardwareShortcuts.match(event.keyCode, event.isCtrlPressed, event.isShiftPressed, event.isAltPressed) ?: return false
        val term = b.terminal
        when (action) {
            HardwareShortcuts.Action.NEW_TERMINAL -> newTerminal()
            HardwareShortcuts.Action.CLOSE_TAB -> current?.let { confirmClose(it) }
            HardwareShortcuts.Action.NEXT_TAB -> cycleTab(forward = true)
            HardwareShortcuts.Action.PREVIOUS_TAB -> cycleTab(forward = false)
            HardwareShortcuts.Action.COPY -> {
                val text = term.selectedText()
                if (text.isNullOrEmpty()) toast(getString(R.string.kbd_nothing_selected))
                else { copy(text); term.clearSelection() }
            }
            HardwareShortcuts.Action.PASTE -> paste()
            HardwareShortcuts.Action.SEARCH -> toggleSearch(true)
            HardwareShortcuts.Action.PALETTE -> openPalette()
            HardwareShortcuts.Action.SNIPPETS -> openSnippets()
            HardwareShortcuts.Action.ZOOM_IN -> term.setFontSizeSp(term.fontSizeSp() + 1f)
            HardwareShortcuts.Action.ZOOM_OUT -> term.setFontSizeSp(term.fontSizeSp() - 1f)
            HardwareShortcuts.Action.ZOOM_RESET -> term.setFontSizeSp(DEFAULT_FONT_SP)
        }
        return true
    }

    /** Ctrl+Tab / Ctrl+Shift+Tab: the next or previous tab, wrapping round. */
    private fun cycleTab(forward: Boolean) {
        if (tabs.size < 2) return
        val index = tabs.indexOf(current).coerceAtLeast(0)
        selectTab(tabs[(index + if (forward) 1 else tabs.size - 1) % tabs.size])
    }

    /** Called by the shortcuts sheet. */
    fun sendShortcut(bytes: String) = binding.terminal.sendRaw(bytes)
    fun sendCommand(command: String) {
        app.settings.noteCommand(command)
        binding.terminal.sendRaw(command + "\r")
    }

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

        fun submit(list: List<TerminalSession>, current: TerminalSession?) {
            items = list; selected = current; notifyDataSetChanged()
        }

        fun notifyTab(s: TerminalSession) {
            val i = items.indexOf(s)
            if (i >= 0) notifyItemChanged(i)
        }

        override fun getItemCount() = items.size + 1

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemTabBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val ctx = holder.b.root.context
            if (position == items.size) {
                // The "new tab" chip: a plus and nothing else.
                holder.b.tabIcon.setImageResource(R.drawable.ic_rt_plus)
                Design.tint(holder.b.tabIcon, R.color.rt_text_muted)
                holder.b.tabTitle.text = ctx.getString(R.string.terminal_new_tab)
                holder.b.tabTitle.setTextColor(Design.color(ctx, R.color.rt_text_muted))
                holder.b.root.contentDescription = ctx.getString(R.string.new_terminal)
                holder.b.tabClose.visible = false
                holder.b.tabBadge.visible = false
                holder.b.root.isSelected = false
                holder.b.root.alpha = 1f
                holder.b.root.setOnClickListener { onNew() }
                return
            }
            val s = items[position]
            val active = s === selected
            holder.b.tabIcon.setImageResource(R.drawable.ic_rt_terminal_square)
            holder.b.tabTitle.text = s.displayTitle
            holder.b.root.contentDescription = s.displayTitle
            holder.b.tabClose.visible = true
            holder.b.tabClose.contentDescription = ctx.getString(R.string.tab_close)
            holder.b.tabBadge.visible = s.unreadRows > 0 && !active
            holder.b.tabBadge.text = if (s.unreadRows > 99) "99+" else s.unreadRows.toString()
            holder.b.root.isSelected = active
            val fg = Design.color(ctx, if (active) R.color.rt_text else R.color.rt_text_secondary)
            holder.b.tabTitle.setTextColor(fg)
            Design.tintColor(holder.b.tabIcon, Design.color(ctx, if (active) R.color.rt_primary else R.color.rt_text_muted))
            holder.b.tabClose.imageTintList = android.content.res.ColorStateList.valueOf(Design.color(ctx, R.color.rt_text_muted))
            // An exited shell stays readable but visibly inert.
            holder.b.root.alpha = if (s.isRunning) 1f else 0.6f
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                holder.b.root.stateDescription =
                    ctx.getString(if (active) R.string.a11y_selected else R.string.a11y_not_selected)
            }
            holder.b.root.setOnClickListener { onSelect(s) }
            holder.b.tabClose.setOnClickListener { onClose(s) }
        }
    }

    companion object {
        private const val ARG_AGENT = "agent"
        private const val ARG_SESSION = "session"
        /** Matches the agent's default upload cap; larger files are refused before sending. */
        private const val MAX_UPLOAD_BYTES = 16 * 1024 * 1024
        /** What an upload claims to be when the phone cannot say. */
        private const val DEFAULT_MIME = "application/octet-stream"
        /** How long after a prompt Enter waits (see [sendPrompt]). */
        private const val PROMPT_ENTER_DELAY_MS = 150L
        /** Longer transcripts are shared as a file; some apps truncate a long EXTRA_TEXT. */
        private const val SHARE_AS_TEXT_MAX = 64 * 1024
        /** Session argument prefix meaning "create a new terminal with this shell id". */
        const val NEW_SESSION_PREFIX = "new:"
        /** Ctrl+0 goes back to the app's default size. */
        private const val DEFAULT_FONT_SP = 13f
        fun newInstance(agentId: String, sessionId: String?) = TerminalFragment().apply {
            arguments = Bundle().apply { putString(ARG_AGENT, agentId); putString(ARG_SESSION, sessionId) }
        }
    }
}
