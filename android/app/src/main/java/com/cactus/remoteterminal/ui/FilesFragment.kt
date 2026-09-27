package com.cactus.remoteterminal.ui

import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.RemoteError
import com.cactus.remoteterminal.databinding.FragmentFilesBinding
import com.cactus.remoteterminal.databinding.ItemFileRowBinding
import com.cactus.remoteterminal.protocol.AgentCaps
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.protocol.FsEntry
import com.cactus.remoteterminal.protocol.FsListing
import com.cactus.remoteterminal.protocol.FsPaths
import com.cactus.remoteterminal.protocol.SessionStream
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume

/**
 * A machine's files, one folder at a time (agent requests `fs.*`). Folders
 * open in place; a file offers View / Download / Share / Copy path / Rename /
 * Delete, and — when the browser was opened from a terminal — Insert path,
 * which types the path at that terminal's cursor. Transfers stream a slice at a
 * time in both directions and can be cancelled.
 */
class FilesFragment : Fragment(), RtScreen {

    private var _binding: FragmentFilesBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!
    /** The terminal this browser was opened from, for "Insert path". */
    private val fromSession: String? get() = requireArguments().getString(ARG_SESSION)

    private var listing: FsListing? = null
    private var path: String? = null
    private var sort = FsPaths.Sort.NAME
    private var showHidden = false
    private var filter = ""
    private var loadJob: Job? = null
    /** Presence last seen, so a machine coming back online reloads the folder by itself. */
    private var wasOnline: Boolean? = null
    private var transferJob: Job? = null
    /** Remote path chosen for "Download", waiting for the system file picker. */
    private var pendingDownload: String? = null
    private lateinit var adapter: Adapter

    private val createDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val remote = pendingDownload
        pendingDownload = null
        if (uri != null && remote != null) downloadTo(remote, uri)
    }

    private val pickUploads = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) upload(uris)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentFilesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding
        b.headerBar.root.padForStatusBar()
        b.list.padForNavigationBar()

        savedInstanceState?.let {
            path = it.getString(STATE_PATH)
            sort = FsPaths.Sort.valueOf(it.getString(STATE_SORT, sort.name))
            showHidden = it.getBoolean(STATE_HIDDEN, false)
            pendingDownload = it.getString(STATE_PENDING)
        }
        if (path == null && savedInstanceState == null) path = requireArguments().getString(ARG_PATH)

        b.headerBar.headerTitle.setText(R.string.files_title)
        b.headerBar.backButton.setOnClickListener { requireActivity().onBackPressedDispatcher.onBackPressed() }
        b.headerBar.headerAction.visible = true
        b.headerBar.headerAction.setImageResource(R.drawable.ic_rt_upload)
        b.headerBar.headerAction.contentDescription = getString(R.string.files_upload)
        b.headerBar.headerAction.setOnClickListener { chooseUploads() }
        b.headerBar.headerOverflow.setOnClickListener { overflow(it) }

        b.upButton.setOnClickListener { listing?.parent?.let { load(it) } }
        b.refreshButton.setOnClickListener { load(listing?.path ?: path) }
        b.searchBar.searchInput.setHint(R.string.files_filter_hint)
        b.searchBar.searchInput.doAfterTextChanged {
            filter = it?.toString() ?: ""
            b.searchBar.searchClear.visible = filter.isNotEmpty()
            render()
        }
        b.searchBar.searchClear.setOnClickListener { b.searchBar.searchInput.setText("") }
        b.transfer.transferCancel.setOnClickListener { transferJob?.cancel() }

        adapter = Adapter(onOpen = { open(it) }, onMenu = { showEntrySheet(it) })
        b.list.layoutManager = LinearLayoutManager(requireContext())
        b.list.adapter = adapter

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.collect { agents ->
                    val agent = agents.firstOrNull { it.agentId == agentId }
                    if (agent == null) { requireActivity().onBackPressedDispatcher.onBackPressed(); return@collect }
                    b.headerBar.headerSubtitle.text = machineName(agent)
                    // Metrics move this flow every few seconds; only a change of
                    // presence (or the first look) is worth asking the machine again.
                    val changed = wasOnline != agent.online
                    wasOnline = agent.online
                    if (changed && (listing == null || agent.online) && loadJob?.isActive != true) load(listing?.path ?: path)
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_PATH, listing?.path ?: path)
        outState.putString(STATE_SORT, sort.name)
        outState.putBoolean(STATE_HIDDEN, showHidden)
        outState.putString(STATE_PENDING, pendingDownload)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private fun agent(): AgentInfo? = app.agents.agent(agentId)
    private fun machineName(a: AgentInfo? = agent()) = a?.let { it.name.ifEmpty { it.hostname } } ?: ""

    /** Why the browser cannot be used right now, or null when it can. */
    private fun unavailable(): String? {
        val a = agent() ?: return getString(R.string.tool_machine_offline, "")
        if (!a.online) return getString(R.string.tool_machine_offline, machineName(a))
        if (!AgentCaps.files(app.client.relayCaps, a)) return getString(R.string.tool_files_unsupported)
        return null
    }

    /* ------------------------------- listing ------------------------------ */

    private fun load(target: String?) {
        val b = _binding ?: return
        val why = unavailable()
        if (why != null) {
            listing = null
            adapter.submit(emptyList())
            b.loading.visible = false
            b.stateBlock.show(icon = R.drawable.ic_rt_wifi_off, title = getString(R.string.tool_files), body = why)
            renderCrumbs()
            return
        }
        loadJob?.cancel()
        b.loading.visible = listing == null
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            try {
                val result = app.remote.list(agentId, target)
                path = result.path
                listing = result
                render()
            } catch (e: RemoteError) {
                // A terminal's directory can be outside the browsable folder (or
                // gone): fall back to the root rather than a dead end.
                if (target != null && listing == null && (e.code == "forbidden" || e.code == "not_found")) {
                    path = null
                    loadJob = null
                    load(null)
                    return@launch
                }
                showError(e.message ?: e.code)
            } finally {
                _binding?.loading?.visible = false
            }
        }
    }

    private fun showError(message: String) {
        val b = _binding ?: return
        if (listing == null) {
            adapter.submit(emptyList())
            b.stateBlock.show(
                icon = R.drawable.ic_rt_alert, title = getString(R.string.files_error_title), body = message,
                actionLabel = R.string.retry_now, actionIcon = R.drawable.ic_rt_refresh, iconTint = R.color.rt_amber,
            ) { load(path) }
        } else toast(message)
    }

    private fun render() {
        val b = _binding ?: return
        renderCrumbs()
        val l = listing ?: return
        val shown = FsPaths.arrange(l.entries, sort, showHidden, filter)
        adapter.submit(shown)
        b.truncatedNote.visible = l.truncated
        b.upButton.isEnabled = l.parent != null
        b.upButton.alpha = if (l.parent != null) 1f else 0.4f
        when {
            shown.isNotEmpty() -> b.stateBlock.hide()
            filter.isNotBlank() -> b.stateBlock.show(icon = R.drawable.ic_rt_search, title = getString(R.string.files_no_match, filter.trim()), body = "")
            else -> b.stateBlock.show(
                icon = R.drawable.ic_rt_folder_open, title = getString(R.string.files_empty), body = getString(R.string.files_empty_body),
                actionLabel = R.string.files_upload, actionIcon = R.drawable.ic_rt_upload,
            ) { chooseUploads() }
        }
    }

    private fun renderCrumbs() {
        val b = _binding ?: return
        val row = b.crumbRow
        row.removeAllViews()
        val l = listing ?: return
        val crumbs = FsPaths.breadcrumbs(l.path, l.root, l.sep)
        for ((i, crumb) in crumbs.withIndex()) {
            if (i > 0) row.addView(TextView(requireContext()).apply {
                setTextAppearance(R.style.RtText_RowMeta)
                text = "›"
                setPadding(Design.dp(context, 5f), 0, Design.dp(context, 5f), 0)
            })
            val last = i == crumbs.size - 1
            row.addView(TextView(requireContext()).apply {
                setTextAppearance(if (last) R.style.RtText_RowTitle else R.style.RtText_RowMeta)
                text = crumb.label
                maxLines = 1
                setPadding(Design.dp(context, 4f), Design.dp(context, 8f), Design.dp(context, 4f), Design.dp(context, 8f))
                if (!last) {
                    setTextColor(Design.color(context, R.color.rt_primary))
                    setOnClickListener { load(crumb.path) }
                }
            })
        }
        b.crumbScroll.post { b.crumbScroll.fullScroll(HorizontalScrollView.FOCUS_RIGHT) }
    }

    private fun childPath(entry: FsEntry): String {
        val l = listing!!
        return FsPaths.child(l.path, entry.name, l.sep)
    }

    private fun open(entry: FsEntry) {
        if (entry.isDir) load(childPath(entry)) else showEntrySheet(entry)
    }

    /* ------------------------------- actions ------------------------------ */

    private fun showEntrySheet(entry: FsEntry) {
        val full = childPath(entry)
        val items = ArrayList<ActionSheet.Item>()
        if (entry.isDir) {
            items += ActionSheet.Item(getString(R.string.files_open), R.drawable.ic_rt_folder_open) { load(full) }
            items += ActionSheet.Item(getString(R.string.files_open_terminal_here), R.drawable.ic_rt_terminal) { TerminalStarter.openIn(this, agentId, full) }
        } else {
            items += ActionSheet.Item(getString(R.string.files_view), R.drawable.ic_rt_search) { view(entry, full) }
            items += ActionSheet.Item(getString(R.string.files_download), R.drawable.ic_rt_download) { chooseDownload(entry, full) }
            items += ActionSheet.Item(getString(R.string.files_share), R.drawable.ic_rt_send) { share(entry, full) }
        }
        items += ActionSheet.Item(getString(R.string.files_copy_path), R.drawable.ic_rt_copy) { MachineActions.copy(requireContext(), full) }
        insertTarget()?.let { s ->
            items += ActionSheet.Item(getString(R.string.files_insert_path), R.drawable.ic_rt_terminal_square) {
                if (app.sessions.input(s, TerminalStarter.shellQuote(full))) toast(getString(R.string.files_path_inserted))
                else toast(getString(R.string.terminal_not_connected))
            }
        }
        items += ActionSheet.Item(getString(R.string.files_rename), R.drawable.ic_rt_tag) { rename(entry, full) }
        items += ActionSheet.Item(getString(R.string.files_delete), R.drawable.ic_rt_trash, danger = true) { confirmDelete(entry, full) }
        ActionSheet.show(requireContext(), entry.name, full, items)
    }

    /** The terminal "Insert path" types into: the one this browser was opened from, while it is attached. */
    private fun insertTarget(): com.cactus.remoteterminal.data.TerminalSession? {
        val sid = fromSession ?: return null
        val s = app.sessions.find(agentId, sid) ?: return null
        return if (s.isRunning && s.stream.state == SessionStream.State.ATTACHED) s else null
    }

    private fun overflow(anchor: View) {
        val menu = PopupMenu(requireContext(), anchor)
        menu.menu.add(0, 1, 0, R.string.files_upload)
        menu.menu.add(0, 2, 1, R.string.files_new_folder)
        menu.menu.add(0, 3, 2, R.string.files_open_terminal_here)
        menu.menu.add(0, 4, 3, R.string.files_show_hidden).apply { isCheckable = true; isChecked = showHidden }
        menu.menu.add(0, 5, 4, R.string.files_sort)
        menu.menu.add(0, 6, 5, R.string.refresh)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> chooseUploads()
                2 -> newFolder()
                3 -> listing?.let { TerminalStarter.openIn(this, agentId, it.path) }
                4 -> { showHidden = !showHidden; render() }
                5 -> chooseSort()
                6 -> load(listing?.path ?: path)
            }
            true
        }
        menu.show()
    }

    private fun chooseSort() {
        val labels = arrayOf<CharSequence>(getString(R.string.files_sort_name), getString(R.string.files_sort_size), getString(R.string.files_sort_modified))
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.files_sort)
            .setSingleChoiceItems(labels, sort.ordinal) { d, which -> sort = FsPaths.Sort.values()[which]; render(); d.dismiss() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun askName(title: Int, initial: String, onName: (String) -> Unit) {
        val input = EditText(requireContext()).apply {
            setText(initial)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setHint(R.string.files_new_folder_hint)
            // Select the name without its extension, the part people rename.
            val dot = initial.lastIndexOf('.')
            if (dot > 0) setSelection(0, dot) else setSelection(initial.length)
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(title)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty() && name != initial) onName(name)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun newFolder() {
        val l = listing ?: return
        askName(R.string.files_new_folder, "") { name ->
            mutate { app.remote.mkdir(agentId, FsPaths.child(l.path, name, l.sep)) }
        }
    }

    private fun rename(entry: FsEntry, full: String) {
        val l = listing ?: return
        askName(R.string.files_rename, entry.name) { name ->
            mutate { app.remote.rename(agentId, full, FsPaths.child(l.path, name, l.sep)) }
        }
    }

    private fun confirmDelete(entry: FsEntry, full: String) {
        val body = if (entry.isDir) R.string.files_delete_folder_body else R.string.files_delete_file_body
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.files_delete_title, entry.name))
            .setMessage(getString(body, machineName()))
            .setPositiveButton(R.string.files_delete) { _, _ -> mutate { app.remote.delete(agentId, full, recursive = entry.isDir) } }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Run a change on the machine, say why if it was refused, and show the folder as it now is. */
    private fun mutate(block: suspend () -> Unit) {
        viewLifecycleOwner.lifecycleScope.launch {
            try { block() } catch (e: RemoteError) { toast(e.message ?: e.code) }
            load(listing?.path ?: path)
        }
    }

    /* ------------------------------ transfers ----------------------------- */

    private fun showTransfer(label: String?, done: Long = 0, total: Long = 0) {
        val t = _binding?.transfer ?: return
        t.transferBar.visible = label != null
        if (label == null) return
        t.transferLabel.text = label
        t.transferProgress.isIndeterminate = total <= 0
        if (total > 0) t.transferProgress.progress = ((done * 1000) / total).toInt().coerceIn(0, 1000)
        t.transferDetail.text = if (total > 0) getString(R.string.files_progress, Format.bytes(done), Format.bytes(total)) else Format.bytes(done)
    }

    /** One transfer at a time; a second waits for the user to cancel or finish the first. */
    private fun startTransfer(block: suspend () -> Unit) {
        if (transferJob?.isActive == true) return
        transferJob = lifecycleScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                toast(getString(R.string.files_cancelled))
                throw e
            } catch (e: RemoteError) {
                toast(e.message ?: e.code)
            } catch (e: Exception) {
                toast(getString(R.string.files_failed, e.message ?: e.javaClass.simpleName))
            } finally {
                showTransfer(null)
            }
        }
    }

    private fun chooseDownload(entry: FsEntry, full: String) {
        pendingDownload = full
        try { createDocument.launch(entry.name) } catch (_: Exception) { pendingDownload = null; toast(getString(R.string.attach_file_unavailable)) }
    }

    private fun downloadTo(remote: String, uri: Uri) {
        val name = listing?.let { FsPaths.name(remote, it.sep) } ?: remote
        startTransfer {
            val out = withContext(Dispatchers.IO) { requireContext().contentResolver.openOutputStream(uri, "w") }
                ?: throw IllegalStateException(getString(R.string.files_cannot_read))
            try {
                showTransfer(getString(R.string.files_downloading, name))
                app.remote.download(agentId, remote, out) { done, total -> showTransfer(getString(R.string.files_downloading, name), done, total) }
            } catch (e: Throwable) {
                // A half-written copy is worse than none.
                withContext(Dispatchers.IO) { runCatching { out.close() }; runCatching { android.provider.DocumentsContract.deleteDocument(requireContext().contentResolver, uri) } }
                throw e
            }
            withContext(Dispatchers.IO) { out.close() }
            toast(getString(R.string.files_downloaded, name))
        }
    }

    private fun share(entry: FsEntry, full: String) {
        startTransfer {
            val file = Sharing.stagingFile(requireContext(), entry.name)
            showTransfer(getString(R.string.files_downloading, entry.name))
            withContext(Dispatchers.IO) { file.outputStream() }.use { out ->
                app.remote.download(agentId, full, out) { done, total -> showTransfer(getString(R.string.files_downloading, entry.name), done, total) }
            }
            Sharing.shareFile(requireContext(), file)
        }
    }

    private fun view(entry: FsEntry, full: String) {
        val image = FsPaths.isImage(entry.name)
        val limit = if (image) MAX_VIEW_IMAGE else MAX_VIEW_TEXT
        if (entry.size > limit) { toast(getString(R.string.files_too_large_to_view)); return }
        startTransfer {
            showTransfer(getString(R.string.files_downloading, entry.name))
            val buf = ByteArrayOutputStream()
            app.remote.download(agentId, full, buf) { done, total -> showTransfer(getString(R.string.files_downloading, entry.name), done, total) }
            val bytes = buf.toByteArray()
            if (image) {
                val bitmap = withContext(Dispatchers.Default) { decodeScaled(bytes) }
                if (bitmap == null) { toast(getString(R.string.files_cannot_read)); return@startTransfer }
                val iv = ImageView(requireContext()).apply { setImageBitmap(bitmap); adjustViewBounds = true }
                MaterialAlertDialogBuilder(requireContext()).setTitle(entry.name).setView(iv).setPositiveButton(R.string.close, null).show()
            } else {
                if (!FsPaths.looksLikeText(bytes)) { toast(getString(R.string.files_not_text)); return@startTransfer }
                val text = String(bytes, Charsets.UTF_8)
                val tv = TextView(requireContext()).apply {
                    setTextAppearance(R.style.RtText_Mono)
                    textSize = 11f
                    setTextIsSelectable(true)
                    this.text = text
                    val p = Design.dp(context, 16f)
                    setPadding(p, p / 2, p, p)
                }
                val scroll = ScrollView(requireContext()).apply { addView(tv) }
                MaterialAlertDialogBuilder(requireContext()).setTitle(entry.name).setView(scroll).setPositiveButton(R.string.close, null).show()
            }
        }
    }

    /** Decode no larger than the screen needs; a 48-megapixel photo would not fit in memory otherwise. */
    private fun decodeScaled(bytes: ByteArray): android.graphics.Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= 1600 || bounds.outHeight / (sample * 2) >= 1600) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun chooseUploads() {
        if (unavailable() != null || listing == null) { toast(unavailable() ?: getString(R.string.terminal_not_connected)); return }
        try { pickUploads.launch(arrayOf("*/*")) } catch (_: Exception) { toast(getString(R.string.attach_file_unavailable)) }
    }

    private fun upload(uris: List<Uri>) {
        val l = listing ?: return
        val dir = l.path
        startTransfer {
            val cr = requireContext().contentResolver
            var sent = 0
            for (uri in uris) {
                val (name, size) = withContext(Dispatchers.IO) { describe(uri) }
                val target = FsPaths.child(dir, name, l.sep)
                var overwrite = false
                while (true) {
                    val input = withContext(Dispatchers.IO) { cr.openInputStream(uri) } ?: throw IllegalStateException(getString(R.string.files_cannot_read))
                    try {
                        showTransfer(getString(R.string.files_uploading, name), 0, size)
                        app.remote.upload(agentId, target, input, size, overwrite) { done, total -> showTransfer(getString(R.string.files_uploading, name), done, total) }
                        sent++
                        break
                    } catch (e: RemoteError) {
                        if (e.code != "exists" || overwrite) throw e
                        if (!askReplace(name)) break
                        overwrite = true
                    } finally {
                        withContext(Dispatchers.IO) { runCatching { input.close() } }
                    }
                }
            }
            if (sent > 0) toast(getString(R.string.files_uploaded, if (uris.size == 1) describeName(uris[0]) else resources.getQuantityString(R.plurals.files_count, sent, sent)))
            load(listing?.path ?: dir)
        }
    }

    private suspend fun askReplace(name: String): Boolean = suspendCancellableCoroutine { cont ->
        val dialog = MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.files_exists_title, name))
            .setPositiveButton(R.string.files_replace) { _, _ -> if (cont.isActive) cont.resume(true) }
            .setNegativeButton(R.string.files_skip) { _, _ -> if (cont.isActive) cont.resume(false) }
            .setOnCancelListener { if (cont.isActive) cont.resume(false) }
            .show()
        cont.invokeOnCancellation { dialog.dismiss() }
    }

    private fun describeName(uri: Uri): String = describe(uri).first

    /** Display name and size (-1 when the provider cannot say) of a picked document. */
    private fun describe(uri: Uri): Pair<String, Long> {
        var name: String? = null
        var size = -1L
        try {
            requireContext().contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    if (!c.isNull(0)) name = c.getString(0)
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        } catch (_: Exception) { /* fall back below */ }
        val fallback = uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { null } ?: "upload"
        return (name?.takeIf { it.isNotBlank() } ?: fallback).replace('/', '_').replace('\\', '_') to size
    }

    private fun toast(text: String) {
        val c = context ?: return
        Toast.makeText(c, text, Toast.LENGTH_LONG).show()
    }

    /* -------------------------------- adapter ----------------------------- */

    private inner class Adapter(
        private val onOpen: (FsEntry) -> Unit,
        private val onMenu: (FsEntry) -> Unit,
    ) : RecyclerView.Adapter<Adapter.VH>() {
        private var items: List<FsEntry> = emptyList()

        inner class VH(val b: ItemFileRowBinding) : RecyclerView.ViewHolder(b.root)

        fun submit(list: List<FsEntry>) { items = list; notifyDataSetChanged() }

        override fun getItemCount() = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemFileRowBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val e = items[position]
            val ctx = holder.b.root.context
            holder.b.fileName.text = e.name
            holder.b.fileName.alpha = if (e.hidden) 0.7f else 1f
            val icon = when {
                e.isDir -> R.drawable.ic_rt_folder
                e.link -> R.drawable.ic_rt_link
                else -> R.drawable.ic_rt_file
            }
            holder.b.fileIcon.setImageResource(icon)
            Design.tint(holder.b.fileIcon, if (e.isDir) R.color.rt_primary else R.color.rt_text_secondary)
            val kind = when {
                e.isDir -> ctx.getString(R.string.files_folder)
                e.isFile -> Format.bytes(e.size)
                else -> ctx.getString(R.string.files_link)
            }
            holder.b.fileMeta.text = if (e.mtime > 0) ctx.getString(R.string.files_meta, kind, Format.relativeTime(ctx, e.mtime)) else kind
            holder.b.root.contentDescription = "${e.name}, ${holder.b.fileMeta.text}"
            holder.b.row.setOnClickListener { onOpen(e) }
            holder.b.row.setOnLongClickListener { onMenu(e); true }
            holder.b.fileMenu.setOnClickListener { onMenu(e) }
        }
    }

    companion object {
        private const val ARG_AGENT = "agent"
        private const val ARG_PATH = "path"
        private const val ARG_SESSION = "session"
        private const val STATE_PATH = "path"
        private const val STATE_SORT = "sort"
        private const val STATE_HIDDEN = "hidden"
        private const val STATE_PENDING = "pending_download"
        private const val MAX_VIEW_TEXT = 1024L * 1024
        private const val MAX_VIEW_IMAGE = 16L * 1024 * 1024

        /** [path] null opens the browsable root; [sessionId] enables "Insert path" into that terminal. */
        fun newInstance(agentId: String, path: String?, sessionId: String?) = FilesFragment().apply {
            arguments = Bundle().apply {
                putString(ARG_AGENT, agentId)
                putString(ARG_PATH, path)
                putString(ARG_SESSION, sessionId)
            }
        }
    }
}
