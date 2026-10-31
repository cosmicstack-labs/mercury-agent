//! The voice capsule: a small borderless window that drops from the top
//! centre of the main display while Optimus is listening or speaking.
//!
//! On macOS it sits ABOVE the menu bar (status-window level) so it reads as
//! coming out of the notch — on Macs with a notch it hangs from it, on Macs
//! without one it takes the same place — and it follows the user across
//! Spaces and over full-screen apps without stealing focus. Elsewhere it is
//! an always-on-top pill at the top centre.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "notch";

#[tauri::command]
pub fn notch_show(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let width = width.clamp(240.0, 640.0);
    let height = height.clamp(32.0, 320.0);
    let window = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html?surface=notch".into()))
            .title("Mercury voice")
            .inner_size(width, height)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    if let Some(monitor) = window.primary_monitor().map_err(|e| e.to_string())? {
        let scale = monitor.scale_factor();
        let screen = monitor.size().to_logical::<f64>(scale);
        let origin = monitor.position().to_logical::<f64>(scale);
        window
            .set_position(LogicalPosition::new(origin.x + (screen.width - width) / 2.0, origin.y))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    raise_above_menu_bar(&window);
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn notch_hide(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn raise_above_menu_bar(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    // SAFETY: Tauri hands back the live NSWindow of this webview window; it is
    // used on the main thread (commands run there for window work) and not retained.
    let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    // NSStatusWindowLevel (25) + 1: above the menu bar and its status items.
    ns.setLevel(26);
    ns.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    ns.setHasShadow(false);
}
