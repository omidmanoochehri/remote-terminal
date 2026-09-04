package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentMachineSettingsBinding
import com.cactus.remoteterminal.databinding.ViewInfoRowBinding
import com.cactus.remoteterminal.databinding.ViewToggleRowBinding
import com.cactus.remoteterminal.protocol.AgentInfo
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.visible
import kotlinx.coroutines.launch

/**
 * Settings for one machine. The display name is renamed on the relay; the
 * connection switches are this phone's policy for that machine and are applied
 * immediately by the session layer. The relay URL is shown read-only because
 * it is account-wide — changing it means pairing again.
 */
class MachineSettingsFragment : Fragment(), RtScreen {

    private var _binding: FragmentMachineSettingsBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private val agentId: String get() = requireArguments().getString(ARG_AGENT)!!
    private var agent: AgentInfo? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentMachineSettingsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.scroll.padForNavigationBar(ime = true)
        Design.excludeFromAutofill(view)

        binding.headerBar.headerTitle.setText(R.string.machine_settings_title)
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        binding.headerBar.headerOverflow.setOnClickListener { anchor ->
            agent?.let { MachineActions.menu(this, anchor, it) }
        }

        with(binding.nameField) {
            fieldLabel.setText(R.string.field_display_name)
            fieldIcon.setImageResource(R.drawable.ic_rt_server)
            fieldInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            fieldInput.contentDescription = getString(R.string.field_display_name)
        }
        with(binding.relayField) {
            fieldLabel.setText(R.string.field_relay_server)
            fieldIcon.setImageResource(R.drawable.ic_rt_globe)
            // Account-wide: shown for confidence, edited only by pairing again.
            fieldInput.isEnabled = false
            fieldInput.setTextColor(Design.color(requireContext(), R.color.rt_text_secondary))
            fieldTrailing.visible = true
            fieldInput.contentDescription = getString(R.string.field_relay_server)
        }

        bindToggle(
            binding.toggleAutoReconnect, R.drawable.ic_rt_refresh, R.color.rt_primary,
            R.string.setting_auto_reconnect, R.string.setting_auto_reconnect_desc,
            app.settings.autoReconnect(agentId),
        ) { value ->
            app.settings.setAutoReconnect(agentId, value)
            if (value) app.sessions.reattachAll(agentId)
        }
        bindToggle(
            binding.toggleKeepAlive, R.drawable.ic_rt_activity, R.color.rt_accent,
            R.string.setting_keep_alive, R.string.setting_keep_alive_desc,
            app.settings.keepAlive(agentId),
        ) { value -> app.settings.setKeepAlive(agentId, value) }
        bindToggle(
            binding.toggleAlerts, R.drawable.ic_rt_bell_ring, R.color.rt_amber,
            R.string.setting_connection_alerts, R.string.setting_connection_alerts_desc,
            app.settings.connectionAlerts(agentId),
        ) { value ->
            app.settings.setConnectionAlerts(agentId, value)
            if (value) host.maybeAskNotifications()
        }

        binding.saveButton.setOnClickListener { save() }
        binding.removeButton.setOnClickListener {
            agent?.let { MachineActions.confirmRemove(this, it) { host.openMachines() } }
        }

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.agents.collect { agents ->
                    val found = agents.firstOrNull { it.agentId == agentId }
                    if (found == null) {
                        host.onBackPressedDispatcher.onBackPressed()
                        return@collect
                    }
                    if (agent == null) render(found) else agent = found
                }
            }
        }
    }

    private fun render(found: AgentInfo) {
        agent = found
        val context = requireContext()
        binding.headerBar.headerSubtitle.text = found.name.ifEmpty { found.hostname }
        binding.nameField.fieldInput.setText(found.name)

        val relay = app.credentials.relayUrl
        binding.relayField.fieldInput.setText(relay ?: getString(R.string.value_unknown))
        val secure = Format.isSecureRelay(relay)
        binding.relayField.fieldTrailing.setText(if (secure) R.string.hint_secure else R.string.hint_insecure)
        binding.relayField.fieldTrailing.setTextColor(
            Design.color(context, if (secure) R.color.rt_text_muted else R.color.rt_status_warn)
        )

        val card = binding.securityCard
        card.removeAllViews()
        val token = ViewInfoRowBinding.inflate(layoutInflater, card, false)
        token.infoIcon.setImageResource(R.drawable.ic_rt_key)
        token.infoLabel.setText(R.string.security_agent_token)
        token.infoValue.setText(R.string.security_agent_token_value)
        token.infoBadge.visible = false
        token.infoRow.contentDescription = getString(R.string.security_agent_token_note)
        token.infoRow.setOnClickListener {
            Toast.makeText(context, R.string.security_agent_token_note, Toast.LENGTH_LONG).show()
        }
        card.addView(token.root)

        val divider = View(context)
        divider.setBackgroundColor(Design.color(context, R.color.rt_divider))
        card.addView(
            divider,
            ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
                marginStart = Design.dp(context, 13f)
                marginEnd = Design.dp(context, 13f)
            }
        )

        val encryption = ViewInfoRowBinding.inflate(layoutInflater, card, false)
        encryption.infoIcon.setImageResource(R.drawable.ic_rt_shield)
        encryption.infoLabel.setText(R.string.security_encryption)
        encryption.infoValue.setText(if (secure) R.string.security_encryption_tls else R.string.security_encryption_plain)
        encryption.infoValue.setTextColor(
            Design.color(context, if (secure) R.color.rt_text else R.color.rt_status_warn)
        )
        Design.tint(encryption.infoIcon, if (secure) R.color.rt_primary else R.color.rt_status_warn)
        encryption.infoBadge.visible = false
        encryption.infoRow.isClickable = false
        encryption.infoRow.background = null
        card.addView(encryption.root)
    }

    private fun bindToggle(
        row: ViewToggleRowBinding,
        icon: Int,
        colour: Int,
        title: Int,
        description: Int,
        initial: Boolean,
        onChange: (Boolean) -> Unit,
    ) {
        row.toggleIcon.setImageResource(icon)
        Design.tint(row.toggleIcon, colour)
        row.toggleTitle.setText(title)
        row.toggleDesc.setText(description)
        row.toggleSwitch.isChecked = initial
        row.toggleRow.contentDescription = "${getString(title)}. ${getString(description)}"
        row.toggleRow.setOnClickListener {
            val next = !row.toggleSwitch.isChecked
            row.toggleSwitch.isChecked = next
            onChange(next)
        }
    }

    private fun save() {
        val name = binding.nameField.fieldInput.text.toString().trim()
        if (name.isEmpty()) {
            binding.nameField.fieldError.visible = true
            binding.nameField.fieldError.setText(R.string.field_display_name)
            return
        }
        binding.nameField.fieldError.visible = false
        if (name != agent?.name) app.agents.renameAgent(agentId, name)
        Toast.makeText(requireContext(), R.string.saved, Toast.LENGTH_SHORT).show()
        host.onBackPressedDispatcher.onBackPressed()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        private const val ARG_AGENT = "agent"
        fun newInstance(agentId: String) = MachineSettingsFragment().apply {
            arguments = Bundle().apply { putString(ARG_AGENT, agentId) }
        }
    }
}
