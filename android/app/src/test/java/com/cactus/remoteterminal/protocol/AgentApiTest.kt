package com.cactus.remoteterminal.protocol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentApiTest {

    @Test fun buildsTheRequestAndParsesTheResponse() {
        val out = JSONObject(Outgoing.agentRequest("q1", "a_x", "fs.list", JSONObject().put("path", "/tmp")))
        assertEquals("agent.request", out.getString("type"))
        assertEquals("fs.list", out.getString("method"))
        assertEquals("/tmp", out.getJSONObject("params").getString("path"))

        val ev = Incoming.parse("""{"type":"agent.response","reqId":"q1","agent":"a_x","result":{"n":1}}""") as RelayEvent.AgentResponse
        assertEquals("q1", ev.reqId)
        assertEquals(1, ev.result.getInt("n"))
        assertTrue(AgentReply.of(ev) is AgentReply.Ok)
        val err = AgentReply.of(Incoming.parse("""{"type":"error","reqId":"q2","code":"forbidden","message":"outside the browsable folder"}""")) as AgentReply.Failed
        assertEquals("outside the browsable folder", err.display)
        assertEquals("The machine did not answer in time.", AgentReply.Failed("timeout", "").display)
    }

    @Test fun capsGateTheTools() {
        val agent = AgentInfo.fromJson(JSONObject("""{"agentId":"a_x","caps":["sessions","fs"]}"""))
        assertTrue(AgentCaps.files(listOf("requests"), agent))
        assertFalse(AgentCaps.processes(listOf("requests"), agent))
        assertFalse(AgentCaps.files(listOf("sessions"), agent)) // an older relay cannot route it
    }

    private val listingJson = """
        {"path":"/home/ann/src","root":"/home/ann","parent":"/home/ann","sep":"/","truncated":false,"entries":[
          {"name":"b.txt","type":"file","size":10,"mtime":300},
          {"name":".env","type":"file","size":5,"mtime":100,"hidden":true},
          {"name":"lib","type":"dir","size":0,"mtime":50},
          {"name":"A.md","type":"file","size":900,"mtime":200},
          {"name":"app","type":"dir","size":0,"mtime":400},
          {"name":"cur","type":"dir","size":0,"mtime":10,"link":true}]}
    """.trimIndent()

    @Test fun foldersComeFirstThenTheChosenOrder() {
        val l = FsListing.fromJson(JSONObject(listingJson))
        assertEquals("/home/ann", l.parent)
        val names = { sort: FsPaths.Sort, hidden: Boolean, filter: String -> FsPaths.arrange(l.entries, sort, hidden, filter).map { it.name } }
        assertEquals(listOf("app", "cur", "lib", "A.md", "b.txt"), names(FsPaths.Sort.NAME, false, ""))
        assertEquals(listOf("app", "cur", "lib", ".env", "A.md", "b.txt"), names(FsPaths.Sort.NAME, true, ""))
        assertEquals(listOf("app", "cur", "lib", "A.md", "b.txt"), names(FsPaths.Sort.SIZE, false, ""))
        assertEquals(listOf("app", "lib", "cur", "b.txt", "A.md"), names(FsPaths.Sort.MODIFIED, false, ""))
        assertEquals(listOf("A.md"), names(FsPaths.Sort.NAME, false, " a.M "))
        assertTrue(l.entries.first { it.name == "cur" }.link)
    }

    @Test fun theRootHasNoParent() {
        val l = FsListing.fromJson(JSONObject("""{"path":"C:\\Users\\Ann","root":"C:\\Users\\Ann","parent":null,"sep":"\\","entries":[]}"""))
        assertNull(l.parent)
        assertEquals("\\", l.sep)
    }

    @Test fun breadcrumbsStartAtTheRoot() {
        assertEquals(
            listOf(FsPaths.Crumb("ann", "/home/ann"), FsPaths.Crumb("src", "/home/ann/src"), FsPaths.Crumb("app", "/home/ann/src/app")),
            FsPaths.breadcrumbs("/home/ann/src/app", "/home/ann", "/"),
        )
        assertEquals(
            listOf(FsPaths.Crumb("Ann", "C:\\Users\\Ann"), FsPaths.Crumb("Documents", "C:\\Users\\Ann\\Documents")),
            FsPaths.breadcrumbs("C:\\Users\\Ann\\Documents", "C:\\Users\\Ann", "\\"),
        )
        assertEquals(listOf(FsPaths.Crumb("/", "/")), FsPaths.breadcrumbs("/", "/", "/"))
        assertEquals(listOf(FsPaths.Crumb("/", "/"), FsPaths.Crumb("etc", "/etc")), FsPaths.breadcrumbs("/etc", "/", "/"))
        assertEquals(listOf(FsPaths.Crumb("C:", "C:\\"), FsPaths.Crumb("tmp", "C:\\tmp")), FsPaths.breadcrumbs("C:\\tmp", "C:\\", "\\"))
    }

    @Test fun pathsJoinWithOneSeparator() {
        assertEquals("/home/ann/x", FsPaths.child("/home/ann", "x", "/"))
        assertEquals("/x", FsPaths.child("/", "x", "/"))
        assertEquals("C:\\x", FsPaths.child("C:\\", "x", "\\"))
        assertEquals("report.txt", FsPaths.name("/home/ann/report.txt", "/"))
        assertEquals("/", FsPaths.name("/", "/"))
    }

    @Test fun textAndImagesAreRecognised() {
        assertTrue(FsPaths.looksLikeText("hello\nwörld".toByteArray()))
        assertFalse(FsPaths.looksLikeText(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x00, 0x00)))
        assertTrue(FsPaths.isImage("shot.PNG"))
        assertFalse(FsPaths.isImage("notes.txt"))
    }

    private val procJson = """
        {"total":4,"killable":"own","owner":"OFFICE\\ann","processes":[
          {"pid":10,"name":"code","user":"OFFICE\\Ann","cpu":0.05,"mem":300,"cmd":"code ."},
          {"pid":20,"name":"lsass","user":"NT AUTHORITY\\SYSTEM","cpu":0.2,"mem":100},
          {"pid":30,"name":"new","user":"ann","cpu":null,"mem":999,"ppid":10},
          {"pid":40,"name":"Bash","user":"ann","cpu":0.05,"mem":50}]}
    """.trimIndent()

    @Test fun ownershipDecidesWhatMayBeEnded() {
        val l = ProcessList.fromJson(JSONObject(procJson))
        assertEquals("OFFICE\\ann", l.owner)
        assertNull(l.refusal(l.processes[0]))
        assertEquals(ProcessList.Refusal.NotOwn("OFFICE\\ann"), l.refusal(l.processes[1]))
        assertNull(l.refusal(l.processes[2])) // no domain, same person
        assertEquals(ProcessList.Refusal.TurnedOff, l.copy(killable = "none").refusal(l.processes[0]))
        assertNull(l.copy(killable = "all").refusal(l.processes[1]))
        assertNull(l.processes[2].cpu)
        assertEquals(10, l.processes[2].ppid)
    }

    @Test fun sameUserIgnoresDomainAndCase() {
        assertTrue(Processes.sameUser("OFFICE\\ann", "office\\ANN"))
        assertTrue(Processes.sameUser("OFFICE\\ann", "ann"))
        assertFalse(Processes.sameUser("OFFICE\\ann", "OFFICE\\annabel"))
        assertFalse(Processes.sameUser("", "ann"))
        assertFalse(Processes.sameUser("ann", null))
    }

    @Test fun processesSortAndFilter() {
        val l = ProcessList.fromJson(JSONObject(procJson)).processes
        assertEquals(listOf(20, 10, 40, 30), Processes.arrange(l, Processes.Sort.CPU, "").map { it.pid })
        assertEquals(listOf(30, 10, 20, 40), Processes.arrange(l, Processes.Sort.MEMORY, "").map { it.pid })
        assertEquals(listOf(40, 10, 20, 30), Processes.arrange(l, Processes.Sort.NAME, "").map { it.pid })
        assertEquals(listOf(10), Processes.arrange(l, Processes.Sort.CPU, "code .").map { it.pid })
        assertEquals(listOf(20), Processes.arrange(l, Processes.Sort.CPU, "system").map { it.pid })
        assertEquals(listOf(30), Processes.arrange(l, Processes.Sort.CPU, "30").map { it.pid })
    }

    @Test fun cpuLabels() {
        assertEquals("—", Processes.cpuLabel(null))
        assertEquals("0%", Processes.cpuLabel(0f))
        assertEquals("2.5%", Processes.cpuLabel(0.025f))
        assertEquals("42%", Processes.cpuLabel(0.4213f))
    }
}
