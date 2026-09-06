//! Remote Terminal agent — Windows service.
//!
//! This binary is both the service and its installer:
//!
//!   remote-terminal-service install [options]   register with the SCM and start
//!   remote-terminal-service uninstall           stop and deregister
//!   remote-terminal-service start|stop|restart  control it
//!   remote-terminal-service status              service state + what the agent says
//!   remote-terminal-service run                 supervise in the console (debugging)
//!   remote-terminal-service --service           what the SCM invokes; not for humans
//!
//! WHY A SERVICE, AND WHAT IT COSTS. Earlier versions ran the agent as a logon
//! scheduled task so that terminals belonged to the signed-in user. A service
//! starts at boot, before and without any logon, and keeps running when the
//! user signs out — which is the whole point of a remote terminal. The price is
//! that terminals then run as LocalSystem, so anyone who can pair a phone gets
//! administrative access to this machine, exactly as with an SSH server. Pass
//! `--account` at install time to run as a named user instead.
//!
//! The service does NOT host terminals itself: it supervises `node index.js`,
//! restarts it with backoff when it dies, funnels its output into one rotating
//! log, and stops it gracefully over the agent's control pipe so open terminals
//! are closed properly rather than torn down.

use std::ffi::c_void;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use rt_windows::logfile::LogFile;
use rt_windows::settings::{default_data_dir, exe_dir, exe_path, Settings};
use rt_windows::wide::w;
use rt_windows::{control, DISPLAY_NAME, PIPE_NAME, SERVICE_NAME, VERSION};

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, ERROR_SERVICE_SPECIFIC_ERROR, HANDLE, NO_ERROR};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation,
};
use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
use windows_sys::Win32::System::Services::*;
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/* --------------------------- supervisor policy ---------------------------- */

/// Exit codes the agent uses to say "do not bother restarting me".
/// 2 = not enrolled or revoked, 3 = refused to run as root (not reachable on
/// Windows, but kept in one place), 5 = another agent already owns this machine.
const FATAL_EXITS: [i32; 3] = [2, 3, 5];

const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A child that lived this long counts as a successful start, so an agent that
/// runs for a week and then crashes restarts immediately rather than in a minute.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);
/// How long a graceful stop may take before the child is terminated.
const STOP_GRACE: Duration = Duration::from_secs(12);

const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const LOG_MAX_FILES: u32 = 5;

/* ---------------------------------- main ---------------------------------- */

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("--service");
    let rest = &args[args.len().min(1)..];

    let code = match cmd {
        "--service" => {
            service_dispatch();
            0
        }
        "install" => cmd_install(rest),
        "uninstall" => cmd_uninstall(),
        "start" => cmd_start(),
        "stop" => cmd_stop(),
        "restart" => {
            let _ = cmd_stop();
            cmd_start()
        }
        "status" => cmd_status(),
        "run" => cmd_run(),
        "--version" | "-v" => {
            println!("{VERSION}");
            0
        }
        "--help" | "-h" | "help" => {
            usage();
            0
        }
        other => {
            eprintln!("unknown command: {other}\n");
            usage();
            2
        }
    };
    std::process::exit(code);
}

fn usage() {
    println!(
        "Remote Terminal agent service {VERSION}

  remote-terminal-service install [options]   install and start the service
      --server <wss://relay>      relay URL           (first install)
      --enroll-token <token>      the account's ENROLL_TOKEN
      --name \"Office PC\"          how the machine appears in the app
      --node <path\\node.exe>      Node.js to run the agent with (default: from PATH)
      --agent <path\\index.js>     the agent to run    (default: next to this exe)
      --data <dir>                state and logs      (default: %ProgramData%\\RemoteTerminal)
      --account <user>            run as this account instead of LocalSystem
      --password <pw>             its password (prompted for by the installer script)
      --no-start                  install without starting
  remote-terminal-service uninstall           stop and remove the service
  remote-terminal-service start | stop | restart
  remote-terminal-service status              service state and what the agent reports
  remote-terminal-service run                 supervise in this console (debugging)

Installing, removing, starting and stopping need an elevated prompt."
    );
}

/* -------------------------------- install --------------------------------- */

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().map(String::as_str);
        }
        if let Some(v) = a.strip_prefix(&format!("{name}=")) {
            return Some(v);
        }
    }
    None
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

/// node.exe next to us, from --node, or the first one on PATH.
fn find_node(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        let p = PathBuf::from(p);
        return if p.is_file() { Ok(p) } else { Err(format!("--node {} does not exist", p.display())) };
    }
    for dir in std::env::var_os("PATH").iter().flat_map(std::env::split_paths) {
        let candidate = dir.join("node.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("node.exe was not found on PATH. Install Node.js 18 or newer (https://nodejs.org), or pass --node.".into())
}

/// index.js next to the executable, one directory up, or under agent\.
fn find_agent(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        let p = PathBuf::from(p);
        return if p.is_file() { Ok(p) } else { Err(format!("--agent {} does not exist", p.display())) };
    }
    let dir = exe_dir();
    let candidates = [
        dir.join("index.js"),
        dir.join("agent").join("index.js"),
        dir.join("..").join("index.js"),
        dir.join("..").join("..").join("index.js"),
    ];
    for c in candidates {
        if c.is_file() {
            return Ok(std::fs::canonicalize(&c).unwrap_or(c));
        }
    }
    Err(format!(
        "the agent's index.js was not found near {}. Pass --agent <path\\index.js>.",
        dir.display()
    ))
}

fn cmd_install(args: &[String]) -> i32 {
    let node = match find_node(flag(args, "--node")) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let agent = match find_agent(flag(args, "--agent")) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let data = flag(args, "--data").map(PathBuf::from).unwrap_or_else(default_data_dir);
    let log = data.join("logs");

    if !agent.parent().map(|p| p.join("node_modules").is_dir()).unwrap_or(false) {
        eprintln!(
            "warning: {}\\node_modules is missing — run \"npm install --omit=dev\" there, or terminals will fall back to pipes.",
            agent.parent().unwrap_or(Path::new(".")).display()
        );
    }

    if let Err(e) = std::fs::create_dir_all(&log) {
        return fail(&format!("cannot create {}: {e}", log.display()));
    }
    // The data directory holds config.json (the enrolment token), the identity
    // and the control key. Only SYSTEM and administrators may read it.
    restrict_to_admins(&data);

    let settings = Settings { node: node.clone(), agent: agent.clone(), data: data.clone(), log: log.clone() };
    if let Err(e) = settings.save(&Settings::path()) {
        return fail(&format!("cannot write {}: {e}", Settings::path().display()));
    }

    // Relay URL and enrolment token go into the agent's own config.json, via
    // the agent itself, so there is exactly one writer of that file.
    if let Some(server) = flag(args, "--server") {
        let mut c = Command::new(&node);
        c.arg(&agent).arg("--configure").arg("--server").arg(server);
        if let Some(t) = flag(args, "--enroll-token") {
            c.arg("--enroll-token").arg(t);
        }
        if let Some(n) = flag(args, "--name") {
            c.arg("--name").arg(n);
        }
        c.env("CONFIG", settings.config_json()).env("DATA_DIR", &data);
        match c.status() {
            Ok(s) if s.success() => {}
            Ok(s) => return fail(&format!("the agent refused the configuration (exit {})", s.code().unwrap_or(-1))),
            Err(e) => return fail(&format!("cannot run {}: {e}", node.display())),
        }
    } else if !settings.config_json().is_file() {
        return fail("first install needs --server <wss://relay> and --enroll-token <token>.");
    }

    let bin = format!("\"{}\" --service", exe_path().display());
    let account = flag(args, "--account");
    match install_service(&bin, account, flag(args, "--password")) {
        Ok(created) => println!(
            "{} service '{SERVICE_NAME}' ({}).",
            if created { "Installed" } else { "Updated" },
            account.unwrap_or("LocalSystem")
        ),
        Err(e) => return fail(&e),
    }

    println!("  node:  {}", node.display());
    println!("  agent: {}", agent.display());
    println!("  data:  {}", data.display());
    println!("  log:   {}", settings.agent_log().display());

    if has(args, "--no-start") {
        println!("\nNot started (--no-start). Start it with: remote-terminal-service start");
        return 0;
    }
    if let Err(e) = start_service() {
        return fail(&e);
    }
    println!("\nStarted. Waiting for the agent to reach the relay…");
    match wait_registered(Duration::from_secs(45)) {
        Some(s) => {
            println!("  {} — {}", if s.name.is_empty() { "this machine".into() } else { s.name.clone() }, s.headline());
            print_pair_code(&data);
        }
        None => {
            println!(
                "  Not registered yet. Check the log:\n    {}\n  or run: remote-terminal-service status",
                settings.agent_log().display()
            );
        }
    }
    0
}

fn print_pair_code(data: &Path) {
    let Some(key) = control::read_key(data) else {
        println!("\nRun \"remote-terminal-service status\" from an elevated prompt for a pairing code.");
        return;
    };
    match control::pair(PIPE_NAME, &key) {
        Ok(p) => {
            println!("\nPair a phone");
            println!("  Relay URL:    {}", p.relay_url);
            println!("  Pairing code: {}", p.code);
            println!("  Valid for:    {} minutes (single use)", (p.ttl_sec / 60).max(1));
            println!("\nIn the app: Machines → Pair → enter the relay URL and this code.");
        }
        Err(e) => println!("\nCould not get a pairing code: {e}"),
    }
}

fn cmd_uninstall() -> i32 {
    let _ = stop_service(Duration::from_secs(30));
    match delete_service() {
        Ok(true) => println!("Removed service '{SERVICE_NAME}'."),
        Ok(false) => println!("Service '{SERVICE_NAME}' was not installed."),
        Err(e) => return fail(&e),
    }
    if let Ok(s) = Settings::load() {
        println!(
            "Configuration, identity and logs were kept in {}.\nRemove the machine in the app so its token is revoked.",
            s.data.display()
        );
    }
    0
}

fn cmd_start() -> i32 {
    match start_service() {
        Ok(()) => {
            println!("Service '{SERVICE_NAME}' started.");
            0
        }
        Err(e) => fail(&e),
    }
}

fn cmd_stop() -> i32 {
    match stop_service(Duration::from_secs(30)) {
        Ok(()) => {
            println!("Service '{SERVICE_NAME}' stopped.");
            0
        }
        Err(e) => fail(&e),
    }
}

fn cmd_status() -> i32 {
    println!("Remote Terminal agent service {VERSION}");
    match query_state() {
        Ok(Some(state)) => println!("  Service:      {}", state_name(state)),
        Ok(None) => println!("  Service:      not installed"),
        Err(e) => println!("  Service:      {e}"),
    }
    match Settings::load() {
        Ok(s) => {
            println!("  Node:         {}", s.node.display());
            println!("  Agent:        {}", s.agent.display());
            println!("  Log:          {}", s.agent_log().display());
        }
        Err(e) => println!("  Settings:     {e}"),
    }
    match control::status(PIPE_NAME) {
        Ok(s) => {
            println!("  Agent:        running (pid {}, version {})", s.pid, s.version);
            println!("  Machine name: {}", if s.name.is_empty() { "-" } else { &s.name });
            println!("  Relay:        {}", s.headline());
            println!("  Uptime:       {}", human_duration(s.uptime_sec));
        }
        Err(e) => println!("  Agent:        {e}"),
    }
    if let Ok(s) = Settings::load() {
        if control::read_key(&s.data).is_some() {
            print_pair_code(&s.data);
        }
    }
    0
}

/// Supervise in the foreground. Ctrl-C stops the child the same way the SCM would.
fn cmd_run() -> i32 {
    let settings = match Settings::load() {
        Ok(s) => s,
        Err(e) => return fail(&e),
    };
    if unsafe { SetConsoleCtrlHandler(Some(console_handler), 1) } == 0 {
        eprintln!("warning: Ctrl-C will not stop the agent gracefully");
    }
    let log = Arc::new(LogFile::open(&settings.agent_log(), LOG_MAX_BYTES, LOG_MAX_FILES));
    println!("Supervising {} (Ctrl-C to stop). Log: {}", settings.agent.display(), settings.agent_log().display());
    supervise(&settings, &log, &CONSOLE_STOP, &mut |_| {})
}

fn fail(msg: &str) -> i32 {
    eprintln!("error: {msg}");
    1
}

fn human_duration(sec: i64) -> String {
    let (d, h, m) = (sec / 86400, (sec % 86400) / 3600, (sec % 3600) / 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

/* ------------------------------ the supervisor ---------------------------- */

/// Runs the agent until `stop` is set or it fails in a way a restart cannot fix.
/// `report` is called with a checkpoint so the SCM sees progress during a slow stop.
fn supervise(settings: &Settings, log: &Arc<LogFile>, stop: &AtomicBool, report: &mut dyn FnMut(u32)) -> i32 {
    let job = Job::create();
    let mut backoff = BACKOFF_START;

    log.info(
        "service starting",
        &[
            ("version", VERSION.to_string()),
            ("node", settings.node.display().to_string()),
            ("agent", settings.agent.display().to_string()),
            ("data", settings.data.display().to_string()),
        ],
    );

    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        let mut child = match spawn_agent(settings, &job) {
            Ok(c) => c,
            Err(e) => {
                log.error("cannot start the agent", &[("err", e.clone())]);
                if !sleep_watching(BACKOFF_MAX, stop) {
                    break;
                }
                continue;
            }
        };
        log.info("agent started", &[("pid", child.id().to_string())]);
        pump_output(&mut child, log);

        // Wait for the child to exit, or for a stop request to arrive.
        let exit = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => {}
                Err(e) => {
                    log.error("cannot query the agent process", &[("err", e.to_string())]);
                    break -1;
                }
            }
            if stop.load(Ordering::SeqCst) {
                report(2);
                let code = stop_child(&mut child, settings, log, report);
                log.info("service stopped", &[("exit", code.to_string())]);
                return 0;
            }
            std::thread::sleep(Duration::from_millis(200));
        };

        let ran = started.elapsed();
        if stop.load(Ordering::SeqCst) {
            log.info("agent exited during shutdown", &[("exit", exit.to_string())]);
            break;
        }
        if FATAL_EXITS.contains(&exit) {
            log.error(
                "the agent cannot run on this machine; not restarting it",
                &[("exit", exit.to_string()), ("hint", fatal_hint(exit).to_string())],
            );
            return exit;
        }
        if ran >= HEALTHY_AFTER {
            backoff = BACKOFF_START;
        }
        log.warn(
            "agent exited; restarting",
            &[
                ("exit", exit.to_string()),
                ("ranSec", ran.as_secs().to_string()),
                ("delayMs", backoff.as_millis().to_string()),
            ],
        );
        if !sleep_watching(backoff, stop) {
            break;
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }

    log.info("service stopped", &[]);
    0
}

fn fatal_hint(exit: i32) -> &'static str {
    match exit {
        2 => "not enrolled, or the relay revoked this machine — run the installer again with --server and --enroll-token",
        5 => "another agent is already running on this machine",
        _ => "see the lines above",
    }
}

fn spawn_agent(settings: &Settings, job: &Job) -> Result<Child, String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;

    let child = Command::new(&settings.node)
        .arg(&settings.agent)
        .current_dir(settings.agent.parent().unwrap_or(Path::new(".")))
        .env("CONFIG", settings.config_json())
        .env("DATA_DIR", &settings.data)
        .env("LOG_DIR", &settings.log)
        .env("NODE_ENV", "production")
        // The supervisor owns the log file: it has to interleave its own lines
        // with the agent's, and it is still writing when the agent is not.
        .env("LOG_TO_FILE", "0")
        .env("RT_SUPERVISED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("{}: {e}", settings.node.display()))?;
    job.adopt(child.id());
    Ok(child)
}

/// Move the child's stdout and stderr into the log, on their own threads.
/// The agent already writes JSON lines, so they go in verbatim; anything else
/// (a Node stack trace, a native module's complaint) is wrapped so the file
/// stays machine-readable.
fn pump_output(child: &mut Child, log: &Arc<LogFile>) {
    for (stream, label) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "stdout"),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "stderr"),
    ] {
        let Some(stream) = stream else { continue };
        let log = Arc::clone(log);
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.starts_with('{') && trimmed.ends_with('}') {
                    log.raw(trimmed);
                } else {
                    log.event(if label == "stderr" { "warn" } else { "info" }, trimmed, &[("stream", label.to_string())]);
                }
            }
        });
    }
}

/// Stop the child the polite way — over its control pipe, so it closes each
/// terminal and tells the relay — and terminate it only if it will not go.
fn stop_child(child: &mut Child, settings: &Settings, log: &LogFile, report: &mut dyn FnMut(u32)) -> i32 {
    match control::read_key(&settings.data) {
        Some(key) => match control::shutdown(PIPE_NAME, &key) {
            Ok(()) => log.info("asked the agent to shut down", &[]),
            Err(e) => log.warn("the agent did not accept the shutdown request", &[("err", e.to_string())]),
        },
        None => log.warn("no control key; the agent will be terminated instead", &[]),
    }

    let deadline = Instant::now() + STOP_GRACE;
    let mut checkpoint = 3;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return status.code().unwrap_or(0);
        }
        std::thread::sleep(Duration::from_millis(200));
        checkpoint += 1;
        report(checkpoint);
    }
    log.warn("the agent did not stop in time; terminating it", &[("graceSec", STOP_GRACE.as_secs().to_string())]);
    let _ = child.kill();
    let _ = child.wait();
    -1
}

/// Sleep, but wake as soon as a stop is requested. False means "stop now".
fn sleep_watching(total: Duration, stop: &AtomicBool) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !stop.load(Ordering::SeqCst)
}

/* -------------------------------- job object ------------------------------ */

/// A job the agent is put into, so that terminating it also takes down every
/// shell it opened. Without this, a killed agent leaves orphaned cmd.exe and
/// pwsh.exe processes behind on every restart.
struct Job(HANDLE);

impl Job {
    fn create() -> Job {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !handle.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
            Job(handle)
        }
    }

    fn adopt(&self, pid: u32) {
        if self.0.is_null() {
            return;
        }
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !proc.is_null() {
                AssignProcessToJobObject(self.0, proc);
                CloseHandle(proc);
            }
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/* --------------------------- SCM: the service side ------------------------ */

static STOP_REQUESTED: OnceLock<Arc<AtomicBool>> = OnceLock::new();
static STATUS_HANDLE: AtomicUsize = AtomicUsize::new(0);
static CURRENT_STATE: AtomicUsize = AtomicUsize::new(SERVICE_START_PENDING as usize);

fn service_dispatch() {
    let mut name = w(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW { lpServiceName: name.as_mut_ptr(), lpServiceProc: Some(service_main) },
        SERVICE_TABLE_ENTRYW { lpServiceName: std::ptr::null_mut(), lpServiceProc: None },
    ];
    unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) };
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
    let handle = RegisterServiceCtrlHandlerExW(w(SERVICE_NAME).as_ptr(), Some(service_handler), std::ptr::null());
    if handle.is_null() {
        return;
    }
    STATUS_HANDLE.store(handle as usize, Ordering::SeqCst);
    let stop = STOP_REQUESTED.get_or_init(|| Arc::new(AtomicBool::new(false))).clone();

    set_status(SERVICE_START_PENDING, 1, 20_000, 0);

    let settings = match Settings::load() {
        Ok(s) => s,
        Err(_) => {
            // Nothing is configured, so there is nowhere to log to either.
            set_status(SERVICE_STOPPED, 0, 0, ERROR_SERVICE_SPECIFIC_ERROR);
            return;
        }
    };
    let log = Arc::new(LogFile::open(&settings.agent_log(), LOG_MAX_BYTES, LOG_MAX_FILES));

    set_status(SERVICE_RUNNING, 0, 0, 0);
    let mut report = |checkpoint: u32| set_status(SERVICE_STOP_PENDING, checkpoint, 20_000, 0);
    let code = supervise(&settings, &log, &stop, &mut report);

    if code == 0 {
        set_status(SERVICE_STOPPED, 0, 0, 0);
    } else {
        // A service-specific code keeps `sc query` honest about *why* it stopped.
        set_status_specific(code as u32);
    }
}

unsafe extern "system" fn service_handler(control: u32, _event: u32, _data: *mut c_void, _ctx: *mut c_void) -> u32 {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            set_status(SERVICE_STOP_PENDING, 1, 20_000, 0);
            if let Some(flag) = STOP_REQUESTED.get() {
                flag.store(true, Ordering::SeqCst);
            }
        }
        SERVICE_CONTROL_INTERROGATE => {
            let state = CURRENT_STATE.load(Ordering::SeqCst) as u32;
            set_status(state, 0, 0, 0);
        }
        _ => {}
    }
    NO_ERROR
}

fn set_status(state: u32, checkpoint: u32, wait_hint: u32, win32_exit: u32) {
    let handle = STATUS_HANDLE.load(Ordering::SeqCst);
    if handle == 0 {
        return;
    }
    CURRENT_STATE.store(state as usize, Ordering::SeqCst);
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING { SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN } else { 0 },
        dwWin32ExitCode: win32_exit,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: checkpoint,
        dwWaitHint: wait_hint,
    };
    unsafe { SetServiceStatus(handle as SERVICE_STATUS_HANDLE, &status) };
}

fn set_status_specific(code: u32) {
    let handle = STATUS_HANDLE.load(Ordering::SeqCst);
    if handle == 0 {
        return;
    }
    CURRENT_STATE.store(SERVICE_STOPPED as usize, Ordering::SeqCst);
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: SERVICE_STOPPED,
        dwControlsAccepted: 0,
        dwWin32ExitCode: ERROR_SERVICE_SPECIFIC_ERROR,
        dwServiceSpecificExitCode: code,
        dwCheckPoint: 0,
        dwWaitHint: 0,
    };
    unsafe { SetServiceStatus(handle as SERVICE_STATUS_HANDLE, &status) };
}

/* -------------------------- SCM: the control side ------------------------- */

struct ScHandle(SC_HANDLE);

impl Drop for ScHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseServiceHandle(self.0) };
        }
    }
}

fn last_error() -> u32 {
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

fn scm(access: u32) -> Result<ScHandle, String> {
    let h = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), access) };
    if h.is_null() {
        let err = last_error();
        return Err(if err == ERROR_ACCESS_DENIED {
            "access denied — run this from an elevated prompt (right-click → Run as administrator).".into()
        } else {
            format!("cannot open the service manager (error {err})")
        });
    }
    Ok(ScHandle(h))
}

fn open_service(access: u32) -> Result<Option<ScHandle>, String> {
    let manager = scm(SC_MANAGER_CONNECT)?;
    let h = unsafe { OpenServiceW(manager.0, w(SERVICE_NAME).as_ptr(), access) };
    if h.is_null() {
        const ERROR_SERVICE_DOES_NOT_EXIST: u32 = 1060;
        let err = last_error();
        if err == ERROR_SERVICE_DOES_NOT_EXIST {
            return Ok(None);
        }
        return Err(if err == ERROR_ACCESS_DENIED {
            "access denied — run this from an elevated prompt.".into()
        } else {
            format!("cannot open service '{SERVICE_NAME}' (error {err})")
        });
    }
    Ok(Some(ScHandle(h)))
}

/// Creates the service, or reconfigures the existing one. True when created.
fn install_service(binary: &str, account: Option<&str>, password: Option<&str>) -> Result<bool, String> {
    let manager = scm(SC_MANAGER_CREATE_SERVICE | SC_MANAGER_CONNECT)?;
    let name = w(SERVICE_NAME);
    let display = w(DISPLAY_NAME);
    let bin = w(binary);
    let account_w = account.map(w);
    let password_w = password.map(w);
    // "Network is up" is the only ordering that matters; the agent retries anyway.
    let deps = w("Tcpip\0");

    let existing = unsafe { OpenServiceW(manager.0, name.as_ptr(), SERVICE_ALL_ACCESS) };
    let (handle, created) = if existing.is_null() {
        let h = unsafe {
            CreateServiceW(
                manager.0,
                name.as_ptr(),
                display.as_ptr(),
                SERVICE_ALL_ACCESS,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_AUTO_START,
                SERVICE_ERROR_NORMAL,
                bin.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                deps.as_ptr(),
                account_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
                password_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
            )
        };
        if h.is_null() {
            return Err(format!("cannot create service '{SERVICE_NAME}' (error {})", last_error()));
        }
        (ScHandle(h), true)
    } else {
        let handle = ScHandle(existing);
        let ok = unsafe {
            ChangeServiceConfigW(
                handle.0,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_AUTO_START,
                SERVICE_ERROR_NORMAL,
                bin.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                deps.as_ptr(),
                account_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
                password_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
                display.as_ptr(),
            )
        };
        if ok == 0 {
            return Err(format!("cannot reconfigure service '{SERVICE_NAME}' (error {})", last_error()));
        }
        (handle, false)
    };

    let mut description = w("Hosts terminal sessions for the Remote Terminal app on your phone.");
    let desc = SERVICE_DESCRIPTIONW { lpDescription: description.as_mut_ptr() };
    unsafe {
        ChangeServiceConfig2W(handle.0, SERVICE_CONFIG_DESCRIPTION, &desc as *const _ as *const c_void);
    }

    // The supervisor restarts the agent; these actions cover the supervisor
    // itself being killed. Reset the counter after an hour of health.
    let mut actions = [
        SC_ACTION { Type: SC_ACTION_RESTART, Delay: 5_000 },
        SC_ACTION { Type: SC_ACTION_RESTART, Delay: 20_000 },
        SC_ACTION { Type: SC_ACTION_RESTART, Delay: 60_000 },
    ];
    let failure = SERVICE_FAILURE_ACTIONSW {
        dwResetPeriod: 3600,
        lpRebootMsg: std::ptr::null_mut(),
        lpCommand: std::ptr::null_mut(),
        cActions: actions.len() as u32,
        lpsaActions: actions.as_mut_ptr(),
    };
    unsafe {
        ChangeServiceConfig2W(handle.0, SERVICE_CONFIG_FAILURE_ACTIONS, &failure as *const _ as *const c_void);
    }

    Ok(created)
}

fn delete_service() -> Result<bool, String> {
    let Some(service) = open_service(SERVICE_ALL_ACCESS)? else {
        return Ok(false);
    };
    if unsafe { DeleteService(service.0) } == 0 {
        return Err(format!("cannot remove service '{SERVICE_NAME}' (error {})", last_error()));
    }
    Ok(true)
}

fn start_service() -> Result<(), String> {
    let Some(service) = open_service(SERVICE_START | SERVICE_QUERY_STATUS)? else {
        return Err(format!("service '{SERVICE_NAME}' is not installed; run: remote-terminal-service install"));
    };
    if unsafe { StartServiceW(service.0, 0, std::ptr::null()) } == 0 {
        const ERROR_SERVICE_ALREADY_RUNNING: u32 = 1056;
        let err = last_error();
        if err != ERROR_SERVICE_ALREADY_RUNNING {
            return Err(format!("cannot start service '{SERVICE_NAME}' (error {err})"));
        }
    }
    Ok(())
}

fn stop_service(timeout: Duration) -> Result<(), String> {
    let Some(service) = open_service(SERVICE_STOP | SERVICE_QUERY_STATUS)? else {
        return Ok(());
    };
    let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut status) } == 0 {
        const ERROR_SERVICE_NOT_ACTIVE: u32 = 1062;
        let err = last_error();
        if err == ERROR_SERVICE_NOT_ACTIVE {
            return Ok(());
        }
        return Err(format!("cannot stop service '{SERVICE_NAME}' (error {err})"));
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match query_state()? {
            Some(state) if state == SERVICE_STOPPED => return Ok(()),
            None => return Ok(()),
            _ => std::thread::sleep(Duration::from_millis(300)),
        }
    }
    Err("the service did not stop within the timeout".into())
}

fn query_state() -> Result<Option<u32>, String> {
    let Some(service) = open_service(SERVICE_QUERY_STATUS)? else {
        return Ok(None);
    };
    let mut buf: SERVICE_STATUS_PROCESS = unsafe { std::mem::zeroed() };
    let mut needed = 0u32;
    let ok = unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            &mut buf as *mut _ as *mut u8,
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(format!("cannot query service '{SERVICE_NAME}' (error {})", last_error()));
    }
    Ok(Some(buf.dwCurrentState))
}

fn state_name(state: u32) -> &'static str {
    match state {
        SERVICE_STOPPED => "stopped",
        SERVICE_START_PENDING => "starting",
        SERVICE_STOP_PENDING => "stopping",
        SERVICE_RUNNING => "running",
        SERVICE_CONTINUE_PENDING => "continuing",
        SERVICE_PAUSE_PENDING => "pausing",
        SERVICE_PAUSED => "paused",
        _ => "unknown",
    }
}

/// Poll the agent until it says it is registered with the relay.
fn wait_registered(timeout: Duration) -> Option<control::Status> {
    let deadline = Instant::now() + timeout;
    let mut last = None;
    while Instant::now() < deadline {
        if let Ok(s) = control::status(PIPE_NAME) {
            if s.registered {
                return Some(s);
            }
            last = Some(s);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    last.filter(|s| s.connected)
}

/* --------------------------------- misc ----------------------------------- */

/// Lock the data directory down to SYSTEM and the administrators. It holds the
/// enrolment token, the machine's identity and the control key; a standard user
/// who could read it could pair a phone and get a LocalSystem shell.
fn restrict_to_admins(dir: &Path) {
    let run = |args: &[&str]| {
        let _ = Command::new("icacls").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status();
    };
    let path = dir.display().to_string();
    run(&[&path, "/inheritance:r"]);
    run(&[&path, "/grant:r", "*S-1-5-18:(OI)(CI)F"]); // LocalSystem
    run(&[&path, "/grant:r", "*S-1-5-32-544:(OI)(CI)F"]); // Administrators
}

/// Ctrl-C in `run` mode, so the console path stops the child the same way the
/// SCM path does. A Win32 console handler is a bare fn, so the flag is static.
static CONSOLE_STOP: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn console_handler(_ctrl_type: u32) -> i32 {
    CONSOLE_STOP.store(true, Ordering::SeqCst);
    1 // handled: do not let the default handler kill us mid-shutdown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_accept_both_spellings() {
        let args: Vec<String> = ["--server", "wss://r", "--name=Office PC", "--no-start"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(flag(&args, "--server"), Some("wss://r"));
        assert_eq!(flag(&args, "--name"), Some("Office PC"));
        assert_eq!(flag(&args, "--missing"), None);
        assert!(has(&args, "--no-start"));
        assert!(!has(&args, "--start"));
    }

    #[test]
    fn a_flag_without_a_value_is_not_taken_from_the_next_flag() {
        let args: Vec<String> = ["--server"].iter().map(|s| s.to_string()).collect();
        assert_eq!(flag(&args, "--server"), None);
    }

    #[test]
    fn fatal_exit_codes_are_the_ones_the_agent_documents() {
        assert!(FATAL_EXITS.contains(&2), "revoked identity must not restart-loop");
        assert!(FATAL_EXITS.contains(&5), "a second agent must not restart-loop");
        assert!(!FATAL_EXITS.contains(&1), "an ordinary crash restarts");
        assert!(!FATAL_EXITS.contains(&9), "a wedged event loop restarts");
    }

    #[test]
    fn durations_read_the_way_a_person_says_them() {
        assert_eq!(human_duration(90), "1m");
        assert_eq!(human_duration(3 * 3600 + 120), "3h 2m");
        assert_eq!(human_duration(50 * 3600), "2d 2h");
    }

    #[test]
    fn service_states_have_names() {
        assert_eq!(state_name(SERVICE_RUNNING), "running");
        assert_eq!(state_name(SERVICE_STOPPED), "stopped");
        assert_eq!(state_name(9999), "unknown");
    }
}
