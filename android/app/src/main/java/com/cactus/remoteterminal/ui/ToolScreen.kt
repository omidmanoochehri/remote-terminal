package com.cactus.remoteterminal.ui

import android.view.inputmethod.InputMethodManager
import androidx.annotation.DrawableRes
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import com.cactus.remoteterminal.databinding.FragmentToolScreenBinding
import com.cactus.remoteterminal.ui.design.visible

/**
 * The frame of a tool screen built on `fragment_tool_screen.xml`: header,
 * safe areas, the optional filter field and the optional bottom button.
 * Screens then fill [FragmentToolScreenBinding.content].
 */
object ToolScreen {

    fun setUp(
        fragment: Fragment,
        b: FragmentToolScreenBinding,
        title: CharSequence,
        subtitle: CharSequence?,
        searchHint: String? = null,
        onSearch: ((String) -> Unit)? = null,
        ctaLabel: String? = null,
        @DrawableRes ctaIcon: Int? = null,
        onCta: (() -> Unit)? = null,
    ) {
        b.headerBar.root.padForStatusBar()
        b.headerBar.headerTitle.text = title
        b.headerBar.headerSubtitle.text = subtitle ?: ""
        b.headerBar.headerSubtitle.visible = !subtitle.isNullOrEmpty()
        b.headerBar.headerOverflow.visible = false
        b.headerBar.backButton.setOnClickListener { fragment.requireActivity().onBackPressedDispatcher.onBackPressed() }

        if (onCta != null && ctaLabel != null) {
            b.ctaButton.visible = true
            b.ctaLabel.text = ctaLabel
            ctaIcon?.let { b.ctaIcon.setImageResource(it) }
            b.ctaButton.contentDescription = ctaLabel
            b.ctaButton.setOnClickListener { onCta() }
            b.ctaButton.marginForNavigationBar()
        } else {
            b.scroll.padForNavigationBar(ime = true)
        }

        if (onSearch != null) {
            b.searchBar.root.visible = true
            b.searchBar.searchInput.hint = searchHint
            b.searchBar.searchInput.doAfterTextChanged {
                val q = it?.toString().orEmpty()
                b.searchBar.searchClear.visible = q.isNotEmpty()
                onSearch(q)
            }
            b.searchBar.searchClear.setOnClickListener { b.searchBar.searchInput.setText("") }
            (b.searchBar.root.layoutParams as? android.view.ViewGroup.MarginLayoutParams)?.let {
                it.bottomMargin = com.cactus.remoteterminal.ui.design.Design.dp(fragment.requireContext(), 6f)
                b.searchBar.root.layoutParams = it
            }
        }
    }

    fun hideKeyboard(fragment: Fragment) {
        val view = fragment.view ?: return
        fragment.requireContext().getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
    }
}
