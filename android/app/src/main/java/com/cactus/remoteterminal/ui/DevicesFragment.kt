package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentDevicesBinding
import com.cactus.remoteterminal.databinding.ItemDeviceBinding
import com.cactus.remoteterminal.net.RelayHttp
import com.cactus.remoteterminal.protocol.DeviceInfo
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Paired phones of the account: add another phone, rename this one, revoke others. */
class DevicesFragment : Fragment(), RtScreen {
    private var _binding: FragmentDevicesBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val host get() = requireActivity() as MainActivity
    private lateinit var adapter: DeviceAdapter

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentDevicesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.addButton.padForNavigationBar()
        binding.headerBar.headerTitle.setText(R.string.devices)
        binding.headerBar.headerSubtitle.visible = false
        binding.headerBar.headerOverflow.visible = false
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }

        adapter = DeviceAdapter(onRevoke = { revoke(it) }, onRename = { renameSelf(it) })
        binding.list.layoutManager = LinearLayoutManager(requireContext())
        binding.list.adapter = adapter
        binding.addButton.setOnClickListener { addPhone() }
        app.agents.refresh()

        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.agents.devices.collect { list ->
                    adapter.submitList(list)
                    binding.list.visible = list.isNotEmpty()
                    if (list.isEmpty()) {
                        binding.stateBlock.show(
                            icon = R.drawable.ic_rt_phone,
                            title = getString(R.string.devices),
                            body = getString(R.string.devices_empty),
                        )
                    } else {
                        binding.stateBlock.hide()
                    }
                }
            }
        }
    }

    /**
     * Mint a pairing code for another phone and show it large enough to read
     * across a desk, with the relay it belongs to.
     */
    private fun addPhone() {
        val creds = app.credentials.load() ?: return
        viewLifecycleOwner.lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { RelayHttp.pairCode(creds.relayUrl, creds.deviceToken) } }
            r.onSuccess { c ->
                MaterialAlertDialogBuilder(requireContext())
                    .setTitle(R.string.qr_show_title)
                    .setMessage(
                        resources.getQuantityString(R.plurals.qr_show_body, (c.ttlSec / 60).coerceAtLeast(1), (c.ttlSec / 60).coerceAtLeast(1)) + "\n\n" +
                            c.code.chunked(3).joinToString(" ") + "\n\n" +
                            getString(R.string.add_phone_relay, creds.relayUrl)
                    )
                    .setPositiveButton(R.string.ok, null)
                    .setNeutralButton(R.string.copy) { _, _ -> MachineActions.copy(requireContext(), c.code) }
                    .show()
            }.onFailure { e ->
                Toast.makeText(requireContext(), getString(R.string.error_generic, e.message ?: ""), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun revoke(d: DeviceInfo) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.revoke_device)
            .setMessage(getString(R.string.revoke_device_confirm, d.name))
            .setPositiveButton(R.string.revoke_device) { _, _ -> app.agents.revokeDevice(d.deviceId) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun renameSelf(d: DeviceInfo) {
        val input = EditText(requireContext()).apply {
            setText(d.name); inputType = InputType.TYPE_CLASS_TEXT; setSelection(text.length)
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.rename_device)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) { app.settings.deviceName = name; app.agents.renameDevice(name) }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }

    class DeviceAdapter(
        private val onRevoke: (DeviceInfo) -> Unit,
        private val onRename: (DeviceInfo) -> Unit,
    ) : ListAdapter<DeviceInfo, DeviceAdapter.VH>(DIFF) {
        class VH(val b: ItemDeviceBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            VH(ItemDeviceBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val d = getItem(position)
            val ctx = holder.b.root.context
            holder.b.name.text = if (d.isSelf) "${d.name} · ${ctx.getString(R.string.device_this_phone)}" else d.name
            holder.b.subtitle.text =
                if (d.online) ctx.getString(R.string.device_online)
                else ctx.getString(R.string.device_last_seen, Format.relativeTime(ctx, d.lastSeen))
            holder.b.revokeButton.visible = !d.isSelf
            holder.b.revokeButton.setOnClickListener { onRevoke(d) }
            holder.b.row.setOnClickListener { if (d.isSelf) onRename(d) }
            holder.b.row.contentDescription = "${holder.b.name.text}, ${holder.b.subtitle.text}"
        }

        companion object {
            val DIFF = object : DiffUtil.ItemCallback<DeviceInfo>() {
                override fun areItemsTheSame(a: DeviceInfo, b: DeviceInfo) = a.deviceId == b.deviceId
                override fun areContentsTheSame(a: DeviceInfo, b: DeviceInfo) = a == b
            }
        }
    }
}
