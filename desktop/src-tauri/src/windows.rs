//! Terminals in windows of their own.
//!
//! WHY. A terminal you keep an eye on — a build, a log, an assistant at work —
//! wants to sit on another monitor, or float over the editor, while the main
//! window gets on with something else. So any terminal can be moved out into
//! a window that shows it alone, and that window can be kept on top.
//!
//! HOW. The new window loads the same frontend, told by an initialisation
//! script which terminal it is for (`window.__RT_WINDOW__`), and runs it as a
//! second, smaller copy of the app with its own relay connection: the protocol
//! state, the emulator and the screen are all already written for one window,
//! and sharing one socket between two web views would mean inventing a bridge
//! for every one of them. The main window keeps the tab, detached, marked as
//! living elsewhere, and takes it back when the window closes — which this
//! module tells it about, because a closing page cannot be trusted to.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::ws::WsState;

/// Every terminal window's label starts with this; the capability file grants
/// these windows what the main one has.
pub const PREFIX: &str = "term-";

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Open [session_id] on [agent_id] in a window of its own. Resolves to the new
/// window's label, which the main window keeps to find it again.
///
/// Async on purpose: building a web view from a synchronous command deadlocks
/// on Windows, because the command would hold the thread WebView2 needs.
#[tauri::command]
pub async fn terminal_window_open(
    app: AppHandle,
    agent_id: String,
    session_id: String,
    title: String,
    on_top: bool,
) -> Result<String, String> {
    let label = format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::SeqCst));
    let boot = serde_json::json!({
        "kind": "terminal",
        "label": label,
        "agentId": agent_id,
        "sessionId": session_id,
        "onTop": on_top,
    });
    let script = format!("window.__RT_WINDOW__ = Object.freeze({boot});");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(960.0, 620.0)
        .min_inner_size(420.0, 300.0)
        .resizable(true)
        .theme(Some(tauri::Theme::Dark))
        .always_on_top(on_top)
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

/// Bring a window to the front: a terminal window, or `main`.
#[tauri::command]
pub fn terminal_window_focus(app: AppHandle, label: String) -> bool {
    if label != "main" && !label.starts_with(PREFIX) {
        return false;
    }
    match app.get_webview_window(&label) {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            true
        }
        None => false,
    }
}

/// Close a terminal window (the main window takes its terminal back).
#[tauri::command]
pub fn terminal_window_close(app: AppHandle, label: String) {
    if !label.starts_with(PREFIX) {
        return;
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
}

/// Keep the calling window above every other one, or stop.
#[tauri::command]
pub fn window_set_on_top(window: WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// A terminal window went away: drop its socket and tell the main window,
/// which takes the terminal back as a tab.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if !window.label().starts_with(PREFIX) {
        return;
    }
    if let WindowEvent::Destroyed = event {
        let app = window.app_handle();
        if let Some(state) = app.try_state::<WsState>() {
            state.close_for(window.label());
        }
        let _ = app.emit_to("main", "rt:window-closed", window.label().to_string());
    }
}
