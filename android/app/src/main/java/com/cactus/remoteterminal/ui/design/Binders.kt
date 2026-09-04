package com.cactus.remoteterminal.ui.design

import android.view.View
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.ViewConnectionBannerBinding
import com.cactus.remoteterminal.databinding.ViewScreenHeaderBinding
import com.cactus.remoteterminal.databinding.ViewStateBlockBinding
import com.cactus.remoteterminal.net.RelayClient
import com.cactus.remoteterminal.ui.Format

/**
 * Binding helpers for the shared chrome. They exist so no screen re-implements
 * the header, the offline strip or the empty/error block: one place decides
 * how those look and how they behave.
 */

/** Configure the top-level header. Actions with no handler are hidden. */
fun ViewScreenHeaderBinding.bind(
    title: CharSequence,
    subtitle: CharSequence? = null,
    @DrawableRes mark: Int = R.drawable.ic_rt_terminal_square,
    onSearch: (() -> Unit)? = null,
    onRefresh: (() -> Unit)? = null,
    onOverflow: ((View) -> Unit)? = null,
) {
    headerTitle.text = title
    headerSubtitle.setTextOrHide(subtitle)
    headerMarkIcon.setImageResource(mark)

    headerSearch.visible = onSearch != null
    headerSearch.setOnClickListener { onSearch?.invoke() }

    headerRefresh.visible = onRefresh != null
    headerRefresh.setOnClickListener { onRefresh?.invoke() }

    headerOverflow.visible = onOverflow != null
    headerOverflow.setOnClickListener { v -> onOverflow?.invoke(v) }
}

/**
 * Render the relay connection strip. It hides itself while connected; while
 * not, it names the state in words and offers a retry when retrying is useful.
 */
fun ViewConnectionBannerBinding.bind(state: RelayClient.ConnectionState, onRetry: () -> Unit) {
    val context = root.context
    val connected = state is RelayClient.ConnectionState.Connected
    root.visible = !connected
    if (connected) return
    bannerText.text = Format.connectionLabel(context, state)
    bannerDot.backgroundTintList = Design.stateList(context, Format.connectionColor(state))
    bannerAction.visible = state is RelayClient.ConnectionState.Reconnecting ||
        state is RelayClient.ConnectionState.Disconnected ||
        state is RelayClient.ConnectionState.Failed
    bannerAction.setOnClickListener { onRetry() }
}

/**
 * Show the shared empty/no-results/offline/error block. [iconTint] carries the
 * tone: neutral for "nothing here", green for success, amber/red for a problem.
 */
fun ViewStateBlockBinding.show(
    @DrawableRes icon: Int,
    title: CharSequence,
    body: CharSequence,
    @StringRes actionLabel: Int? = null,
    @DrawableRes actionIcon: Int = R.drawable.ic_rt_plus,
    iconTint: Int = R.color.rt_text_muted,
    onAction: (() -> Unit)? = null,
) {
    root.visible = true
    stateIcon.setImageResource(icon)
    Design.tint(stateIcon, iconTint)
    stateTitle.text = title
    stateBody.text = body
    val hasAction = actionLabel != null && onAction != null
    stateAction.visible = hasAction
    if (hasAction) {
        stateActionLabel.setText(actionLabel!!)
        stateActionIcon.setImageResource(actionIcon)
        stateAction.setOnClickListener { onAction!!.invoke() }
        stateAction.contentDescription = root.context.getString(actionLabel)
    }
}

fun ViewStateBlockBinding.hide() {
    root.visible = false
}
