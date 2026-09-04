package com.cactus.remoteterminal.terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.SystemClock
import android.text.InputType
import android.util.AttributeSet
import android.util.TypedValue
import android.view.ActionMode
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.OverScroller
import androidx.core.content.res.ResourcesCompat
import com.cactus.remoteterminal.R
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Renders a [TerminalEmulator] and turns touches and keys into terminal input.
 *
 *  - Drawing: only visible rows, cells batched into same-style runs drawn from
 *    a reusable char buffer; wide glyphs drawn per cell; box/block drawing
 *    characters drawn as primitives so TUI borders align with any fallback font.
 *  - Scrolling: drag + fling through scrollback, "follow" mode pinned to the
 *    newest output, a count of rows that arrived while scrolled up.
 *  - Selection: long-press selects a word, two handles adjust it, a floating
 *    action mode offers copy / select all / paste.
 *  - Search: highlights matches and jumps between them.
 *  - Mouse: when the application enabled mouse reporting, taps and swipes are
 *    reported instead of scrolling locally; long-press still selects.
 *  - Input: soft keyboard (with IME composing), hardware keys, and the shared
 *    [ModifierState] for on-screen Ctrl/Alt/Shift — all encoded by [KeyEncoder].
 */
class TerminalView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    /* ------------------------------- wiring ------------------------------- */

    var emulator: TerminalEmulator = TerminalEmulator()
        set(value) {
            if (field === value) return
            field = value
            selection = null
            clearSearch()
            follow = true
            recomputeGeometry()
            scrollToBottom()
            invalidate()
        }

    var theme: TerminalTheme = TerminalTheme.DARK
        set(value) { field = value; invalidate() }

    var modifiers: ModifierState = ModifierState()

    /** Bytes the user typed / keys pressed, ready for the shell. */
    var onInput: ((String) -> Unit)? = null
    /** The visible grid changed size. */
    var onGeometryChanged: ((cols: Int, rows: Int) -> Unit)? = null
    /** A plain tap (raise the keyboard). */
    var onTap: (() -> Unit)? = null
    /** Follow state / count of unseen rows changed. */
    var onFollowChanged: ((following: Boolean, newRows: Int) -> Unit)? = null
    var onFontSizeChanged: ((Float) -> Unit)? = null
    /** Text was copied (show a confirmation). */
    var onCopy: ((String) -> Unit)? = null
    /** The user chose Paste from the selection menu. */
    var onPasteRequest: (() -> Unit)? = null
    /** Search state changed: (current 1-based or 0, total). */
    var onSearchResult: ((Int, Int) -> Unit)? = null

    /** Cursor style from settings; a DECSCUSR request from the application overrides it. */
    var cursorStyleSetting: Int = TerminalEmulator.CURSOR_BLOCK
    var blinkEnabled: Boolean = true
        set(value) { field = value; cursorOn = true; invalidate() }
    var hapticsEnabled: Boolean = true
    /** In the alternate screen without mouse reporting, vertical swipes send arrow keys (for less/vim/man). */
    var swipeArrowsInAltScreen: Boolean = true

    /* ------------------------------- paints ------------------------------- */

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
    private val fillPaint = Paint()
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val cursorPaint = Paint()
    private val selectionPaint = Paint()
    private val searchPaint = Paint()
    private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private var fontSizeSp = 13f
    private var lineSpacing = 1.0f
    private var monoTypeface: Typeface = Typeface.MONOSPACE
    /** False only if we ended up on a font whose glyphs are not all the same width. */
    private var fontIsMono = true
    private var charW = 1f
    private var lineH = 1f
    private var baseline = 0f
    private val runBuf = CharArray(1024)

    /* ------------------------------- scroll ------------------------------- */

    private var topRow = 0
    private var follow = true
    private var lastReportedNew = -1
    private val scroller = OverScroller(context)
    private var scrollRemainder = 0f
    private var cursorOn = true
    private val blink = object : Runnable {
        override fun run() {
            if (!blinkEnabled || !hasWindowFocus()) { cursorOn = true; return }
            cursorOn = !cursorOn
            invalidate()
            postDelayed(this, 530)
        }
    }

    /* ------------------------------ selection ----------------------------- */

    private class Selection(var startRow: Int, var startCol: Int, var endRow: Int, var endCol: Int) {
        fun normalized(): IntArray =
            if (startRow < endRow || (startRow == endRow && startCol <= endCol)) intArrayOf(startRow, startCol, endRow, endCol)
            else intArrayOf(endRow, endCol, startRow, startCol)
    }
    private var selection: Selection? = null
    private var draggingHandle = 0 // 0 none, 1 start, 2 end
    private var actionMode: ActionMode? = null
    private val handleRadius get() = charW * 1.6f

    /* -------------------------------- search ------------------------------ */

    private class Match(val row: Int, val startCol: Int, val endCol: Int)
    private val matches = ArrayList<Match>()
    private var currentMatch = -1
    private var searchQuery = ""

    /* ------------------------------ composing ----------------------------- */

    private var composing: String = ""

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        contentDescription = context.getString(R.string.terminal_content_description)
        fillPaint.style = Paint.Style.FILL
        linePaint.style = Paint.Style.STROKE
        linePaint.strokeCap = Paint.Cap.BUTT
        handlePaint.style = Paint.Style.FILL
        monoTypeface = pickMonoTypeface()
        applyFont()
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); removeCallbacks(blink); postDelayed(blink, 530) }
    override fun onDetachedFromWindow() { super.onDetachedFromWindow(); removeCallbacks(blink); actionMode?.finish() }
    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        cursorOn = true
        removeCallbacks(blink)
        if (hasWindowFocus) postDelayed(blink, 530)
        invalidate()
    }

    /* ------------------------------- font --------------------------------- */

    fun setFontSizeSp(sp: Float, notify: Boolean = true) {
        val clamped = sp.coerceIn(8f, 32f)
        if (abs(clamped - fontSizeSp) < 0.01f) return
        fontSizeSp = clamped
        applyFont(); recomputeGeometry(); invalidate()
        if (notify) onFontSizeChanged?.invoke(clamped)
    }

    fun fontSizeSp(): Float = fontSizeSp

    fun setLineSpacing(mult: Float) {
        lineSpacing = mult.coerceIn(0.8f, 2f)
        applyFont(); recomputeGeometry(); invalidate()
    }

    /**
     * Prefer the system monospace face when the user asked for it in settings,
     * falling back to the bundled one if the platform face is not really
     * fixed-width (which would leave every line short of the right edge).
     */
    fun setPreferSystemFont(preferSystem: Boolean) {
        val wanted = if (preferSystem && isFixedWidth(Typeface.MONOSPACE)) Typeface.MONOSPACE else pickMonoTypeface()
        if (wanted == monoTypeface) return
        monoTypeface = wanted
        applyFont(); recomputeGeometry(); invalidate()
    }

    /**
     * The bundled font, so the cell width we measure is the width the glyphs are
     * actually drawn at. Some ROMs alias "monospace" to their proportional UI
     * font, which would leave every line short of the right edge; the system
     * face is only used if the bundle is missing *and* it is really fixed-width.
     */
    private fun pickMonoTypeface(): Typeface {
        val bundled = runCatching { ResourcesCompat.getFont(context, R.font.terminal_mono) }.getOrNull()
        if (bundled != null && isFixedWidth(bundled)) return bundled
        if (isFixedWidth(Typeface.MONOSPACE)) return Typeface.MONOSPACE
        return bundled ?: Typeface.MONOSPACE
    }

    private fun isFixedWidth(tf: Typeface): Boolean {
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.typeface = tf
        p.textSize = 100f
        val w = p.measureText("M")
        return w > 0f && WIDTH_SAMPLE.all { abs(p.measureText(it) - w) < 0.5f }
    }

    private fun applyFont() {
        val px = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, fontSizeSp, resources.displayMetrics)
        textPaint.typeface = monoTypeface
        textPaint.textSize = px
        val fm = textPaint.fontMetrics
        // Widest sample glyph, so a cell can never be narrower than what it holds.
        charW = WIDTH_SAMPLE.fold(textPaint.measureText("M")) { w, s -> max(w, textPaint.measureText(s)) }
            .coerceAtLeast(1f)
        fontIsMono = isFixedWidth(monoTypeface)
        lineH = ((fm.descent - fm.ascent) * lineSpacing).coerceAtLeast(1f)
        baseline = -fm.ascent + (lineH - (fm.descent - fm.ascent)) / 2f
        linePaint.strokeWidth = max(1f, px / 12f)
    }

    /* ------------------------------ geometry ------------------------------ */

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { recomputeGeometry() }

    val cols: Int get() = max(2, (width / charW).toInt())
    val rows: Int get() = max(2, (height / lineH).toInt())

    private fun recomputeGeometry() {
        if (width == 0 || height == 0) return
        val c = cols; val r = rows
        if (c != emulator.cols || r != emulator.rows) {
            onGeometryChanged?.invoke(c, r)
        }
        clampScroll()
    }

    /** Ask the host to (re)send geometry, e.g. after the emulator was swapped. */
    fun pushGeometry() { if (width > 0 && height > 0) onGeometryChanged?.invoke(cols, rows) }

    /* ------------------------------ scrolling ----------------------------- */

    private fun maxTop(): Int = max(0, emulator.totalRows() - rows)

    private fun clampScroll() {
        val m = maxTop()
        if (follow) topRow = m else topRow = topRow.coerceIn(0, m)
    }

    /** Call after feeding output: keeps following the end and refreshes the "new rows" count. */
    fun notifyUpdated() {
        if (follow) topRow = maxTop()
        else if (topRow > maxTop()) topRow = maxTop()
        reportFollow()
        postInvalidateOnAnimation()
    }

    private fun reportFollow() {
        val newRows = if (follow) 0 else max(0, maxTop() - topRow)
        if (newRows != lastReportedNew) { lastReportedNew = newRows; onFollowChanged?.invoke(follow, newRows) }
    }

    fun scrollToBottom() {
        follow = true
        topRow = maxTop()
        scroller.forceFinished(true)
        reportFollow()
        invalidate()
    }

    private fun scrollByRows(delta: Int) {
        if (delta == 0) return
        val m = maxTop()
        topRow = (topRow + delta).coerceIn(0, m)
        follow = topRow >= m
        reportFollow()
        invalidate()
    }

    fun scrollToRow(absRow: Int) {
        val m = maxTop()
        topRow = (absRow - rows / 2).coerceIn(0, m)
        follow = topRow >= m
        reportFollow()
        invalidate()
    }

    override fun computeScroll() {
        if (scroller.computeScrollOffset()) {
            val target = scroller.currY
            if (target != topRow) { topRow = target.coerceIn(0, maxTop()); follow = topRow >= maxTop(); reportFollow() }
            postInvalidateOnAnimation()
        }
    }

    /* ------------------------------- drawing ------------------------------ */

    override fun onDraw(canvas: Canvas) {
        val t = theme
        canvas.drawColor(t.background)
        val em = emulator
        val total = em.totalRows()
        val visible = rows
        val cursorAbs = em.cursorAbsRow()
        val showCursor = em.cursorVisible && (cursorOn || !blinkEnabled)
        val sel = selection?.normalized()
        var y = 0f
        for (r in 0 until visible) {
            val abs = topRow + r
            if (abs >= total) break
            val row = em.rowAt(abs)
            drawRow(canvas, row, y, t)
            if (sel != null && abs in sel[0]..sel[2]) drawSelectionRow(canvas, abs, y, sel, row.cols)
            if (matches.isNotEmpty()) drawSearchRow(canvas, abs, y)
            if (showCursor && abs == cursorAbs) drawCursor(canvas, row, y, t)
            y += lineH
        }
        if (sel != null) drawHandles(canvas, sel)
    }

    private fun drawRow(canvas: Canvas, row: Row, y: Float, t: TerminalTheme) {
        val n = row.cols
        val codes = row.codes; val fgs = row.fg; val bgs = row.bg; val flags = row.flags
        var x = 0
        while (x < n) {
            val fl = flags[x]
            if (fl and TerminalEmulator.CONTINUATION != 0) { x++; continue }
            val fg = fgs[x]; val bg = bgs[x]
            val code = codes[x]
            // Wide glyphs and box-drawing characters are drawn one cell at a time.
            if (fl and TerminalEmulator.WIDE != 0 || isBoxDrawing(code)) {
                val w = if (fl and TerminalEmulator.WIDE != 0) 2 else 1
                drawCell(canvas, row, x, w, y, t)
                x += w
                continue
            }
            // Without a fixed-width font a batched run would drift off the grid.
            if (!fontIsMono) { drawCell(canvas, row, x, 1, y, t); x++; continue }
            // Batch a run of narrow cells with identical style.
            val start = x
            var len = 0
            while (x < n && len < runBuf.size - 2 && flags[x] == fl && fgs[x] == fg && bgs[x] == bg && !isBoxDrawing(codes[x]) && row.combining(x) == null) {
                val c = codes[x]
                if (c >= 0x10000) { if (len >= runBuf.size - 2) break; runBuf[len++] = Character.highSurrogate(c); runBuf[len++] = Character.lowSurrogate(c) }
                else runBuf[len++] = c.toChar()
                x++
            }
            if (x == start) { drawCell(canvas, row, x, 1, y, t); x++; continue }
            paintRun(canvas, runBuf, len, start, x - start, y, fg, bg, fl, t)
        }
    }

    private fun styleColors(fgIn: Int, bgIn: Int, fl: Int, t: TerminalTheme): Long {
        var fg = fgIn; var bg = bgIn
        if (fl and TerminalEmulator.BOLD != 0 && fg in 0..7) fg += 8 // bold brightens the base colours (xterm)
        var fgc = resolve(fg, true, t)
        var bgc = resolve(bg, false, t)
        if (fl and TerminalEmulator.REVERSE != 0) { val tmp = fgc; fgc = bgc; bgc = tmp }
        if (fl and TerminalEmulator.DIM != 0) fgc = blend(fgc, bgc, 0.55f)
        return (fgc.toLong() and 0xFFFFFFFFL) or ((bgc.toLong() and 0xFFFFFFFFL) shl 32)
    }

    private fun paintRun(canvas: Canvas, chars: CharArray, len: Int, startCol: Int, cells: Int, y: Float, fg: Int, bg: Int, fl: Int, t: TerminalTheme) {
        val colors = styleColors(fg, bg, fl, t)
        val fgc = colors.toInt(); val bgc = (colors ushr 32).toInt()
        val x0 = startCol * charW
        val x1 = (startCol + cells) * charW
        if (bgc != t.background) { fillPaint.color = bgc; canvas.drawRect(x0, y, x1, y + lineH, fillPaint) }
        if (fl and TerminalEmulator.HIDDEN != 0) return
        applyTextStyle(fgc, fl)
        canvas.drawText(chars, 0, len, x0, y + baseline, textPaint)
    }

    private fun applyTextStyle(color: Int, fl: Int) {
        textPaint.color = color
        textPaint.isFakeBoldText = fl and TerminalEmulator.BOLD != 0
        textPaint.isUnderlineText = fl and TerminalEmulator.UNDERLINE != 0
        textPaint.isStrikeThruText = fl and TerminalEmulator.STRIKE != 0
        textPaint.textSkewX = if (fl and TerminalEmulator.ITALIC != 0) -0.2f else 0f
    }

    private fun drawCell(canvas: Canvas, row: Row, col: Int, cells: Int, y: Float, t: TerminalTheme) {
        val fl = row.flags[col]
        val colors = styleColors(row.fg[col], row.bg[col], fl, t)
        val fgc = colors.toInt(); val bgc = (colors ushr 32).toInt()
        val x0 = col * charW
        val x1 = x0 + cells * charW
        if (bgc != t.background) { fillPaint.color = bgc; canvas.drawRect(x0, y, x1, y + lineH, fillPaint) }
        if (fl and TerminalEmulator.HIDDEN != 0) return
        val code = row.codes[col]
        if (isBoxDrawing(code) && drawBox(canvas, code, x0, y, charW, lineH, fgc)) return
        applyTextStyle(fgc, fl)
        val s = StringBuilder(4).appendCodePoint(code)
        row.combining(col)?.let { s.append(it) }
        canvas.drawText(s, 0, s.length, x0, y + baseline, textPaint)
    }

    private fun drawCursor(canvas: Canvas, row: Row, y: Float, t: TerminalTheme) {
        val em = emulator
        val col = em.cursorCol.coerceIn(0, row.cols - 1)
        val wide = row.flags[col] and TerminalEmulator.WIDE != 0
        val x0 = col * charW
        val x1 = x0 + (if (wide) 2 else 1) * charW
        val style = if (em.cursorStyle != TerminalEmulator.CURSOR_BLOCK) em.cursorStyle else cursorStyleSetting
        cursorPaint.color = t.cursor
        when {
            !hasFocus() -> { linePaint.color = t.cursor; canvas.drawRect(x0 + 0.5f, y + 0.5f, x1 - 0.5f, y + lineH - 0.5f, linePaint) }
            style == TerminalEmulator.CURSOR_UNDERLINE -> canvas.drawRect(x0, y + lineH - max(2f, lineH / 8f), x1, y + lineH, cursorPaint)
            style == TerminalEmulator.CURSOR_BAR -> canvas.drawRect(x0, y, x0 + max(2f, charW / 6f), y + lineH, cursorPaint)
            else -> {
                canvas.drawRect(x0, y, x1, y + lineH, cursorPaint)
                val code = row.codes[col]
                if (code != 0 && code != ' '.code && !isBoxDrawing(code)) {
                    applyTextStyle(t.background, row.flags[col])
                    val s = StringBuilder(4).appendCodePoint(code)
                    canvas.drawText(s, 0, s.length, x0, y + baseline, textPaint)
                }
            }
        }
    }

    private fun drawSelectionRow(canvas: Canvas, abs: Int, y: Float, sel: IntArray, cols: Int) {
        val from = if (abs == sel[0]) sel[1] else 0
        val to = if (abs == sel[2]) sel[3] else cols - 1
        selectionPaint.color = theme.selection
        canvas.drawRect(from * charW, y, (to + 1) * charW, y + lineH, selectionPaint)
    }

    private fun drawSearchRow(canvas: Canvas, abs: Int, y: Float) {
        for ((i, m) in matches.withIndex()) {
            if (m.row != abs) continue
            searchPaint.color = if (i == currentMatch) 0xAAFFB300.toInt() else 0x66FFB300
            canvas.drawRect(m.startCol * charW, y, (m.endCol + 1) * charW, y + lineH, searchPaint)
        }
    }

    private fun drawHandles(canvas: Canvas, sel: IntArray) {
        handlePaint.color = 0xFF3B82F6.toInt()
        val r = handleRadius
        handlePoint(sel[0], sel[1], true)?.let { canvas.drawCircle(it[0], it[1], r, handlePaint) }
        handlePoint(sel[2], sel[3], false)?.let { canvas.drawCircle(it[0], it[1], r, handlePaint) }
    }

    /** Screen position of a selection handle (below-left of the start cell / below-right of the end cell). */
    private fun handlePoint(row: Int, col: Int, start: Boolean): FloatArray? {
        val r = row - topRow
        if (r < -1 || r > rows) return null
        val x = (if (start) col else col + 1) * charW
        val y = (r + 1) * lineH + handleRadius * 0.9f
        return floatArrayOf(x, y)
    }

    private fun resolve(code: Int, isFg: Boolean, t: TerminalTheme): Int = when {
        code == TerminalEmulator.DEFAULT -> if (isFg) t.foreground else t.background
        code and TerminalEmulator.TRUECOLOR != 0 -> 0xFF000000.toInt() or (code and 0xFFFFFF)
        code in 0..255 -> t.palette[code]
        else -> if (isFg) t.foreground else t.background
    }

    private fun blend(a: Int, b: Int, wa: Float): Int = Color.argb(
        255,
        (Color.red(a) * wa + Color.red(b) * (1 - wa)).roundToInt(),
        (Color.green(a) * wa + Color.green(b) * (1 - wa)).roundToInt(),
        (Color.blue(a) * wa + Color.blue(b) * (1 - wa)).roundToInt(),
    )

    /* ---------------------------- box drawing ----------------------------- */

    private fun isBoxDrawing(code: Int) = code in 0x2500..0x259F

    /**
     * Draw common box/block characters with primitives so borders line up
     * regardless of which font supplies the glyph. Returns false for shapes
     * we leave to the font.
     */
    private fun drawBox(canvas: Canvas, code: Int, x: Float, y: Float, w: Float, h: Float, color: Int): Boolean {
        val cx = x + w / 2f; val cy = y + h / 2f
        val sw = linePaint.strokeWidth
        linePaint.color = color
        fillPaint.color = color
        fun hLeft() = canvas.drawLine(x, cy, cx, cy, linePaint)
        fun hRight() = canvas.drawLine(cx, cy, x + w, cy, linePaint)
        fun vUp() = canvas.drawLine(cx, y, cx, cy, linePaint)
        fun vDown() = canvas.drawLine(cx, cy, cx, y + h, linePaint)
        when (code) {
            0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254C, 0x254D, 0x2550 -> { canvas.drawLine(x, cy, x + w, cy, linePaint) }
            0x2502, 0x2503, 0x2506, 0x2507, 0x250A, 0x250B, 0x254E, 0x254F, 0x2551 -> { canvas.drawLine(cx, y, cx, y + h, linePaint) }
            0x250C, 0x250D, 0x250E, 0x250F, 0x2552, 0x2553, 0x2554, 0x256D -> { hRight(); vDown() }
            0x2510, 0x2511, 0x2512, 0x2513, 0x2555, 0x2556, 0x2557, 0x256E -> { hLeft(); vDown() }
            0x2514, 0x2515, 0x2516, 0x2517, 0x2558, 0x2559, 0x255A, 0x2570 -> { hRight(); vUp() }
            0x2518, 0x2519, 0x251A, 0x251B, 0x255B, 0x255C, 0x255D, 0x256F -> { hLeft(); vUp() }
            in 0x251C..0x2523, 0x255E, 0x255F, 0x2560 -> { vUp(); vDown(); hRight() }
            in 0x2524..0x252B, 0x2561, 0x2562, 0x2563 -> { vUp(); vDown(); hLeft() }
            in 0x252C..0x2533, 0x2564, 0x2565, 0x2566 -> { hLeft(); hRight(); vDown() }
            in 0x2534..0x253B, 0x2567, 0x2568, 0x2569 -> { hLeft(); hRight(); vUp() }
            in 0x253C..0x254B, 0x256A, 0x256B, 0x256C -> { hLeft(); hRight(); vUp(); vDown() }
            0x2574 -> hLeft(); 0x2575 -> vUp(); 0x2576 -> hRight(); 0x2577 -> vDown()
            0x2588 -> canvas.drawRect(x, y, x + w, y + h, fillPaint)
            0x2580 -> canvas.drawRect(x, y, x + w, cy, fillPaint)
            0x2584 -> canvas.drawRect(x, cy, x + w, y + h, fillPaint)
            0x258C -> canvas.drawRect(x, y, cx, y + h, fillPaint)
            0x2590 -> canvas.drawRect(cx, y, x + w, y + h, fillPaint)
            in 0x2581..0x2583, in 0x2585..0x2587 -> { val frac = (code - 0x2580) / 8f; canvas.drawRect(x, y + h * (1 - frac), x + w, y + h, fillPaint) }
            in 0x2589..0x258B, in 0x258D..0x258F -> { val frac = (0x2590 - code) / 8f; canvas.drawRect(x, y, x + w * frac, y + h, fillPaint) }
            0x2591, 0x2592, 0x2593 -> {
                fillPaint.color = Color.argb(if (code == 0x2591) 64 else if (code == 0x2592) 128 else 192, Color.red(color), Color.green(color), Color.blue(color))
                canvas.drawRect(x, y, x + w, y + h, fillPaint)
            }
            0x2596 -> canvas.drawRect(x, cy, cx, y + h, fillPaint)
            0x2597 -> canvas.drawRect(cx, cy, x + w, y + h, fillPaint)
            0x2598 -> canvas.drawRect(x, y, cx, cy, fillPaint)
            0x259D -> canvas.drawRect(cx, y, x + w, cy, fillPaint)
            else -> return false
        }
        if (sw <= 0f) return true
        return true
    }

    /* -------------------------------- touch ------------------------------- */

    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean { setFontSizeSp(fontSizeSp * d.scaleFactor); return true }
    })

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean { scroller.forceFinished(true); scrollRemainder = 0f; return true }

        override fun onSingleTapUp(e: MotionEvent): Boolean {
            if (selection != null) { clearSelection(); return true }
            val em = emulator
            if (em.mouseMode != TerminalEmulator.MOUSE_OFF && follow) {
                val (col, row) = cellAt(e.x, e.y, screenRelative = true)
                em.mouseReport(TerminalEmulator.MOUSE_EVENT_PRESS, col, row, 0)?.let { onInput?.invoke(it) }
                em.mouseReport(TerminalEmulator.MOUSE_EVENT_RELEASE, col, row, 0)?.let { onInput?.invoke(it) }
            }
            requestFocus()
            onTap?.invoke()
            return true
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            if (draggingHandle != 0) return true
            val em = emulator
            scrollRemainder += dy
            val lines = (scrollRemainder / lineH).toInt()
            if (lines == 0) return true
            scrollRemainder -= lines * lineH
            when {
                em.mouseMode != TerminalEmulator.MOUSE_OFF && follow -> {
                    val (col, row) = cellAt(e2.x, e2.y, screenRelative = true)
                    val kind = if (lines > 0) TerminalEmulator.MOUSE_EVENT_WHEEL_DOWN else TerminalEmulator.MOUSE_EVENT_WHEEL_UP
                    repeat(abs(lines)) { em.mouseReport(kind, col, row, 0)?.let { onInput?.invoke(it) } }
                }
                em.isAltScreen && swipeArrowsInAltScreen && follow -> {
                    val key = if (lines > 0) KeyEncoder.Key.DOWN else KeyEncoder.Key.UP
                    val bytes = KeyEncoder.encodeKey(key, KeyEncoder.Mods.NONE, em.applicationCursorKeys)
                    repeat(abs(lines)) { onInput?.invoke(bytes) }
                }
                else -> scrollByRows(lines)
            }
            return true
        }

        override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
            val em = emulator
            if (draggingHandle != 0 || (em.mouseMode != TerminalEmulator.MOUSE_OFF && follow) || (em.isAltScreen && swipeArrowsInAltScreen && follow)) return false
            scroller.fling(0, topRow, 0, (-vy / lineH).roundToInt(), 0, 0, 0, maxTop())
            postInvalidateOnAnimation()
            return true
        }

        override fun onLongPress(e: MotionEvent) {
            if (draggingHandle != 0) return
            startWordSelection(e.x, e.y)
        }
    })

    /** Cell under a point: absolute row (or screen row when screenRelative) and column. */
    private fun cellAt(x: Float, y: Float, screenRelative: Boolean = false): Pair<Int, Int> {
        val col = (x / charW).toInt().coerceIn(0, emulator.cols - 1)
        val row = (y / lineH).toInt().coerceIn(0, rows - 1)
        return if (screenRelative) col to row.coerceIn(0, emulator.rows - 1) else col to (topRow + row).coerceIn(0, max(0, emulator.totalRows() - 1))
    }

    @Suppress("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        if (scaleDetector.isInProgress) return true
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                draggingHandle = handleAt(event.x, event.y)
                if (draggingHandle != 0) { parent?.requestDisallowInterceptTouchEvent(true); actionMode?.finish() }
            }
            MotionEvent.ACTION_MOVE -> if (draggingHandle != 0) { moveHandle(event.x, event.y); return true }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (draggingHandle != 0) { draggingHandle = 0; showSelectionMenu(); return true }
        }
        gestures.onTouchEvent(event)
        return true
    }

    /* ------------------------------ selection ----------------------------- */

    private fun startWordSelection(x: Float, y: Float) {
        val (col, row) = cellAt(x, y)
        if (row >= emulator.totalRows()) return
        val text = emulator.rowText(row, trimEnd = false)
        if (col >= text.length) return
        var s = col; var e = col
        fun wordChar(c: Char) = c.isLetterOrDigit() || c in "_-./~:@"
        if (wordChar(text[col])) {
            while (s > 0 && wordChar(text[s - 1])) s--
            while (e < text.length - 1 && wordChar(text[e + 1])) e++
        }
        selection = Selection(row, s, row, e)
        if (hapticsEnabled) performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        follow = false
        reportFollow()
        showSelectionMenu()
        invalidate()
    }

    private fun handleAt(x: Float, y: Float): Int {
        val sel = selection?.normalized() ?: return 0
        val r = handleRadius * 1.6f
        handlePoint(sel[0], sel[1], true)?.let { if (abs(it[0] - x) < r && abs(it[1] - y) < r) return 1 }
        handlePoint(sel[2], sel[3], false)?.let { if (abs(it[0] - x) < r && abs(it[1] - y) < r) return 2 }
        return 0
    }

    private fun moveHandle(x: Float, y: Float) {
        val sel = selection ?: return
        val n = sel.normalized()
        val (col, row) = cellAt(x, (y - handleRadius * 0.9f - lineH))
        if (draggingHandle == 1) { sel.startRow = row; sel.startCol = col; sel.endRow = n[2]; sel.endCol = n[3] }
        else { sel.startRow = n[0]; sel.startCol = n[1]; sel.endRow = row; sel.endCol = col }
        // Auto-scroll when dragging near the edges.
        if (y < lineH) scrollByRows(-1) else if (y > height - lineH) scrollByRows(1)
        invalidate()
    }

    fun selectedText(): String? {
        val sel = selection?.normalized() ?: return null
        return emulator.textBetween(sel[0], sel[1], sel[2], sel[3])
    }

    fun clearSelection() {
        selection = null
        actionMode?.finish()
        invalidate()
    }

    fun selectAll() {
        val total = emulator.totalRows()
        if (total == 0) return
        selection = Selection(0, 0, total - 1, emulator.cols - 1)
        showSelectionMenu()
        invalidate()
    }

    fun hasSelection(): Boolean = selection != null

    private fun showSelectionMenu() {
        if (selection == null) return
        if (actionMode != null) { actionMode?.invalidate(); return }
        val callback = object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                menu.add(0, 1, 0, R.string.copy).setIcon(R.drawable.ic_content_copy).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
                menu.add(0, 2, 1, R.string.select_all).setIcon(R.drawable.ic_select_all).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
                menu.add(0, 3, 2, R.string.paste).setIcon(R.drawable.ic_content_paste).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
                return true
            }
            override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                when (item.itemId) {
                    1 -> { selectedText()?.let { onCopy?.invoke(it) }; clearSelection() }
                    2 -> selectAll()
                    3 -> { clearSelection(); onPasteRequest?.invoke() }
                }
                return true
            }
            override fun onDestroyActionMode(mode: ActionMode) { actionMode = null }
        }
        actionMode = startActionMode(object : ActionMode.Callback2() {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu) = callback.onCreateActionMode(mode, menu)
            override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = callback.onPrepareActionMode(mode, menu)
            override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = callback.onActionItemClicked(mode, item)
            override fun onDestroyActionMode(mode: ActionMode) = callback.onDestroyActionMode(mode)
            override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
                val sel = selection?.normalized()
                if (sel == null) { outRect.set(0, 0, width, lineH.toInt()); return }
                val top = ((sel[0] - topRow) * lineH).toInt().coerceIn(0, height)
                val bottom = ((sel[2] - topRow + 1) * lineH).toInt().coerceIn(0, height)
                outRect.set(0, top, width, max(bottom, top + lineH.toInt()))
            }
        }, ActionMode.TYPE_FLOATING)
    }

    /* -------------------------------- search ------------------------------ */

    /** Find [query] in the whole buffer (case-insensitive). Returns the number of matches and jumps to the nearest one. */
    fun search(query: String): Int {
        matches.clear()
        currentMatch = -1
        searchQuery = query
        if (query.isNotEmpty()) {
            val q = query.lowercase()
            val total = emulator.totalRows()
            for (r in 0 until total) {
                val text = emulator.rowText(r, trimEnd = true).lowercase()
                var from = 0
                while (true) {
                    val i = text.indexOf(q, from)
                    if (i < 0) break
                    matches.add(Match(r, i, i + q.length - 1))
                    from = i + max(1, q.length)
                }
            }
            if (matches.isNotEmpty()) {
                // Nearest match at or above the visible top row, else the last one.
                currentMatch = matches.indexOfLast { it.row <= topRow + rows - 1 }.let { if (it < 0) matches.size - 1 else it }
                scrollToRow(matches[currentMatch].row)
            }
        }
        onSearchResult?.invoke(if (currentMatch >= 0) currentMatch + 1 else 0, matches.size)
        invalidate()
        return matches.size
    }

    fun searchNext(forward: Boolean) {
        if (matches.isEmpty()) return
        currentMatch = ((currentMatch + if (forward) 1 else -1) + matches.size) % matches.size
        scrollToRow(matches[currentMatch].row)
        onSearchResult?.invoke(currentMatch + 1, matches.size)
        invalidate()
    }

    fun clearSearch() {
        if (matches.isEmpty() && searchQuery.isEmpty()) return
        matches.clear(); currentMatch = -1; searchQuery = ""
        onSearchResult?.invoke(0, 0)
        invalidate()
    }

    /* -------------------------------- input ------------------------------- */

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_NULL
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_ACTION_NONE
        return object : BaseInputConnection(this, false) {
            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                composing = ""
                typeText(text.toString()); return true
            }
            override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
                composing = text.toString(); return true   // sent on finishComposingText / commitText
            }
            override fun finishComposingText(): Boolean {
                if (composing.isNotEmpty()) { val c = composing; composing = ""; typeText(c) }
                return true
            }
            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) onKeyDown(event.keyCode, event)
                return true
            }
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                repeat(max(1, beforeLength)) { sendKey(KeyEncoder.Key.BACKSPACE) }
                return true
            }
            override fun performEditorAction(actionCode: Int): Boolean { sendKey(KeyEncoder.Key.ENTER); return true }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val hw = KeyEncoder.Mods(ctrl = event.isCtrlPressed, alt = event.isAltPressed, shift = event.isShiftPressed)
        val key = when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> KeyEncoder.Key.ENTER
            KeyEvent.KEYCODE_DEL -> KeyEncoder.Key.BACKSPACE
            KeyEvent.KEYCODE_ESCAPE -> KeyEncoder.Key.ESCAPE
            KeyEvent.KEYCODE_TAB -> KeyEncoder.Key.TAB
            KeyEvent.KEYCODE_DPAD_UP -> KeyEncoder.Key.UP
            KeyEvent.KEYCODE_DPAD_DOWN -> KeyEncoder.Key.DOWN
            KeyEvent.KEYCODE_DPAD_LEFT -> KeyEncoder.Key.LEFT
            KeyEvent.KEYCODE_DPAD_RIGHT -> KeyEncoder.Key.RIGHT
            KeyEvent.KEYCODE_MOVE_HOME -> KeyEncoder.Key.HOME
            KeyEvent.KEYCODE_MOVE_END -> KeyEncoder.Key.END
            KeyEvent.KEYCODE_PAGE_UP -> KeyEncoder.Key.PAGE_UP
            KeyEvent.KEYCODE_PAGE_DOWN -> KeyEncoder.Key.PAGE_DOWN
            KeyEvent.KEYCODE_INSERT -> KeyEncoder.Key.INSERT
            KeyEvent.KEYCODE_FORWARD_DEL -> KeyEncoder.Key.DELETE
            in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> KeyEncoder.Key.values()[KeyEncoder.Key.F1.ordinal + (keyCode - KeyEvent.KEYCODE_F1)]
            else -> null
        }
        if (key != null) { sendKey(key, hw); return true }
        if (keyCode == KeyEvent.KEYCODE_SHIFT_LEFT || keyCode == KeyEvent.KEYCODE_SHIFT_RIGHT || keyCode == KeyEvent.KEYCODE_CTRL_LEFT ||
            keyCode == KeyEvent.KEYCODE_CTRL_RIGHT || keyCode == KeyEvent.KEYCODE_ALT_LEFT || keyCode == KeyEvent.KEYCODE_ALT_RIGHT) return true
        // With Ctrl/Alt held the base character is wanted (Ctrl+C, Alt+F), so strip those bits.
        val meta = if (hw.ctrl || hw.alt) event.metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv() else event.metaState
        val ch = event.getUnicodeChar(meta)
        if (ch == 0 || ch and KeyCharacterMap.COMBINING_ACCENT != 0) return super.onKeyDown(keyCode, event)
        typeText(String(Character.toChars(ch)), hw)
        return true
    }

    private fun mergeMods(hw: KeyEncoder.Mods?): KeyEncoder.Mods {
        val sticky = modifiers.mods()
        if (hw == null) return sticky
        return KeyEncoder.Mods(ctrl = sticky.ctrl || hw.ctrl, alt = sticky.alt || hw.alt, shift = sticky.shift || hw.shift)
    }

    /** Send typed text, applying sticky/hardware modifiers, then release one-shot modifiers. */
    fun typeText(s: String, hw: KeyEncoder.Mods? = null) {
        if (s.isEmpty()) return
        val out = KeyEncoder.encodeText(s, mergeMods(hw))
        modifiers.consume()
        onInput?.invoke(out)
        scrollToBottom()
    }

    /** Send a special key with sticky/hardware modifiers. */
    fun sendKey(key: KeyEncoder.Key, hw: KeyEncoder.Mods? = null) {
        val out = KeyEncoder.encodeKey(key, mergeMods(hw), emulator.applicationCursorKeys, emulator.applicationKeypad)
        modifiers.consume()
        onInput?.invoke(out)
        scrollToBottom()
    }

    /** Send raw bytes (shortcuts, pasted text already wrapped by the host). */
    fun sendRaw(s: String) {
        if (s.isEmpty()) return
        onInput?.invoke(s)
        scrollToBottom()
    }

    /** Pasted clipboard text, wrapped for bracketed paste when the application asked for it. */
    fun paste(text: String) = sendRaw(KeyEncoder.paste(text, emulator.bracketedPaste))

    /** Convenience for hosts: the time base used for modifier double-taps. */
    fun now(): Long = SystemClock.uptimeMillis()

    private companion object {
        /** Glyphs a proportional font renders at clearly different widths. */
        val WIDTH_SAMPLE = arrayOf("i", "l", "W", "@", "1", " ", "m")
    }
}
