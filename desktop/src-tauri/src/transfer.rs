//! Local files for the file browser's transfers, and opening links.
//!
//! A download from a machine arrives as base64 slices of at most 192 KiB and is
//! written straight to the file the user chose, one slice at a time, so a large
//! file never has to sit whole in the web view's memory. An upload is the same
//! thing in reverse: the frontend asks for the next slice of the picked file.
//!
//! Links found in terminal output open in the default browser — http, https
//! and ftp only. Anything else (a `file:` link from a remote machine names a
//! file on *that* machine, not this one) is refused here as well as in the
//! frontend.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};

use base64::Engine;
use serde::Serialize;

/// The largest slice either direction moves at once: 192 KiB raw, 256 KiB of
/// base64, comfortably inside the relay's 1 MiB frame.
const MAX_SLICE: u64 = 192 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileInfo {
    pub name: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSlice {
    pub data: String,
    pub size: u64,
    pub eof: bool,
}

fn err(e: impl std::fmt::Display) -> String {
    format!("{e}")
}

/// Name and size of a file picked (or dropped) for upload.
#[tauri::command]
pub fn local_file_info(path: String) -> Result<LocalFileInfo, String> {
    let meta = std::fs::metadata(&path).map_err(err)?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    Ok(LocalFileInfo { name, size: meta.len() })
}

/// One slice of a local file, base64.
#[tauri::command]
pub async fn local_file_read(path: String, offset: u64, length: u64) -> Result<LocalSlice, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path).map_err(err)?;
        let size = file.metadata().map_err(err)?.len();
        let want = length.min(MAX_SLICE).min(size.saturating_sub(offset));
        let mut buf = vec![0u8; want as usize];
        if want > 0 {
            file.seek(SeekFrom::Start(offset)).map_err(err)?;
            file.read_exact(&mut buf).map_err(err)?;
        }
        Ok(LocalSlice {
            data: base64::engine::general_purpose::STANDARD.encode(&buf),
            size,
            eof: offset + want >= size,
        })
    })
    .await
    .map_err(err)?
}

/// Write one slice of a download. Offset 0 creates (or truncates) the file;
/// every later slice must start exactly where the file ends, so a slice lost
/// or repeated is an error rather than a silently corrupt file.
#[tauri::command]
pub async fn local_file_write(path: String, offset: u64, data: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(err)?;
        let mut file = if offset == 0 {
            OpenOptions::new().create(true).write(true).truncate(true).open(&path).map_err(err)?
        } else {
            let file = OpenOptions::new().append(true).open(&path).map_err(err)?;
            let have = file.metadata().map_err(err)?.len();
            if have != offset {
                return Err(format!("slice at {offset} does not continue the file (have {have})"));
            }
            file
        };
        file.write_all(&bytes).map_err(err)?;
        Ok(offset + bytes.len() as u64)
    })
    .await
    .map_err(err)?
}

/// Drop what a cancelled or failed download left behind.
#[tauri::command]
pub fn local_file_remove(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(e)),
    }
}

/// Only these reach the browser; see the module comment.
fn openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("ftp://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Open a link in the default browser.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !openable(&url) {
        return Err("only http, https and ftp links can be opened".into());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let verb = wide("open");
        let target = wide(&url);
        // SW_SHOWNORMAL; anything above 32 is success.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result as isize <= 32 {
            return Err(format!("the link could not be opened ({})", result as isize));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::openable;

    #[test]
    fn only_web_links_open() {
        assert!(openable("https://example.com/a?b=c"));
        assert!(openable("HTTP://example.com"));
        assert!(openable("ftp://files.example.com/x"));
        assert!(!openable("file:///C:/Windows/system32/calc.exe"));
        assert!(!openable("javascript:alert(1)"));
        assert!(!openable("https://example.com/a b"));
        assert!(!openable("ms-settings:"));
    }
}
