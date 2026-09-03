package com.cactus.remoteterminal.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionStreamTest {
    @Test fun firstAttachIsFullReplayThenLiveOutputApplies() {
        val s = SessionStream()
        val (reqId, since) = s.beginAttach(80, 24)
        assertNull("no history: full replay", since)
        assertEquals(SessionStream.State.ATTACHING, s.state)
        assertEquals(SessionStream.Verdict.IGNORE, s.onOutput(5, 5))
        val r = s.onAttached(reqId, 0, 10, 80, 24)
        assertTrue(r.accepted); assertTrue(r.resetScreen); assertFalse(r.outputLost)
        assertEquals(SessionStream.Verdict.APPLY, s.onOutput(6, 6))     // replay chunk [0,6)
        assertEquals(SessionStream.Verdict.APPLY, s.onOutput(10, 4))    // replay chunk [6,10)
        assertEquals(SessionStream.Verdict.APPLY, s.onOutput(13, 3))    // live
        assertEquals(13, s.lastSeq)
        assertEquals(SessionStream.Verdict.DUPLICATE, s.onOutput(13, 3))
        assertEquals(SessionStream.Verdict.DUPLICATE, s.onOutput(8, 2))
    }

    @Test fun reattachWithSameGeometryResumesWithSince() {
        val s = SessionStream()
        val (r1, _) = s.beginAttach(100, 30)
        s.onAttached(r1, 0, 0, 100, 30)
        s.onOutput(40, 40)
        s.onDisconnected()
        val (r2, since) = s.beginAttach(100, 30)
        assertEquals(40L, since)
        val a = s.onAttached(r2, 40, 47, 100, 30)
        assertTrue(a.accepted); assertFalse(a.resetScreen); assertFalse(a.outputLost)
        assertEquals(SessionStream.Verdict.APPLY, s.onOutput(47, 7))
    }

    @Test fun geometryChangeForcesFullReplay() {
        val s = SessionStream()
        val (r1, _) = s.beginAttach(100, 30)
        s.onAttached(r1, 0, 0, 100, 30)
        s.onOutput(40, 40)
        s.onDisconnected()
        val (_, since) = s.beginAttach(80, 24)
        assertNull("different width: history is not reusable", since)
    }

    @Test fun lostRangeIsReportedAndStreamResumesAtFrom() {
        val s = SessionStream()
        val (r1, _) = s.beginAttach(80, 24)
        s.onAttached(r1, 0, 0, 80, 24)
        s.onOutput(100, 100)
        s.onDisconnected()
        val (r2, since) = s.beginAttach(80, 24)
        assertEquals(100L, since)
        val a = s.onAttached(r2, 5000, 6000, 80, 24) // ring buffer no longer holds our position
        assertTrue(a.outputLost); assertTrue(a.resetScreen)
        assertEquals(5000, s.lastSeq)
        assertEquals(SessionStream.Verdict.APPLY, s.onOutput(6000, 1000))
    }

    @Test fun staleAcknowledgementsAreIgnoredAndGapsDetach() {
        val s = SessionStream()
        val (old, _) = s.beginAttach(80, 24)
        val (fresh, _) = s.beginAttach(80, 24)
        assertFalse(s.onAttached(old, 0, 0, 80, 24).accepted)
        assertEquals(SessionStream.State.ATTACHING, s.state)
        assertTrue(s.onAttached(fresh, 0, 0, 80, 24).accepted)
        assertEquals(SessionStream.Verdict.APPLY, s.onOutput(3, 3))
        assertEquals(SessionStream.Verdict.GAP, s.onOutput(10, 3))
        assertEquals(SessionStream.State.DETACHED, s.state)
        assertEquals(3, s.lastSeq)
        val (_, since) = s.beginAttach(80, 24)
        assertEquals(3L, since)
    }

    @Test fun lagAndResetBehave() {
        val s = SessionStream()
        val (r, _) = s.beginAttach(80, 24)
        s.onAttached(r, 0, 0, 80, 24)
        s.onOutput(9, 9)
        s.onLag()
        assertEquals(SessionStream.State.DETACHED, s.state)
        assertEquals(9L, s.beginAttach(80, 24).second)
        s.reset()
        assertEquals(0, s.lastSeq)
        assertNull(s.beginAttach(80, 24).second)
    }

    @Test fun noteGeometryKeepsSinceAfterAResizeWhileAttached() {
        val s = SessionStream()
        val (r, _) = s.beginAttach(80, 24)
        s.onAttached(r, 0, 0, 80, 24)
        s.onOutput(20, 20)
        s.noteGeometry(120, 40)   // PTY was resized while attached; new output belongs to 120x40
        s.onOutput(30, 10)
        s.onDisconnected()
        assertEquals(30L, s.beginAttach(120, 40).second)
    }
}
