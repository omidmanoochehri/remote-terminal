package com.cactus.remoteterminal.ui

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import com.cactus.remoteterminal.R
import java.io.File

/**
 * Handing files to other apps: a file downloaded from a machine, a terminal
 * transcript. They are staged in the cache's `shared/` folder — the only place
 * the FileProvider exposes — and each share replaces the last, so the cache
 * never collects copies.
 */
object Sharing {

    /** A fresh, empty staging file called [name] (the folder is cleared first). */
    fun stagingFile(context: Context, name: String): File {
        val dir = File(context.cacheDir, "shared")
        dir.mkdirs()
        dir.listFiles()?.forEach { it.delete() }
        val safe = name.replace(Regex("[/\\\\\u0000-\u001F]"), "_").ifEmpty { "file" }
        return File(dir, safe)
    }

    fun mimeFor(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    fun shareFile(context: Context, file: File, mime: String = mimeFor(file.name), subject: String? = null) {
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            if (subject != null) putExtra(Intent.EXTRA_SUBJECT, subject)
            clipData = ClipData.newRawUri(file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        start(context, Intent.createChooser(send, null))
    }

    fun shareText(context: Context, text: String, subject: String?) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            if (subject != null) putExtra(Intent.EXTRA_SUBJECT, subject)
        }
        start(context, Intent.createChooser(send, null))
    }

    private fun start(context: Context, intent: Intent) {
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, R.string.link_cannot_open, Toast.LENGTH_SHORT).show()
        }
    }
}
