package com.cactus.remoteterminal.data

import com.cactus.remoteterminal.protocol.SysInfo
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WakeOnLanTest {
    private val mac = byteArrayOf(0xAA.toByte(), 0xBB.toByte(), 0xCC.toByte(), 0x01, 0x02, 0x03)

    @Test fun parsesEveryCommonSpelling() {
        for (s in listOf("aa:bb:cc:01:02:03", "AA-BB-CC-01-02-03", "aabb.cc01.0203", "AABBCC010203", " aa:bb:cc:01:02:03 ")) {
            assertArrayEquals(s, mac, WakeOnLan.parseMac(s))
        }
        assertNull(WakeOnLan.parseMac("aa:bb:cc:01:02"))
        assertNull(WakeOnLan.parseMac("zz:bb:cc:01:02:03"))
        assertNull(WakeOnLan.parseMac(""))
        assertEquals("aa:bb:cc:01:02:03", WakeOnLan.normalizeMac("AABB.CC01.0203"))
    }

    @Test fun magicPacketIsSixFFsThenSixteenMacs() {
        val p = WakeOnLan.magicPacket(mac)
        assertEquals(102, p.size)
        for (i in 0 until 6) assertEquals(0xFF.toByte(), p[i])
        for (r in 0 until 16) assertArrayEquals(mac, p.copyOfRange(6 + r * 6, 12 + r * 6))
    }

    @Test fun directedBroadcast() {
        assertEquals("192.168.1.255", WakeOnLan.directedBroadcast("192.168.1.20/24"))
        assertEquals("10.255.255.255", WakeOnLan.directedBroadcast("10.1.2.3/8"))
        assertEquals("172.16.7.255", WakeOnLan.directedBroadcast("172.16.4.9/22"))
        assertNull(WakeOnLan.directedBroadcast("192.168.1.20/31"))
        assertNull(WakeOnLan.directedBroadcast("fe80::1/64"))
        assertNull(WakeOnLan.directedBroadcast("192.168.1.20"))
        assertNull(WakeOnLan.directedBroadcast("300.1.1.1/24"))
    }

    @Test fun suggestionTakesFirstInterfaceWithMacAndIpv4() {
        val info = SysInfo.fromJson(JSONObject("""
            {"hostname":"h","platform":"linux","interfaces":[
              {"name":"tun0","addresses":[{"family":"IPv4","address":"10.8.0.2","cidr":"10.8.0.2/24"}]},
              {"name":"eth1","mac":"aa:bb:cc:dd:ee:01","addresses":[{"family":"IPv6","address":"fe80::1","cidr":"fe80::1/64"}]},
              {"name":"eth0","mac":"AA:BB:CC:DD:EE:FF","addresses":[{"family":"IPv4","address":"192.168.1.20","cidr":"192.168.1.20/24"}]}
            ]}"""))
        assertEquals(WakeOnLan.Target("aa:bb:cc:dd:ee:ff", "192.168.1.255", 9), WakeOnLan.suggest(info))
    }

    @Test fun targetJsonRoundTripAndDefaults() {
        val t = WakeOnLan.Target("aa:bb:cc:dd:ee:ff", "10.0.0.255", 7)
        assertEquals(t, WakeOnLan.Target.fromJson(t.toJson().toString()))
        assertEquals(WakeOnLan.Target("x"), WakeOnLan.Target.fromJson("{\"mac\":\"x\",\"port\":0}"))
        assertNull(WakeOnLan.Target.fromJson("nope"))
        val manual = t.copy(manual = true)
        assertEquals(true, org.json.JSONObject(manual.toJson().toString()).getBoolean("manual"))
        assertEquals(manual, WakeOnLan.Target.fromJson(manual.toJson().toString()))
        assertEquals(false, t.toJson().has("manual"))
    }
}
