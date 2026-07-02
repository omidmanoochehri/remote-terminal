package com.cactus.remoteterminal

import android.content.Context
import android.content.res.ColorStateList
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import org.json.JSONObject
import kotlin.math.min
import kotlin.random.Random

/**
 * Single-screen terminal client. Renders a real VT/ANSI grid via [TerminalView]
 * + [TerminalEmulator], manages saved connection [Profile]s, and talks to the
 * relay via [MiniWebSocket] (ws:// or wss://) with auto-reconnect.
 */
class MainActivity : AppCompatActivity(), MiniWebSocket.Listener {

    private lateinit var statusChip: Chip
    private lateinit var profileLabel: TextView
    private lateinit var connectBtn: MaterialButton
    private lateinit var terminal: TerminalView
    private lateinit var keyRow: LinearLayout
    private lateinit var input: TextInputEditText
    private lateinit var sendBtn: MaterialButton

    private lateinit var prefs: Prefs
    private var current: Profile? = null

    private var ws: MiniWebSocket? = null
    @Volatile private var connected = false
    private var wantConnected = false
    private var reconnectAttempt = 0
    private val ui = Handler(Looper.getMainLooper())
    private val term = TerminalEmulator()

    // Local command history.
    private val history = ArrayList<String>()
    private var historyIdx = -1

    // Control sequences (kept as code points so the source stays plain ASCII).
    private val ESC = 27.toChar().toString()
    private val CR = "\r"
    private val ETX = 3.toChar().toString()
    private val TAB = "\t"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        setSupportActionBar(findViewById<MaterialToolbar>(R.id.toolbar))
        supportActionBar?.title = getString(R.string.app_name)

        statusChip = findViewById(R.id.statusChip)
        profileLabel = findViewById(R.id.profileLabel)
        connectBtn = findViewById(R.id.connectBtn)
        terminal = findViewById(R.id.terminal)
        keyRow = findViewById(R.id.keyRow)
        input = findViewById(R.id.input)
        sendBtn = findViewById(R.id.sendBtn)

        terminal.emulator = term
        terminal.onInput = { data -> sendInput(data) }
        terminal.onGeometryChanged = { cols, rows -> sendResize(cols, rows) }
        terminal.onTap = { showKeyboardFor(terminal) }
        terminal.onCopyLine = { line -> copyToClipboard(line); setStatus("copied", R.color.status_ok) }
        terminal.onFontSizeChanged = { sp -> prefs.fontSizeSp = sp }
        term.onResponse = { data -> sendInput(data) }
        terminal.setFontSizeSp(prefs.fontSizeSp)

        connectBtn.setOnClickListener { if (wantConnected) userDisconnect() else userConnect() }
        profileLabel.setOnClickListener { showProfiles() }
        sendBtn.setOnClickListener { sendCurrentLine() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) { sendCurrentLine(); true } else false
        }

        buildKeyRow()
        selectInitialProfile()
        appendSystem("Pick or add a profile, then Connect.\r\n")
    }

    /* ------------------------------ key row ------------------------------- */

    private fun buildKeyRow() {
        addToggle("Ctrl") { on -> terminal.ctrlActive = on }
        addToggle("Alt") { on -> terminal.altActive = on }
        addKey("Esc") { sendInput(ESC) }
        addKey("Tab") { sendInput(TAB) }
        addKey("<") { sendInput(ESC + "[D") }
        addKey(">") { sendInput(ESC + "[C") }
        addKey("Up") { onHistoryOrArrow(-1) }
        addKey("Dn") { onHistoryOrArrow(1) }
        addKey("^C") { sendInput(ETX) }
        addKey("Enter") { sendInput(CR) }
        addKey("Paste") { pasteFromClipboard() }
        addKey("Clear") { term.clear(); terminal.notifyUpdated() }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun makeKey(label: String) = MaterialButton(this).apply {
        text = label
        isAllCaps = false
        textSize = 13f
        minWidth = 0; minimumWidth = 0
        minHeight = 0; minimumHeight = 0
        insetTop = 0; insetBottom = 0
        cornerRadius = dp(8)
        setPadding(dp(14), dp(6), dp(14), dp(6))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { marginStart = dp(3); marginEnd = dp(3); topMargin = dp(6); bottomMargin = dp(6) }
        backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(context, R.color.surface_variant))
        setTextColor(ContextCompat.getColor(context, R.color.on_surface))
    }

    private fun addKey(label: String, onClick: () -> Unit) {
        keyRow.addView(makeKey(label).apply { setOnClickListener { onClick() } })
    }

    /** A sticky modifier toggle that recolours when active. */
    private fun addToggle(label: String, onChange: (Boolean) -> Unit) {
        val btn = makeKey(label)
        var on = false
        fun paint() {
            btn.backgroundTintList = ColorStateList.valueOf(
                ContextCompat.getColor(this, if (on) R.color.accent else R.color.surface_variant))
            btn.setTextColor(ContextCompat.getColor(this, if (on) R.color.on_accent else R.color.on_surface))
        }
        btn.setOnClickListener { on = !on; onChange(on); paint() }
        keyRow.addView(btn)
    }

    private fun onHistoryOrArrow(dir: Int) {
        if (term.isAltScreen) { sendInput(if (dir < 0) ESC + "[A" else ESC + "[B"); return }
        if (history.isEmpty()) return
        historyIdx = (historyIdx + dir).coerceIn(0, history.size - 1)
        input.setText(history[historyIdx]); input.setSelection(input.text?.length ?: 0)
    }

    private fun showKeyboardFor(v: View) {
        v.requestFocus()
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .showSoftInput(v, InputMethodManager.SHOW_IMPLICIT)
    }

    /* ------------------------------ profiles ------------------------------ */

    private fun selectInitialProfile() {
        val list = prefs.profiles()
        current = list.firstOrNull { it.name == prefs.lastProfile } ?: list.firstOrNull()
        updateProfileLabel()
    }

    private fun updateProfileLabel() {
        val p = current
        profileLabel.text = if (p == null) "no profile" else "${p.name} · ${p.server}"
    }

    private fun showProfiles() {
        val list = prefs.profiles()
        val names = list.map { it.name }.toTypedArray()
        var sel = list.indexOfFirst { it.name == current?.name }.coerceAtLeast(0)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.profiles)
            .setSingleChoiceItems(names, sel) { _, which -> sel = which }
            .setPositiveButton(R.string.connect) { _, _ ->
                if (list.isNotEmpty()) { current = list[sel]; prefs.lastProfile = list[sel].name; updateProfileLabel(); userConnect() }
            }
            .setNeutralButton(R.string.add_profile) { _, _ -> editProfile(null) }
            .setNegativeButton(R.string.edit_profile) { _, _ -> if (list.isNotEmpty()) editProfile(list[sel]) }
            .show()
    }

    private fun editProfile(existing: Profile?) {
        val view = layoutInflater.inflate(R.layout.dialog_profile, null)
        val name = view.findViewById<TextInputEditText>(R.id.pName)
        val server = view.findViewById<TextInputEditText>(R.id.pServer)
        val room = view.findViewById<TextInputEditText>(R.id.pRoom)
        val token = view.findViewById<TextInputEditText>(R.id.pToken)
        val pair = view.findViewById<TextInputEditText>(R.id.pPair)
        existing?.let {
            name.setText(it.name); server.setText(it.server); room.setText(it.room)
            token.setText(it.token); pair.setText(it.pair)
        }
        if (existing == null) server.setText("wss://")

        val b = MaterialAlertDialogBuilder(this)
            .setTitle(if (existing == null) R.string.add_profile else R.string.edit_profile)
            .setView(view)
            .setPositiveButton(R.string.save) { _, _ ->
                val p = Profile(
                    name.text?.toString()?.trim().orEmpty().ifEmpty { "Unnamed" },
                    server.text?.toString()?.trim().orEmpty(),
                    room.text?.toString()?.trim().orEmpty(),
                    token.text?.toString()?.trim().orEmpty(),
                    pair.text?.toString()?.trim().orEmpty(),
                )
                if (existing != null && existing.name != p.name) prefs.remove(existing.name)
                prefs.upsert(p)
                current = p; prefs.lastProfile = p.name; updateProfileLabel()
            }
            .setNegativeButton(R.string.cancel, null)
        if (existing != null) b.setNeutralButton(R.string.delete) { _, _ ->
            prefs.remove(existing.name); selectInitialProfile()
        }
        b.show()
    }

    /* ----------------------------- connection ----------------------------- */

    private fun userConnect() {
        val p = current ?: run { showProfiles(); return }
        wantConnected = true
        reconnectAttempt = 0
        connectBtn.text = getString(R.string.disconnect)
        openSocket(p)
    }

    private fun userDisconnect() {
        wantConnected = false
        ui.removeCallbacksAndMessages(null)
        ws?.close(); ws = null
        connected = false
        connectBtn.text = getString(R.string.connect)
        setStatus("disconnected", R.color.on_surface_muted)
    }

    private fun openSocket(p: Profile) {
        setStatus(if (reconnectAttempt == 0) "connecting…" else "reconnecting…", R.color.status_warn)
        ws = MiniWebSocket(p.url(), this).also { it.connect() }
    }

    private fun scheduleReconnect() {
        if (!wantConnected) return
        val delay = min(30_000L, 500L * (1L shl min(reconnectAttempt, 6))) + Random.nextLong(400)
        reconnectAttempt++
        setStatus("reconnecting in ${delay / 1000}s…", R.color.status_warn)
        ui.postDelayed({ current?.let { openSocket(it) } }, delay)
    }

    /* --------------------------- socket callbacks ------------------------- */

    override fun onOpen() = runOnUiThread {
        connected = true
        reconnectAttempt = 0
        setStatus("connected", R.color.status_ok)
        sendResize(term.cols, term.rows)
    }

    override fun onText(text: String) = runOnUiThread { handleMessage(text) }

    override fun onClose(reason: String) = runOnUiThread {
        connected = false
        if (wantConnected) { appendSystem("\r\n[$reason]\r\n"); scheduleReconnect() }
        else setStatus(reason, R.color.on_surface_muted)
    }

    override fun onError(t: Throwable) = runOnUiThread {
        android.util.Log.e("RT", "ws error", t)
        connected = false
        if (wantConnected) scheduleReconnect()
        else setStatus("error: ${t.message ?: t.javaClass.simpleName}", R.color.status_err)
    }

    /* ------------------------------ messages ------------------------------ */

    private fun handleMessage(text: String) {
        val msg = try { JSONObject(text) } catch (e: Exception) { return }
        when (msg.optString("type")) {
            "output", "replay" -> { term.feed(msg.optString("data")); terminal.notifyUpdated() }
            "welcome" -> setStatus("connected · room ${msg.optString("room")}", R.color.status_ok)
            "status" -> {
                val peer = msg.optString("peer")
                if (peer == "connected") setStatus("agent online", R.color.status_ok)
                else setStatus("agent offline", R.color.status_warn)
                appendSystem("\r\n[agent $peer]\r\n")
            }
            "exit" -> appendSystem("\r\n[shell exited ${msg.optInt("code")}]\r\n")
            "pong" -> {}
            "error" -> setStatus("server: ${msg.optString("message")}", R.color.status_err)
        }
    }

    private fun sendCurrentLine() {
        val line = input.text?.toString() ?: ""
        if (line.isNotEmpty()) {
            history.remove(line); history.add(line)
            while (history.size > 100) history.removeAt(0)
        }
        historyIdx = history.size
        sendInput(line + CR)
        input.setText("")
    }

    private fun sendInput(data: String) {
        val sock = ws
        if (sock == null || !connected) { setStatus("not connected", R.color.status_warn); return }
        sock.send(JSONObject().put("type", "input").put("data", data).toString())
    }

    private fun sendResize(cols: Int, rows: Int) {
        ws?.send(JSONObject().put("type", "resize").put("cols", cols).put("rows", rows).toString())
    }

    /* -------------------------------- view -------------------------------- */

    private fun appendSystem(s: String) { term.feed(s); terminal.notifyUpdated() }

    private fun setStatus(s: String, colorRes: Int) {
        statusChip.text = s
        statusChip.chipStrokeColor = ColorStateList.valueOf(ContextCompat.getColor(this, colorRes))
        statusChip.setTextColor(ContextCompat.getColor(this, colorRes))
    }

    private fun copyToClipboard(text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("terminal", text))
    }

    private fun pasteFromClipboard() {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = cm.primaryClip ?: return
        if (clip.itemCount == 0) return
        val text = clip.getItemAt(0).coerceToText(this)?.toString() ?: return
        if (text.isNotEmpty()) sendInput(text)
    }

    /* -------------------------------- menu -------------------------------- */

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu); return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_profiles -> { showProfiles(); true }
        R.id.action_zoom_in -> { terminal.setFontSizeSp(terminal.fontSizeSp() + 1f); true }
        R.id.action_zoom_out -> { terminal.setFontSizeSp(terminal.fontSizeSp() - 1f); true }
        else -> super.onOptionsItemSelected(item)
    }

    override fun onDestroy() {
        super.onDestroy()
        wantConnected = false
        ui.removeCallbacksAndMessages(null)
        ws?.close()
    }
}
