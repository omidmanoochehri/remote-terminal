#![windows_subsystem = "windows"]

//! Remote Terminal agent — tray icon.
//!
//! A window-less program in the interactive session that shows whether the
//! machine is reachable from the phone, and does the four things a person
//! actually wants from a tray icon: get a pairing code, force a reconnect,
//! open the log, and start or stop the service.
//!
//! It never hosts a terminal and never talks to the relay. Everything it knows
//! comes from the agent's control pipe, so the tray can be closed, crash or
//! never be started at all without affecting a single session.
//!
//! Run with `--pair` to print a pairing code and exit; the tray relaunches
//! itself that way, elevated, when the signed-in user cannot read the control
//! key (`control.key` is readable by SYSTEM and administrators only, because
//! a pairing code is enough to get a shell on this machine).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rt_windows::control::{self, ControlError, Status};
use rt_windows::settings::{exe_dir, Settings};
use rt_windows::wide::{fill, w};
use rt_windows::{DISPLAY_NAME, PIPE_NAME, VERSION};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateBitmap, CreateDIBSection, DeleteObject, GetDC, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, ShellExecuteW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIIF_WARNING, NIM_ADD,
    NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

/* --------------------------------- state ---------------------------------- */

const WM_TRAY: u32 = WM_APP + 1;
const TIMER_POLL: usize = 1;
const POLL_MS: u32 = 3000;

const ID_HEADER: usize = 1;
const ID_STATUS: usize = 2;
const ID_PAIR: usize = 10;
const ID_RECONNECT: usize = 11;
const ID_LOG: usize = 20;
const ID_LOG_FOLDER: usize = 21;
const ID_CONFIG: usize = 22;
const ID_SERVICE_START: usize = 30;
const ID_SERVICE_STOP: usize = 31;
const ID_SERVICE_RESTART: usize = 32;
const ID_ABOUT: usize = 40;
const ID_EXIT: usize = 41;

/// What the icon's dot means. Colours are 0x00RRGGBB.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Health {
    Connected,
    Connecting,
    Offline,
    Stopped,
}

impl Health {
    fn colour(self) -> u32 {
        match self {
            Health::Connected => 0x33_C4_6B,  // green
            Health::Connecting => 0xE8_A3_3D, // amber
            Health::Offline => 0xD9_3A_3A,    // red
            Health::Stopped => 0x8A_8A_8A,    // grey
        }
    }

    fn of(status: &Result<Status, ControlError>) -> Health {
        match status {
            Ok(s) if s.registered => Health::Connected,
            Ok(s) if s.connected => Health::Connecting,
            Ok(_) => Health::Offline,
            Err(ControlError::NotRunning) => Health::Stopped,
            Err(_) => Health::Offline,
        }
    }
}

struct Tray {
    hwnd: HWND,
    icon: HICON,
    health: Health,
    status: Result<Status, ControlError>,
    settings: Option<Settings>,
    /// Suppresses the "went offline" balloon during the first poll and while
    /// the service is deliberately being restarted from this menu.
    announced: bool,
}

static QUITTING: AtomicBool = AtomicBool::new(false);
static mut TRAY: Option<Box<Tray>> = None;

fn tray() -> Option<&'static mut Tray> {
    // Single-threaded: every access happens on the message loop's thread.
    unsafe { (*std::ptr::addr_of_mut!(TRAY)).as_deref_mut() }
}

/* ---------------------------------- main ---------------------------------- */

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--pair") {
        std::process::exit(pair_dialog());
    }
    if args.iter().any(|a| a == "--version") {
        message(&format!("Remote Terminal tray {VERSION}"), "Remote Terminal", MB_ICONINFORMATION);
        return;
    }

    if already_running() {
        // A second tray icon for the same agent would only confuse; the first
        // one is already showing everything this one would.
        return;
    }

    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let class = w("RemoteTerminalTray");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);

        // A message-only window: it exists to receive the tray callback and
        // to own the popup menu, and is never shown.
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            w(DISPLAY_NAME).as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }

        let status = control::status_either();
        let health = Health::of(&status);
        let icon = make_icon(health.colour());
        TRAY = Some(Box::new(Tray {
            hwnd,
            icon,
            health,
            status,
            settings: Settings::load().ok(),
            announced: false,
        }));

        add_icon();
        refresh(false);
        SetTimer(hwnd, TIMER_POLL, POLL_MS, None);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        remove_icon();
    }
}

/// One tray icon per session is enough; a named event would need more Win32
/// than finding our own window class does.
fn already_running() -> bool {
    unsafe { !FindWindowW(w("RemoteTerminalTray").as_ptr(), std::ptr::null()).is_null() }
}

/* ------------------------------ window procedure -------------------------- */

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            match lparam as u32 {
                WM_RBUTTONUP | WM_CONTEXTMENU => show_menu(hwnd),
                WM_LBUTTONDBLCLK => on_command(ID_LOG),
                WM_LBUTTONUP => show_menu(hwnd),
                _ => {}
            }
            0
        }
        WM_TIMER => {
            if wparam == TIMER_POLL {
                refresh(true);
            }
            0
        }
        WM_COMMAND => {
            on_command((wparam & 0xffff) as usize);
            0
        }
        WM_DESTROY => {
            remove_icon();
            PostQuitMessage(0);
            0
        }
        // Explorer restarting takes every tray icon with it; put ours back.
        _ if msg == taskbar_created() => {
            add_icon();
            refresh(false);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn taskbar_created() -> u32 {
    static mut CACHED: u32 = 0;
    unsafe {
        let slot = &mut *std::ptr::addr_of_mut!(CACHED);
        if *slot == 0 {
            *slot = RegisterWindowMessageW(w("TaskbarCreated").as_ptr());
        }
        *slot
    }
}

/* ------------------------------- the icon --------------------------------- */

fn notify_data(t: &Tray) -> NOTIFYICONDATAW {
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = t.hwnd;
    data.uID = 1;
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    data.uCallbackMessage = WM_TRAY;
    data.hIcon = t.icon;
    data
}

fn add_icon() {
    let Some(t) = tray() else { return };
    let mut data = notify_data(t);
    fill(&mut data.szTip, DISPLAY_NAME);
    unsafe { Shell_NotifyIconW(NIM_ADD, &data) };
}

fn remove_icon() {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(t) = tray() else { return };
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = t.hwnd;
    data.uID = 1;
    unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
}

/// Poll the agent and update the icon, its tooltip, and — when the machine
/// changes between reachable and not — a balloon, because that is the one
/// state change worth interrupting someone for.
fn refresh(announce: bool) {
    let Some(t) = tray() else { return };
    let status = control::status_either();
    let health = Health::of(&status);
    let changed = health != t.health;

    if changed {
        let old = std::mem::replace(&mut t.icon, make_icon(health.colour()));
        t.health = health;
        unsafe { DestroyIcon(old) };
    }
    t.status = status;

    let tip = match &t.status {
        Ok(s) if !s.name.is_empty() => format!("{} — {}", s.name, s.headline()),
        Ok(s) => format!("{DISPLAY_NAME} — {}", s.headline()),
        Err(ControlError::NotRunning) => format!("{DISPLAY_NAME} — service not running"),
        Err(e) => format!("{DISPLAY_NAME} — {e}"),
    };

    let mut data = notify_data(t);
    fill(&mut data.szTip, &tip);
    if announce && changed && t.announced {
        data.uFlags |= NIF_INFO;
        data.dwInfoFlags = if health == Health::Connected { NIIF_INFO } else { NIIF_WARNING };
        fill(&mut data.szInfoTitle, DISPLAY_NAME);
        fill(
            &mut data.szInfo,
            match health {
                Health::Connected => "This machine is reachable from your phone.",
                Health::Connecting => "Reconnecting to the relay…",
                Health::Offline => "This machine is offline: the relay cannot be reached.",
                Health::Stopped => "The Remote Terminal service is not running.",
            },
        );
    }
    t.announced = true;
    unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) };
}

/// The app logo, 32×32, top-down BGRA with straight alpha (the byte order of a
/// little-endian 0xAARRGGBB word). Generated from the app icon.
const LOGO: &[u8; 32 * 32 * 4] = include_bytes!("tray-logo.bgra");

/// The 32×32 app logo with a status dot drawn over it.
///
/// Drawing the dot beats shipping four .ico files: the colour is the state, so
/// the icon and the thing it reports can never disagree, and there is no
/// resource compiler in the build.
fn make_icon(dot: u32) -> HICON {
    const N: i32 = 32;
    let mut pixels: Vec<u32> = LOGO
        .chunks_exact(4)
        .map(|p| u32::from_le_bytes([p[0], p[1], p[2], p[3]]))
        .collect();
    let px = |buf: &mut Vec<u32>, x: i32, y: i32, argb: u32| {
        if (0..N).contains(&x) && (0..N).contains(&y) {
            buf[(y * N + x) as usize] = argb;
        }
    };
    // The status dot, bottom-right, with a dark ring so it reads on any taskbar.
    let (cx, cy) = (24, 24);
    let colour = 0xFF00_0000 | dot;
    for y in cy - 8..=cy + 8 {
        for x in cx - 8..=cx + 8 {
            let d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            if d2 <= 36 {
                px(&mut pixels, x, y, colour);
            } else if d2 <= 56 {
                px(&mut pixels, x, y, 0xFF_10_10_14);
            }
        }
    }

    unsafe {
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: N,
            biHeight: -N, // top-down, so row 0 is the top
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let dc = GetDC(std::ptr::null_mut());
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let colour_bmp: HBITMAP = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        ReleaseDC(std::ptr::null_mut(), dc);
        if colour_bmp.is_null() || bits.is_null() {
            return std::ptr::null_mut();
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u32, pixels.len());

        // A 32-bit icon still needs a mask bitmap; the alpha channel decides
        // what shows, so an all-zero mask is right.
        let mask: HBITMAP = CreateBitmap(N, N, 1, 1, std::ptr::null());
        let icon_info = ICONINFO {
            fIcon: 1,
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: colour_bmp,
        };
        let icon = CreateIconIndirect(&icon_info);
        DeleteObject(colour_bmp as _);
        DeleteObject(mask as _);
        icon
    }
}

/* --------------------------------- menu ----------------------------------- */

fn show_menu(hwnd: HWND) {
    let Some(t) = tray() else { return };
    unsafe {
        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }
        let name = match &t.status {
            Ok(s) if !s.name.is_empty() => s.name.clone(),
            _ => DISPLAY_NAME.to_string(),
        };
        let line = match &t.status {
            Ok(s) => s.headline(),
            Err(ControlError::NotRunning) => "The service is not running".to_string(),
            Err(e) => e.to_string(),
        };
        let running = t.status.is_ok();

        AppendMenuW(menu, MF_STRING | MF_GRAYED, ID_HEADER, w(&name).as_ptr());
        AppendMenuW(menu, MF_STRING | MF_GRAYED, ID_STATUS, w(&format!("   {line}")).as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(
            menu,
            MF_STRING | if running { 0 } else { MF_GRAYED },
            ID_PAIR,
            w("&Pair a phone…").as_ptr(),
        );
        AppendMenuW(
            menu,
            MF_STRING | if running { 0 } else { MF_GRAYED },
            ID_RECONNECT,
            w("&Reconnect now").as_ptr(),
        );
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(menu, MF_STRING, ID_LOG, w("Open &log").as_ptr());
        AppendMenuW(menu, MF_STRING, ID_LOG_FOLDER, w("Open log &folder").as_ptr());
        AppendMenuW(menu, MF_STRING, ID_CONFIG, w("Open &configuration").as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        if running {
            AppendMenuW(menu, MF_STRING, ID_SERVICE_RESTART, w("Res&tart the service").as_ptr());
            AppendMenuW(menu, MF_STRING, ID_SERVICE_STOP, w("St&op the service").as_ptr());
        } else {
            AppendMenuW(menu, MF_STRING, ID_SERVICE_START, w("&Start the service").as_ptr());
        }
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(menu, MF_STRING, ID_ABOUT, w("&About").as_ptr());
        AppendMenuW(menu, MF_STRING, ID_EXIT, w("&Hide this icon").as_ptr());

        let mut pt: POINT = std::mem::zeroed();
        GetCursorPos(&mut pt);
        // Required so the menu closes when the user clicks away from it.
        SetForegroundWindow(hwnd);
        let chosen = TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
            pt.x,
            pt.y,
            0,
            hwnd,
            std::ptr::null(),
        );
        DestroyMenu(menu);
        if chosen > 0 {
            on_command(chosen as usize);
        }
    }
}

fn on_command(id: usize) {
    let Some(t) = tray() else { return };
    match id {
        ID_PAIR => {
            let data = t.settings.as_ref().map(|s| s.data.clone());
            match data.as_deref().and_then(control::read_key) {
                Some(key) => show_pair_code(&key),
                // Only administrators can read the control key, by design.
                // Ask Windows to run this same program elevated instead.
                None => elevate_self("--pair"),
            }
        }
        ID_RECONNECT => match control::reconnect_either() {
            Ok(()) => balloon("Reconnecting", "Asked the agent to reconnect to the relay."),
            Err(e) => message(&format!("Could not reach the agent.\n\n{e}"), "Reconnect", MB_ICONWARNING),
        },
        ID_LOG => open_path(t.settings.as_ref().map(|s| s.agent_log())),
        ID_LOG_FOLDER => open_path(t.settings.as_ref().map(|s| s.log.clone())),
        ID_CONFIG => open_path(t.settings.as_ref().map(|s| s.config_json())),
        ID_SERVICE_START => service_command("start"),
        ID_SERVICE_STOP => service_command("stop"),
        ID_SERVICE_RESTART => service_command("restart"),
        ID_ABOUT => about(t),
        ID_EXIT => unsafe {
            DestroyWindow(t.hwnd);
        },
        _ => {}
    }
}

fn about(t: &Tray) {
    let agent = match &t.status {
        Ok(s) => format!("Agent {} (pid {}), up {}h", s.version, s.pid, s.uptime_sec / 3600),
        Err(e) => format!("Agent: {e}"),
    };
    let log = t
        .settings
        .as_ref()
        .map(|s| s.agent_log().display().to_string())
        .unwrap_or_else(|| "not configured".into());
    message(
        &format!("Remote Terminal tray {VERSION}\n{agent}\n\nLog: {log}\n\nClosing this icon does not stop the service."),
        "About Remote Terminal",
        MB_ICONINFORMATION,
    );
}

/* -------------------------------- actions --------------------------------- */

fn show_pair_code(key: &str) {
    match control::pair(PIPE_NAME, key) {
        Ok(p) => {
            copy_to_clipboard(&p.code);
            message(
                &format!(
                    "Pairing code:  {}\n\nRelay:  {}\nValid for {} minutes, once.\n\nThe code is on the clipboard. In the app: Machines → Pair.",
                    p.code,
                    p.relay_url,
                    (p.ttl_sec / 60).max(1)
                ),
                "Pair a phone",
                MB_ICONINFORMATION,
            );
        }
        Err(e) => message(&format!("Could not create a pairing code.\n\n{e}"), "Pair a phone", MB_ICONWARNING),
    }
}

/// `--pair`, used by the elevated relaunch: read the key as an administrator,
/// show the code, and exit.
fn pair_dialog() -> i32 {
    let Ok(settings) = Settings::load() else {
        message(
            "This machine has no Remote Terminal service installed.",
            "Pair a phone",
            MB_ICONWARNING,
        );
        return 1;
    };
    match control::read_key(&settings.data) {
        Some(key) => {
            show_pair_code(&key);
            0
        }
        None => {
            message(
                &format!(
                    "Cannot read the control key in {}.\n\nRun this from an account with administrator rights.",
                    settings.data.display()
                ),
                "Pair a phone",
                MB_ICONWARNING,
            );
            1
        }
    }
}

/// Re-run this program elevated. Windows shows the consent prompt; if the user
/// declines, nothing happens, which is the correct outcome.
fn elevate_self(arg: &str) {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("remote-terminal-tray.exe"));
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w("runas").as_ptr(),
            w(&exe).as_ptr(),
            w(arg).as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL as i32,
        );
    }
}

/// Starting and stopping a service needs elevation, so hand it to the service
/// binary through the same consent prompt.
fn service_command(verb: &str) {
    let exe = exe_dir().join("remote-terminal-service.exe");
    if !exe.is_file() {
        message(
            &format!("remote-terminal-service.exe is not next to this program ({}).", exe_dir().display()),
            DISPLAY_NAME,
            MB_ICONWARNING,
        );
        return;
    }
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w("runas").as_ptr(),
            w(&exe).as_ptr(),
            w(verb).as_ptr(),
            std::ptr::null(),
            // Hidden: the service binary prints to a console nobody is looking
            // at. Which means nothing it says reaches the user, so whether it
            // worked has to be decided here, from the agent itself.
            SW_HIDE as i32,
        );
    }

    let want_running = verb != "stop";
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut reached = false;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(400));
        if control::status_either().is_ok() == want_running {
            reached = true;
            break;
        }
    }

    if let Some(t) = tray() {
        t.announced = false; // the change was asked for; do not announce it
    }
    refresh(false);

    if !reached {
        // Either the consent prompt was declined, or the service is not
        // installed, or the agent is failing to start. Only the log can say
        // which, so point at it rather than guess.
        let log = tray()
            .and_then(|t| t.settings.as_ref().map(|s| s.agent_log().display().to_string()))
            .unwrap_or_else(|| "the service log".into());
        message(
            &format!(
                "The service did not {verb}.\n\nEither the administrator prompt was declined, or it is failing to start.\n\n{log}"
            ),
            DISPLAY_NAME,
            MB_ICONWARNING,
        );
    }
}

fn open_path(path: Option<PathBuf>) {
    let Some(path) = path else {
        message("This machine has no Remote Terminal service installed.", DISPLAY_NAME, MB_ICONWARNING);
        return;
    };
    if !path.exists() {
        message(
            &format!("{} does not exist yet.", path.display()),
            DISPLAY_NAME,
            MB_ICONINFORMATION,
        );
        return;
    }
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w("open").as_ptr(),
            w(&path).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL as i32,
        );
    }
}

/* --------------------------------- Win32 ---------------------------------- */

fn message(text: &str, title: &str, icon: MESSAGEBOX_STYLE) {
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            w(text).as_ptr(),
            w(title).as_ptr(),
            MB_OK | MB_SETFOREGROUND | icon,
        );
    }
}

fn balloon(title: &str, text: &str) {
    let Some(t) = tray() else { return };
    let mut data = notify_data(t);
    data.uFlags |= NIF_INFO;
    data.dwInfoFlags = NIIF_INFO;
    fill(&mut data.szInfoTitle, title);
    fill(&mut data.szInfo, text);
    unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) };
}

fn copy_to_clipboard(text: &str) {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    const CF_UNICODETEXT: u32 = 13;

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return;
        }
        EmptyClipboard();
        let bytes = wide.len() * 2;
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if !handle.is_null() {
            let dst = GlobalLock(handle);
            if !dst.is_null() {
                std::ptr::copy_nonoverlapping(wide.as_ptr(), dst as *mut u16, wide.len());
                GlobalUnlock(handle);
                // The clipboard owns the memory now; do not free it.
                SetClipboardData(CF_UNICODETEXT, handle as _);
            }
        }
        CloseClipboard();
    }
}
