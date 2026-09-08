//! A pseudoconsole and the shell inside it.
//!
//! WHY THIS IS HERE AND NOT IN NODE. The agent already has node-pty, which
//! does exactly this — but it does it in the agent's own process, which under
//! the service is LocalSystem. A pseudoconsole belongs to whoever created it:
//! conhost stamps the console object with the creator's DACL and integrity
//! level, so a shell running as a signed-in user cannot attach to one that
//! SYSTEM made. The console has to be created *by* the user, which means in a
//! process already running as the user — this one.
//!
//! The plumbing, then:
//!
//! ```text
//!   agent ──stdin (framed)──▶ [ launcher ] ──pipe──▶ ConPTY ──▶ shell
//!   agent ◀──stdout (raw)──── [ launcher ] ◀─pipe── ConPTY ◀──
//! ```
//!
//! Output is copied straight through, byte for byte, so what the phone's
//! emulator sees is what conhost produced.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, GetStdHandle, ResizePseudoConsole, COORD, HPCON, STD_ERROR_HANDLE,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES,
    STARTUPINFOEXW,
};

use crate::frame::{Frame, FrameReader};
use crate::wide::w;

/// How much to move per read. Big enough that a `dir /s` is not a thousand
/// syscalls, small enough that a prompt appears at once.
const CHUNK: usize = 16 * 1024;

/// A handle carried onto another thread. Win32 handles are process-wide and
/// safe to use from any thread; Rust just cannot know that about a raw pointer.
struct Shared(HANDLE);
unsafe impl Send for Shared {}

/// Run `argv` in a pseudoconsole, wired to this process's own stdin and
/// stdout, and return the shell's exit code.
///
/// Blocks until the shell exits. `cwd` empty means "wherever we already are".
pub fn run(argv: &[String], cwd: &str, cols: u16, rows: u16) -> Result<i32, String> {
    if argv.is_empty() {
        return Err("no shell to start".to_string());
    }

    unsafe {
        // Two pipes, and a pseudoconsole holding the far end of each.
        let (in_read, in_write) = pipe()?;
        let (out_read, out_write) = pipe()?;

        let mut hpc: HPCON = 0;
        let size = COORD { X: cols.max(1) as i16, Y: rows.max(1) as i16 };
        let hr = CreatePseudoConsole(size, in_read, out_write, 0, &mut hpc);
        // conhost holds its own duplicates now, so these go back; keeping them
        // would stop the pipes ever reporting that the shell had finished.
        CloseHandle(in_read);
        CloseHandle(out_write);
        if hr < 0 {
            CloseHandle(in_write);
            CloseHandle(out_read);
            return Err(format!("CreatePseudoConsole failed (0x{hr:08x})"));
        }

        let child = match spawn(argv, cwd, hpc) {
            Ok(child) => child,
            Err(err) => {
                ClosePseudoConsole(hpc);
                CloseHandle(in_write);
                CloseHandle(out_read);
                return Err(err);
            }
        };

        // Keystrokes and resizes, on their own thread: reading stdin blocks,
        // and the output must not wait for a key.
        let stop = Arc::new(AtomicBool::new(false));
        {
            let stop = Arc::clone(&stop);
            let to_shell = Shared(in_write);
            // HPCON is a plain integer, so it crosses to the thread as it is.
            std::thread::spawn(move || pump_input(to_shell, hpc, stop));
        }

        // Output, likewise on its own thread: conhost holds the write end open
        // until the pseudoconsole is closed, so a reader on this thread would
        // never come back to notice that the shell had exited.
        let output = {
            let from_shell = Shared(out_read);
            let process = Shared(child.hProcess);
            std::thread::spawn(move || pump_output(from_shell, process))
        };

        WaitForSingleObject(child.hProcess, INFINITE);
        let mut code: u32 = 0;
        GetExitCodeProcess(child.hProcess, &mut code);

        // Closing the pseudoconsole lets conhost flush what the shell left on
        // the screen and then close the pipe, which is what ends the output
        // thread. Wait for it, or the last screenful never reaches the phone.
        stop.store(true, Ordering::SeqCst);
        ClosePseudoConsole(hpc);
        let _ = output.join();

        CloseHandle(in_write);
        CloseHandle(out_read);
        CloseHandle(child.hProcess);
        CloseHandle(child.hThread);
        // The input thread is still blocked reading stdin and only the agent
        // closing it will free it. Exiting does that; do not wait here.

        Ok(code as i32)
    }
}

/// The shell, attached to the pseudoconsole.
///
/// THE STANDARD HANDLES ARE THE WHOLE TRICK. Leaving `STARTF_USESTDHANDLES`
/// off does not mean "this child has no standard handles": Windows copies the
/// parent's, and our parent's are pipes back to the agent. The shell then uses
/// those instead of the console it is attached to — writing past the emulator
/// and reading the agent's framing as keystrokes. It still counts as attached,
/// and `mode con` even reports the right size, so the only symptom is that
/// nothing typed ever arrives. Declaring three null handles is what makes the
/// shell fall back to the pseudoconsole, and it is what node-pty does too.
unsafe fn spawn(argv: &[String], cwd: &str, hpc: HPCON) -> Result<PROCESS_INFORMATION, String> {
    let mut size: usize = 0;
    InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
    // A Vec<u8> is byte-aligned and the attribute list is a struct full of
    // pointers, so allocate it as words.
    let mut attrs = vec![0usize; size.div_ceil(std::mem::size_of::<usize>()).max(1)];
    let list = attrs.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
        return Err(format!("InitializeProcThreadAttributeList failed ({})", last_error()));
    }
    // The pseudoconsole goes in by value: it is a handle, not a pointer to one.
    let ok = UpdateProcThreadAttribute(
        list,
        0,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
        hpc as *const core::ffi::c_void,
        std::mem::size_of::<HPCON>(),
        std::ptr::null_mut(),
        std::ptr::null(),
    );
    if ok == 0 {
        let err = last_error();
        DeleteProcThreadAttributeList(list);
        return Err(format!("UpdateProcThreadAttribute failed ({err})"));
    }

    let mut si: STARTUPINFOEXW = std::mem::zeroed();
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList = list;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = std::ptr::null_mut();
    si.StartupInfo.hStdOutput = std::ptr::null_mut();
    si.StartupInfo.hStdError = std::ptr::null_mut();

    let mut command = w(crate::cmdline::join(argv));
    let dir = w(cwd);
    let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
    let started = CreateProcessW(
        std::ptr::null(),
        command.as_mut_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        0, // and nothing is inherited either way
        EXTENDED_STARTUPINFO_PRESENT,
        std::ptr::null(),
        if cwd.is_empty() { std::ptr::null() } else { dir.as_ptr() },
        &si as *const _ as *const _,
        &mut pi,
    );
    let err = last_error();
    DeleteProcThreadAttributeList(list);
    if started == 0 {
        return Err(format!("cannot start {}: CreateProcessW failed ({err})", argv[0]));
    }
    Ok(pi)
}

/// Copy the console's output to our stdout until conhost closes the pipe.
fn pump_output(from_shell: Shared, process: Shared) {
    unsafe {
        let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
        let mut buf = [0u8; CHUNK];
        loop {
            let mut read = 0u32;
            let ok = ReadFile(from_shell.0, buf.as_mut_ptr(), CHUNK as u32, &mut read, std::ptr::null_mut());
            if ok == 0 || read == 0 {
                return;
            }
            if !write_all(stdout, &buf[..read as usize]) {
                // The agent is gone. Take the shell with it rather than leave
                // it writing into a closed pipe.
                TerminateProcess(process.0, 1);
                return;
            }
        }
    }
}

/// Read framed stdin; write the payloads into the console and act on resizes.
fn pump_input(to_shell: Shared, console: HPCON, stop: Arc<AtomicBool>) {
    unsafe {
        let stdin = GetStdHandle(STD_INPUT_HANDLE);
        let mut reader = FrameReader::new();
        let mut buf = [0u8; CHUNK];
        while !stop.load(Ordering::SeqCst) {
            let mut read = 0u32;
            let ok = ReadFile(stdin, buf.as_mut_ptr(), CHUNK as u32, &mut read, std::ptr::null_mut());
            if ok == 0 || read == 0 {
                break; // the agent closed our stdin
            }
            reader.push(&buf[..read as usize]);
            loop {
                match reader.next() {
                    Some(Frame::Data(bytes)) => {
                        if !write_all(to_shell.0, &bytes) {
                            return;
                        }
                    }
                    Some(Frame::Resize(cols, rows)) => {
                        let size = COORD { X: cols.max(1) as i16, Y: rows.max(1) as i16 };
                        ResizePseudoConsole(console, size);
                    }
                    Some(Frame::Corrupt(why)) => {
                        eprintln!(
                            "{{\"launch\":\"remote-terminal-shell\",\"ok\":false,\"error\":\"input out of sync: {why}\"}}"
                        );
                        return;
                    }
                    None => break,
                }
            }
        }
    }
}

unsafe fn pipe() -> Result<(HANDLE, HANDLE), String> {
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    if CreatePipe(&mut read, &mut write, std::ptr::null(), 0) == 0 {
        return Err(format!("CreatePipe failed ({})", last_error()));
    }
    Ok((read, write))
}

unsafe fn write_all(handle: HANDLE, mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        let mut written = 0u32;
        let ok = WriteFile(handle, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut());
        if ok == 0 || written == 0 {
            return false;
        }
        bytes = &bytes[written as usize..];
    }
    true
}

/// Make this process's standard handles inheritable and hand back what a child
/// should be given. Used when the launcher passes its own stdio on to a copy of
/// itself running as the signed-in user — the one child that is meant to have
/// them.
pub fn inheritable_stdio() -> (HANDLE, HANDLE, HANDLE) {
    unsafe {
        let handles = [
            GetStdHandle(STD_INPUT_HANDLE),
            GetStdHandle(STD_OUTPUT_HANDLE),
            GetStdHandle(STD_ERROR_HANDLE),
        ];
        for h in handles {
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            }
        }
        (handles[0], handles[1], handles[2])
    }
}

/// Wait for a process and give back its exit code.
pub fn wait_for(process: HANDLE) -> i32 {
    unsafe {
        if WaitForSingleObject(process, INFINITE) != WAIT_OBJECT_0 {
            return -1;
        }
        let mut code: u32 = 0;
        GetExitCodeProcess(process, &mut code);
        code as i32
    }
}

fn last_error() -> u32 {
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}
