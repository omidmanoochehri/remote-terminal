//! On-disk state: user settings, the cached machine list, and the long-lived
//! relay credentials.
//!
//! The device token is the one secret here. On Windows it is sealed with DPAPI
//! under the current user account — the desktop equivalent of the Android
//! Keystore wrapping in `CredentialStore.kt`: the file on disk holds only
//! ciphertext, and another user account cannot read it. A blob that no longer
//! decrypts (a restored profile, a new machine) reports "not paired" rather
//! than failing, so the user simply pairs again.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub relay_url: String,
    pub device_id: String,
    pub device_token: String,
    pub account_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredentials {
    relay_url: String,
    device_id: String,
    account_id: String,
    /// base64 of the sealed token.
    device_token_enc: String,
    /// "dpapi" when the platform sealed it, "plain" when it could not.
    protection: String,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Only these names are addressable, so the frontend can never reach outside
/// the app's own configuration directory.
fn resolve(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let file = match name {
        "settings" => "settings.json",
        "agents" => "agents-cache.json",
        _ => return Err(format!("unknown store: {name}")),
    };
    Ok(config_dir(app)?.join(file))
}

#[tauri::command]
pub fn store_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = resolve(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{e}")),
    }
}

#[tauri::command]
pub fn store_write(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = resolve(&app, &name)?;
    write_atomic(&path, contents.as_bytes())
}

#[tauri::command]
pub fn store_delete(app: AppHandle, name: String) -> Result<(), String> {
    let path = resolve(&app, &name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{e}")),
    }
}

/// Write through a temporary file so a crash mid-write cannot leave a
/// half-written settings or credentials file behind.
fn write_atomic(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| format!("{e}"))?;
        file.write_all(bytes).map_err(|e| format!("{e}"))?;
        file.sync_all().map_err(|e| format!("{e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("{e}"))
}

/* ----------------------------- credentials ----------------------------- */

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("credentials.json"))
}

#[tauri::command]
pub fn credentials_load(app: AppHandle) -> Result<Option<Credentials>, String> {
    let path = credentials_path(&app)?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{e}")),
    };
    let stored: StoredCredentials = match serde_json::from_str(&text) {
        Ok(s) => s,
        // A file we cannot parse is a file we cannot honour: forget it rather
        // than leaving the app wedged on a broken pairing.
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
    };
    let sealed = base64::engine::general_purpose::STANDARD
        .decode(stored.device_token_enc.as_bytes())
        .map_err(|_| "credentials are corrupt".to_string());
    let sealed = match sealed {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
    };
    let token = if stored.protection == "dpapi" {
        match unseal(&sealed) {
            Some(bytes) => bytes,
            None => {
                let _ = fs::remove_file(&path);
                return Ok(None);
            }
        }
    } else {
        sealed
    };
    let device_token = match String::from_utf8(token) {
        Ok(t) => t,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
    };
    Ok(Some(Credentials {
        relay_url: stored.relay_url,
        device_id: stored.device_id,
        device_token,
        account_id: stored.account_id,
    }))
}

#[tauri::command]
pub fn credentials_save(app: AppHandle, credentials: Credentials) -> Result<(), String> {
    let (blob, protection) = match seal(credentials.device_token.as_bytes()) {
        Some(sealed) => (sealed, "dpapi"),
        None => (credentials.device_token.as_bytes().to_vec(), "plain"),
    };
    let stored = StoredCredentials {
        relay_url: credentials.relay_url,
        device_id: credentials.device_id,
        account_id: credentials.account_id,
        device_token_enc: base64::engine::general_purpose::STANDARD.encode(blob),
        protection: protection.to_string(),
    };
    let text = serde_json::to_string_pretty(&stored).map_err(|e| format!("{e}"))?;
    let path = credentials_path(&app)?;
    write_atomic(&path, text.as_bytes())?;
    restrict_permissions(&path);
    Ok(())
}

#[tauri::command]
pub fn credentials_clear(app: AppHandle) -> Result<(), String> {
    let path = credentials_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{e}")),
    }
}

/// Where the user can find (and back up or delete) all of this.
#[tauri::command]
pub fn config_directory(app: AppHandle) -> Result<String, String> {
    Ok(config_dir(&app)?.display().to_string())
}

/* ------------------------------ platform ------------------------------- */

#[cfg(unix)]
fn restrict_permissions(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &PathBuf) {
    // Windows inherits the per-user ACL of the app's configuration directory,
    // and DPAPI already binds the token to this user account.
}

#[cfg(windows)]
fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    crypt(plain, true)
}

#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
    crypt(sealed, false)
}

#[cfg(windows)]
fn crypt(input: &[u8], protect: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: input.len() as u32,
            pbData: input.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = if protect {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out_blob,
            )
        } else {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pbData.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as _);
        Some(bytes)
    }
}

#[cfg(not(windows))]
fn seal(_plain: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn unseal(_sealed: &[u8]) -> Option<Vec<u8>> {
    None
}
