package com.cactus.remoteterminal.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.databinding.FragmentQrScanBinding
import com.cactus.remoteterminal.ui.design.hide
import com.cactus.remoteterminal.ui.design.show
import com.cactus.remoteterminal.ui.design.visible
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Reads a pairing code from a QR code. The decoder is ZXing running on the
 * analysis thread; frames are never stored or sent anywhere. Accepted payloads
 * are a `remoteterminal://pair?relay=…&code=…` link or a bare six-digit code —
 * the same code the agent prints and a paired phone can display.
 */
class QrScanFragment : Fragment(), RtScreen {

    private var _binding: FragmentQrScanBinding? = null
    private val binding get() = _binding!!
    private val host get() = requireActivity() as MainActivity

    private var analysisExecutor: ExecutorService? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var handled = false
    private var warnedUnsupported = false

    private val reader = QRCodeReader()
    private val hints = mapOf(DecodeHintType.TRY_HARDER to true)

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else showPermissionState(permanentlyDenied = !shouldShowRationale())
        }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentQrScanBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.headerBar.root.padForStatusBar()
        binding.manualButton.padForNavigationBar()

        binding.headerBar.headerTitle.setText(R.string.qr_title)
        binding.headerBar.headerSubtitle.setText(R.string.qr_subtitle)
        binding.headerBar.headerOverflow.visible = false
        binding.headerBar.backButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }
        binding.manualButton.setOnClickListener { host.onBackPressedDispatcher.onBackPressed() }

        if (ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            // Explain first: the platform prompt has no room for a reason.
            showPermissionState(permanentlyDenied = false)
        }
    }

    private fun shouldShowRationale() = shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)

    private fun showPermissionState(permanentlyDenied: Boolean) {
        val b = _binding ?: return
        b.frameHolder.visible = false
        b.preview.visible = false
        b.permissionBlock.show(
            icon = R.drawable.ic_rt_camera,
            title = getString(R.string.qr_permission_title),
            body = getString(R.string.qr_permission_body),
            actionLabel = if (permanentlyDenied) R.string.qr_permission_settings else R.string.qr_permission_action,
            actionIcon = R.drawable.ic_rt_camera,
        ) {
            if (permanentlyDenied) {
                startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", requireContext().packageName, null)
                    )
                )
            } else {
                cameraPermission.launch(Manifest.permission.CAMERA)
            }
        }
    }

    private fun startCamera() {
        val b = _binding ?: return
        b.permissionBlock.hide()
        b.frameHolder.visible = true
        b.preview.visible = true

        val executor = Executors.newSingleThreadExecutor()
        analysisExecutor = executor
        val future = ProcessCameraProvider.getInstance(requireContext())
        future.addListener({
            val binding = _binding ?: return@addListener
            val provider = try { future.get() } catch (t: Throwable) {
                Log.w(TAG, "no camera provider", t)
                Toast.makeText(requireContext(), R.string.error_title, Toast.LENGTH_LONG).show()
                return@addListener
            }
            cameraProvider = provider

            val preview = Preview.Builder().build().also { it.setSurfaceProvider(binding.preview.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { image -> analyse(image) }

            try {
                provider.unbindAll()
                provider.bindToLifecycle(viewLifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (t: Throwable) {
                Log.w(TAG, "cannot bind camera", t)
            }
        }, ContextCompat.getMainExecutor(requireContext()))
    }

    private fun analyse(image: ImageProxy) {
        if (handled) { image.close(); return }
        try {
            val plane = image.planes.firstOrNull() ?: return
            val buffer = plane.buffer
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            val source = PlanarYUVLuminanceSource(
                bytes, plane.rowStride, image.height, 0, 0,
                minOf(plane.rowStride, image.width), image.height, false
            )
            val result = reader.decode(BinaryBitmap(HybridBinarizer(source)), hints)
            val parsed = PairingPayload.parse(result.text)
            if (parsed == null) {
                // A readable code that is not a pairing code: say so once rather
                // than leaving the user pointing the camera at it forever.
                if (!warnedUnsupported) {
                    warnedUnsupported = true
                    binding.root.post {
                        _binding?.scanHint?.setText(R.string.qr_unsupported)
                    }
                }
                return
            }
            handled = true
            binding.root.post { deliver(parsed.relay, parsed.code) }
        } catch (_: Exception) {
            // Not a readable code in this frame; the next one gets a turn.
        } finally {
            reader.reset()
            image.close()
        }
    }

    private fun deliver(relay: String?, code: String) {
        val callback = pendingResult
        pendingResult = null
        host.onBackPressedDispatcher.onBackPressed()
        callback?.invoke(relay, code)
    }

    override fun onDestroyView() {
        cameraProvider?.unbindAll()
        cameraProvider = null
        analysisExecutor?.shutdown()
        analysisExecutor = null
        super.onDestroyView()
        _binding = null
    }

    companion object {
        private const val TAG = "QrScanFragment"

        /**
         * Where the scanned code goes. Set by [MainActivity.openQrScanner]
         * immediately before the screen is pushed and cleared on delivery.
         */
        var pendingResult: ((relay: String?, code: String) -> Unit)? = null
    }
}
