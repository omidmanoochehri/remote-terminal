package com.cactus.remoteterminal.ui

import android.content.Context
import android.text.InputType
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.WakeOnLan
import com.cactus.remoteterminal.ui.Forms.text
import com.cactus.remoteterminal.ui.Forms.validateOnPositive
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/**
 * Wake-on-LAN from the phone: the magic packet goes out as UDP broadcast on
 * whatever network the phone is on, so it only reaches a machine on the same
 * LAN. Needs nothing beyond the INTERNET permission.
 */
object WakeUi {

    /** Send the magic packet three times, 100 ms apart, then say so. */
    fun wake(fragment: Fragment, agentId: String) {
        val app = fragment.requireActivity().application as App
        val context = fragment.requireContext().applicationContext
        val target = app.settings.wakeTarget(agentId) ?: return
        val mac = WakeOnLan.parseMac(target.mac) ?: return
        fragment.viewLifecycleOwner.lifecycleScope.launch {
            val error = withContext(Dispatchers.IO) {
                try {
                    val packet = WakeOnLan.magicPacket(mac)
                    val address = InetAddress.getByName(target.broadcast)
                    DatagramSocket().use { socket ->
                        socket.broadcast = true
                        repeat(3) { i ->
                            socket.send(DatagramPacket(packet, packet.size, address, target.port))
                            if (i < 2) delay(100)
                        }
                    }
                    null
                } catch (e: Exception) {
                    e.message ?: e.javaClass.simpleName
                }
            }
            Toast.makeText(
                context,
                if (error == null) context.getString(R.string.wol_sent) else context.getString(R.string.wol_failed, error),
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    /** Edit a machine's MAC, broadcast address and port. */
    fun edit(context: Context, agentId: String, onSaved: () -> Unit) {
        val app = context.applicationContext as App
        val current = app.settings.wakeTargetRaw(agentId)
        val box = Forms.column(context)
        val mac = Forms.input(context, context.getString(R.string.wol_mac), current?.mac.orEmpty(), helper = context.getString(R.string.wol_mac_hint), mono = true)
        val broadcast = Forms.input(
            context, context.getString(R.string.wol_broadcast), current?.broadcast ?: WakeOnLan.DEFAULT_BROADCAST, mono = true,
            type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
        )
        val port = Forms.input(
            context, context.getString(R.string.wol_port), (current?.port ?: WakeOnLan.DEFAULT_PORT).toString(),
            type = InputType.TYPE_CLASS_NUMBER,
        )
        box.addView(mac); box.addView(broadcast); box.addView(port)
        box.addView(Forms.note(context, context.getString(R.string.wol_lan_note)))
        val dialog = MaterialAlertDialogBuilder(context)
            .setTitle(R.string.wol_edit_title)
            .setView(android.widget.ScrollView(context).apply { addView(box) })
            .setPositiveButton(R.string.save, null)
            .setNeutralButton(R.string.wol_clear) { _, _ -> app.settings.setWakeTargetManually(agentId, null); onSaved() }
            .setNegativeButton(R.string.cancel, null)
            .show()
        dialog.validateOnPositive {
            mac.error = null; broadcast.error = null; port.error = null
            val m = WakeOnLan.normalizeMac(mac.text)
            val b = broadcast.text.trim().ifEmpty { WakeOnLan.DEFAULT_BROADCAST }
            val p = port.text.trim().toIntOrNull()
            var ok = true
            if (m == null) { mac.error = context.getString(R.string.wol_mac_invalid); ok = false }
            if (!WakeOnLan.isIpv4(b)) { broadcast.error = context.getString(R.string.wol_broadcast_invalid); ok = false }
            if (p == null || p !in 1..65535) { port.error = context.getString(R.string.wol_port_invalid); ok = false }
            if (ok) {
                app.settings.setWakeTargetManually(agentId, WakeOnLan.Target(m!!, b, p!!))
                Toast.makeText(context, R.string.wol_saved, Toast.LENGTH_SHORT).show()
                onSaved()
            }
            ok
        }
    }
}
