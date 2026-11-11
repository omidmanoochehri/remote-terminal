package com.cactus.remoteterminal.ui

import android.os.Bundle
import android.os.SystemClock
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.SeekBar
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.cactus.remoteterminal.App
import com.cactus.remoteterminal.R
import com.cactus.remoteterminal.data.Settings
import com.cactus.remoteterminal.databinding.FragmentPlayerBinding
import com.cactus.remoteterminal.terminal.Asciicast
import com.cactus.remoteterminal.terminal.CastTimeline
import com.cactus.remoteterminal.terminal.TerminalEmulator
import com.cactus.remoteterminal.terminal.TerminalTheme
import com.cactus.remoteterminal.ui.design.FilterChips
import com.cactus.remoteterminal.ui.design.visible
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Plays a recording into a read-only terminal. Seeking resets the screen and
 * replays every event up to the chosen time, which is quick: the events are
 * only text for the emulator.
 */
class PlayerFragment : Fragment(), RtScreen {
    private var _binding: FragmentPlayerBinding? = null
    private val binding get() = _binding!!
    private val app get() = requireActivity().application as App
    private val recordingId: String get() = requireArguments().getString(ARG_ID)!!

    private var cast: Asciicast.Cast? = null
    private var timeline: CastTimeline? = null
    private var emulator = TerminalEmulator()
    /** Events already fed to [emulator]. */
    private var applied = 0
    /** Play position in (possibly idle-capped) seconds. */
    private var position = 0.0
    private var speed = 1.0
    private var playing = false
    private var loop: Job? = null
    private var userSeeking = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentPlayerBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding
        b.headerBar.root.padForStatusBar()
        b.controls.padForNavigationBar()
        b.terminalFrame.clipToOutline = true
        b.headerBar.headerOverflow.visible = false
        b.headerBar.backButton.setOnClickListener { requireActivity().onBackPressedDispatcher.onBackPressed() }

        val s = app.settings
        val term = b.terminal
        term.setFontSizeSp(s.fontSizeSp, notify = false)
        term.setLineSpacing(s.lineSpacing)
        term.setPreferSystemFont(s.terminalFontFamily == Settings.FONT_SYSTEM)
        term.linksEnabled = false
        term.swipeTabsEnabled = false
        val theme = TerminalTheme.byId(s.terminalTheme)
        term.theme = theme
        b.terminalFrame.backgroundTintList = android.content.res.ColorStateList.valueOf(theme.background)
        // Read-only: nothing typed here goes anywhere, and the grid keeps the recorded size.
        term.onInput = null
        term.onGeometryChanged = { cols, _ -> fitWidth(cols) }

        b.playButton.setOnClickListener { if (playing) pause() else play() }
        b.restartButton.setOnClickListener { seekTo(0.0); play() }
        b.skipIdle.setOnCheckedChangeListener { _, checked -> rebuildTimeline(checked) }
        b.seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) seekTo(fraction(progress) * (timeline?.duration ?: 0.0))
            }
            override fun onStartTrackingTouch(bar: SeekBar) { userSeeking = true }
            override fun onStopTrackingTouch(bar: SeekBar) { userSeeking = false }
        })
        renderSpeed()
        renderTransport()

        viewLifecycleOwner.lifecycleScope.launch {
            val meta = withContext(Dispatchers.IO) { app.recordings.meta(recordingId) }
            b.headerBar.headerTitle.text = meta?.title ?: getString(R.string.recordings_title)
            b.headerBar.headerSubtitle.text = meta?.machine.orEmpty()
            val loaded = withContext(Dispatchers.IO) {
                runCatching { app.recordings.castFile(recordingId).bufferedReader().use { r -> Asciicast.parse(r.lineSequence()) } }
            }
            val bb = _binding ?: return@launch
            bb.loading.visible = false
            loaded.onFailure {
                android.widget.Toast.makeText(requireContext(), getString(R.string.recording_cannot_open, it.message ?: ""), android.widget.Toast.LENGTH_LONG).show()
                requireActivity().onBackPressedDispatcher.onBackPressed()
            }
            loaded.onSuccess { c ->
                cast = c
                timeline = CastTimeline(c.events, bb.skipIdle.isChecked)
                resetScreen()
                play()
            }
        }
    }

    /** Shrink the font until the recorded width fits the view, down to the smallest size. */
    private fun fitWidth(viewCols: Int) {
        val c = cast ?: return
        val term = _binding?.terminal ?: return
        if (viewCols >= c.header.width) return
        val next = (term.fontSizeSp() * viewCols / c.header.width).coerceAtLeast(MIN_FONT_SP)
        if (next < term.fontSizeSp() - 0.05f) term.post { term.setFontSizeSp(next, notify = false) }
    }

    private fun fraction(progress: Int) = progress / 1000.0

    private fun resetScreen() {
        val c = cast ?: return
        emulator = TerminalEmulator(c.header.width, c.header.height, SCROLLBACK)
        emulator.muteResponses = true
        applied = 0
        binding.terminal.emulator = emulator
        fitWidth(binding.terminal.cols)
    }

    /** Feed every event due by [position]. */
    private fun catchUp() {
        val c = cast ?: return
        val t = timeline ?: return
        val due = t.countAt(position)
        if (due < applied) { resetScreen() }
        while (applied < due) {
            val e = c.events[applied++]
            when (e.type) {
                "o" -> emulator.feed(e.data)
                "r" -> Asciicast.parseSize(e.data)?.let { (cols, rows) -> emulator.resize(cols, rows) }
            }
        }
        _binding?.terminal?.notifyUpdated()
    }

    private fun seekTo(t: Double) {
        val tl = timeline ?: return
        position = t.coerceIn(0.0, tl.duration)
        catchUp()
        renderTransport()
    }

    private fun rebuildTimeline(skipIdle: Boolean) {
        val c = cast ?: return
        val next = CastTimeline(c.events, skipIdle)
        // Stay on the same event: its time on the new timeline.
        position = if (applied == 0) 0.0 else next.times[applied - 1]
        timeline = next
        renderTransport()
    }

    private fun play() {
        val tl = timeline ?: return
        if (position >= tl.duration) seekTo(0.0)
        playing = true
        loop?.cancel()
        loop = viewLifecycleOwner.lifecycleScope.launch {
            var last = SystemClock.elapsedRealtime()
            while (isActive && playing) {
                delay(FRAME_MS)
                val now = SystemClock.elapsedRealtime()
                val dt = (now - last) / 1000.0
                last = now
                if (userSeeking) continue
                val duration = timeline?.duration ?: 0.0
                position = (position + dt * speed).coerceAtMost(duration)
                catchUp()
                if (position >= duration) playing = false
                renderTransport()
            }
        }
        renderTransport()
    }

    private fun pause() {
        playing = false
        loop?.cancel()
        renderTransport()
    }

    private fun renderTransport() {
        val b = _binding ?: return
        val duration = timeline?.duration ?: 0.0
        b.playButton.setImageResource(if (playing) R.drawable.ic_rt_pause else R.drawable.ic_rt_play)
        b.playButton.contentDescription = getString(if (playing) R.string.player_pause else R.string.player_play)
        if (!userSeeking) b.seek.progress = if (duration <= 0.0) 0 else ((position / duration) * 1000).toInt()
        b.timeLabel.text = getString(R.string.player_time, Format.clock(position), Format.clock(duration))
    }

    private fun renderSpeed() {
        val b = _binding ?: return
        val chips = SPEEDS.map { FilterChips.Chip(it.toString(), label(it)) }
        FilterChips.render(b.speedRow, chips, speed.toString(), onSelect = { id -> speed = id.toDouble(); renderSpeed() })
        b.speedRow.contentDescription = getString(R.string.player_speed)
    }

    private fun label(v: Double) = (if (v % 1.0 == 0.0) v.toInt().toString() else v.toString()) + "×"

    override fun onPause() {
        super.onPause()
        pause()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        loop?.cancel()
        _binding = null
    }

    companion object {
        private const val ARG_ID = "id"
        private const val FRAME_MS = 33L
        private const val SCROLLBACK = 2000
        private const val MIN_FONT_SP = 8f
        private val SPEEDS = listOf(0.5, 1.0, 2.0, 4.0)

        fun newInstance(recordingId: String) = PlayerFragment().apply {
            arguments = Bundle().apply { putString(ARG_ID, recordingId) }
        }
    }
}
