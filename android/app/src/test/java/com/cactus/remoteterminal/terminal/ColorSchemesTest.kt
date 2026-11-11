package com.cactus.remoteterminal.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ColorSchemesTest {
    private val campbell = """
        {"name":"Campbell","background":"#0C0C0C","foreground":"#CCCCCC","cursorColor":"#FFFFFF","selectionBackground":"#FFFFFF",
         "black":"#0C0C0C","red":"#C50F1F","green":"#13A10E","yellow":"#C19C00","blue":"#0037DA","purple":"#881798","cyan":"#3A96DD","white":"#CCCCCC",
         "brightBlack":"#767676","brightRed":"#E74856","brightGreen":"#16C60C","brightYellow":"#F9F1A5","brightBlue":"#3B78FF","brightPurple":"#B4009E","brightCyan":"#61D6D6","brightWhite":"#F2F2F2"}
    """.trimIndent()

    @Test fun hexParsing() {
        assertEquals(0xFF112233.toInt(), ColorSchemes.parseHex("#112233"))
        assertEquals(0xFFAABBCC.toInt(), ColorSchemes.parseHex("abc"))
        assertEquals(0x80112233.toInt(), ColorSchemes.parseHex("#11223380"))
        assertNull(ColorSchemes.parseHex("#12"))
        assertNull(ColorSchemes.parseHex("#GGGGGG"))
        assertNull(ColorSchemes.parseHex(null))
        assertEquals("#0A0B0C", ColorSchemes.toHex(0xFF0A0B0C.toInt()))
    }

    @Test fun importsAWindowsTerminalScheme() {
        val t = ColorSchemes.import(campbell).single()
        assertEquals("Campbell", t.name)
        assertTrue(t.id.startsWith("user:"))
        assertEquals(0xFF0C0C0C.toInt(), t.background)
        assertEquals(0xFFC50F1F.toInt(), t.ansi[1])
        assertEquals(0xFFF2F2F2.toInt(), t.ansi[15])
        assertEquals(0xFFFFFFFF.toInt(), t.cursor)
        // A selection without alpha is made translucent so text stays readable.
        assertEquals(0x66FFFFFF, t.selection)
        assertEquals(false, t.isLight)
    }

    @Test fun importsArraysAndSettingsFilesAndAliases() {
        assertEquals(2, ColorSchemes.import("[$campbell, $campbell]").size)
        assertEquals(1, ColorSchemes.import("{\"profiles\":{},\"schemes\":[$campbell]}").size)
        val magenta = campbell.replace("\"purple\"", "\"magenta\"").replace("\"brightPurple\"", "\"brightMagenta\"")
        assertEquals(0xFF881798.toInt(), ColorSchemes.import(magenta).single().ansi[5])
    }

    @Test fun missingOptionalColoursFallBack() {
        val t = ColorSchemes.import(campbell.replace("\"cursorColor\":\"#FFFFFF\",", "").replace("\"selectionBackground\":\"#FFFFFF\",", "")).single()
        assertEquals(t.foreground, t.cursor)
    }

    @Test fun clearErrors() {
        for ((text, expect) in listOf(
            "" to "Paste", "{oops" to "not valid JSON", "[]" to "No colour scheme",
            campbell.replace("\"red\":\"#C50F1F\",", "") to "red",
            campbell.replace("\"background\":\"#0C0C0C\"", "\"background\":\"blue\"") to "background",
            campbell.replace("\"name\":\"Campbell\",", "") to "name",
        )) {
            try { ColorSchemes.import(text); fail(text) } catch (e: IllegalArgumentException) {
                assertTrue("${e.message} should mention $expect", e.message!!.contains(expect))
            }
        }
    }

    @Test fun exportThenImportKeepsTheColours() {
        val exported = ColorSchemes.toJson(TerminalTheme.SOLARIZED_DARK).toString()
        val back = ColorSchemes.import(exported).single()
        assertEquals(TerminalTheme.SOLARIZED_DARK.background, back.background)
        assertEquals(TerminalTheme.SOLARIZED_DARK.ansi.toList(), back.ansi.toList())
        assertEquals("Solarized Dark", back.name)
    }

    @Test fun storedFormKeepsIds() {
        val mine = ColorSchemes.copyOf(TerminalTheme.LIGHT, "Paper", id = "user:paper")
        val list = ColorSchemes.listFromJson(ColorSchemes.listToJson(listOf(mine)).toString())
        assertEquals("user:paper", list.single().id)
        assertTrue(list.single().isLight)
    }

    @Test fun editingOneColour() {
        val t = ColorSchemes.withColour(TerminalTheme.DARK, "3", 0x123456)
        assertEquals(0xFF123456.toInt(), t.ansi[3])
        assertEquals(TerminalTheme.DARK.ansi[2], t.ansi[2])
        assertTrue(ColorSchemes.withColour(t, "background", 0xFFFFFF).isLight)
    }
}
