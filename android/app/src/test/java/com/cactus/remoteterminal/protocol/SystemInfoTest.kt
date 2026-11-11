package com.cactus.remoteterminal.protocol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SystemInfoTest {
    @Test fun parsesAFullSysInfo() {
        val i = SysInfo.fromJson(JSONObject("""
            { "hostname": "prod-01", "platform": "linux", "os": "Ubuntu 24.04", "release": "6.8.0-45-generic",
              "arch": "x64", "cpuModel": "AMD Ryzen 7 5800X", "cpus": 16, "memoryTotal": 16687661056,
              "uptimeSec": 279484, "agentUptimeSec": 3600, "nodeVersion": "v24.1.0", "agentVersion": "0.13.0",
              "user": "omid", "timezone": "Europe/Berlin",
              "interfaces": [ { "name": "eth0", "mac": "aa:bb:cc:dd:ee:ff",
                "addresses": [ { "family": "IPv4", "address": "192.168.1.20", "cidr": "192.168.1.20/24" },
                               { "family": "IPv6", "address": "fe80::1", "cidr": "fe80::1/64" } ] } ] }"""))
        assertEquals("prod-01", i.hostname)
        assertEquals(16, i.cpus)
        assertEquals(16687661056L, i.memoryTotal)
        assertEquals("Europe/Berlin", i.timezone)
        assertEquals("aa:bb:cc:dd:ee:ff", i.interfaces.single().mac)
        assertEquals("192.168.1.20/24", i.interfaces.single().addresses[0].cidr)
    }

    @Test fun missingFieldsAreNull() {
        val i = SysInfo.fromJson(JSONObject("""{"hostname":"h","platform":"win32","user":null,"interfaces":[{"name":"x","mac":"00:00:00:00:00:00","addresses":[]}]}"""))
        assertNull(i.user); assertNull(i.os); assertNull(i.memoryTotal)
        assertNull(i.interfaces.single().mac)
    }

    @Test fun parsesAndFiltersPorts() {
        val l = PortList.fromJson(JSONObject("""
            {"ports":[{"proto":"tcp","family":"IPv4","address":"0.0.0.0","port":22,"pid":812,"process":"sshd"},
                      {"proto":"udp","family":"IPv6","address":"::","port":5353,"pid":null,"process":null},
                      {"proto":"tcp","family":"IPv4","address":"127.0.0.1","port":5432,"pid":1001,"process":"postgres"}],
             "sampledAt":1727600000000,"truncated":true}"""))
        assertEquals(3, l.ports.size)
        assertEquals(true, l.truncated)
        assertNull(l.ports[1].pid)
        assertEquals("[::]:5353", l.ports[1].endpoint)
        assertEquals("0.0.0.0:22", l.ports[0].endpoint)
        assertEquals(listOf(5432), PortList.filter(l.ports, "postgres").map { it.port })
        assertEquals(listOf(22), PortList.filter(l.ports, "22").map { it.port })
        assertEquals(listOf(5353), PortList.filter(l.ports, "udp").map { it.port })
        assertEquals(listOf(22), PortList.filter(l.ports, "812").map { it.port })
    }
}
