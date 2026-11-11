package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Snippets
import com.cactus.remoteterminal.databinding.FragmentToolScreenBinding
import com.cactus.remoteterminal.ui.design.SettingsBuilder
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import kotlinx.coroutines.launch

/**
 * Settings → Snippets: the library grouped by folder, searchable, with a
 * button for a new one. Tapping a snippet edits it (delete is in the editor).
 */
class SnippetsFragment : Fragment(), RtScreen {
    private var _binding: FragmentToolScreenBinding? = null
    private val app get() = requireActivity().application as App
    private var query = ""

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentToolScreenBinding.inflate(inflater, container, false)
        return _binding!!.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = _binding!!
        ToolScreen.setUp(
            this, b, getString(R.string.snippets_title), getString(R.string.snippets_subtitle),
            searchHint = getString(R.string.snippets_search_hint), onSearch = { query = it; render() },
            ctaLabel = getString(R.string.snippets_new), ctaIcon = R.drawable.ic_rt_plus,
            onCta = { SnippetUi.edit(requireContext(), null) },
        )
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.settings.version.collect { render() }
            }
        }
    }

    private fun render() {
        val b = _binding ?: return
        val all = app.settings.snippets
        val shown = Snippets.search(all, query)
        val builder = SettingsBuilder(b.content)
        builder.clear()
        for ((folder, items) in Snippets.grouped(shown)) {
            builder.section(folder.ifEmpty { getString(R.string.snippets_no_folder) })
            for (s in items) {
                builder.row(
                    R.drawable.ic_rt_command, if (s.run) R.color.rt_primary else R.color.rt_accent,
                    s.name, SnippetUi.preview(s),
                    value = getString(if (s.run) R.string.snippet_runs else R.string.snippet_inserts),
                ) { SnippetUi.edit(requireContext(), s) }
            }
        }
        builder.finish()
        when {
            all.isEmpty() -> b.stateBlock.show(
                icon = R.drawable.ic_rt_command,
                title = getString(R.string.snippets_empty_title),
                body = getString(R.string.snippets_empty_body),
            )
            shown.isEmpty() -> b.stateBlock.show(
                icon = R.drawable.ic_rt_search,
                title = getString(R.string.snippets_none_match, query.trim()),
                body = "",
            )
            else -> b.stateBlock.hide()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
