package com.cactus.remoteterminal.ui

import android.content.Context
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Snippet
import com.cactus.remoteterminal.data.Snippets
import com.cactus.remoteterminal.ui.Forms.text
import com.cactus.remoteterminal.ui.Forms.validateOnPositive
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputLayout

/**
 * The snippet dialogs shared by the manager and the terminal: the editor, the
 * searchable picker, and the fill-in form for placeholders.
 */
object SnippetUi {

    /** Create ([snippet] null) or edit a snippet; [onSaved] after it is stored. */
    fun edit(context: Context, snippet: Snippet?, onSaved: (Snippet) -> Unit = {}) {
        val app = context.applicationContext as App
        val box = Forms.column(context)
        val name = Forms.input(context, context.getString(R.string.snippet_name), snippet?.name.orEmpty())
        val folder = Forms.input(context, context.getString(R.string.snippet_folder), snippet?.folder.orEmpty(), helper = context.getString(R.string.snippet_folder_hint))
        val body = Forms.input(
            context, context.getString(R.string.snippet_body), snippet?.body.orEmpty(),
            helper = context.getString(R.string.snippet_body_help), multiLine = true, mono = true,
        )
        val run = Forms.checkBox(context, context.getString(R.string.snippet_run), snippet?.run ?: true)
        box.addView(name); box.addView(folder); box.addView(body); box.addView(run)

        val builder = MaterialAlertDialogBuilder(context)
            .setTitle(if (snippet == null) R.string.snippets_new else R.string.snippets_edit)
            .setView(android.widget.ScrollView(context).apply { addView(box) })
            .setPositiveButton(R.string.save, null)
            .setNegativeButton(R.string.cancel, null)
        if (snippet != null) builder.setNeutralButton(R.string.delete) { _, _ -> confirmDelete(context, snippet) {} }
        val dialog = builder.show()
        dialog.validateOnPositive {
            name.error = null; body.error = null
            when {
                name.text.isBlank() -> { name.error = context.getString(R.string.snippet_name_required); false }
                body.text.isEmpty() -> { body.error = context.getString(R.string.snippet_body_required); false }
                else -> {
                    val saved = Snippet(
                        id = snippet?.id ?: Snippet.newId(),
                        name = name.text.trim(),
                        folder = folder.text.trim(),
                        body = body.text,
                        run = run.isChecked,
                    )
                    app.settings.saveSnippet(saved)
                    onSaved(saved)
                    true
                }
            }
        }
    }

    fun confirmDelete(context: Context, snippet: Snippet, onDeleted: () -> Unit) {
        val app = context.applicationContext as App
        MaterialAlertDialogBuilder(context)
            .setTitle(context.getString(R.string.snippet_delete_title, snippet.name))
            .setMessage(R.string.snippet_delete_body)
            .setPositiveButton(R.string.delete) { _, _ -> app.settings.deleteSnippet(snippet.id); onDeleted() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** A line under a snippet's name: where it is filed and the start of what it sends. */
    fun detail(s: Snippet): String =
        listOfNotNull(s.folder.ifEmpty { null }, preview(s)).joinToString("  ·  ")

    /** The first line of what a snippet sends, with an ellipsis when there is more. */
    fun preview(s: Snippet): String {
        val first = s.body.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
        return if (s.body.trim().contains('\n')) "$first …" else first
    }

    /** The searchable picker; [onPick] gets the chosen snippet. */
    fun pick(context: Context, onPick: (Snippet) -> Unit) {
        val app = context.applicationContext as App
        SearchSheet.show(
            context,
            hint = context.getString(R.string.snippets_search_hint),
            emptyText = { q ->
                if (q.isEmpty()) context.getString(R.string.snippets_empty_title) else context.getString(R.string.snippets_none_match, q)
            },
            results = { q ->
                val all = app.settings.snippets
                val shown = if (q.isBlank()) Snippets.grouped(all).flatMap { it.second }
                else com.cactus.remoteterminal.data.FuzzyMatch.rank(all, q) { "${it.name} ${it.folder} ${it.body}" }
                shown.map { s -> SearchSheet.Entry(s.name, detail(s), R.drawable.ic_rt_command) { onPick(s) } }
            },
            footer = SearchSheet.Entry(context.getString(R.string.snippets_new), null, R.drawable.ic_rt_plus) {
                edit(context, null) { onPick(it) }
            },
        )
    }

    /**
     * The text to send for [snippet]: straight away when it has no
     * placeholders, otherwise after the fill-in form (prefilled with what was
     * typed last time, or the defaults).
     */
    fun fill(context: Context, snippet: Snippet, onReady: (String) -> Unit) {
        val fields = Snippets.fields(snippet.body)
        if (fields.isEmpty()) { onReady(Snippets.fill(snippet.body, emptyMap())); return }
        val app = context.applicationContext as App
        val last = app.settings.snippetValues(snippet.id)
        val box = Forms.column(context)
        val inputs = LinkedHashMap<String, TextInputLayout>()
        for (f in fields) {
            val input = Forms.input(context, f.name, last[f.name] ?: f.default)
            inputs[f.name] = input
            box.addView(input)
        }
        val dialog = MaterialAlertDialogBuilder(context)
            .setTitle(context.getString(R.string.snippet_fill_title, snippet.name))
            .setView(android.widget.ScrollView(context).apply { addView(box) })
            .setPositiveButton(if (snippet.run) R.string.snippet_send else R.string.snippet_insert, null)
            .setNegativeButton(R.string.cancel, null)
            .show()
        dialog.validateOnPositive {
            val values = inputs.mapValues { it.value.text }
            app.settings.setSnippetValues(snippet.id, values)
            onReady(Snippets.fill(snippet.body, values))
            true
        }
    }
}
