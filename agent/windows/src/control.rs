//! Client for the agent's control pipe (`agent/lib/control.js`).
//!
//! One request per connection, newline-delimited JSON. A named pipe is just a
//! file on Windows, so this needs no pipe API beyond opening one — and being a
//! plain read/write means a hung agent shows up as a timeout on our side
//! rather than a wedged service.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use crate::json;

#[derive(Debug, Default, Clone)]
pub struct Status {
    pub version: String,
    pub name: String,
    pub pid: i64,
    pub connected: bool,
    pub registered: bool,
    pub sessions: i64,
    pub uptime_sec: i64,
    pub last_error: Option<String>,
}

impl Status {
    /// The one-line summary the tray shows in its tooltip and its menu header.
    pub fn headline(&self) -> String {
        if self.registered {
            match self.sessions {
                0 => "Connected — no terminals open".to_string(),
                1 => "Connected — 1 terminal".to_string(),
                n => format!("Connected — {n} terminals"),
            }
        } else if self.connected {
            "Connecting to the relay…".to_string()
        } else {
            match &self.last_error {
                Some(e) => format!("Offline — {e}"),
                None => "Offline".to_string(),
            }
        }
    }
}

#[derive(Debug)]
pub enum ControlError {
    /// Nothing is listening: the service is stopped, or still starting.
    NotRunning,
    /// The agent answered, but said no (an unenrolled agent, a missing key).
    Refused(String),
    Io(String),
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlError::NotRunning => write!(f, "the agent is not running"),
            ControlError::Refused(m) => write!(f, "{m}"),
            ControlError::Io(m) => write!(f, "{m}"),
        }
    }
}

/// Send one command and return the raw JSON response.
pub fn request(pipe: &str, cmd: &str, key: Option<&str>) -> Result<String, ControlError> {
    let mut body = format!("{{\"cmd\":{}", json::quote(cmd));
    if let Some(k) = key {
        body.push_str(&format!(",\"key\":{}", json::quote(k)));
    }
    body.push_str("}\n");

    let mut file = open_with_retry(pipe)?;
    file.write_all(body.as_bytes()).map_err(|e| ControlError::Io(e.to_string()))?;
    file.flush().ok();

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match file.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > 64 * 1024 {
                    break;
                }
            }
            Err(e) => return Err(ControlError::Io(e.to_string())),
        }
    }
    let text = String::from_utf8_lossy(&buf).trim().to_string();
    if text.is_empty() {
        return Err(ControlError::Io("the agent closed the pipe without answering".into()));
    }
    if json::bool_of(&text, "ok") != Some(true) {
        let why = json::str_of(&text, "error").unwrap_or_else(|| "refused".into());
        return Err(ControlError::Refused(why));
    }
    Ok(text)
}

/// A pipe with every instance busy is a normal race, not a failure; a pipe
/// that does not exist means the agent is not running.
fn open_with_retry(pipe: &str) -> Result<std::fs::File, ControlError> {
    for attempt in 0..5 {
        match std::fs::OpenOptions::new().read(true).write(true).open(pipe) {
            Ok(f) => return Ok(f),
            Err(e) => match e.kind() {
                std::io::ErrorKind::NotFound => return Err(ControlError::NotRunning),
                _ => std::thread::sleep(Duration::from_millis(40 * (attempt + 1))),
            },
        }
    }
    Err(ControlError::NotRunning)
}

pub fn status(pipe: &str) -> Result<Status, ControlError> {
    let raw = request(pipe, "status", None)?;
    Ok(Status {
        version: json::str_of(&raw, "version").unwrap_or_default(),
        name: json::str_of(&raw, "name").unwrap_or_default(),
        pid: json::i64_of(&raw, "pid").unwrap_or(0),
        connected: json::bool_of(&raw, "connected").unwrap_or(false),
        registered: json::bool_of(&raw, "registered").unwrap_or(false),
        sessions: json::i64_of(&raw, "sessions").unwrap_or(0),
        uptime_sec: json::i64_of(&raw, "uptimeSec").unwrap_or(0),
        last_error: json::str_of(&raw, "lastError"),
    })
}

pub struct PairCode {
    pub code: String,
    pub ttl_sec: i64,
    pub relay_url: String,
}

/// Ask the running agent for a pairing code. Needs the control key, which only
/// the agent's account and the administrators who installed it can read.
pub fn pair(pipe: &str, key: &str) -> Result<PairCode, ControlError> {
    let raw = request(pipe, "pair", Some(key))?;
    Ok(PairCode {
        code: json::str_of(&raw, "code").unwrap_or_default(),
        ttl_sec: json::i64_of(&raw, "ttlSec").unwrap_or(300),
        relay_url: json::str_of(&raw, "relayUrl").unwrap_or_default(),
    })
}

pub fn reconnect(pipe: &str) -> Result<(), ControlError> {
    request(pipe, "reconnect", None).map(|_| ())
}

/// Ask the agent to close its sessions and exit. Used by the service for a
/// clean stop: a TerminateProcess would drop every terminal without notice.
pub fn shutdown(pipe: &str, key: &str) -> Result<(), ControlError> {
    request(pipe, "shutdown", Some(key)).map(|_| ())
}

/// The control key, if this account may read it.
pub fn read_key(data_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(data_dir.join("control.key")).ok()?;
    let key = text.trim().to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headline_says_what_the_user_needs_to_know() {
        let mut s = Status { registered: true, connected: true, ..Default::default() };
        assert_eq!(s.headline(), "Connected — no terminals open");
        s.sessions = 1;
        assert_eq!(s.headline(), "Connected — 1 terminal");
        s.sessions = 4;
        assert_eq!(s.headline(), "Connected — 4 terminals");

        s.registered = false;
        assert_eq!(s.headline(), "Connecting to the relay…");

        s.connected = false;
        assert_eq!(s.headline(), "Offline");
        s.last_error = Some("disconnected (1006)".into());
        assert_eq!(s.headline(), "Offline — disconnected (1006)");
    }

    #[test]
    fn a_missing_pipe_reads_as_not_running() {
        let err = status(r"\\.\pipe\remote-terminal-agent-does-not-exist").unwrap_err();
        assert!(matches!(err, ControlError::NotRunning), "{err}");
    }

    #[test]
    fn no_key_file_is_not_an_error() {
        assert_eq!(read_key(Path::new(r"C:\does\not\exist")), None);
    }
}
