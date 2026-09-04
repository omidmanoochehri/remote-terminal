package com.cactus.remoteterminal.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The scanner must accept exactly what the product produces and nothing else:
 * a QR code found in the wild should never be able to point the phone at a
 * relay of someone else's choosing.
 */
class PairingPayloadTest {

    @Test
    fun bareSixDigitCodeIsAccepted() {
        val parsed = PairingPayload.parse("482913")
        assertEquals("482913", parsed?.code)
        assertNull(parsed?.relay)
    }

    @Test
    fun surroundingWhitespaceIsIgnored() {
        assertEquals("482913", PairingPayload.parse("  482913\n")?.code)
    }

    @Test
    fun pairingLinkCarriesRelayAndCode() {
        val parsed = PairingPayload.parse("remoteterminal://pair?relay=wss%3A%2F%2Frelay.example.com&code=482913")
        assertEquals("wss://relay.example.com", parsed?.relay)
        assertEquals("482913", parsed?.code)
    }

    @Test
    fun pairingLinkWithoutRelayStillWorks() {
        val parsed = PairingPayload.parse("remoteterminal://pair?code=100200")
        assertEquals("100200", parsed?.code)
        assertNull(parsed?.relay)
    }

    @Test
    fun spacedCodeInLinkIsNormalised() {
        assertEquals("482913", PairingPayload.parse("remoteterminal://pair?code=482%20913")?.code)
    }

    @Test
    fun otherSchemesAreRejected() {
        assertNull(PairingPayload.parse("https://example.com/pair?code=482913&relay=wss://evil.example"))
        assertNull(PairingPayload.parse("otpauth://totp/x?secret=482913"))
    }

    @Test
    fun nonWebSocketRelayIsRejected() {
        assertNull(PairingPayload.parse("remoteterminal://pair?relay=file%3A%2F%2F%2Fetc&code=482913"))
    }

    @Test
    fun malformedOrEmptyPayloadsAreRejected() {
        assertNull(PairingPayload.parse(null))
        assertNull(PairingPayload.parse(""))
        assertNull(PairingPayload.parse("hello world"))
        assertNull(PairingPayload.parse("12345"))
        assertNull(PairingPayload.parse("1234567"))
        assertNull(PairingPayload.parse("remoteterminal://pair"))
        assertNull(PairingPayload.parse("remoteterminal://pair?code=abcdef"))
    }
}
