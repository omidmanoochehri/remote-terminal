package com.cactus.remoteterminal.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TriggerTest {
    @Test fun decodesReplyEscapes() {
        assertEquals("yes\r", OutputWatch.decodeReply("yes\\r"))
        assertEquals("a\nb\tc\u001B[A\\", OutputWatch.decodeReply("a\\nb\\tc\\e[A\\\\"))
        assertEquals("\\x stays", OutputWatch.decodeReply("\\x stays"))
        assertEquals("trailing \\", OutputWatch.decodeReply("trailing \\"))
    }

    @Test fun repliesAtMostEveryTwoSeconds() {
        val w = OutputWatch("password:", keepWatching = true, reply = "secret\\r")
        assertTrue(w.isTrigger)
        assertEquals("secret\r", w.replyNow(10_000))
        assertNull(w.replyNow(11_999))
        assertEquals("secret\r", w.replyNow(12_000))
    }

    @Test fun plainWatchNeverReplies() {
        assertNull(OutputWatch("x", keepWatching = true).replyNow(0))
        assertNull(OutputWatch("x", keepWatching = true, reply = "").replyNow(0))
    }

    @Test fun regexMatchesCaseInsensitivelyAcrossChunksAndOnlyOnce() {
        val w = OutputWatch("continue\\? \\[y/n\\]", keepWatching = true, regex = true, reply = "y\\r")
        assertFalse(w.feed("Do you want to conti"))
        assertTrue(w.feed("nue? [Y/n] "))
        assertFalse(w.feed(" "))
        assertTrue(w.feed("\u001B[1mContinue? [y/N]\u001B[0m"))
    }

    @Test fun regexThatMatchesNothingNeverFires() {
        val w = OutputWatch("x*", keepWatching = true, regex = true)
        assertFalse(w.feed("abc"))
        assertTrue(w.feed("xx"))
    }

    @Test fun invalidRegexIsReported() {
        assertNotNull(OutputWatch.regexError("(unclosed"))
        assertNull(OutputWatch.regexError("^ok$"))
    }
}
