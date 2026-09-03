package com.cactus.remoteterminal.net

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream

class FrameCodecTest {
    private val mask = byteArrayOf(0x12, 0x34, 0x56, 0x78)

    private fun roundTrip(payload: ByteArray, opcode: Int = FrameCodec.OP_TEXT): FrameCodec.Frame {
        val bytes = FrameCodec.encode(opcode, payload, mask)
        val f = FrameCodec.read(ByteArrayInputStream(bytes), 16L * 1024 * 1024)!!
        assertTrue(f.fin)
        assertEquals(opcode, f.opcode)
        return f
    }

    @Test fun encodesAndDecodesAllLengthClasses() {
        for (len in intArrayOf(0, 1, 125, 126, 127, 65535, 65536, 70000)) {
            val payload = ByteArray(len) { (it * 7).toByte() }
            val f = roundTrip(payload)
            assertArrayEquals("len $len", payload, f.payload)
        }
        val small = FrameCodec.encode(FrameCodec.OP_TEXT, ByteArray(5), mask)
        assertEquals(0x81.toByte(), small[0])
        assertEquals((0x80 or 5).toByte(), small[1])
        val medium = FrameCodec.encode(FrameCodec.OP_TEXT, ByteArray(300), mask)
        assertEquals((0x80 or 126).toByte(), medium[1])
        val large = FrameCodec.encode(FrameCodec.OP_BINARY, ByteArray(70000), mask)
        assertEquals((0x80 or 127).toByte(), large[1])
    }

    @Test fun clientFramesAreMasked() {
        val payload = "hello".toByteArray()
        val bytes = FrameCodec.encode(FrameCodec.OP_TEXT, payload, mask)
        val masked = bytes.copyOfRange(6, 11)
        assertFalse(masked.contentEquals(payload))
        for (i in payload.indices) assertEquals(payload[i], (masked[i].toInt() xor mask[i and 3].toInt()).toByte())
    }

    @Test fun unmaskedServerFramesDecode() {
        val bytes = byteArrayOf(0x81.toByte(), 3, 'a'.code.toByte(), 'b'.code.toByte(), 'c'.code.toByte())
        val f = FrameCodec.read(ByteArrayInputStream(bytes), 1024)!!
        assertEquals("abc", String(f.payload))
        assertNull(FrameCodec.read(ByteArrayInputStream(ByteArray(0)), 1024))
    }

    @Test fun oversizedAndMalformedFramesAreRefused() {
        val big = FrameCodec.encode(FrameCodec.OP_TEXT, ByteArray(2000), mask)
        try { FrameCodec.read(ByteArrayInputStream(big), 1000); fail("expected refusal") } catch (_: FrameCodec.ProtocolException) {}
        val rsv = byteArrayOf(0xC1.toByte(), 0)
        try { FrameCodec.read(ByteArrayInputStream(rsv), 1000); fail("rsv bits") } catch (_: FrameCodec.ProtocolException) {}
        val fragmentedControl = byteArrayOf(0x09, 0)
        try { FrameCodec.read(ByteArrayInputStream(fragmentedControl), 1000); fail("fragmented ping") } catch (_: FrameCodec.ProtocolException) {}
        val huge = byteArrayOf(0x82.toByte(), 127, 0x7F, -1, -1, -1, -1, -1, -1, -1)
        try { FrameCodec.read(ByteArrayInputStream(huge), 1000); fail("64-bit length") } catch (_: FrameCodec.ProtocolException) {}
    }

    @Test fun assemblerJoinsContinuationsAndPassesControlFrames() {
        val a = FrameCodec.Assembler(1024)
        assertNull(a.add(FrameCodec.Frame(false, FrameCodec.OP_TEXT, "hel".toByteArray())))
        val ping = a.add(FrameCodec.Frame(true, FrameCodec.OP_PING, byteArrayOf(1)))!!
        assertEquals(FrameCodec.OP_PING, ping.opcode)
        assertNull(a.add(FrameCodec.Frame(false, FrameCodec.OP_CONTINUATION, "lo ".toByteArray())))
        val msg = a.add(FrameCodec.Frame(true, FrameCodec.OP_CONTINUATION, "wörld".toByteArray()))!!
        assertEquals("hello wörld", msg.text)
        // a second message works after the first completed
        assertEquals("x", a.add(FrameCodec.Frame(true, FrameCodec.OP_TEXT, "x".toByteArray()))!!.text)
        try { a.add(FrameCodec.Frame(true, FrameCodec.OP_CONTINUATION, ByteArray(1))); fail("orphan continuation") } catch (_: FrameCodec.ProtocolException) {}
        val small = FrameCodec.Assembler(4)
        small.add(FrameCodec.Frame(false, FrameCodec.OP_TEXT, ByteArray(3)))
        try { small.add(FrameCodec.Frame(true, FrameCodec.OP_CONTINUATION, ByteArray(3))); fail("message cap") } catch (_: FrameCodec.ProtocolException) {}
    }

    @Test fun invalidUtf8TextIsRejected() {
        assertTrue(FrameCodec.isValidUtf8("plain ascii, ünïcödé, 😀".toByteArray()))
        assertFalse(FrameCodec.isValidUtf8(byteArrayOf(0xC0.toByte(), 0x80.toByte())))            // overlong
        assertFalse(FrameCodec.isValidUtf8(byteArrayOf(0xED.toByte(), 0xA0.toByte(), 0x80.toByte()))) // surrogate
        assertFalse(FrameCodec.isValidUtf8(byteArrayOf(0xF4.toByte(), 0x90.toByte(), 0x80.toByte(), 0x80.toByte()))) // > U+10FFFF
        assertFalse(FrameCodec.isValidUtf8(byteArrayOf(0xE2.toByte(), 0x82.toByte())))            // truncated
        val a = FrameCodec.Assembler(1024)
        try { a.add(FrameCodec.Frame(true, FrameCodec.OP_TEXT, byteArrayOf(0xFF.toByte()))); fail("bad utf8") } catch (_: FrameCodec.ProtocolException) {}
    }

    @Test fun closePayloadRoundTripsAndHandshakeMathMatchesRfc() {
        val p = FrameCodec.closePayload(4401, "revoked")
        assertEquals(4401, FrameCodec.closeCode(p))
        assertEquals("revoked", FrameCodec.closeReason(p))
        assertEquals(1005, FrameCodec.closeCode(ByteArray(0)))
        assertEquals(125, FrameCodec.closePayload(1000, "x".repeat(500)).size)
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", FrameCodec.acceptFor("dGhlIHNhbXBsZSBub25jZQ=="))
        assertEquals("", FrameCodec.base64(ByteArray(0)))
        assertEquals("Zg==", FrameCodec.base64("f".toByteArray()))
        assertEquals("Zm9v", FrameCodec.base64("foo".toByteArray()))
        assertEquals("Zm9vYg==", FrameCodec.base64("foob".toByteArray()))
    }
}
