package com.cactus.remoteterminal.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Presets are stored as JSON in the phone's preferences, so what a newer build
 * writes has to survive being read back, and a file that has been edited or
 * corrupted must not take the settings screen down with it.
 */
class TerminalPresetTest {

    private val full = TerminalPreset(
        id = "abc123",
        name = "API logs",
        agentId = "agent-1",
        shellId = "bash",
        directory = "/srv/api",
        command = "tail -f log/production.log",
    )

    @Test
    fun roundTripsEveryField() {
        val back = TerminalPreset.fromJson(full.toJson())
        assertEquals(full, back)
    }

    @Test
    fun roundTripsAMachineAgnosticPreset() {
        val floating = TerminalPreset(id = "x1", name = "Scratch")
        val back = TerminalPreset.fromJson(floating.toJson())
        assertEquals(floating, back)
        assertNull(back?.agentId)
        assertNull(back?.shellId)
        assertEquals("", back?.directory)
        assertEquals("", back?.command)
    }

    @Test
    fun roundTripsAList() {
        val list = listOf(full, TerminalPreset(id = "x1", name = "Scratch", directory = "~"))
        assertEquals(list, TerminalPreset.listFromJson(TerminalPreset.listToJson(list)))
    }

    @Test
    fun malformedStorageReadsAsEmptyRatherThanThrowing() {
        assertTrue(TerminalPreset.listFromJson("not json").isEmpty())
        assertTrue(TerminalPreset.listFromJson("{}").isEmpty())
    }

    @Test
    fun entriesWithoutAnIdOrNameAreDropped() {
        val raw = """[{"name":"no id"},{"id":"a","name":"kept"},{"id":"b"}]"""
        val parsed = TerminalPreset.listFromJson(raw)
        assertEquals(1, parsed.size)
        assertEquals("kept", parsed.first().name)
    }

    @Test
    fun summaryPrefersTheDirectoryThenTheCommand() {
        assertEquals("/srv/api", full.summary)
        assertEquals("htop", TerminalPreset(id = "c", name = "Top", command = "htop").summary)
        assertEquals("", TerminalPreset(id = "d", name = "Plain").summary)
    }

    @Test
    fun idsAreDistinct() {
        val ids = (1..50).map { TerminalPreset.newId() }.toSet()
        assertEquals(50, ids.size)
    }
}
