package com.cactus.remoteterminal.ui

import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.BuildConfig
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.CredentialStore
import com.cactus.remoteterminal.databinding.FragmentAddMachineBinding
import com.cactus.remoteterminal.net.RelayHttp
import com.cactus.remoteterminal.ui.design.Design
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URI

/**
 * Pairing, as the three steps the design shows: connection details, then the
 * redemption, then confirmation. Redeeming a code is the only network call and
 * it is the same one the previous pairing screen made, so relays do not care
 * that the UI changed.
 */
class AddMachineFragment : Fragment(), RtScreen {

    private enum class Step { CONNECTION, VERIFY, FINISH }

    private var _binding: FragmentAddMachineBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity

    private var step = Step.CONNECTION
    private var working = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentAddMachineBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.scroll.padForNavigationBar(ime = true)
        Design.excludeFromAutofill(view)

        binding.headerBar.headerTitle.setText(R.string.add_machine_title)
        binding.headerBar.headerSubtitle.setText(R.string.add_machine_subtitle)
        binding.headerBar.headerOverflow.visible = false
        // Nothing is paired yet on first run, so there is nowhere to go back to.
        binding.headerBar.backButton.visible = app.credentials.isPaired
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }

        with(binding.nameField) {
            fieldLabel.setText(R.string.pair_name_hint)
            fieldIcon.setImageResource(R.drawable.ic_rt_monitor)
            fieldInput.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            fieldInput.setText(app.settings.deviceName.ifEmpty { defaultDeviceName() })
            fieldInput.contentDescription = getString(R.string.pair_name_hint)
        }
        with(binding.relayField) {
            fieldLabel.setText(R.string.field_relay_server)
            fieldIcon.setImageResource(R.drawable.ic_rt_globe)
            fieldInput.inputType = InputType.TYPE_TEXT_VARIATION_URI
            fieldInput.hint = getString(R.string.pair_relay_hint)
            fieldInput.setText(app.credentials.relayUrl.orEmpty())
            fieldInput.contentDescription = getString(R.string.field_relay_server)
            fieldTrailing.visible = true
            fieldInput.doAfterTextChanged { renderRelayHint() }
        }
        with(binding.codeField) {
            fieldLabel.setText(R.string.field_pairing_code)
            fieldIcon.setImageResource(R.drawable.ic_rt_key)
            fieldInput.inputType = InputType.TYPE_CLASS_NUMBER
            fieldInput.filters = arrayOf(android.text.InputFilter.LengthFilter(7))
            fieldInput.hint = getString(R.string.pair_code_hint)
            // Spaced digits read better, but only once there are digits to space.
            fieldInput.doAfterTextChanged { text -> fieldInput.letterSpacing = if (text.isNullOrEmpty()) 0f else 0.18f }
            fieldInput.contentDescription = getString(R.string.field_pairing_code)
            fieldTrailing.visible = true
            fieldTrailing.setText(R.string.hint_scan)
            fieldTrailing.setTextColor(Design.color(requireContext(), R.color.rt_primary))
            fieldTrailing.isClickable = true
            fieldTrailing.setOnClickListener { openScanner() }
        }
        renderRelayHint()

        binding.scanQrButton.setOnClickListener { openScanner() }
        binding.primaryButton.setOnClickListener { onPrimary() }
        binding.setupGuide.setOnClickListener {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.machines_empty_action)
                .setMessage(R.string.machines_help)
                .setPositiveButton(R.string.ok, null)
                .show()
        }

        if (app.client.state.value is com.cactus.remoteterminal.net.RelayClient.ConnectionState.Unpaired &&
            app.agents.agents.value.isNotEmpty()
        ) {
            binding.codeField.fieldError.visible = true
            binding.codeField.fieldError.setText(R.string.unpaired_notice)
        }

        render()
    }

    private fun defaultDeviceName(): String {
        val model = Build.MODEL ?: "Android"
        val manufacturer = Build.MANUFACTURER ?: ""
        return if (model.startsWith(manufacturer, ignoreCase = true)) model
        else "$manufacturer $model".trim().replaceFirstChar { it.uppercase() }
    }

    /** The relay hint only appears once there is a URL to judge. */
    private fun renderRelayHint() {
        val raw = binding.relayField.fieldInput.text.toString().trim()
        binding.relayField.fieldTrailing.visible = raw.isNotEmpty()
        if (raw.isEmpty()) return
        val secure = !raw.startsWith("ws://") && !raw.startsWith("http://")
        binding.relayField.fieldTrailing.setText(if (secure) R.string.hint_secure else R.string.hint_insecure)
        binding.relayField.fieldTrailing.setTextColor(
            Design.color(requireContext(), if (secure) R.color.rt_text_muted else R.color.rt_status_warn)
        )
    }

    private fun openScanner() {
        host.openQrScanner { relay, code ->
            val b = _binding ?: return@openQrScanner
            relay?.let { b.relayField.fieldInput.setText(it) }
            b.codeField.fieldInput.setText(code)
            b.codeField.fieldError.visible = false
            renderRelayHint()
        }
    }

    /* ------------------------------- stepper ------------------------------ */

    private fun render() {
        val b = _binding ?: return
        renderStepper()

        b.stepConnection.visible = step == Step.CONNECTION
        b.progress.visible = step == Step.VERIFY && working
        b.footerRow.visible = step == Step.CONNECTION

        when (step) {
            Step.CONNECTION -> {
                b.stepResult.hide()
                b.primaryLabel.setText(R.string.action_continue)
                b.primaryIcon.setImageResource(R.drawable.ic_rt_arrow_right)
                b.primaryButton.visible = true
                b.primaryButton.isEnabled = true
            }
            Step.VERIFY -> {
                if (working) {
                    b.stepResult.hide()
                    b.primaryButton.visible = false
                } else {
                    b.primaryButton.visible = true
                    b.primaryLabel.setText(R.string.action_retry)
                    b.primaryIcon.setImageResource(R.drawable.ic_rt_refresh)
                }
            }
            Step.FINISH -> {
                b.primaryButton.visible = true
                b.primaryLabel.setText(R.string.finish_action)
                b.primaryIcon.setImageResource(R.drawable.ic_rt_arrow_right)
            }
        }
    }

    private fun renderStepper() {
        val b = _binding ?: return
        val pills = listOf(b.stepperBar.step1, b.stepperBar.step2, b.stepperBar.step3)
        val index = step.ordinal
        for ((i, pill) in pills.withIndex()) {
            val active = i <= index
            pill.isSelected = active
            pill.setTextColor(Design.color(requireContext(), if (active) R.color.rt_primary else R.color.rt_text_muted))
            pill.setTypeface(null, Typeface.BOLD)
            if (Build.VERSION.SDK_INT >= 30) {
                pill.stateDescription = getString(
                    when {
                        i < index -> R.string.a11y_step_done
                        i == index -> R.string.a11y_step_current
                        else -> R.string.a11y_step_todo
                    }
                )
            }
        }
        b.stepperBar.stepLine1.setBackgroundColor(
            Design.color(requireContext(), if (index >= 1) R.color.rt_primary_edge else R.color.rt_divider)
        )
        b.stepperBar.stepLine2.setBackgroundColor(
            Design.color(requireContext(), if (index >= 2) R.color.rt_primary_edge else R.color.rt_divider)
        )
    }

    /* -------------------------------- action ------------------------------ */

    private fun onPrimary() {
        when (step) {
            Step.CONNECTION -> attempt()
            Step.VERIFY -> { step = Step.CONNECTION; render() }
            Step.FINISH -> host.onPaired()
        }
    }

    private fun attempt() {
        val b = binding
        b.relayField.fieldError.visible = false
        b.codeField.fieldError.visible = false

        val relay = try {
            RelayHttp.normalizeRelayUrl(b.relayField.fieldInput.text.toString())
        } catch (_: Exception) {
            showFieldError(b.relayField.fieldError, getString(R.string.pair_error_url))
            return
        }
        val code = b.codeField.fieldInput.text.toString().filter { it.isDigit() }
        if (!code.matches(Regex("^[0-9]{6}$"))) {
            showFieldError(b.codeField.fieldError, getString(R.string.pair_error_code))
            return
        }
        val name = b.nameField.fieldInput.text.toString().trim().ifEmpty { defaultDeviceName() }

        if (relay.startsWith("ws://") && !isPrivateHost(relay)) {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.pair_insecure_title)
                .setMessage(getString(R.string.pair_insecure_text, relay))
                .setPositiveButton(R.string.pair_insecure_continue) { _, _ -> pair(relay, code, name) }
                .setNegativeButton(R.string.cancel, null)
                .show()
        } else {
            pair(relay, code, name)
        }
    }

    private fun showFieldError(view: android.widget.TextView, message: String) {
        view.text = message
        view.visible = true
    }

    private fun isPrivateHost(url: String): Boolean {
        val host = try { URI(url).host ?: return false } catch (_: Exception) { return false }
        return host == "localhost" || host == "10.0.2.2" || host.startsWith("10.") || host.startsWith("192.168.") ||
            Regex("^172\\.(1[6-9]|2[0-9]|3[01])\\.").containsMatchIn(host) || host.startsWith("127.") || host.endsWith(".local")
    }

    private fun pair(relay: String, code: String, name: String) {
        step = Step.VERIFY
        working = true
        render()
        binding.stepResult.show(
            icon = R.drawable.ic_rt_key,
            title = getString(R.string.verify_title),
            body = getString(R.string.verify_body, Format.relayHost(relay)),
        )
        binding.stepResult.stateAction.visible = false

        viewLifecycleOwner.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val r = RelayHttp.redeem(relay, code, name, BuildConfig.VERSION_NAME)
                    app.credentials.save(CredentialStore.Credentials(relay, r.deviceId, r.deviceToken, r.accountId))
                    r
                }
            }
            val b = _binding ?: return@launch
            working = false
            result.onSuccess {
                app.settings.deviceName = name
                app.agents.clearCache()
                app.client.onPaired()
                step = Step.FINISH
                render()
                b.stepResult.show(
                    icon = R.drawable.ic_rt_check,
                    title = getString(R.string.finish_title),
                    body = getString(R.string.finish_body, Format.relayHost(relay)),
                    iconTint = R.color.rt_primary,
                )
                b.stepResult.stateAction.visible = false
            }.onFailure { e ->
                val message = when (e) {
                    is RelayHttp.RelayException -> e.message ?: e.code
                    else -> e.message ?: e.javaClass.simpleName
                }
                render()
                b.stepResult.show(
                    icon = R.drawable.ic_rt_alert,
                    title = getString(R.string.verify_failed_title),
                    body = getString(R.string.pair_failed, message),
                    iconTint = R.color.rt_status_error,
                )
                b.stepResult.stateAction.visible = false
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
