package com.cactus.remoteterminal.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WcWidthTest {
    @Test
    fun asciiAndLatinAreOneCell() {
        assertEquals(1, WcWidth.of('a'.code))
        assertEquals(1, WcWidth.of('~'.code))
        assertEquals(1, WcWidth.of(0xE9)) // é precomposed
        assertEquals(1, WcWidth.of(0x2500)) // box drawing ─
        assertEquals(1, WcWidth.of(0x2588)) // full block
        assertEquals(1, WcWidth.of(0x0410)) // Cyrillic
        assertEquals(1, WcWidth.of(0x05D0)) // Hebrew alef
    }

    @Test
    fun controlsAreZeroWidth() {
        assertEquals(0, WcWidth.of(0x00))
        assertEquals(0, WcWidth.of(0x1B))
        assertEquals(0, WcWidth.of(0x7F))
        assertEquals(0, WcWidth.of(0x9B))
    }

    @Test
    fun combiningAndFormatCharactersAreZeroWidth() {
        assertEquals(0, WcWidth.of(0x0301)) // combining acute
        assertEquals(0, WcWidth.of(0x0308)) // combining diaeresis
        assertEquals(0, WcWidth.of(0x200D)) // zero width joiner
        assertEquals(0, WcWidth.of(0xFE0F)) // variation selector-16
        assertEquals(0, WcWidth.of(0x20E3)) // combining enclosing keycap
        assertEquals(0, WcWidth.of(0x1160)) // Hangul jungseong filler
        assertEquals(0, WcWidth.of(0xE0100)) // variation selector supplement
        assertEquals(0, WcWidth.of(0xFEFF)) // BOM / ZWNBSP
        assertTrue(WcWidth.isCombining(0x0301))
        assertFalse(WcWidth.isCombining('a'.code))
    }

    @Test
    fun eastAsianWideAndEmojiAreTwoCells() {
        assertEquals(2, WcWidth.of('日'.code))
        assertEquals(2, WcWidth.of('本'.code))
        assertEquals(2, WcWidth.of(0xAC00)) // Hangul syllable 가
        assertEquals(2, WcWidth.of(0xFF21)) // fullwidth A
        assertEquals(2, WcWidth.of(0x3000)) // ideographic space
        assertEquals(2, WcWidth.of(0x1F600)) // 😀
        assertEquals(2, WcWidth.of(0x1F680)) // 🚀
        assertEquals(2, WcWidth.of(0x2705)) // ✅
        assertEquals(2, WcWidth.of(0x20000)) // CJK extension B
    }

    @Test
    fun regionalIndicatorsAndTextPresentationSymbolsAreNarrow() {
        // Regional indicator letters are ambiguous; most terminals treat them as 1 cell each.
        assertEquals(1, WcWidth.of(0x1F1E6))
        // ☺ (U+263A) has text presentation by default: narrow.
        assertEquals(1, WcWidth.of(0x263A))
        // ☁ (U+2601) is also text presentation by default.
        assertEquals(1, WcWidth.of(0x2601))
    }
}
