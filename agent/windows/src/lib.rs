//! Shared pieces of the Windows agent: where things live on disk, how to talk
//! to a running agent, and how to write a log that rotates.
//!
//! Both binaries are deliberately thin. The agent itself is the Node process in
//! `agent/index.js`; the service binary only supervises it and the tray binary
//! only looks at it. Nothing here knows the relay protocol.

pub mod control;
pub mod json;
pub mod logfile;
pub mod settings;
pub mod wide;

/// The name the SCM knows the service by, and the pipe the agent listens on.
pub const SERVICE_NAME: &str = "RemoteTerminalAgent";
pub const DISPLAY_NAME: &str = "Remote Terminal Agent";
pub const PIPE_NAME: &str = r"\\.\pipe\remote-terminal-agent";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
