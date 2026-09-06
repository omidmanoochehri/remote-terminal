//! The public half of the control channel.
//!
//! WHY THIS EXISTS. The agent's own control pipe is created by Node, which
//! offers no way to set a security descriptor on it, so it inherits the
//! creating token's default DACL. When the agent runs under the service — as
//! LocalSystem — that default is SYSTEM and Administrators, and the signed-in
//! user's tray icon gets ERROR_ACCESS_DENIED on every poll. A tray that can
//! only ever say "not running" is worse than no tray.
//!
//! So the supervisor, which *can* set a DACL, opens a second pipe that
//! authenticated users may talk to, and forwards the harmless commands to the
//! agent. What is forwarded is deliberately short:
//!
//!   ping, status   carry no credential and change nothing
//!   reconnect      idempotent; the agent would reconnect on its own anyway
//!
//! `pair` and `shutdown` are not forwarded at any price. A pairing code is
//! enough to get a shell on this machine, so it stays behind the control key
//! that only SYSTEM and administrators can read — the tray elevates for it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{FlushFileBuffers, ReadFile, WriteFile, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
};

use crate::wide::w;

/// SYSTEM and Administrators get everything; authenticated users may open the
/// pipe and talk to it. Anonymous logons and network logons are not included:
/// this is a channel for the person sitting at the machine.
const SDDL: &str = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGW;;;AU)";

const IN_BUF: u32 = 8 * 1024;
const OUT_BUF: u32 = 64 * 1024;
const MAX_REQUEST: usize = 8 * 1024;
/// The client connected between our CreateNamedPipeW and our ConnectNamedPipe.
const ERROR_PIPE_CONNECTED: u32 = 535;

/// Serve `handler` on `pipe_name` until `stop` is set. Blocking: run it on its
/// own thread. One client at a time is plenty — the tray polls every 3s.
pub fn serve(pipe_name: &str, stop: Arc<AtomicBool>, handler: impl Fn(&str) -> String) {
    // The instance is created once and then reused: closing and recreating it
    // between clients would leave a window in which the pipe does not exist,
    // and a tray polling through that window would report the machine down.
    let mut pipe = None;

    while !stop.load(Ordering::SeqCst) {
        let handle = match pipe {
            Some(h) => h,
            None => match create(pipe_name) {
                Some(h) => {
                    pipe = Some(h);
                    h
                }
                // Nothing here is essential — without it the tray simply
                // cannot ask — so a failure must never take the supervisor
                // down with it.
                None => {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    continue;
                }
            },
        };

        // Blocks until a client arrives. On stop, the guard in service.rs
        // connects to the pipe itself, which unblocks this and lets the loop
        // see the flag.
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
            || last_error() == ERROR_PIPE_CONNECTED;

        if connected && !stop.load(Ordering::SeqCst) {
            if let Some(line) = read_line(handle) {
                let response = handler(&line);
                write_all(handle, response.as_bytes());
                write_all(handle, b"\n");
                // Without this, disconnecting can discard what we just wrote.
                unsafe { FlushFileBuffers(handle) };
            }
        }
        unsafe { DisconnectNamedPipe(handle) };

        if !connected {
            // A broken instance cannot be reused; drop it and make a new one.
            unsafe { CloseHandle(handle) };
            pipe = None;
        }
    }

    if let Some(handle) = pipe {
        unsafe { CloseHandle(handle) };
    }
}

fn create(pipe_name: &str) -> Option<HANDLE> {
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        let ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w(SDDL).as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        );
        if ok == 0 {
            return None;
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = CreateNamedPipeW(
            w(pipe_name).as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1, // one instance: the callers are a tray icon and a CLI, not a fleet
            OUT_BUF,
            IN_BUF,
            0,
            &mut attributes,
        );
        LocalFree(descriptor as _);
        if handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(handle)
        }
    }
}

fn read_line(pipe: HANDLE) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let mut read = 0u32;
        let ok = unsafe { ReadFile(pipe, chunk.as_mut_ptr(), chunk.len() as u32, &mut read, std::ptr::null_mut()) };
        if ok == 0 || read == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..read as usize]);
        if buf.contains(&b'\n') || buf.len() > MAX_REQUEST {
            break;
        }
    }
    if buf.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&buf);
    Some(text.lines().next().unwrap_or("").to_string())
}

fn write_all(pipe: HANDLE, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        let mut written = 0u32;
        let ok = unsafe { WriteFile(pipe, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut()) };
        if ok == 0 || written == 0 {
            return;
        }
        bytes = &bytes[written as usize..];
    }
}

fn last_error() -> u32 {
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

/* ------------------------------ the handler ------------------------------- */

/// The forwarding policy, kept separate from the pipe plumbing so it can be
/// tested without a pipe.
///
/// `ask` is "send this command to the agent and give me its answer".
pub fn dispatch(request: &str, ask: impl Fn(&str) -> Result<String, String>) -> String {
    let cmd = crate::json::str_of(request, "cmd").unwrap_or_default();
    match cmd.as_str() {
        "ping" | "status" | "reconnect" => match ask(&cmd) {
            Ok(answer) => answer,
            Err(why) => format!("{{\"ok\":false,\"error\":{}}}", crate::json::quote(&why)),
        },
        // Saying *why* matters: the tray uses this to decide to elevate rather
        // than to show a failure.
        "pair" | "shutdown" => {
            "{\"ok\":false,\"needsKey\":true,\"error\":\"this command needs administrator rights\"}".to_string()
        }
        "" => "{\"ok\":false,\"error\":\"bad request\"}".to_string(),
        other => format!("{{\"ok\":false,\"error\":{}}}", crate::json::quote(&format!("unknown command: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harmless_commands_are_forwarded_verbatim() {
        let answer = dispatch(r#"{"cmd":"status"}"#, |cmd| {
            assert_eq!(cmd, "status");
            Ok(r#"{"ok":true,"connected":true}"#.to_string())
        });
        assert_eq!(answer, r#"{"ok":true,"connected":true}"#);

        let ping = dispatch(r#"{"cmd":"ping"}"#, |_| Ok(r#"{"ok":true,"pid":9}"#.to_string()));
        assert_eq!(ping, r#"{"ok":true,"pid":9}"#);
        let reconnect = dispatch(r#"{"cmd":"reconnect"}"#, |_| Ok(r#"{"ok":true}"#.to_string()));
        assert_eq!(reconnect, r#"{"ok":true}"#);
    }

    #[test]
    fn a_pairing_code_is_never_handed_out_here() {
        for cmd in ["pair", "shutdown"] {
            let answer = dispatch(&format!(r#"{{"cmd":"{cmd}"}}"#), |_| {
                panic!("{cmd} must not reach the agent over the public pipe")
            });
            assert_eq!(crate::json::bool_of(&answer, "ok"), Some(false));
            assert_eq!(crate::json::bool_of(&answer, "needsKey"), Some(true));
        }
    }

    #[test]
    fn a_key_supplied_by_the_caller_does_not_unlock_anything() {
        // The pipe is reachable by any signed-in user, so a guessed or stolen
        // key must not be a way in through it.
        let answer = dispatch(r#"{"cmd":"pair","key":"deadbeef"}"#, |_| panic!("forwarded"));
        assert_eq!(crate::json::bool_of(&answer, "ok"), Some(false));
    }

    #[test]
    fn an_agent_that_is_not_running_produces_an_error_not_a_panic() {
        let answer = dispatch(r#"{"cmd":"status"}"#, |_| Err("the agent is not running".into()));
        assert_eq!(crate::json::bool_of(&answer, "ok"), Some(false));
        assert_eq!(crate::json::str_of(&answer, "error").as_deref(), Some("the agent is not running"));
    }

    #[test]
    fn junk_is_rejected_without_reaching_the_agent() {
        assert_eq!(crate::json::bool_of(&dispatch("not json", |_| panic!()), "ok"), Some(false));
        assert_eq!(crate::json::bool_of(&dispatch("{}", |_| panic!()), "ok"), Some(false));
        let unknown = dispatch(r#"{"cmd":"rm -rf"}"#, |_| panic!("forwarded"));
        assert!(crate::json::str_of(&unknown, "error").unwrap().contains("unknown command"));
    }
}
