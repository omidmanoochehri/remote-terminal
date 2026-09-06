//! The rotating log the service writes.
//!
//! The supervisor owns the file rather than the agent, because the two have to
//! share it: the agent's own JSON lines arrive on its stdout, and everything
//! the agent cannot report about itself — that it exited, why, and when it will
//! be restarted — is written by the supervisor around them. One file, in the
//! same JSON-lines format, is what an operator wants to read six weeks later.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct LogFile {
    inner: Mutex<Inner>,
}

struct Inner {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    max_bytes: u64,
    max_files: u32,
}

impl LogFile {
    pub fn open(path: &Path, max_bytes: u64, max_files: u32) -> LogFile {
        let mut inner = Inner {
            path: path.to_path_buf(),
            file: None,
            size: 0,
            max_bytes,
            max_files: max_files.max(1),
        };
        inner.reopen();
        LogFile { inner: Mutex::new(inner) }
    }

    /// Write one line verbatim — used for the agent's own JSON output, which is
    /// already in the right format and must not be wrapped or re-encoded.
    pub fn raw(&self, line: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.write_line(line);
        }
    }

    /// Write one supervisor event as a JSON line beside the agent's.
    pub fn event(&self, level: &str, msg: &str, fields: &[(&str, String)]) {
        let mut line = format!(
            "{{\"t\":\"{}\",\"level\":\"{level}\",\"comp\":\"service\",\"msg\":{}",
            now_iso8601(),
            crate::json::quote(msg)
        );
        for (k, v) in fields {
            let value = if v.parse::<f64>().is_ok() || v == "true" || v == "false" {
                v.clone()
            } else {
                crate::json::quote(v)
            };
            line.push_str(&format!(",{}:{}", crate::json::quote(k), value));
        }
        line.push('}');
        self.raw(&line);
    }

    pub fn info(&self, msg: &str, fields: &[(&str, String)]) {
        self.event("info", msg, fields);
    }
    pub fn warn(&self, msg: &str, fields: &[(&str, String)]) {
        self.event("warn", msg, fields);
    }
    pub fn error(&self, msg: &str, fields: &[(&str, String)]) {
        self.event("error", msg, fields);
    }
}

impl Inner {
    fn reopen(&mut self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match OpenOptions::new().create(true).append(true).open(&self.path) {
            Ok(f) => {
                self.size = f.metadata().map(|m| m.len()).unwrap_or(0);
                self.file = Some(f);
            }
            // A log that cannot be opened must not stop the service; the Event
            // Log entry the installer writes is the fallback of record.
            Err(_) => self.file = None,
        }
    }

    fn rotate(&mut self) {
        self.file = None;
        for i in (1..self.max_files).rev() {
            let from = if i == 1 {
                self.path.clone()
            } else {
                with_suffix(&self.path, i - 1)
            };
            let _ = std::fs::rename(&from, with_suffix(&self.path, i));
        }
        self.reopen();
    }

    fn write_line(&mut self, line: &str) {
        if self.file.is_none() {
            self.reopen();
        }
        let len = line.len() as u64 + 2;
        if self.max_bytes > 0 && self.size > 0 && self.size + len > self.max_bytes {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            if writeln!(f, "{line}").is_ok() {
                self.size += len;
            } else {
                self.file = None;
            }
        }
    }
}

fn with_suffix(path: &Path, n: u32) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(format!(".{n}"));
    PathBuf::from(s)
}

/// UTC in the same shape as the agent's `t` field, from the system clock only —
/// pulling in a date library to print one timestamp would be absurd.
pub fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil_from_unix(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Howard Hinnant's days-from-civil, run backwards. Correct for any year.
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rt-log-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("agent.log")
    }

    #[test]
    fn events_are_json_lines_alongside_raw_agent_output() {
        let path = tmp("events");
        let log = LogFile::open(&path, 0, 3);
        log.raw(r#"{"t":"x","level":"info","comp":"agent","msg":"connected"}"#);
        log.info("agent started", &[("pid", "4321".to_string()), ("node", r"C:\n\node.exe".to_string())]);

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains(r#""comp":"agent""#), "agent lines pass through untouched");
        assert!(lines[1].contains(r#""comp":"service""#));
        assert!(lines[1].contains(r#""pid":4321"#), "numbers stay numbers: {}", lines[1]);
        assert!(lines[1].contains(r#""node":"C:\\n\\node.exe""#), "paths are escaped: {}", lines[1]);
    }

    #[test]
    fn rotation_keeps_max_files_generations() {
        let path = tmp("rotate");
        let log = LogFile::open(&path, 200, 3);
        for i in 0..40 {
            log.info(&format!("line {i}"), &[]);
        }
        let dir = path.parent().unwrap();
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["agent.log", "agent.log.1", "agent.log.2"]);
        let newest = std::fs::read_to_string(&path).unwrap();
        assert!(newest.contains("line 39"), "the newest line is in agent.log");
    }

    #[test]
    fn reopening_appends_so_a_restart_keeps_history() {
        let path = tmp("append");
        LogFile::open(&path, 0, 2).info("first boot", &[]);
        LogFile::open(&path, 0, 2).info("second boot", &[]);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 2);
    }

    #[test]
    fn timestamps_match_the_agents_format() {
        let t = now_iso8601();
        assert_eq!(t.len(), 24, "{t}");
        assert!(t.ends_with('Z') && t.contains('T'), "{t}");
        // A known instant: 2021-01-01T00:00:00Z.
        assert_eq!(civil_from_unix(1_609_459_200), (2021, 1, 1, 0, 0, 0));
        // A leap day, and a time late in the day.
        assert_eq!(civil_from_unix(1_583_020_799), (2020, 2, 29, 23, 59, 59));
    }
}
