package com.cactus.remoteterminal.ui

import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Recordings
import com.cactus.remoteterminal.databinding.FragmentToolScreenBinding
import com.cactus.remoteterminal.ui.Forms.text
import com.cactus.remoteterminal.ui.Forms.validateOnPositive
import com.cactus.remoteterminal.ui.design.SettingsBuilder
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Settings → Recordings: every terminal recording on this phone, newest
 * first. A recording plays here, or leaves as an asciicast `.cast` file that
 * any asciinema player can show.
 */
class RecordingsFragment : Fragment(), RtScreen {
    private var _binding: FragmentToolScreenBinding? = null
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private var items: List<Recordings.Meta> = emptyList()

    private var pendingExport: Recordings.Meta? = null
    private val exportDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val m = pendingExport
        pendingExport = null
        if (uri != null && m != null) exportTo(m, uri)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentToolScreenBinding.inflate(inflater, container, false)
        return _binding!!.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        ToolScreen.setUp(this, _binding!!, getString(R.string.recordings_title), getString(R.string.recordings_subtitle))
    }

    override fun onResume() {
        super.onResume()
        load()
    }

    private fun load() {
        _binding?.loading?.visible = items.isEmpty()
        viewLifecycleOwner.lifecycleScope.launch {
            items = withContext(Dispatchers.IO) { app.recordings.list() }
            render()
        }
    }

    private fun render() {
        val b = _binding ?: return
        b.loading.visible = false
        val builder = SettingsBuilder(b.content)
        builder.clear()
        if (items.isNotEmpty()) builder.section(getString(R.string.recordings_title))
        for (m in items) {
            builder.row(R.drawable.ic_rt_record, R.color.rt_danger, m.title, metaLine(m)) { open(m) }
        }
        builder.finish()
        if (items.isEmpty()) {
            b.stateBlock.show(
                icon = R.drawable.ic_rt_record,
                title = getString(R.string.recordings_empty_title),
                body = getString(R.string.recordings_empty_body),
            )
        } else b.stateBlock.hide()
    }

    private fun metaLine(m: Recordings.Meta): String {
        val date = DateUtils.formatDateTime(requireContext(), m.startedAt, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH)
        return listOf(m.machine, date, Format.clock(m.durationSec), Format.bytes(m.size))
            .filter { it.isNotEmpty() }
            .joinToString(getString(R.string.recording_meta_separator))
    }

    private fun open(m: Recordings.Meta) {
        ActionSheet.show(
            requireContext(), m.title, metaLine(m),
            listOf(
                ActionSheet.Item(getString(R.string.recording_play), R.drawable.ic_rt_play) { host.openPlayer(m.id) },
                ActionSheet.Item(getString(R.string.recording_share), R.drawable.ic_rt_upload) { share(m) },
                ActionSheet.Item(getString(R.string.recording_export), R.drawable.ic_rt_download) {
                    pendingExport = m
                    try { exportDoc.launch(app.recordings.fileName(m)) } catch (_: Exception) {
                        pendingExport = null
                        toast(getString(R.string.attach_file_unavailable))
                    }
                },
                ActionSheet.Item(getString(R.string.recording_rename), R.drawable.ic_rt_tag) { rename(m) },
                ActionSheet.Item(getString(R.string.recording_delete), R.drawable.ic_rt_trash, danger = true) { confirmDelete(m) },
            ),
        )
    }

    private fun share(m: Recordings.Meta) {
        val context = requireContext()
        viewLifecycleOwner.lifecycleScope.launch {
            val file = withContext(Dispatchers.IO) {
                runCatching {
                    Sharing.stagingFile(context, app.recordings.fileName(m)).also { f -> f.outputStream().use { app.recordings.export(m.id, it) } }
                }.getOrNull()
            }
            if (file == null) toast(getString(R.string.files_cannot_read))
            else Sharing.shareFile(context, file, "application/octet-stream", m.title)
        }
    }

    private fun exportTo(m: Recordings.Meta, uri: Uri) {
        val cr = requireContext().contentResolver
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { cr.openOutputStream(uri, "w")?.use { app.recordings.export(m.id, it) } != null }.getOrDefault(false)
            }
            toast(getString(if (ok) R.string.recording_exported else R.string.files_cannot_read))
        }
    }

    private fun rename(m: Recordings.Meta) {
        val context = requireContext()
        val box = Forms.column(context)
        val input = Forms.input(context, getString(R.string.recording_rename), m.title)
        box.addView(input)
        val dialog = MaterialAlertDialogBuilder(context)
            .setTitle(R.string.recording_rename)
            .setView(box)
            .setPositiveButton(R.string.save, null)
            .setNegativeButton(R.string.cancel, null)
            .show()
        dialog.validateOnPositive {
            val title = input.text.trim()
            if (title.isEmpty()) return@validateOnPositive false
            viewLifecycleOwner.lifecycleScope.launch {
                withContext(Dispatchers.IO) { app.recordings.rename(m.id, title) }
                load()
            }
            true
        }
    }

    private fun confirmDelete(m: Recordings.Meta) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(getString(R.string.recording_delete_title, m.title))
            .setMessage(R.string.recording_delete_body)
            .setPositiveButton(R.string.delete) { _, _ ->
                viewLifecycleOwner.lifecycleScope.launch {
                    withContext(Dispatchers.IO) { app.recordings.delete(m.id) }
                    load()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun toast(text: String) {
        val c = context ?: return
        Toast.makeText(c, text, Toast.LENGTH_LONG).show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
