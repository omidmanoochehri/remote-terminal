package com.cactus.remoteterminal.data

import org.junit.Assert.assertEquals
import org.junit.Test

class PromptTest {

    @Test fun `text alone is sent without trailing blank space`() {
        assertEquals("explain this", Prompt.text("explain this\n\n  "))
        assertEquals("a\nb", Prompt.text("a\r\nb"))
    }

    @Test fun `uploaded paths follow the text after a space`() {
        assertEquals("look at /tmp/rt/shot.png", Prompt.text("look at", listOf("/tmp/rt/shot.png")))
        assertEquals("two /tmp/a.txt /tmp/b.txt", Prompt.text("two", listOf("/tmp/a.txt", "/tmp/b.txt")))
    }

    @Test fun `files alone are just their paths`() {
        assertEquals("/tmp/a.txt", Prompt.text("   ", listOf("/tmp/a.txt")))
    }

    @Test fun `paths are quoted the way the machine needs`() {
        assertEquals("see '/tmp/my file.txt'", Prompt.text("see", listOf("/tmp/my file.txt")))
        assertEquals("see \"C:\\Users\\me\\a b.png\"", Prompt.text("see", listOf("C:\\Users\\me\\a b.png")))
    }

    @Test fun `missing paths are skipped`() {
        assertEquals("hi /x", Prompt.text("hi", listOf(null, "", "/x")))
    }
}
