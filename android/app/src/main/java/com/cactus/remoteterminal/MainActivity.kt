package com.cactus.remoteterminal

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/**
 * Single-screen terminal client. Framework-only (no AndroidX) so it builds
 * without Google's Maven repo. Talks to the relay via [MiniWebSocket].
 */
class MainActivity : Activity(), MiniWebSocket.Listener {

    private lateinit var serverUrl: EditText
    private lateinit var room: EditText
    private lateinit var connectBtn: Button
    private lateinit var status: TextView
    private lateinit var scroll: ScrollView
    private lateinit var terminal: TextView
    private lateinit var keyRow: LinearLayout
    private lateinit var input: EditText
    private lateinit var sendBtn: Button

    private var ws: MiniWebSocket? = null
    @Volatile private var connected = false
    private val term = TerminalBuffer()

    // Control sequences built from code points (keeps the file plain ASCII).
    private val ESC = 27.toChar().toString()
    private val CR = "\r"
    private val ETX = 3.toChar().toString()   // Ctrl-C
    private val TAB = "\t"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        serverUrl = findViewById(R.id.serverUrl)
        room = findViewById(R.id.room)
        connectBtn = findViewById(R.id.connectBtn)
        status = findViewById(R.id.status)
        scroll = findViewById(R.id.scroll)
        terminal = findViewById(R.id.terminal)
        keyRow = findViewById(R.id.keyRow)
        input = findViewById(R.id.input)
        sendBtn = findViewById(R.id.sendBtn)

        serverUrl.setText("ws://10.0.2.2:8080")
        room.setText("demo")

        connectBtn.setOnClickListener { if (connected) disconnect() else connect() }
        sendBtn.setOnClickListener { sendCurrentLine() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) { sendCurrentLine(); true } else false
        }

        addKey("Esc") { sendInput(ESC) }
        addKey("Tab") { sendInput(TAB) }
        addKey("Ctrl+C") { sendInput(ETX) }
        addKey("Up") { sendInput(ESC + "[A") }
        addKey("Down") { sendInput(ESC + "[B") }
        addKey("Enter") { sendInput(CR) }
        addKey("Clear") { term.clear(); repaint() }

        appendSystem("Not connected. Enter server + room, then Connect.\n")
    }

    /* -------------------------------- keys -------------------------------- */

    private fun addKey(label: String, onClick: () -> Unit) {
        val btn = Button(this).apply {
            text = label
            textSize = 12f
            isAllCaps = false
            minWidth = 0
            minimumWidth = 0
            setPadding(24, 8, 24, 8)
            setOnClickListener { onClick() }
        }
        keyRow.addView(btn)
    }

    /* ----------------------------- connection ----------------------------- */

    private fun connect() {
        val base = serverUrl.text.toString().trim().removeSuffix("/")
        val r = room.text.toString().trim().ifEmpty { "demo" }
        if (base.isEmpty()) { setStatus("enter a server URL"); return }
        val url = "$base/?role=phone&room=$r"
        setStatus("connecting to $url …")
        ws = MiniWebSocket(url, this).also { it.connect() }
    }

    private fun disconnect() {
        ws?.close()
        ws = null
    }

    /* --------------------------- socket callbacks ------------------------- */

    override fun onOpen() = runOnUiThread {
        connected = true
        connectBtn.text = "Close"
        setStatus("connected")
        sendResize(100, 30)
    }

    override fun onText(text: String) = runOnUiThread { handleMessage(text) }

    override fun onClose(reason: String) = runOnUiThread { markDisconnected(reason) }

    override fun onError(t: Throwable) = runOnUiThread {
        android.util.Log.e("RT", "ws error", t)
        markDisconnected("error: ${t.message ?: t.javaClass.simpleName}")
    }

    private fun markDisconnected(why: String) {
        if (!connected && connectBtn.text == "Connect") { setStatus(why); return }
        connected = false
        connectBtn.text = "Connect"
        setStatus(why)
        appendSystem("\n[$why]\n")
    }

    /* ------------------------------ messages ------------------------------ */

    private fun handleMessage(text: String) {
        val msg = try { JSONObject(text) } catch (e: Exception) { return }
        when (msg.optString("type")) {
            "output" -> { term.feed(msg.optString("data")); repaint() }
            "welcome" -> setStatus("connected · room ${msg.optString("room")}")
            "status" -> {
                val peer = msg.optString("peer")
                setStatus(if (peer == "connected") "agent online" else "agent offline")
                appendSystem("\n[agent $peer]\n")
            }
            "exit" -> appendSystem("\n[shell exited ${msg.optInt("code")}]\n")
            "error" -> setStatus("server: ${msg.optString("message")}")
        }
    }

    private fun sendCurrentLine() {
        sendInput(input.text.toString() + CR)
        input.setText("")
    }

    private fun sendInput(data: String) {
        val sock = ws
        if (sock == null || !connected) { setStatus("not connected"); return }
        sock.send(JSONObject().put("type", "input").put("data", data).toString())
    }

    private fun sendResize(cols: Int, rows: Int) {
        ws?.send(JSONObject().put("type", "resize").put("cols", cols).put("rows", rows).toString())
    }

    /* ------------------------------- view --------------------------------- */

    private fun repaint() {
        terminal.text = term.render()
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun appendSystem(s: String) { term.feed(s); repaint() }

    private fun setStatus(s: String) { status.text = s }

    override fun onDestroy() {
        super.onDestroy()
        ws?.close()
    }
}
