//! Remote Terminal — shell launcher.
//!
//! ```text
//!   remote-terminal-shell --cols 120 --rows 40 -- "C:\...\pwsh.exe" -NoLogo
//!   remote-terminal-shell --probe
//! ```
//!
//! THE PROBLEM IT SOLVES. The agent runs as a Windows service so that a phone
//! can reach this machine before anyone signs in. A service is LocalSystem, so
//! every terminal it opened was LocalSystem too: `%USERPROFILE%` pointed at
//! `C:\Windows\system32\config\systemprofile`, PATH was the machine's and not
//! the person's, and none of their profile — PowerShell, git, npm, ssh keys —
//! was there. It worked, and it was nobody's terminal.
//!
//! This binary borrows the token of whoever is signed in and starts the shell
//! with it, so a terminal opened from the phone is the same terminal they
//! would get by opening one themselves.
//!
//! HOW. In two hops, because a pseudoconsole belongs to whoever created it:
//!
//!   1. this process, as LocalSystem, finds the signed-in user's token and
//!      starts a second copy of itself with it, handing over its own stdin,
//!      stdout and stderr;
//!   2. that copy — now the user — creates the pseudoconsole, starts the shell
//!      in it, and copies bytes between the console and the inherited pipes.
//!
//! Doing it in one hop does not work: conhost stamps the console object with
//! the creator's DACL and integrity level, and a shell running as a standard
//! user is then refused access to a console SYSTEM made.
//!
//! WHAT THE AGENT SEES. stdout is the terminal's output, raw. stdin is framed
//! (see `frame.rs`) because it carries resizes as well as keystrokes. stderr
//! carries one JSON line saying who the terminal ended up belonging to, and
//! then anything that went wrong.

use std::process::exit;

use rt_windows::conpty;
use rt_windows::job::Job;
use rt_windows::usersession::{self, UserSession};
use rt_windows::wide::w;
use rt_windows::VERSION;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

/// Exit codes above anything a shell plausibly returns, so "the launcher
/// failed" is never mistaken for "the shell failed". Reported on stderr too.
const EXIT_USAGE: i32 = 121;
const EXIT_NO_USER: i32 = 122;
const EXIT_LAUNCH: i32 = 123;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RunAs {
    /// The signed-in user if there is one, this account if there is not.
    Auto,
    /// The signed-in user or nothing.
    User,
    /// Whoever we already are. Used by hop 2, and by an agent that is not a
    /// service and so has a perfectly good profile of its own.
    Self_,
}

struct Options {
    cols: u16,
    rows: u16,
    cwd: String,
    env: Vec<(String, String)>,
    run_as: RunAs,
    /// This copy is hop 2: create the console here.
    host: bool,
    probe: bool,
    argv: Vec<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = match parse(&args) {
        Ok(opts) => opts,
        Err(why) => {
            report(&format!("{{\"ok\":false,\"error\":{}}}", quote(&why)));
            eprintln!("usage: remote-terminal-shell [--cols N] [--rows N] [--cwd DIR] [--env NAME=VALUE]");
            eprintln!("                             [--run-as auto|user|self] -- <shell> [args...]");
            exit(EXIT_USAGE);
        }
    };

    if opts.probe {
        exit(probe());
    }
    if opts.argv.is_empty() {
        report("{\"ok\":false,\"error\":\"no shell to start\"}");
        exit(EXIT_USAGE);
    }

    // Hop 2, or hop 1 with nothing to impersonate: host the console here.
    if opts.host || opts.run_as == RunAs::Self_ {
        if !opts.host {
            report(&ready("self", "", &opts.cwd, 0));
        }
        exit(host(&opts));
    }

    match usersession::active_user() {
        Ok(user) => exit(as_user(&opts, &user)),
        Err(why) if opts.run_as == RunAs::User => {
            report(&format!("{{\"ok\":false,\"error\":{}}}", quote(&why)));
            exit(EXIT_NO_USER);
        }
        Err(why) => {
            // --run-as auto: better a SYSTEM terminal than no terminal, but
            // say so, because it is not the one the operator asked for.
            report(&format!(
                "{{\"launch\":\"remote-terminal-shell\",\"ok\":true,\"as\":\"self\",\"reason\":{},\"cwd\":{}}}",
                quote(&why),
                quote(&opts.cwd)
            ));
            exit(host(&opts));
        }
    }
}

/* ------------------------------- hop 1: token ----------------------------- */

/// Start a copy of ourselves as `user`, with our own stdio, and wait for it.
fn as_user(opts: &Options, user: &UserSession) -> i32 {
    let cwd = if opts.cwd.is_empty() { user.home.clone() } else { opts.cwd.clone() };
    let mut env = opts.env.clone();
    // The shell is talking to a phone, not to a console window.
    env.push(("SESSIONNAME".to_string(), format!("RemoteTerminal-{}", user.session_id)));
    let block = usersession::build_block(&user.env, &env);

    let exe = std::env::current_exe().unwrap_or_else(|_| "remote-terminal-shell.exe".into());
    let mut command = vec![
        exe.to_string_lossy().into_owned(),
        "--host".to_string(),
        "--cols".to_string(),
        opts.cols.to_string(),
        "--rows".to_string(),
        opts.rows.to_string(),
    ];
    if !cwd.is_empty() {
        command.push("--cwd".to_string());
        command.push(cwd.clone());
    }
    command.push("--".to_string());
    command.extend(opts.argv.iter().cloned());

    let (stdin, stdout, stderr) = conpty::inheritable_stdio();
    let job = Job::create();

    let pi = match start_as(user.token, &command, &cwd, &block, (stdin, stdout, stderr)) {
        Ok(pi) => pi,
        Err(why) => {
            report(&format!("{{\"ok\":false,\"error\":{}}}", quote(&why)));
            return EXIT_LAUNCH;
        }
    };
    // Before anything else can go wrong: if we are killed, the shell and its
    // conhost go too.
    job.adopt_handle(pi.hProcess);

    report(&ready("user", &user.user, &cwd, user.session_id));

    let code = conpty::wait_for(pi.hProcess);
    unsafe {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }
    code
}

fn start_as(
    token: HANDLE,
    command: &[String],
    cwd: &str,
    env: &[u16],
    stdio: (HANDLE, HANDLE, HANDLE),
) -> Result<PROCESS_INFORMATION, String> {
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        // An EMPTY desktop name, which is not the same as no name at all:
        // NULL inherits ours, and a service's station is `Service-0x0-3e7$`,
        // which is not the signed-in user's. An empty string asks Windows to
        // use the station and desktop of the session the token belongs to.
        // `winsta0\default` is the usual incantation and does work, but it
        // names session 0's station when a service asks for it, which is not
        // what anyone means here.
        let mut desktop = w("");
        si.lpDesktop = desktop.as_mut_ptr();
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = stdio.0;
        si.hStdOutput = stdio.1;
        si.hStdError = stdio.2;

        let mut line = w(rt_windows::cmdline::join(command));
        let dir = w(cwd);
        let base = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;

        // BREAKING OUT OF THE JOB IS NOT OPTIONAL HERE. The service supervises
        // the agent inside a job object so that killing it cannot leave shells
        // behind, and we inherit that job. A job belongs to the session of the
        // process that created it — session 0 — and a process inside one may
        // not start a process in another session. That is the whole point of
        // what we are doing, and without CREATE_BREAKAWAY_FROM_JOB it fails
        // with a bare ERROR_ACCESS_DENIED that names nothing.
        //
        // The retry is for a job that will not let anyone leave: an older
        // supervisor, or somebody else's. It cannot work, but failing the way
        // it used to beats failing differently.
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let mut last = 0u32;
        for flags in [base | CREATE_BREAKAWAY_FROM_JOB, base] {
            let ok = CreateProcessAsUserW(
                token,
                std::ptr::null(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1, // the stdio handles have to reach the child
                flags,
                env.as_ptr() as *const core::ffi::c_void,
                if cwd.is_empty() { std::ptr::null() } else { dir.as_ptr() },
                &si,
                &mut pi,
            );
            if ok != 0 {
                return Ok(pi);
            }
            last = windows_sys::Win32::Foundation::GetLastError();
        }
        Err(match last {
            1314 => "CreateProcessAsUser was refused; the launcher must run as LocalSystem".to_string(),
            5 => "CreateProcessAsUser was denied (5); the agent's job object does not allow breaking away                   into the signed-in user's session"
                .to_string(),
            other => format!("CreateProcessAsUser failed ({other})"),
        })
    }
}

/* ------------------------------ hop 2: console ---------------------------- */

fn host(opts: &Options) -> i32 {
    // Hop 1 already put these in the environment block it built for us; when
    // we are hop 1 as well (no user to impersonate) they still have to be set.
    if !opts.host {
        for (name, value) in &opts.env {
            std::env::set_var(name, value);
        }
    }
    match conpty::run(&opts.argv, &opts.cwd, opts.cols, opts.rows) {
        Ok(code) => code,
        Err(why) => {
            report(&format!("{{\"ok\":false,\"error\":{}}}", quote(&why)));
            EXIT_LAUNCH
        }
    }
}

/* ---------------------------------- probe --------------------------------- */

/// Say what this machine can do without starting anything. The agent runs this
/// once at startup — and `--doctor` prints it — so that "terminals will run as
/// SYSTEM" is something an operator finds out before a phone does.
fn probe() -> i32 {
    match usersession::active_user() {
        Ok(user) => {
            report(&format!(
                "{{\"launch\":\"remote-terminal-shell\",\"version\":{},\"ok\":true,\"as\":\"user\",\"user\":{},\"cwd\":{},\"session\":{}}}",
                quote(VERSION),
                quote(&user.user),
                quote(&user.home),
                user.session_id
            ));
            println!("terminals will run as {} (session {})", user.user, user.session_id);
        }
        Err(why) => {
            report(&format!(
                "{{\"launch\":\"remote-terminal-shell\",\"version\":{},\"ok\":false,\"error\":{}}}",
                quote(VERSION),
                quote(&why)
            ));
            println!("terminals will run as this account: {why}");
        }
    }
    0
}

/* --------------------------------- plumbing -------------------------------- */

fn ready(as_who: &str, user: &str, cwd: &str, session: u32) -> String {
    format!(
        "{{\"launch\":\"remote-terminal-shell\",\"ok\":true,\"as\":{},\"user\":{},\"cwd\":{},\"session\":{}}}",
        quote(as_who),
        quote(user),
        quote(cwd),
        session
    )
}

/// One line on stderr, which is where the agent reads status from. Marked so
/// that a stray line from a shell cannot be mistaken for one of ours.
fn report(line: &str) {
    let line = if line.contains("\"launch\"") {
        line.to_string()
    } else {
        format!("{{\"launch\":\"remote-terminal-shell\",{}", &line[1..])
    };
    eprintln!("{line}");
}

fn quote(s: &str) -> String {
    rt_windows::json::quote(s)
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut opts = Options {
        cols: 80,
        rows: 24,
        cwd: String::new(),
        env: Vec::new(),
        run_as: RunAs::Auto,
        host: false,
        probe: false,
        argv: Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        // Everything after `--` is the shell and its arguments, untouched.
        if arg == "--" {
            opts.argv = args[i + 1..].to_vec();
            return Ok(opts);
        }
        let mut value = |name: &str| -> Result<String, String> {
            i += 1;
            args.get(i).cloned().ok_or_else(|| format!("{name} needs a value"))
        };
        match arg {
            "--cols" => opts.cols = parse_size(&value("--cols")?, "--cols")?,
            "--rows" => opts.rows = parse_size(&value("--rows")?, "--rows")?,
            "--cwd" => opts.cwd = value("--cwd")?,
            "--env" => {
                let pair = value("--env")?;
                match pair.split_once('=') {
                    Some((k, v)) if !k.is_empty() => opts.env.push((k.to_string(), v.to_string())),
                    _ => return Err(format!("--env wants NAME=VALUE, got \"{pair}\"")),
                }
            }
            "--run-as" => {
                opts.run_as = match value("--run-as")?.as_str() {
                    "auto" => RunAs::Auto,
                    "user" => RunAs::User,
                    "self" => RunAs::Self_,
                    other => return Err(format!("--run-as wants auto, user or self, got \"{other}\"")),
                }
            }
            "--host" => opts.host = true,
            "--probe" => opts.probe = true,
            "--version" | "-V" => {
                println!("remote-terminal-shell {VERSION}");
                exit(0);
            }
            other => return Err(format!("unknown option \"{other}\"")),
        }
        i += 1;
    }
    if !opts.probe {
        return Err("no shell given; put it after \"--\"".to_string());
    }
    Ok(opts)
}

fn parse_size(text: &str, name: &str) -> Result<u16, String> {
    let n: u32 = text.parse().map_err(|_| format!("{name} wants a number, got \"{text}\""))?;
    Ok(n.clamp(1, 1000) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_shell_and_its_arguments_survive_the_double_dash() {
        let o = parse(&args(&["--cols", "120", "--rows", "40", "--", "C:\\pwsh.exe", "-NoLogo", "--cols"])).unwrap();
        assert_eq!((o.cols, o.rows), (120, 40));
        // `--cols` after the separator belongs to the shell, not to us.
        assert_eq!(o.argv, args(&["C:\\pwsh.exe", "-NoLogo", "--cols"]));
        assert_eq!(o.run_as, RunAs::Auto);
        assert!(!o.host);
    }

    #[test]
    fn geometry_is_clamped_rather_than_trusted() {
        assert_eq!(parse_size("0", "--cols").unwrap(), 1);
        assert_eq!(parse_size("99999", "--rows").unwrap(), 1000);
        assert!(parse_size("wide", "--cols").is_err());
    }

    #[test]
    fn env_overrides_accumulate_and_keep_their_values() {
        let o = parse(&args(&["--env", "TERM=xterm-256color", "--env", "X=a=b", "--", "cmd.exe"])).unwrap();
        assert_eq!(o.env, vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("X".to_string(), "a=b".to_string()),
        ]);
        assert!(parse(&args(&["--env", "novalue", "--", "cmd.exe"])).is_err());
        assert!(parse(&args(&["--env", "=v", "--", "cmd.exe"])).is_err());
    }

    #[test]
    fn probe_needs_no_shell_but_everything_else_does() {
        assert!(parse(&args(&["--probe"])).unwrap().probe);
        assert!(parse(&args(&["--cols", "80"])).is_err());
        assert!(parse(&args(&["--nonsense", "--", "cmd.exe"])).is_err());
        assert!(parse(&args(&["--cwd"])).is_err());
    }

    #[test]
    fn run_as_takes_the_three_words_and_nothing_else() {
        assert_eq!(parse(&args(&["--run-as", "user", "--", "cmd"])).unwrap().run_as, RunAs::User);
        assert_eq!(parse(&args(&["--run-as", "self", "--", "cmd"])).unwrap().run_as, RunAs::Self_);
        assert!(parse(&args(&["--run-as", "root", "--", "cmd"])).is_err());
    }

    #[test]
    fn every_status_line_is_marked_and_parseable() {
        let line = ready("user", "OFFICE\\ann", "C:\\Users\\ann", 2);
        assert_eq!(rt_windows::json::str_of(&line, "launch").as_deref(), Some("remote-terminal-shell"));
        assert_eq!(rt_windows::json::bool_of(&line, "ok"), Some(true));
        assert_eq!(rt_windows::json::str_of(&line, "user").as_deref(), Some("OFFICE\\ann"));
        assert_eq!(rt_windows::json::str_of(&line, "cwd").as_deref(), Some("C:\\Users\\ann"));
    }
}
