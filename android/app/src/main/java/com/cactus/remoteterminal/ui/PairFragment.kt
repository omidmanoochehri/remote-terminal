package com.cactus.remoteterminal.ui

import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.BuildConfig
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.CredentialStore
import com.cactus.remoteterminal.databinding.FragmentPairBinding
import com.cactus.remoteterminal.net.RelayHttp
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URI

/** First-run pairing: relay URL + 6-digit code → long-lived device token. */
class PairFragment : Fragment() {
    private var _binding: FragmentPairBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentPairBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.root.padForAllBars()
        app.credentials.relayUrl?.let { binding.relayInput.setText(it) }
        binding.nameInput.setText(app.settings.deviceName.ifEmpty { defaultDeviceName() })
        binding.pairButton.setOnClickListener { attempt() }
        if (app.client.state.value is com.cactus.remoteterminal.net.RelayClient.ConnectionState.Unpaired && app.agents.agents.value.isNotEmpty()) {
            binding.errorText.text = getString(R.string.unpaired_notice)
            binding.errorText.isVisible = true
        }
    }

    private fun defaultDeviceName(): String {
        val model = Build.MODEL ?: "Android"
        val manufacturer = Build.MANUFACTURER ?: ""
        return if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model".trim().replaceFirstChar { it.uppercase() }
    }

    private fun attempt() {
        val b = binding
        b.relayLayout.error = null; b.codeLayout.error = null; b.errorText.isVisible = false
        val relay = try { RelayHttp.normalizeRelayUrl(b.relayInput.text.toString()) } catch (_: Exception) {
            b.relayLayout.error = getString(R.string.pair_error_url); return
        }
        val code = b.codeInput.text.toString().trim()
        if (!code.matches(Regex("^[0-9]{6}$"))) { b.codeLayout.error = getString(R.string.pair_error_code); return }
        val name = b.nameInput.text.toString().trim().ifEmpty { defaultDeviceName() }
        if (relay.startsWith("ws://") && !isPrivateHost(relay)) {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.pair_insecure_title)
                .setMessage(getString(R.string.pair_insecure_text, relay))
                .setPositiveButton(R.string.pair_insecure_continue) { _, _ -> pair(relay, code, name) }
                .setNegativeButton(R.string.cancel, null)
                .show()
        } else pair(relay, code, name)
    }

    private fun isPrivateHost(url: String): Boolean {
        val host = try { URI(url).host ?: return false } catch (_: Exception) { return false }
        return host == "localhost" || host == "10.0.2.2" || host.startsWith("10.") || host.startsWith("192.168.") ||
            Regex("^172\\.(1[6-9]|2[0-9]|3[01])\\.").containsMatchIn(host) || host.startsWith("127.") || host.endsWith(".local")
    }

    private fun pair(relay: String, code: String, name: String) {
        val b = binding
        b.pairButton.isEnabled = false
        b.progress.isVisible = true
        b.pairButton.text = getString(R.string.pair_working)
        viewLifecycleOwner.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val r = RelayHttp.redeem(relay, code, name, BuildConfig.VERSION_NAME)
                    app.credentials.save(CredentialStore.Credentials(relay, r.deviceId, r.deviceToken, r.accountId))
                    r
                }
            }
            val bb = _binding ?: return@launch
            bb.progress.isVisible = false
            bb.pairButton.isEnabled = true
            bb.pairButton.text = getString(R.string.pair_action)
            result.onSuccess {
                app.settings.deviceName = name
                app.agents.clearCache()
                app.client.onPaired()
                (requireActivity() as MainActivity).onPaired()
            }.onFailure { e ->
                val msg = when (e) {
                    is RelayHttp.RelayException -> e.message ?: e.code
                    else -> e.message ?: e.javaClass.simpleName
                }
                bb.errorText.text = getString(R.string.pair_failed, msg)
                bb.errorText.isVisible = true
            }
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}
