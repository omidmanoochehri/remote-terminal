//! Finding the person sitting at the machine, and their environment.
//!
//! WHY. The agent runs as a service, which means LocalSystem, which means a
//! shell it starts has SYSTEM's profile: `C:\Windows\system32\config\
//! systemprofile` for a home directory, none of the user's PATH, no
//! PowerShell profile, no `.gitconfig`, no npm, no `%USERPROFILE%\Documents`.
//! Useful as a rescue console, useless as *your* terminal.
//!
//! So the launcher asks Windows who is signed in at the console, borrows their
//! token, and starts the shell with it. LocalSystem holds SE_TCB_NAME, which
//! is what `WTSQueryUserToken` demands; nothing else here needs a privilege.
//!
//! Nothing in this module decides *whether* to do that — see `bin/shell.rs`.

use std::os::windows::ffi::OsStringExt;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{DuplicateTokenEx, SecurityImpersonation, TokenPrimary, TOKEN_ALL_ACCESS};
use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSActive, WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSQueryUserToken,
    WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW,
};

/// A primary token for a signed-in user, plus what their environment says
/// about them. Closes the token on drop.
pub struct UserSession {
    pub token: HANDLE,
    pub session_id: u32,
    /// `DOMAIN\name`, read from the user's own environment.
    pub user: String,
    /// `%USERPROFILE%` — where a shell should start.
    pub home: String,
    /// The user's environment, as `CreateEnvironmentBlock` built it.
    pub env: Vec<(String, String)>,
}

impl Drop for UserSession {
    fn drop(&mut self) {
        if !self.token.is_null() {
            unsafe { CloseHandle(self.token) };
        }
    }
}

/// The user signed in at the console, or at an RDP session if there is no
/// console one. `Err` when nobody is signed in, or when the caller is not
/// LocalSystem and so may not ask.
pub fn active_user() -> Result<UserSession, String> {
    let console = unsafe { WTSGetActiveConsoleSessionId() };
    if console != u32::MAX {
        match token_for(console) {
            Ok(token) => return describe(token, console),
            // Not being allowed to ask is a different problem from there
            // being nobody to ask about, and looking at the other sessions
            // would only produce the same refusal.
            Err(Refusal::NotPermitted(why)) => return Err(why),
            Err(Refusal::NoUser) => {}
        }
    }

    // A machine reached over RDP has no console session; the person is real
    // all the same.
    for id in active_sessions() {
        if id == console {
            continue;
        }
        match token_for(id) {
            Ok(token) => return describe(token, id),
            Err(Refusal::NotPermitted(why)) => return Err(why),
            Err(Refusal::NoUser) => {}
        }
    }

    Err("no one is signed in".to_string())
}

/// Why a session did not yield a token.
enum Refusal {
    /// Nobody is signed in there. Try the next session.
    NoUser,
    /// We are not allowed to ask; no other session will go differently.
    NotPermitted(String),
}

fn token_for(session_id: u32) -> Result<HANDLE, Refusal> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if WTSQueryUserToken(session_id, &mut token) == 0 {
            return Err(match last_error() {
                // ERROR_NO_SUCH_LOGON_SESSION / ERROR_NONE_MAPPED: an empty
                // session, which is what a signed-out machine looks like.
                1312 | 1332 => Refusal::NoUser,
                // ERROR_PRIVILEGE_NOT_HELD.
                1314 => Refusal::NotPermitted(
                    concat!(
                        "only LocalSystem may borrow a signed-in user's token (SE_TCB_NAME); ",
                        "the agent has to be running as the service for this"
                    )
                    .to_string(),
                ),
                code => Refusal::NotPermitted(format!("WTSQueryUserToken failed ({code})")),
            });
        }
        // The token WTS hands back is fine to impersonate with but not to
        // start a process with; CreateProcessAsUser needs a primary token.
        let mut primary: HANDLE = std::ptr::null_mut();
        let ok = DuplicateTokenEx(
            token,
            TOKEN_ALL_ACCESS,
            std::ptr::null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(Refusal::NotPermitted(format!("DuplicateTokenEx failed ({})", last_error())));
        }
        Ok(primary)
    }
}

fn active_sessions() -> Vec<u32> {
    let mut out = Vec::new();
    unsafe {
        let mut list: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut count: u32 = 0;
        if WTSEnumerateSessionsW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &mut list, &mut count) == 0 {
            return out;
        }
        for i in 0..count as usize {
            let info = &*list.add(i);
            if info.State == WTSActive {
                out.push(info.SessionId);
            }
        }
        WTSFreeMemory(list as *mut _);
    }
    out
}

fn describe(token: HANDLE, session_id: u32) -> Result<UserSession, String> {
    let env = environment(token)?;
    let get = |name: &str| -> String {
        env.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    // The name comes out of the user's own environment rather than out of
    // LookupAccountSid: it is the same answer, without a second API and its
    // domain-controller round trip.
    let name = get("USERNAME");
    let domain = get("USERDOMAIN");
    let user = if domain.is_empty() || name.is_empty() { name.clone() } else { format!("{domain}\\{name}") };
    Ok(UserSession { token, session_id, user, home: get("USERPROFILE"), env })
}

/// The user's full environment — PATH, APPDATA, everything their own session
/// would see. Needs their profile to be loaded, which it is: they are signed in.
fn environment(token: HANDLE) -> Result<Vec<(String, String)>, String> {
    unsafe {
        let mut block: *mut core::ffi::c_void = std::ptr::null_mut();
        if CreateEnvironmentBlock(&mut block, token, 0) == 0 {
            return Err(format!("CreateEnvironmentBlock failed ({})", last_error()));
        }
        let wide = read_block(block as *const u16);
        DestroyEnvironmentBlock(block);
        Ok(parse_block(&wide))
    }
}

/// Copy a `NAME=VALUE\0NAME=VALUE\0\0` block out of Windows' memory.
unsafe fn read_block(mut p: *const u16) -> Vec<u16> {
    let start = p;
    let mut len = 0usize;
    loop {
        if *p == 0 {
            // Two NULs in a row end the block.
            if *p.add(1) == 0 {
                len += 1;
                break;
            }
        }
        p = p.add(1);
        len += 1;
    }
    std::slice::from_raw_parts(start, len).to_vec()
}

/// Split a `NAME=VALUE\0...` block into pairs.
pub fn parse_block(block: &[u16]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in block.split(|&c| c == 0) {
        if entry.is_empty() {
            continue;
        }
        let text = std::ffi::OsString::from_wide(entry).to_string_lossy().into_owned();
        // `=C:=C:\path` — the per-drive cwd entries — start with `=` and must
        // be kept as they are, name and all.
        let split = text[1..].find('=').map(|i| i + 1);
        match split {
            Some(i) => out.push((text[..i].to_string(), text[i + 1..].to_string())),
            None => out.push((text, String::new())),
        }
    }
    out
}

/// Apply `NAME=VALUE` overrides to an environment and render the result as a
/// block for `CREATE_UNICODE_ENVIRONMENT`.
///
/// Windows wants the block sorted case-insensitively, and an override has to
/// replace the existing entry rather than sit next to it — two `PATH`s and the
/// shell picks whichever it saw first.
pub fn build_block(base: &[(String, String)], overrides: &[(String, String)]) -> Vec<u16> {
    let mut merged: Vec<(String, String)> = base.to_vec();
    for (name, value) in overrides {
        match merged.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
            Some(slot) => slot.1 = value.clone(),
            None => merged.push((name.clone(), value.clone())),
        }
    }
    merged.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    let mut block = Vec::new();
    for (name, value) in &merged {
        block.extend(format!("{name}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

fn last_error() -> u32 {
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(entries: &[&str]) -> Vec<u16> {
        let mut v = Vec::new();
        for e in entries {
            v.extend(e.encode_utf16());
            v.push(0);
        }
        v.push(0);
        v
    }

    #[test]
    fn a_block_splits_into_pairs() {
        let pairs = parse_block(&wide(&["PATH=C:\\Windows", "USERNAME=ann", "EMPTY="]));
        assert_eq!(pairs, vec![
            ("PATH".to_string(), "C:\\Windows".to_string()),
            ("USERNAME".to_string(), "ann".to_string()),
            ("EMPTY".to_string(), String::new()),
        ]);
    }

    #[test]
    fn the_per_drive_entries_windows_hides_in_there_keep_their_names() {
        // cmd.exe stores "the current directory on D:" as an entry literally
        // named "=D:". Dropping or renaming it breaks `cd D:` in a shell.
        let pairs = parse_block(&wide(&["=D:=D:\\work", "PATH=C:\\Windows"]));
        assert_eq!(pairs[0], ("=D:".to_string(), "D:\\work".to_string()));
    }

    #[test]
    fn an_override_replaces_rather_than_duplicates() {
        let base = vec![("Path".to_string(), "C:\\Windows".to_string()), ("TERM".to_string(), "dumb".to_string())];
        let block = build_block(&base, &[("TERM".to_string(), "xterm-256color".to_string())]);
        let back = parse_block(&block);
        assert_eq!(back.iter().filter(|(k, _)| k.eq_ignore_ascii_case("TERM")).count(), 1);
        assert_eq!(back.iter().find(|(k, _)| k == "TERM").unwrap().1, "xterm-256color");
        assert_eq!(back.iter().find(|(k, _)| k == "Path").unwrap().1, "C:\\Windows");
    }

    #[test]
    fn a_new_variable_is_added_and_the_block_stays_sorted() {
        let base = vec![("ZED".to_string(), "1".to_string()), ("alpha".to_string(), "2".to_string())];
        let block = build_block(&base, &[("COLORTERM".to_string(), "truecolor".to_string())]);
        let names: Vec<String> = parse_block(&block).into_iter().map(|(k, _)| k).collect();
        assert_eq!(names, vec!["alpha", "COLORTERM", "ZED"]);
    }

    #[test]
    fn the_block_is_double_nul_terminated() {
        let block = build_block(&[("A".to_string(), "b".to_string())], &[]);
        assert_eq!(block, wide(&["A=b"]));
    }
}
