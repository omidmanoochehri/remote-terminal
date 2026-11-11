package com.cactus.remoteterminal.data

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SnippetsTest {
    @Test fun fieldsInOrderOfFirstAppearanceWithDefaults() {
        val f = Snippets.fields("ssh {{user:root}}@{{host}} -p {{ port : 22}} # {{user}}")
        assertEquals(listOf("user", "host", "port"), f.map { it.name })
        assertEquals(listOf("root", "", " 22"), f.map { it.default })
    }

    @Test fun laterDefaultFillsAnEarlierBareOccurrence() {
        assertEquals("x", Snippets.fields("{{a}} {{a:x}}").single().default)
    }

    @Test fun fillUsesValuesThenDefaults() {
        val body = "kubectl -n {{ns:default}} logs {{pod}}"
        assertEquals("kubectl -n default logs api-1", Snippets.fill(body, mapOf("pod" to "api-1")))
        assertEquals("kubectl -n prod logs ", Snippets.fill(body, mapOf("ns" to "prod")))
    }

    @Test fun quadrupleBraceIsALiteral() {
        assertEquals("echo {{name}}", Snippets.fill("echo {{{{name}}", emptyMap()))
        assertFalse(Snippets.hasPlaceholders("echo {{{{name}}"))
    }

    @Test fun invalidNamesStayLiteral() {
        assertEquals("{{1abc}} {{}} {{a}", Snippets.fill("{{1abc}} {{}} {{a}", emptyMap()))
        assertFalse(Snippets.hasPlaceholders("{{\$x}}"))
        // Names are trimmed and may hold spaces and dashes, up to 32 characters.
        assertTrue(Snippets.hasPlaceholders("{{ my-name 2 }}"))
        assertFalse(Snippets.hasPlaceholders("{{" + "a".repeat(33) + "}}"))
    }

    @Test fun aBraceBeforeAPlaceholderStaysLiteral() {
        assertEquals("{x", Snippets.fill("{{{a}}", mapOf("a" to "x")))
        assertFalse(Snippets.hasPlaceholders("{{a\nb}}"))
    }

    @Test fun multiLineInputIsJoinedWithCarriageReturns() {
        assertEquals("a\rb\r", Snippets.toInput("a\nb", run = true, bracketed = false))
        assertEquals("a\rb", Snippets.toInput("a\r\nb\n", run = false, bracketed = false))
        assertEquals("\u001B[200~a\rb\u001B[201~\r", Snippets.toInput("a\nb", run = true, bracketed = true))
        // A single line is typed as is, even in bracketed mode.
        assertEquals("ls\r", Snippets.toInput("ls", run = true, bracketed = true))
    }

    @Test fun jsonRoundTripAndBadEntriesSkipped() {
        val list = listOf(Snippet("a1", "Logs", "k8s", "kubectl logs {{pod}}", run = false), Snippet("b2", "Up", "", "uptime"))
        val back = Snippet.listFromJson(Snippet.listToJson(list).toString())
        assertEquals(list, back)
        val mixed = JSONArray("[{\"id\":\"x\",\"name\":\"n\",\"body\":\"b\"}, {\"name\":\"no id\",\"body\":\"b\"}, 5, {\"id\":\"y\",\"name\":\"n\",\"body\":3}]")
        assertEquals(listOf("x"), Snippet.listFromJson(mixed).map { it.id })
        assertTrue(Snippet.listFromJson(mixed).single().run)
        assertEquals(emptyList<Snippet>(), Snippet.listFromJson("not json"))
    }

    @Test fun groupedUnfiledFirstThenFoldersAlphabetically() {
        val g = Snippets.grouped(listOf(Snippet("1", "b", "Zeta", ""), Snippet("2", "a", "", ""), Snippet("3", "c", "alpha", ""), Snippet("4", "a", "Zeta", "")))
        assertEquals(listOf("", "alpha", "Zeta"), g.map { it.first })
        assertEquals(listOf("a", "b"), g[2].second.map { it.name })
    }

    @Test fun searchLooksAtNameFolderAndBody() {
        val list = listOf(Snippet("1", "Deploy", "ops", "make deploy"), Snippet("2", "Logs", "k8s", "kubectl logs"))
        assertEquals(listOf("2"), Snippets.search(list, "KUBE").map { it.id })
        assertEquals(listOf("1"), Snippets.search(list, "ops").map { it.id })
        assertEquals(2, Snippets.search(list, " ").size)
        assertNull(Snippets.search(list, "zzz").firstOrNull())
    }
}
