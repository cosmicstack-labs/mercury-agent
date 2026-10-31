//! Mercury Desktop — the native shell.
//!
//! The shell owns what a browser tab cannot: the window and tray, the OS
//! keychain, finding and starting the runtime on this computer, deep links
//! and updates. Everything the user looks at is the shared React dashboard
//! (../../../ui), talking to a runtime over its HTTP API.

mod commands;
mod notch;
mod tray;

use tauri::{AppHandle, Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch focuses this one and
        // hands over its arguments (deep links on Windows and Linux).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::local::detect_local_runtime,
            commands::local::read_attach_token,
            commands::local::probe_local_health,
            commands::local::run_mercury,
            commands::installer::install_runtime,
            commands::secrets::secret_get,
            commands::secrets::secret_set,
            commands::secrets::secret_delete,
            notch::notch_show,
            notch::notch_hide,
        ])
        .setup(|app| {
            tray::install(app.handle())?;

            // Installed builds get the `mercury://` scheme from their
            // installer; a dev build must register it itself.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if cfg!(debug_assertions) {
                    let _ = app.deep_link().register_all();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Mercury in the tray; Quit lives there.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Mercury Desktop")
        .run(|app, event| {
            // macOS: clicking the Dock icon with the window hidden brings it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            let _ = (app, &event);
        });
}

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
