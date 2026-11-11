package com.cactus.remoteterminal.data

import com.cactus.remoteterminal.terminal.ColorSchemes
import com.cactus.remoteterminal.terminal.TerminalTheme
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class BackupTest {
    private val scheme = ColorSchemes.copyOf(TerminalTheme.GRUVBOX, "Mine", id = "user:abc")

    private val data = Backup.Data(
        presets = listOf(TerminalPreset("p1", "API", directory = "/srv")),
        snippets = listOf(Snippet("s1", "Logs", "", "tail -f {{file}}")),
        schemes = listOf(scheme),
        commandShortcuts = listOf("ls" to "ls -la"),
        settings = mapOf(Settings.KEY_FONT_SIZE to 14.0, Settings.KEY_HAPTICS to false, Settings.KEY_SCROLLBACK to 10000),
    )

    @Test fun buildThenParseRoundTrips() {
        val json = Backup.build(data, "android", "0.13.0", 1727600000000).toString()
        val o = JSONObject(json)
        assertEquals("remote-terminal-backup", o.getString("format"))
        assertEquals(1, o.getInt("version"))
        assertEquals("android", o.getString("app"))
        val back = Backup.parse(json)
        assertEquals(data.presets, back.presets)
        assertEquals(data.snippets, back.snippets)
        assertEquals(data.commandShortcuts, back.commandShortcuts)
        assertEquals("user:abc", back.schemes.single().id)
        assertEquals(TerminalTheme.GRUVBOX.background, back.schemes.single().background)
        assertEquals(data.settings, back.settings)
        assertEquals(Backup.Summary(1, 1, 1, 1, 3), Backup.summary(back))
    }

    @Test fun formatAndVersionAreChecked() {
        for (bad in listOf("nope", "{}", "{\"format\":\"other\",\"version\":1}", "{\"format\":\"remote-terminal-backup\"}")) {
            try { Backup.parse(bad); fail(bad) } catch (e: IllegalArgumentException) { assertTrue(e.message!!.isNotEmpty()) }
        }
        try { Backup.parse("{\"format\":\"remote-terminal-backup\",\"version\":2}"); fail() } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("newer"))
        }
    }

    @Test fun unknownKeysIgnoredAndWrongTypesSkipped() {
        val d = Backup.parse("""
            {"format":"remote-terminal-backup","version":1,"extra":true,
             "presets":"no","snippets":[{"id":"a","name":"A","body":"x"},{"id":"b"}],
             "commandShortcuts":[{"label":"x","command":"y"},{"label":1}],
             "settings":{"font_size":"15","haptics":"yes","scrollback_lines":2000.5,"paste_confirm_lines":5,
                         "relay_url":"wss://evil","device_name":"x","cursor_style":"bar"}}""")
        assertTrue(d.presets.isEmpty())
        assertEquals(listOf("a"), d.snippets.map { it.id })
        assertEquals(listOf("x" to "y"), d.commandShortcuts)
        assertEquals(mapOf("font_size" to 15.0, "paste_confirm_lines" to 5, "cursor_style" to "bar"), d.settings)
    }

    @Test fun readsTheDesktopsBackup() {
        val d = Backup.parse("""
            {"format":"remote-terminal-backup","version":1,"app":"desktop",
             "settings":{"wheel_switch_tabs":false,"bell":"sound","font_size":99,"cursor_style":"beam",
                         "terminal_font_family":"system","scrollback_lines":"20000","cursor_blink":"false"}}""")
        assertEquals(false, d.settings[Settings.KEY_SWIPE_TABS])
        assertEquals("vibrate", d.settings[Settings.KEY_BELL])
        assertEquals("system", d.settings[Settings.KEY_FONT_FAMILY])
        assertEquals(20000, d.settings[Settings.KEY_SCROLLBACK])
        assertEquals(false, d.settings[Settings.KEY_CURSOR_BLINK])
        // Out of range or not one of the allowed values: skipped.
        assertEquals(null, d.settings[Settings.KEY_FONT_SIZE])
        assertEquals(null, d.settings[Settings.KEY_CURSOR_STYLE])
    }

    @Test fun credentialsAndPerMachineKeysAreNeverPortable() {
        for (k in Backup.SETTINGS.keys) {
            assertFalse(k, k.contains("device") || k.contains("relay") || k.contains("token") || k.contains("favourite") || k.contains('.'))
        }
    }

    @Test fun mergeReplacesByIdAndAddsTheRest() {
        val incoming = Backup.Data(
            snippets = listOf(Snippet("s1", "Logs v2", "", "x"), Snippet("s2", "New", "", "y")),
            commandShortcuts = listOf("ls" to "ls -lah", "df" to "df -h"),
            settings = mapOf(Settings.KEY_FONT_SIZE to 16.0),
        )
        val m = Backup.merge(data, incoming)
        assertEquals(listOf("Logs v2", "New"), m.snippets.map { it.name })
        assertEquals(data.presets, m.presets)
        assertEquals(listOf("ls" to "ls -lah", "df" to "df -h"), m.commandShortcuts)
        assertEquals(16.0, m.settings[Settings.KEY_FONT_SIZE])
        assertEquals(false, m.settings[Settings.KEY_HAPTICS])

        val r = Backup.replace(data, incoming)
        assertTrue(r.presets.isEmpty())
        assertTrue(r.schemes.isEmpty())
        assertEquals(2, r.snippets.size)
        assertEquals(false, r.settings[Settings.KEY_HAPTICS])
    }
}
