package com.cactus.remoteterminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.InputType
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Draws a [TerminalEmulator] grid on a Canvas: colours, attributes, a blinking
 * cursor, touch scrolling through scrollback, pinch-to-zoom font sizing, and
 * live keyboard input (soft + hardware) forwarded to the shell as raw bytes.
 *
 * Framework-only (no AndroidX) so it builds under the Aliyun-mirror constraint.
 */
class TerminalView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null,
) : View(context, attrs) {

    var emulator = TerminalEmulator()
        set(value) { field = value; recomputeGeometry(); invalidate() }

    /** Raw bytes the user typed, to be sent to the shell. */
    var onInput: ((String) -> Unit)? = null
    /** Fired when the visible grid size changes, so the host can send `resize`. */
    var onGeometryChanged: ((cols: Int, rows: Int) -> Unit)? = null
    /** Single tap — host uses it to raise the soft keyboard. */
    var onTap: (() -> Unit)? = null
    /** Long-press — host copies the given line text to the clipboard. */
    var onCopyLine: ((String) -> Unit)? = null
    /** Font size changed (e.g. via pinch) — host persists it. */
    var onFontSizeChanged: ((Float) -> Unit)? = null

    // Sticky modifiers driven by the on-screen key bar (Phase 2 key row).
    var ctrlActive = false
    var altActive = false

    private val fg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bgPaint = Paint()
    private val cursorPaint = Paint()

    private var fontSizeSp = 13f
    private var charW = 0f
    private var lineH = 0f
    private var baseline = 0f

    // Absolute index of the top visible row; `follow` keeps us pinned to the end.
    private var topRow = 0
    private var follow = true
    private var cursorOn = true

    private val defaultFg = 0xFFE6E6E6.toInt()
    private val defaultBg = 0xFF0C0C0C.toInt()

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        override fun onSingleTapUp(e: MotionEvent): Boolean { requestFocus(); onTap?.invoke(); return true }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            scrollByRows((dy / lineH).roundToInt()); return true
        }
        override fun onLongPress(e: MotionEvent) { copyLineAt(e.y) }
    })

    /** Copy the (trimmed) text of the row under a long-press to the clipboard. */
    private fun copyLineAt(yPx: Float) {
        if (lineH <= 0f) return
        val abs = topRow + (yPx / lineH).toInt()
        if (abs < 0 || abs >= emulator.totalRows()) return
        val row = emulator.rowAt(abs)
        var end = row.size
        while (end > 0 && row[end - 1].code == ' '.code) end--
        val sb = StringBuilder()
        for (x in 0 until end) sb.appendCodePoint(row[x].code)
        val text = sb.toString()
        if (text.isNotBlank()) { performHapticFeedback(0); onCopyLine?.invoke(text) }
    }

    private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean {
            setFontSizeSp(fontSizeSp * d.scaleFactor); return true
        }
    })

    private val blink = object : Runnable {
        override fun run() { cursorOn = !cursorOn; invalidate(); postDelayed(this, 530) }
    }

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        bgPaint.style = Paint.Style.FILL
        cursorPaint.color = 0xFFE6E6E6.toInt()
        applyFontMetrics()
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); postDelayed(blink, 530) }
    override fun onDetachedFromWindow() { super.onDetachedFromWindow(); removeCallbacks(blink) }

    /* ------------------------------ font/size ----------------------------- */

    fun setFontSizeSp(sp: Float) {
        val clamped = sp.coerceIn(8f, 32f)
        if (clamped == fontSizeSp) return
        fontSizeSp = clamped
        applyFontMetrics(); recomputeGeometry(); invalidate()
        onFontSizeChanged?.invoke(clamped)
    }

    fun fontSizeSp(): Float = fontSizeSp

    private fun applyFontMetrics() {
        val px = android.util.TypedValue.applyDimension(
            android.util.TypedValue.COMPLEX_UNIT_SP, fontSizeSp, resources.displayMetrics)
        fg.typeface = Typeface.MONOSPACE
        fg.textSize = px
        val fm = fg.fontMetrics
        charW = fg.measureText("M")
        lineH = (fm.descent - fm.ascent)
        baseline = -fm.ascent
    }

    /* ------------------------------ geometry ------------------------------ */

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) { recomputeGeometry() }

    private fun recomputeGeometry() {
        if (charW <= 0f || lineH <= 0f || width == 0 || height == 0) return
        val cols = max(1, (width / charW).toInt())
        val rows = max(1, (height / lineH).toInt())
        if (cols != emulator.cols || rows != emulator.rows) {
            emulator.resize(cols, rows)
            onGeometryChanged?.invoke(cols, rows)
        }
    }

    /** Call after feeding output so the view refreshes and (if following) sticks to the end. */
    fun notifyUpdated() {
        if (follow) topRow = max(0, emulator.totalRows() - visibleRows())
        invalidate()
    }

    private fun visibleRows(): Int = if (lineH <= 0f) 0 else (height / lineH).toInt()

    private fun scrollByRows(rows: Int) {
        val maxTop = max(0, emulator.totalRows() - visibleRows())
        topRow = (topRow + rows).coerceIn(0, maxTop)
        follow = topRow >= maxTop
        invalidate()
    }

    fun scrollToBottom() { follow = true; notifyUpdated() }

    /* ------------------------------ drawing ------------------------------- */

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(defaultBg)
        if (charW <= 0f) return
        val vis = visibleRows()
        val total = emulator.totalRows()
        var y = 0f
        for (r in 0 until vis) {
            val abs = topRow + r
            if (abs >= total) break
            drawRow(canvas, emulator.rowAt(abs), y, abs)
            y += lineH
        }
    }

    /** Draw one row, batching consecutive cells that share a style. */
    private fun drawRow(canvas: Canvas, row: Array<TerminalEmulator.Cell>, y: Float, absRow: Int) {
        val cursorHere = cursorOn && emulator.cursorVisible && absRow == emulator.cursorAbsRow()
        var x = 0
        val n = row.size
        while (x < n) {
            val c = row[x]
            val start = x
            val sb = StringBuilder()
            // extend the run while style matches and no cursor boundary is crossed
            while (x < n && sameStyle(row[x], c) && !(cursorHere && x == emulator.cursorCol)) {
                sb.appendCodePoint(row[x].code); x++
                if (cursorHere && x == emulator.cursorCol) break
            }
            paintRun(canvas, sb.toString(), start, y, c)
            if (cursorHere && x == emulator.cursorCol && x < n) {
                drawCursorCell(canvas, row[x], x, y); x++
            }
        }
        // cursor past end-of-content (e.g. empty line)
        if (cursorHere && emulator.cursorCol >= n) {
            canvas.drawRect(emulator.cursorCol * charW, y, (emulator.cursorCol + 1) * charW, y + lineH, cursorPaint)
        }
    }

    private fun sameStyle(a: TerminalEmulator.Cell, b: TerminalEmulator.Cell) =
        a.fg == b.fg && a.bg == b.bg && a.flags == b.flags

    private fun paintRun(canvas: Canvas, text: String, startCol: Int, y: Float, style: TerminalEmulator.Cell) {
        if (text.isEmpty()) return
        var fgc = resolve(style.fg, true)
        var bgc = resolve(style.bg, false)
        if (style.flags and TerminalEmulator.REVERSE != 0) { val t = fgc; fgc = bgc; bgc = t }
        if (style.flags and TerminalEmulator.DIM != 0) fgc = dim(fgc)
        val x0 = startCol * charW
        val x1 = (startCol + text.length) * charW
        if (bgc != defaultBg) { bgPaint.color = bgc; canvas.drawRect(x0, y, x1, y + lineH, bgPaint) }
        if (style.flags and TerminalEmulator.HIDDEN != 0) return
        fg.color = fgc
        fg.isFakeBoldText = style.flags and TerminalEmulator.BOLD != 0
        fg.isUnderlineText = style.flags and TerminalEmulator.UNDERLINE != 0
        fg.textSkewX = if (style.flags and TerminalEmulator.ITALIC != 0) -0.2f else 0f
        canvas.drawText(text, x0, y + baseline, fg)
    }

    private fun drawCursorCell(canvas: Canvas, c: TerminalEmulator.Cell, col: Int, y: Float) {
        val x0 = col * charW
        canvas.drawRect(x0, y, x0 + charW, y + lineH, cursorPaint)
        fg.color = defaultBg
        fg.isFakeBoldText = false; fg.isUnderlineText = false; fg.textSkewX = 0f
        canvas.drawText(String(Character.toChars(c.code)), x0, y + baseline, fg)
    }

    private fun resolve(code: Int, isFg: Boolean): Int = when {
        code == TerminalEmulator.DEFAULT -> if (isFg) defaultFg else defaultBg
        code and TerminalEmulator.TRUECOLOR != 0 -> 0xFF000000.toInt() or (code and 0xFFFFFF)
        code in 0..255 -> PALETTE[code]
        else -> if (isFg) defaultFg else defaultBg
    }

    private fun dim(c: Int): Int = Color.argb(
        255, Color.red(c) * 2 / 3, Color.green(c) * 2 / 3, Color.blue(c) * 2 / 3
    )

    /* ------------------------------- input -------------------------------- */

    @Suppress("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaler.onTouchEvent(event)
        gestures.onTouchEvent(event)
        return true
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        // A dumb terminal: no autocorrect/suggestions; deliver raw keys.
        outAttrs.inputType = InputType.TYPE_NULL
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
        return object : BaseInputConnection(this, false) {
            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                typeText(text.toString()); return true
            }
            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) onKeyDown(event.keyCode, event)
                return true
            }
            override fun deleteSurroundingText(before: Int, after: Int): Boolean {
                repeat(before) { send(DEL) }; return true
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val bytes = when (keyCode) {
            KeyEvent.KEYCODE_ENTER -> "\r"
            KeyEvent.KEYCODE_DEL -> DEL
            KeyEvent.KEYCODE_ESCAPE -> ESC
            KeyEvent.KEYCODE_TAB -> "\t"
            KeyEvent.KEYCODE_DPAD_UP -> ESC + "[A"
            KeyEvent.KEYCODE_DPAD_DOWN -> ESC + "[B"
            KeyEvent.KEYCODE_DPAD_RIGHT -> ESC + "[C"
            KeyEvent.KEYCODE_DPAD_LEFT -> ESC + "[D"
            KeyEvent.KEYCODE_MOVE_HOME -> ESC + "[H"
            KeyEvent.KEYCODE_MOVE_END -> ESC + "[F"
            KeyEvent.KEYCODE_FORWARD_DEL -> ESC + "[3~"
            else -> {
                val u = event.unicodeChar
                if (u != 0) String(Character.toChars(u)) else return super.onKeyDown(keyCode, event)
            }
        }
        if (event.isCtrlPressed && bytes.length == 1) { send(ctrlByte(bytes)); return true }
        typeText(bytes)
        return true
    }

    /** Apply sticky Ctrl/Alt from the key bar, then send. */
    fun typeText(s: String) {
        var out = s
        if (ctrlActive && s.length == 1) { out = ctrlByte(s); ctrlActive = false }
        if (altActive) { out = ESC + out; altActive = false }
        send(out)
    }

    /** Map a printable char to its Ctrl-modified control byte (Ctrl-A = 0x01, ...). */
    private fun ctrlByte(s: String): String {
        if (s.isEmpty()) return s
        val code = s[0].uppercaseChar().code
        return if (code in 64..95) (code and 0x1F).toChar().toString() else s
    }

    private fun send(s: String) { if (s.isNotEmpty()) onInput?.invoke(s) }

    companion object {
        private const val ESC = "\u001B"
        private const val DEL = "\u007F"

        /** xterm 256-colour palette as ARGB ints. */
        private val PALETTE = IntArray(256).also { p ->
            val base = intArrayOf(
                0x000000, 0xCD0000, 0x00CD00, 0xCDCD00, 0x1E90FF, 0xCD00CD, 0x00CDCD, 0xE5E5E5,
                0x7F7F7F, 0xFF0000, 0x00FF00, 0xFFFF00, 0x5C5CFF, 0xFF00FF, 0x00FFFF, 0xFFFFFF,
            )
            for (i in 0 until 16) p[i] = 0xFF000000.toInt() or base[i]
            val steps = intArrayOf(0, 95, 135, 175, 215, 255)
            var idx = 16
            for (r in 0 until 6) for (g in 0 until 6) for (b in 0 until 6) {
                p[idx++] = 0xFF000000.toInt() or (steps[r] shl 16) or (steps[g] shl 8) or steps[b]
            }
            for (i in 0 until 24) { val v = 8 + i * 10; p[232 + i] = 0xFF000000.toInt() or (v shl 16) or (v shl 8) or v }
        }
    }
}
