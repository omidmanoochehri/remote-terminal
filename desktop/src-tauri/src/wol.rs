//! Wake-on-LAN: send a magic packet as a UDP broadcast.
//!
//! The packet is built (and the MAC parsed) by the frontend, in
//! `ui/js/core/wol.js`, which is unit tested there; this side only checks that
//! it really is a magic packet and puts it on the wire — three times, 100 ms
//! apart, because a single datagram on a busy LAN is easily lost.

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::time::Duration;

/// 6 × 0xFF, then the same 6-byte MAC sixteen times.
fn is_magic_packet(packet: &[u8]) -> bool {
    if packet.len() != 102 || packet[..6].iter().any(|&b| b != 0xff) {
        return false;
    }
    let mac = &packet[6..12];
    packet[6..].chunks(6).all(|chunk| chunk == mac)
}

fn send(packet: &[u8], target: SocketAddrV4, repeats: u32) -> Result<(), String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("{e}"))?;
    socket.set_broadcast(true).map_err(|e| format!("{e}"))?;
    for i in 0..repeats {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(100));
        }
        socket.send_to(packet, target).map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

/// Send [packet] to `broadcast:port` three times, 100 ms apart.
#[tauri::command]
pub async fn wake_on_lan(packet: Vec<u8>, broadcast: String, port: u16) -> Result<(), String> {
    if !is_magic_packet(&packet) {
        return Err("not a Wake-on-LAN magic packet".into());
    }
    let address: Ipv4Addr = broadcast
        .trim()
        .parse()
        .map_err(|_| format!("{broadcast} is not an IPv4 address"))?;
    if port == 0 {
        return Err("the port must be between 1 and 65535".into());
    }
    let target = SocketAddrV4::new(address, port);
    tauri::async_runtime::spawn_blocking(move || send(&packet, target, 3))
        .await
        .map_err(|e| format!("{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(mac: [u8; 6]) -> Vec<u8> {
        let mut p = vec![0xffu8; 6];
        for _ in 0..16 {
            p.extend_from_slice(&mac);
        }
        p
    }

    #[test]
    fn recognises_a_magic_packet() {
        assert!(is_magic_packet(&packet([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])));
        let mut bad = packet([1, 2, 3, 4, 5, 6]);
        bad[50] ^= 1;
        assert!(!is_magic_packet(&bad));
        assert!(!is_magic_packet(&bad[..100]));
        let mut no_sync = packet([1, 2, 3, 4, 5, 6]);
        no_sync[0] = 0;
        assert!(!is_magic_packet(&no_sync));
    }

    #[test]
    fn sends_to_loopback() {
        let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        receiver.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let port = receiver.local_addr().unwrap().port();
        let p = packet([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
        send(&p, SocketAddrV4::new(Ipv4Addr::LOCALHOST, port), 1).unwrap();
        let mut buf = [0u8; 200];
        let (n, _) = receiver.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], &p[..]);
    }
}
