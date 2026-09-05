//! The platform things a terminal client needs and a web view cannot do:
//! reading files and images off the clipboard, loading a picked file for
//! upload, keeping the display awake, and the app lock.

use base64::Engine;
use serde::Serialize;

/// Matches the agent's default upload cap; anything larger is refused before
/// a byte reaches the relay.
const MAX_UPLOAD_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFile {
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// base64 of the file's bytes, chunked and framed by the frontend.
    pub data: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContents {
    pub text: String,
    /// Paths of files on the clipboard, if any (Explorer copy).
    pub files: Vec<String>,
    /// True when the clipboard holds a bitmap we can turn into a file.
    pub has_image: bool,
}

/* -------------------------------- files -------------------------------- */

/// Read a file for upload into a session. Refuses anything over the agent's
/// cap rather than streaming bytes that will be rejected at the far end.
#[tauri::command]
pub async fn read_file_for_upload(path: String) -> Result<LoadedFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| format!("{e}"))?;
        if !meta.is_file() {
            return Err("not a file".to_string());
        }
        if meta.len() > MAX_UPLOAD_BYTES {
            return Err(format!(
                "File is larger than {} MiB.",
                MAX_UPLOAD_BYTES / (1024 * 1024)
            ));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("{e}"))?;
        let name = std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let mime = mime_for(&name);
        Ok(LoadedFile {
            size: bytes.len() as u64,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            name,
            mime,
        })
    })
    .await
    .map_err(|e| format!("{e}"))?
}

/// Enough of a type map for the agent's advisory `mime` field; the agent never
/// executes what it stores, so a wrong guess costs nothing but a label.
fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "json" => "application/json",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "sh" | "bash" => "text/x-shellscript",
        "ps1" => "text/plain",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

/* ------------------------------ clipboard ------------------------------ */

#[tauri::command]
pub fn clipboard_read() -> Result<ClipboardContents, String> {
    #[cfg(windows)]
    {
        win_clipboard::read()
    }
    #[cfg(not(windows))]
    {
        Ok(ClipboardContents::default())
    }
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        win_clipboard::write_text(&text)
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Ok(())
    }
}

/// The clipboard bitmap as a file ready to upload: a PNG when the source app
/// offered one, otherwise the DIB wrapped as a BMP. Either is a real file the
/// machine can open, which is the point — nothing is re-encoded or guessed at.
#[tauri::command]
pub fn clipboard_read_image() -> Result<Option<LoadedFile>, String> {
    #[cfg(windows)]
    {
        let found = win_clipboard::read_image()?;
        Ok(found.map(|(name, mime, bytes)| LoadedFile {
            name,
            mime,
            size: bytes.len() as u64,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        }))
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/* ----------------------------- keep awake ------------------------------ */

/// Hold the display awake while a terminal is open ("Keep screen on").
#[tauri::command]
pub fn set_keep_awake(enabled: bool) {
    #[cfg(windows)]
    {
        // SetThreadExecutionState is per-thread, so the request has to be made
        // and released on one long-lived thread rather than a pool worker.
        keep_awake_thread().send(enabled);
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
    }
}

#[cfg(windows)]
struct KeepAwake {
    tx: std::sync::mpsc::Sender<bool>,
}

#[cfg(windows)]
impl KeepAwake {
    fn send(&self, enabled: bool) {
        let _ = self.tx.send(enabled);
    }
}

#[cfg(windows)]
fn keep_awake_thread() -> &'static KeepAwake {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };

    static INSTANCE: OnceLock<KeepAwake> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                let mut held = false;
                while let Ok(enabled) = rx.recv() {
                    if enabled == held {
                        continue;
                    }
                    held = enabled;
                    unsafe {
                        if enabled {
                            SetThreadExecutionState(
                                ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                            );
                        } else {
                            SetThreadExecutionState(ES_CONTINUOUS);
                        }
                    }
                }
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            })
            .ok();
        KeepAwake { tx }
    })
}

/* ------------------------------ app lock ------------------------------- */

/// Whether this machine can ask for a credential at all (Windows Hello, or the
/// account password behind it). When it cannot, the app-lock setting turns
/// itself off rather than pretending to protect anything.
#[tauri::command]
pub fn app_lock_available() -> bool {
    #[cfg(windows)]
    {
        use windows::Security::Credentials::UI::{
            UserConsentVerifier, UserConsentVerifierAvailability,
        };
        match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()) {
            Ok(UserConsentVerifierAvailability::Available) => true,
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Ask for the device credential. Returns true only on an explicit success.
#[tauri::command]
pub async fn app_lock_prompt(window: tauri::WebviewWindow, message: String) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| format!("{e}"))?;
        let raw = hwnd.0 as isize;
        tauri::async_runtime::spawn_blocking(move || win_consent::prompt(raw, &message))
            .await
            .map_err(|e| format!("{e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, message);
        Ok(true)
    }
}

#[cfg(windows)]
mod win_consent {
    use windows::core::HSTRING;
    use windows::Foundation::IAsyncOperation;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

    /// A Win32 window has to hand its HWND to the verifier; the plain WinRT
    /// entry point only works for packaged apps.
    pub fn prompt(hwnd: isize, message: &str) -> Result<bool, String> {
        let interop: IUserConsentVerifierInterop =
            windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .map_err(|e| format!("{e}"))?;
        let text = HSTRING::from(message);
        let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop
                .RequestVerificationForWindowAsync(HWND(hwnd as _), &text)
                .map_err(|e| format!("{e}"))?
        };
        let result = operation.get().map_err(|e| format!("{e}"))?;
        Ok(result == UserConsentVerificationResult::Verified)
    }
}

/* -------------------------- Windows clipboard -------------------------- */

#[cfg(windows)]
mod win_clipboard {
    use super::ClipboardContents;
    use windows_sys::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    const CF_DIB: u32 = 8;
    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;

    /// The clipboard is a global lock; hold it for as short a time as possible
    /// and always release it, including on an early return.
    struct Guard;

    impl Guard {
        fn open() -> Result<Guard, String> {
            // Another app may be mid-update; a couple of retries is standard.
            for _ in 0..8 {
                if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                    return Ok(Guard);
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err("the clipboard is busy".into())
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    fn available(format: u32) -> bool {
        unsafe { IsClipboardFormatAvailable(format) != 0 }
    }

    unsafe fn locked_bytes(handle: HANDLE) -> Option<Vec<u8>> {
        if handle.is_null() {
            return None;
        }
        let size = GlobalSize(handle as HGLOBAL);
        let ptr = GlobalLock(handle as HGLOBAL) as *const u8;
        if ptr.is_null() || size == 0 {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        GlobalUnlock(handle as HGLOBAL);
        Some(bytes)
    }

    pub fn read() -> Result<ClipboardContents, String> {
        let _guard = Guard::open()?;
        let mut out = ClipboardContents::default();

        if available(CF_UNICODETEXT) {
            unsafe {
                let handle = GetClipboardData(CF_UNICODETEXT);
                if !handle.is_null() {
                    let ptr = GlobalLock(handle as HGLOBAL) as *const u16;
                    if !ptr.is_null() {
                        let mut len = 0usize;
                        while *ptr.add(len) != 0 {
                            len += 1;
                        }
                        out.text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                        GlobalUnlock(handle as HGLOBAL);
                    }
                }
            }
        }

        if available(CF_HDROP) {
            unsafe {
                let handle = GetClipboardData(CF_HDROP);
                if !handle.is_null() {
                    let count = DragQueryFileW(handle as _, u32::MAX, std::ptr::null_mut(), 0);
                    for i in 0..count {
                        let needed = DragQueryFileW(handle as _, i, std::ptr::null_mut(), 0);
                        if needed == 0 {
                            continue;
                        }
                        let mut buffer = vec![0u16; needed as usize + 1];
                        let written =
                            DragQueryFileW(handle as _, i, buffer.as_mut_ptr(), buffer.len() as u32);
                        if written > 0 {
                            out.files
                                .push(String::from_utf16_lossy(&buffer[..written as usize]));
                        }
                    }
                }
            }
        }

        out.has_image = available(CF_DIB) || available(png_format());
        Ok(out)
    }

    fn png_format() -> u32 {
        let name: Vec<u16> = "PNG\0".encode_utf16().collect();
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }

    /// A PNG when the source app offered one; otherwise the device-independent
    /// bitmap with a file header in front of it, which is a valid `.bmp`.
    pub fn read_image() -> Result<Option<(String, String, Vec<u8>)>, String> {
        let _guard = Guard::open()?;
        let stamp = timestamp();

        let png = png_format();
        if png != 0 && available(png) {
            unsafe {
                if let Some(bytes) = locked_bytes(GetClipboardData(png)) {
                    if !bytes.is_empty() {
                        return Ok(Some((
                            format!("pasted-{stamp}.png"),
                            "image/png".into(),
                            bytes,
                        )));
                    }
                }
            }
        }

        if available(CF_DIB) {
            unsafe {
                if let Some(dib) = locked_bytes(GetClipboardData(CF_DIB)) {
                    if let Some(bmp) = dib_to_bmp(&dib) {
                        return Ok(Some((
                            format!("pasted-{stamp}.bmp"),
                            "image/bmp".into(),
                            bmp,
                        )));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Prefix a BITMAPFILEHEADER so the DIB on the clipboard becomes a file.
    /// The pixel offset is the header size plus the colour table, which for a
    /// BITMAPINFOHEADER is either `biClrUsed` entries or, for a bitfields
    /// bitmap, three masks.
    fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
        if dib.len() < 40 {
            return None;
        }
        let read_u32 = |at: usize| -> u32 {
            u32::from_le_bytes([dib[at], dib[at + 1], dib[at + 2], dib[at + 3]])
        };
        let header_size = read_u32(0) as usize;
        if header_size < 40 || header_size > dib.len() {
            return None;
        }
        let bit_count = u16::from_le_bytes([dib[14], dib[15]]) as u32;
        let compression = read_u32(16);
        let clr_used = read_u32(32) as usize;

        let palette_bytes = if bit_count <= 8 {
            let entries = if clr_used > 0 { clr_used } else { 1usize << bit_count };
            entries * 4
        } else if compression == 3 {
            // BI_BITFIELDS: three DWORD masks follow the header.
            12
        } else {
            0
        };

        let offset = 14 + header_size + palette_bytes;
        if offset > 14 + dib.len() {
            return None;
        }
        let total = 14 + dib.len();
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(dib);
        Some(out)
    }

    fn timestamp() -> String {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{secs}")
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        let _guard = Guard::open()?;
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide.len() * 2;
        unsafe {
            if EmptyClipboard() == 0 {
                return Err("could not take the clipboard".into());
            }
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if handle.is_null() {
                return Err("out of memory".into());
            }
            let ptr = GlobalLock(handle) as *mut u16;
            if ptr.is_null() {
                return Err("could not lock the clipboard buffer".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            GlobalUnlock(handle);
            if SetClipboardData(CF_UNICODETEXT, handle as HANDLE).is_null() {
                return Err("the clipboard refused the text".into());
            }
        }
        Ok(())
    }
}
