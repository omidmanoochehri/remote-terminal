package com.cactus.remoteterminal.ui.design

import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.ViewBottomNavItemBinding

/**
 * The floating bottom navigation bar from the design set: a rounded bar
 * carrying Home, Machines, Terminals and Settings. Selection is green icon +
 * bold green label; everything else is the dim ink.
 *
 * It is a plain LinearLayout rather than Material's BottomNavigationView so
 * the bar can float clear of the screen edges exactly as designed and still
 * expose real 48dp touch targets.
 */
class BottomNavView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : LinearLayout(context, attrs, defStyleAttr) {

    enum class Destination(@DrawableRes val icon: Int, @StringRes val label: Int) {
        HOME(R.drawable.ic_rt_home, R.string.nav_home),
        MACHINES(R.drawable.ic_rt_monitor, R.string.nav_machines),
        TERMINALS(R.drawable.ic_rt_terminal_square, R.string.nav_terminals),
        SETTINGS(R.drawable.ic_rt_settings, R.string.nav_settings),
    }

    private val items = ArrayList<ViewBottomNavItemBinding>(Destination.entries.size)

    var onSelected: ((Destination) -> Unit)? = null

    var selected: Destination = Destination.HOME
        set(value) {
            field = value
            render()
        }

    init {
        orientation = HORIZONTAL
        background = androidx.appcompat.content.res.AppCompatResources.getDrawable(context, R.drawable.rt_nav_bar)
        val inflater = LayoutInflater.from(context)
        for (destination in Destination.entries) {
            val item = ViewBottomNavItemBinding.inflate(inflater, this, false)
            item.navIcon.setImageResource(destination.icon)
            item.navLabel.setText(destination.label)
            item.root.contentDescription = context.getString(destination.label)
            item.root.setOnClickListener {
                if (selected != destination) {
                    selected = destination
                    onSelected?.invoke(destination)
                }
            }
            addView(item.root)
            items.add(item)
        }
        render()
    }

    private fun render() {
        for ((index, item) in items.withIndex()) {
            val active = Destination.entries[index] == selected
            Design.tint(item.navIcon, if (active) R.color.rt_primary else R.color.rt_text_dim)
            item.navLabel.setTextColor(
                Design.color(item.root.context, if (active) R.color.rt_primary else R.color.rt_text_dim)
            )
            item.navLabel.setTypeface(null, if (active) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
            item.root.isSelected = active
            // Announced as "selected" by TalkBack, so state never relies on colour.
            item.root.isActivated = active
            item.root.stateDescription(active)
        }
    }

    private fun View.stateDescription(active: Boolean) {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            stateDescription = context.getString(if (active) R.string.a11y_selected else R.string.a11y_not_selected)
        }
    }
}
