package com.cactus.remoteterminal.protocol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessagesTest {
    private val agentJson = """
        {"agentId":"a_k3x7m2q9p4w8n6b5v1c0","name":"Prod","hostname":"prod-01","platform":"linux","os":"Ubuntu 24.04","arch":"x64",
         "agentVersion":"0.3.0","protocol":3,"shells":[{"id":"bash","label":"bash","default":true},{"id":"sh"}],
         "caps":["sessions","replay"],"online":true,"lastSeen":1725264000000,"instanceId":"abc",
         "sessions":[{"sessionId":"s_k3x7m2q9p4w8n6b5v1c0","title":"Logs","shell":"bash","state":"running","createdAt":1,"lastActiveAt":2,"cols":100,"rows":30,"seq":42,"attached":1,"exitCode":null}]}
    """.trimIndent()

    @Test fun parsesAgentInfoWithShellsAndSessions() {
        val a = AgentInfo.fromJson(JSONObject(agentJson))
        assertEquals("Prod", a.name)
        assertEquals("linux", a.platform)
        assertFalse(a.isWindows)
        assertEquals(listOf("bash", "sh"), a.shells.map { it.id })
        assertTrue(a.shells[0].isDefault)
        assertEquals("sh", a.shells[1].label)
        assertTrue(a.online)
        assertEquals(1725264000000L, a.lastSeen)
        assertEquals("abc", a.instanceId)
        val s = a.sessions.single()
        assertEquals("Logs", s.title)
        assertTrue(s.isRunning)
        assertEquals(42L, s.seq)
        assertNull(s.exitCode)
        assertEquals(1, s.attached)
    }

    @Test fun parsesWelcomeAndEvents() {
        val w = Incoming.parse("""{"type":"welcome","v":3,"connId":"c_1","accountId":"default","deviceId":"d_1","caps":["ping"],
            "limits":{"maxSessionsPerAgent":4},"agents":[$agentJson],"devices":[{"deviceId":"d_1","name":"Pixel","isSelf":true,"createdAt":5}]}""") as RelayEvent.Welcome
        assertEquals(3, w.version)
        assertEquals(4, w.limits.maxSessionsPerAgent)
        assertEquals(64, w.limits.maxSessionsPerAccount)
        assertEquals(1, w.agents.size)
        assertTrue(w.devices.single().isSelf)

        val out = Incoming.parse("""{"type":"output","agent":"a_1","session":"s_1","seq":17,"data":"hi[31m"}""") as RelayEvent.Output
        assertEquals(17L, out.seq)
        assertEquals("hi[31m", out.data)

        val att = Incoming.parse("""{"type":"session.attached","reqId":"r1","agent":"a_1","session":"s_1","from":5,"seq":12,"cols":80,"rows":24}""") as RelayEvent.SessionAttached
        assertEquals("r1", att.reqId); assertEquals(5L, att.from); assertEquals(12L, att.seq)

        val upd = Incoming.parse("""{"type":"session.updated","agent":"a_1","session":"s_1","cols":90,"rows":20}""") as RelayEvent.SessionUpdated
        assertNull(upd.title); assertEquals(90, upd.cols)

        val err = Incoming.parse("""{"type":"error","code":"agent_offline","message":"agent is offline","reqId":"r9"}""") as RelayEvent.Error
        assertEquals("r9", err.reqId)
        assertEquals("The machine is offline.", err.display)

        val exit = Incoming.parse("""{"type":"exit","agent":"a_1","session":"s_1","code":null}""") as RelayEvent.Exit
        assertNull(exit.code)

        assertTrue(Incoming.parse("""{"type":"pong"}""") is RelayEvent.Pong)
        assertEquals("weird", (Incoming.parse("""{"type":"weird"}""") as RelayEvent.Unknown).type)
    }

    @Test fun outgoingBuildersProduceProtocolShapes() {
        val create = JSONObject(Outgoing.sessionCreate("r1", "a_1", "bash", 100, 30, "Logs"))
        assertEquals("session.create", create.getString("type"))
        assertEquals("bash", create.getString("shell"))
        assertEquals(30, create.getInt("rows"))
        val noShell = JSONObject(Outgoing.sessionCreate("r2", "a_1", null, 80, 24, null))
        assertFalse(noShell.has("shell")); assertFalse(noShell.has("title"))

        val attach = JSONObject(Outgoing.sessionAttach("r3", "a_1", "s_1", 40L, 80, 24))
        assertEquals(40, attach.getInt("since"))
        assertFalse(JSONObject(Outgoing.sessionAttach("r4", "a_1", "s_1", null, 80, 24)).has("since"))

        val input = JSONObject(Outgoing.input("a_1", "s_1", "ls\r"))
        assertEquals("ls\r", input.getString("data"))
        assertEquals("a_1", input.getString("agent"))
        assertEquals("resize", JSONObject(Outgoing.resize("a_1", "s_1", 1, 2)).getString("type"))
        assertEquals("device.revoke", JSONObject(Outgoing.deviceRevoke("d_2")).getString("type"))
        assertEquals("ping", JSONObject(Outgoing.ping()).getString("type"))
    }
}
