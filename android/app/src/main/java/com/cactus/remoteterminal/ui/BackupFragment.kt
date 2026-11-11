package com.cactus.remoteterminal.ui

import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.BuildConfig
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Backup
import com.cactus.remoteterminal.databinding.FragmentToolScreenBinding
import com.cactus.remoteterminal.ui.Forms.text
import com.cactus.remoteterminal.ui.Forms.validateOnPositive
import com.cactus.remoteterminal.ui.design.SettingsBuilder
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Settings → Backup & restore. The file is the same on the phone and the
 * desktop app, so either can import what the other exported.
 */
class BackupFragment : Fragment(), RtScreen {
    private var _binding: FragmentToolScreenBinding? = null
    private val app get() = requireActivity().application as App

    private var pendingJson: String? = null
    private val saveDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val json = pendingJson
        pendingJson = null
        if (uri != null && json != null) write(uri, json)
    }
    private val openDoc = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) read(uri)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentToolScreenBinding.inflate(inflater, container, false)
        return _binding!!.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        ToolScreen.setUp(this, _binding!!, getString(R.string.backup_title), getString(R.string.backup_subtitle))
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.settings.version.collect { render() }
            }
        }
    }

    private fun render() {
        val b = _binding ?: return
        val here = Backup.summary(app.settings.backupData())
        val builder = SettingsBuilder(b.content)
        builder.clear()
        builder.section(getString(R.string.backup_export_group))
            .row(R.drawable.ic_rt_save, R.color.rt_primary, getString(R.string.backup_export_file), getString(R.string.backup_export_file_desc)) { exportToFile() }
            .row(R.drawable.ic_rt_upload, R.color.rt_accent, getString(R.string.backup_share), getString(R.string.backup_share_desc)) { share() }
            .note(getString(R.string.backup_contents, summaryText(here)))
        builder.section(getString(R.string.backup_import_group))
            .row(R.drawable.ic_rt_folder_open, R.color.rt_primary, getString(R.string.backup_import_file), null) {
                try { openDoc.launch(arrayOf("application/json", "text/plain", "application/octet-stream")) } catch (_: Exception) {
                    toast(getString(R.string.attach_file_unavailable))
                }
            }
            .row(R.drawable.ic_rt_copy, R.color.rt_accent, getString(R.string.backup_import_paste), null) { pasteDialog() }
            .note(getString(R.string.backup_never))
        builder.finish()
    }

    private fun summaryText(s: Backup.Summary) = listOf(
        resources.getQuantityString(R.plurals.backup_n_presets, s.presets, s.presets),
        resources.getQuantityString(R.plurals.backup_n_snippets, s.snippets, s.snippets),
        resources.getQuantityString(R.plurals.backup_n_schemes, s.schemes, s.schemes),
        resources.getQuantityString(R.plurals.backup_n_settings, s.settings, s.settings),
    ).joinToString(", ")

    private fun backupJson(): String =
        Backup.build(app.settings.backupData(), "android", BuildConfig.VERSION_NAME, System.currentTimeMillis()).toString(2)

    private fun exportToFile() {
        pendingJson = backupJson()
        try { saveDoc.launch(Backup.fileName(System.currentTimeMillis())) } catch (_: Exception) {
            pendingJson = null
            toast(getString(R.string.attach_file_unavailable))
        }
    }

    private fun share() {
        val context = requireContext()
        val json = backupJson()
        viewLifecycleOwner.lifecycleScope.launch {
            val file = withContext(Dispatchers.IO) {
                Sharing.stagingFile(context, Backup.fileName(System.currentTimeMillis())).also { it.writeText(json) }
            }
            Sharing.shareFile(context, file, "application/json", getString(R.string.backup_title))
        }
    }

    private fun write(uri: Uri, json: String) {
        val cr = requireContext().contentResolver
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { cr.openOutputStream(uri, "w")?.use { it.write(json.toByteArray(Charsets.UTF_8)) } != null }.getOrDefault(false)
            }
            toast(getString(if (ok) R.string.backup_saved else R.string.files_cannot_read))
        }
    }

    private fun read(uri: Uri) {
        val cr = requireContext().contentResolver
        viewLifecycleOwner.lifecycleScope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching {
                    cr.openInputStream(uri)?.use { input ->
                        // A backup is small; anything past a few MiB is not one.
                        val bytes = input.readBytes()
                        if (bytes.size > MAX_BYTES) null else String(bytes, Charsets.UTF_8)
                    }
                }.getOrNull()
            }
            if (text == null) toast(getString(R.string.backup_read_failed)) else confirmImport(text)
        }
    }

    private fun pasteDialog() {
        val context = requireContext()
        val box = Forms.column(context)
        val input = Forms.input(context, getString(R.string.backup_import_paste_hint), multiLine = true, mono = true)
        box.addView(input)
        val dialog = MaterialAlertDialogBuilder(context)
            .setTitle(R.string.backup_import_paste)
            .setView(box)
            .setPositiveButton(R.string.backup_import_title, null)
            .setNegativeButton(R.string.cancel, null)
            .show()
        dialog.validateOnPositive {
            try {
                Backup.parse(input.text)
            } catch (e: IllegalArgumentException) {
                input.error = e.message
                return@validateOnPositive false
            }
            confirmImport(input.text)
            true
        }
    }

    /** Say what the backup holds, then merge or replace. */
    private fun confirmImport(text: String) {
        val incoming = try { Backup.parse(text) } catch (e: IllegalArgumentException) {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.backup_import_title)
                .setMessage(e.message)
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }
        val summary = Backup.summary(incoming)
        if (summary.isEmpty) { toast(getString(R.string.backup_empty)); return }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.backup_import_title)
            .setMessage(summaryText(summary) + "\n\n" + getString(R.string.backup_import_help))
            .setPositiveButton(R.string.backup_merge) { _, _ -> apply(Backup.merge(app.settings.backupData(), incoming)) }
            .setNeutralButton(R.string.backup_replace) { _, _ -> apply(Backup.replace(app.settings.backupData(), incoming)) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun apply(d: Backup.Data) {
        app.settings.applyBackup(d)
        toast(getString(R.string.backup_imported))
    }

    private fun toast(text: String) {
        val c = context ?: return
        Toast.makeText(c, text, Toast.LENGTH_LONG).show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        private const val MAX_BYTES = 8 * 1024 * 1024
    }
}
