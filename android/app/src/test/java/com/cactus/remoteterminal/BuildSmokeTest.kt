package com.cactus.remoteterminal

import org.junit.Assert.assertEquals
import org.junit.Test

/** Verifies the JVM unit-test toolchain itself (JUnit 4 + Kotlin) works. */
class BuildSmokeTest {
    @Test
    fun protocolVersionIsThree() {
        assertEquals(3, BuildConfig.PROTOCOL_VERSION)
    }
}
