//! Where the pieces live. Written by `remote-terminal-service install` into
//! `service.conf` next to the two executables, and read by both of them.
//!
//! It deliberately holds only paths — no relay URL, no enrolment token. Those
//! belong to the agent's own `config.json` under ProgramData, which is ACL'd
//! to SYSTEM and Administrators, and which the tray never needs to read.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Settings {
    /// node.exe that runs the agent.
    pub node: PathBuf,
    /// The agent's index.js.
    pub agent: PathBuf,
    /// State, config and the control socket key (default %ProgramData%\RemoteTerminal).
    pub data: PathBuf,
    /// Rotating logs (default <data>\logs).
    pub log: PathBuf,
}

impl Settings {
    pub fn config_json(&self) -> PathBuf {
        self.data.join("config.json")
    }
    pub fn agent_log(&self) -> PathBuf {
        self.log.join("agent.log")
    }

    /// The file next to the running executable, whichever of the two it is.
    pub fn path() -> PathBuf {
        exe_dir().join("service.conf")
    }

    pub fn load() -> Result<Settings, String> {
        Settings::load_from(&Settings::path())
    }

    pub fn load_from(file: &Path) -> Result<Settings, String> {
        let text = std::fs::read_to_string(file)
            .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        let map = parse(&text);
        let get = |k: &str| -> Result<PathBuf, String> {
            map.get(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| format!("{} is missing \"{k}=\"; reinstall the service", file.display()))
        };
        let data = get("data")?;
        let log = map
            .get("log")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("logs"));
        Ok(Settings { node: get("node")?, agent: get("agent")?, data, log })
    }

    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let body = format!(
            "# Written by \"remote-terminal-service install\". Paths only.\n\
             node={}\nagent={}\ndata={}\nlog={}\n",
            self.node.display(),
            self.agent.display(),
            self.data.display(),
            self.log.display()
        );
        std::fs::write(file, body)
    }
}

/// key=value, `#` comments, blank lines. Values keep every character after the
/// first `=`, so a path with spaces or an `=` in it survives.
fn parse(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    out
}

pub fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("remote-terminal-service.exe"))
}

pub fn exe_dir() -> PathBuf {
    exe_path().parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."))
}

/// %ProgramData%\RemoteTerminal — the default home for state and logs.
pub fn default_data_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("RemoteTerminal")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_paths_with_spaces_comments_and_crlf() {
        let text = "# comment\r\nnode=C:\\Program Files\\nodejs\\node.exe\r\n\r\nagent = C:\\a\\index.js\r\ndata=C:\\ProgramData\\RemoteTerminal\r\n";
        let map = parse(text);
        assert_eq!(map["node"], r"C:\Program Files\nodejs\node.exe");
        assert_eq!(map["agent"], r"C:\a\index.js");
        assert_eq!(map.get("log"), None);
    }

    #[test]
    fn log_defaults_under_data_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("rt-settings-{}", std::process::id()));
        let file = dir.join("service.conf");
        let s = Settings {
            node: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            agent: PathBuf::from(r"C:\Program Files\Remote Terminal Agent\index.js"),
            data: PathBuf::from(r"C:\ProgramData\RemoteTerminal"),
            log: PathBuf::from(r"C:\ProgramData\RemoteTerminal\logs"),
        };
        s.save(&file).unwrap();
        let back = Settings::load_from(&file).unwrap();
        assert_eq!(back.node, s.node);
        assert_eq!(back.agent, s.agent);
        assert_eq!(back.agent_log(), s.agent_log());

        std::fs::write(&file, "node=n\nagent=a\ndata=C:\\d\n").unwrap();
        assert_eq!(Settings::load_from(&file).unwrap().log, PathBuf::from(r"C:\d\logs"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_file_says_what_to_do() {
        let dir = std::env::temp_dir().join(format!("rt-settings-bad-{}", std::process::id()));
        let file = dir.join("service.conf");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, "node=n\n").unwrap();
        let err = Settings::load_from(&file).unwrap_err();
        assert!(err.contains("reinstall"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
