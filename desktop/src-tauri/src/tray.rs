//! The notification-area icon, and closing to it.
//!
//! WHY. A terminal client is something you leave running: sessions stay open on
//! the machines, and a window closed by habit or by Alt+F4 should not drop
//! them. So the close button hides the window and the tray icon brings it back,
//! which is what every long-running desktop app on Windows does.
//!
//! Quitting is then something you have to mean: the tray menu's Quit, which is
//! the only path that lets the window actually close.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};

/// The tray image. 32x32 is the size Windows asks for at 100% scaling and the
/// one it scales best from.
const ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// What the close button does, and whether a quit is already under way.
pub struct TrayState {
    /// Off puts the close button back to closing the app outright.
    close_to_tray: AtomicBool,
    /// Set by Quit so the close it triggers is not turned into a hide.
    quitting: AtomicBool,
}

impl Default for TrayState {
    fn default() -> Self {
        TrayState { close_to_tray: AtomicBool::new(true), quitting: AtomicBool::new(false) }
    }
}

/// Called by the frontend once its settings are loaded, and whenever the
/// setting changes. Until then the default above applies.
#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) {
    app.state::<TrayState>().close_to_tray.store(enabled, Ordering::SeqCst);
}

/// Bring the window back from the tray. Also un-minimises it: hidden and
/// minimised are different states and it can be in both.
fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Remote Terminal", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Remote Terminal")
        .menu(&menu)
        // Left click opens the window; the menu is on the right button, which
        // is where Windows users look for it.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal(app),
            "quit" => {
                app.state::<TrayState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left, button_state: MouseButtonState::Up, ..
            } = event
            {
                reveal(tray.app_handle());
            }
        });

    // The app icon, embedded rather than taken from `default_window_icon()`:
    // that returns an Option, and a tray icon with no image is one the user
    // cannot click — which, with the close button hiding the window, would
    // leave them no way back into the app at all. The window icon is only a
    // fallback for the case where this PNG stops decoding.
    match Image::from_bytes(ICON) {
        Ok(icon) => builder = builder.icon(icon),
        Err(err) => {
            eprintln!("tray icon could not be decoded ({err}); using the window icon");
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
        }
    }
    builder.build(app)?;
    Ok(())
}

/// The close button. Hides rather than closes unless the user asked otherwise,
/// or unless this close *is* the quit.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    let state = window.app_handle().state::<TrayState>();
    if state.quitting.load(Ordering::SeqCst) || !state.close_to_tray.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
}
