use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

/// The tray icon: the app's persistent presence while the window is hidden.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Mercury", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Mercury", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

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
