use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};

/// The tray icon: the app's persistent presence while the window is hidden.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Mercury", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Mercury", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &updates, &separator, &quit])?;

    // macOS: a monochrome template image, tinted by the system to match the
    // menu bar (light, dark, tinted wallpapers). Elsewhere: the colour tile.
    #[cfg(target_os = "macos")]
    let (icon, template) = (
        Image::from_bytes(include_bytes!("../icons/tray/macos-template.png"))?,
        true,
    );
    #[cfg(not(target_os = "macos"))]
    let (icon, template) = (Image::from_bytes(include_bytes!("../icons/tray/tray.png"))?, false);

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(template)
        .tooltip("Mercury")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::show_main(app),
            // The window opens Settings → About and checks this app and every server.
            "check-updates" => {
                crate::show_main(app);
                let _ = app.emit("menu-check-updates", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
