//! Remote Terminal for the desktop.
//!
//! The Rust side owns exactly what a web view cannot do for itself: the relay
//! socket (which needs an `Authorization` header), the HTTPS pairing calls,
//! the credential store, the clipboard and the app lock. Everything above that
//! — the protocol state machine, the terminal emulator, the screens — lives in
//! `ui/` and is a port of the Android app, so the two clients stay in step.

mod http;
mod store;
mod sys;
mod ws;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ws::WsState::default())
        .invoke_handler(tauri::generate_handler![
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            http::pair_redeem,
            http::pair_code,
            store::store_read,
            store::store_write,
            store::store_delete,
            store::credentials_load,
            store::credentials_save,
            store::credentials_clear,
            store::config_directory,
            sys::read_file_for_upload,
            sys::clipboard_read,
            sys::clipboard_read_image,
            sys::clipboard_write_text,
            sys::set_keep_awake,
            sys::app_lock_available,
            sys::app_lock_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Remote Terminal");
}
