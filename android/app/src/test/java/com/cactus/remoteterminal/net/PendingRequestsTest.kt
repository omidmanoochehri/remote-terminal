package com.cactus.remoteterminal.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingRequestsTest {
    private var now = 1_000L
    private val pending = PendingRequests<String> { now }

    @Test fun eachRequestIsAnsweredExactlyOnceByItsReply() {
        val got = ArrayList<String>()
        pending.add("q1", 30_000) { got.add("q1:$it") }
        pending.add("q2", 30_000) { got.add("q2:$it") }
        assertTrue(pending.complete("q2", "ok"))
        assertFalse(pending.complete("q2", "again"))  // late duplicate
        assertFalse(pending.complete("q9", "stray"))  // someone else's
        assertEquals(listOf("q2:ok"), got)
        assertEquals(1, pending.size)
    }

    @Test fun deadlinesExpireOnlyWhatIsDue() {
        val got = ArrayList<String>()
        pending.add("slow", 30_000) { got.add("slow:$it") }
        pending.add("fast", 5_000) { got.add("fast:$it") }
        assertEquals(6_000L, pending.nextDeadline)
        now += 4_999
        assertEquals(0, pending.expire { "timeout" })
        now += 1
        assertEquals(1, pending.expire { "timeout" })
        assertEquals(listOf("fast:timeout"), got)
        assertFalse(pending.complete("fast", "too late"))
        assertTrue(pending.has("slow"))
    }

    @Test fun aDroppedConnectionFailsEverything() {
        val got = ArrayList<String>()
        pending.add("a", 30_000) { got.add("a:$it") }
        pending.add("b", 30_000) { got.add("b:$it") }
        pending.failAll { "disconnected" }
        assertEquals(listOf("a:disconnected", "b:disconnected"), got)
        assertEquals(0, pending.size)
        assertNull(pending.nextDeadline)
    }

    @Test fun aCallbackMayIssueANewRequest() {
        // Re-entrancy: answering one request often starts the next (a download's next slice).
        pending.add("first", 1_000) { pending.add("second", 1_000) {} }
        pending.failAll { "x" }
        assertTrue(pending.has("second"))
    }
}
