//! "Mercury is driving": a glowing ring around the pointer and a small label
//! beside it while Optimus moves the mouse, so it's obvious the agent (not
//! the owner) is in control. It fades out a moment after the last action.
//!
//! - macOS: two borderless AppKit windows on the main thread (Optimus.app
//!   runs an NSApplication for them), click-through, on every Space, and
//!   excluded from screen capture so Optimus's own screenshots never see them.
//! - Windows: a layered, click-through, topmost tool window excluded from
//!   capture (WDA_EXCLUDEFROMCAPTURE).
//! - Linux X11: a small label window that ignores input and is hidden while a
//!   screenshot is taken. Wayland doesn't let apps place such windows.
//!
//! `follow` and `done` can be called from any thread.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub const LABEL: &str = "☿ Mercury · Optimus is driving";

/// Bumped on every follow: a pending hide only fires if nothing moved since.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Show the overlay at the pointer (screen coordinates, as the input APIs use).
pub fn follow(x: i32, y: i32) {
    if !enabled() {
        return;
    }
    GENERATION.fetch_add(1, Ordering::Relaxed);
    platform::follow(x, y);
}

/// The batch of actions is over: fade out soon unless more come.
pub fn done() {
    let generation = GENERATION.load(Ordering::Relaxed);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1600));
        if GENERATION.load(Ordering::Relaxed) == generation {
            platform::hide();
        }
    });
}

/// Around a screenshot on platforms that can't exclude the overlay from capture.
pub fn capture_guard() -> CaptureGuard {
    CaptureGuard(platform::hide_for_capture())
}

pub struct CaptureGuard(bool);

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        if self.0 {
            platform::restore_after_capture();
        }
    }
}

fn enabled() -> bool {
    crate::core::settings().get("showOverlay").and_then(serde_json::Value::as_bool) != Some(false)
}

// ── macOS ─────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;

    use dispatch2::DispatchQueue;
    use objc2::rc::Retained;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSColor, NSFont, NSScreen, NSTextField, NSWindow,
        NSWindowCollectionBehavior, NSWindowSharingType, NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    const RING: f64 = 46.0;
    const LABEL_W: f64 = 236.0;
    const LABEL_H: f64 = 26.0;

    struct Windows {
        ring: Retained<NSWindow>,
        label: Retained<NSWindow>,
        shown: bool,
    }

    thread_local! {
        static WINDOWS: RefCell<Option<Windows>> = const { RefCell::new(None) };
    }

    fn window(mtm: MainThreadMarker, w: f64, h: f64) -> Retained<NSWindow> {
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h));
        let win = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(NSWindow::alloc(mtm), rect, NSWindowStyleMask::Borderless, NSBackingStoreType::Buffered, false)
        };
        unsafe { win.setReleasedWhenClosed(false) };
        win.setOpaque(false);
        win.setBackgroundColor(Some(&NSColor::clearColor()));
        win.setHasShadow(false);
        win.setIgnoresMouseEvents(true);
        win.setLevel(1000); // screen-saver level: above full-screen apps and menus
        win.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        // Never in screenshots, including Optimus's own.
        win.setSharingType(NSWindowSharingType::None);
        win
    }

    fn build(mtm: MainThreadMarker) -> Windows {
        let accent = NSColor::colorWithSRGBRed_green_blue_alpha(0.46, 0.38, 1.0, 0.95);
        let glow = NSColor::colorWithSRGBRed_green_blue_alpha(0.46, 0.38, 1.0, 0.16);
        let dark = NSColor::colorWithSRGBRed_green_blue_alpha(0.09, 0.08, 0.16, 0.86);

        let ring = window(mtm, RING, RING);
        if let Some(view) = ring.contentView() {
            view.setWantsLayer(true);
            if let Some(layer) = view.layer() {
                layer.setCornerRadius(RING / 2.0);
                layer.setBorderWidth(3.0);
                layer.setBorderColor(Some(&accent.CGColor()));
                layer.setBackgroundColor(Some(&glow.CGColor()));
            }
        }

        let label = window(mtm, LABEL_W, LABEL_H);
        if let Some(view) = label.contentView() {
            view.setWantsLayer(true);
            if let Some(layer) = view.layer() {
                layer.setCornerRadius(LABEL_H / 2.0);
                layer.setBackgroundColor(Some(&dark.CGColor()));
                layer.setBorderWidth(1.0);
                layer.setBorderColor(Some(&accent.CGColor()));
            }
            let text = NSTextField::labelWithString(&NSString::from_str(super::LABEL), mtm);
            text.setTextColor(Some(&NSColor::whiteColor()));
            text.setFont(Some(&NSFont::boldSystemFontOfSize(12.0)));
            text.setFrame(NSRect::new(NSPoint::new(12.0, 5.0), NSSize::new(LABEL_W - 20.0, LABEL_H - 9.0)));
            view.addSubview(&text);
        }
        Windows { ring, label, shown: false }
    }

    /// Run AppKit on the main thread (never returns). The overlay windows live here.
    pub fn run_main_loop() -> ! {
        let mtm = MainThreadMarker::new().expect("main thread");
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        WINDOWS.with(|w| *w.borrow_mut() = Some(build(mtm)));
        app.run();
        std::process::exit(0)
    }

    pub fn follow(x: i32, y: i32) {
        DispatchQueue::main().exec_async(move || {
            let Some(mtm) = MainThreadMarker::new() else { return };
            // AppKit's origin is the bottom-left of the main screen; ours is its top-left.
            let screens = NSScreen::screens(mtm);
            let Some(main) = screens.firstObject() else { return };
            let h = main.frame().size.height;
            let (fx, fy) = (x as f64, h - y as f64);
            WINDOWS.with(|w| {
                if let Some(w) = w.borrow_mut().as_mut() {
                    w.ring.setFrameOrigin(NSPoint::new(fx - RING / 2.0, fy - RING / 2.0));
                    w.label.setFrameOrigin(NSPoint::new(fx + RING / 2.0 + 4.0, fy - RING / 2.0 - LABEL_H + 6.0));
                    if !w.shown {
                        w.ring.orderFrontRegardless();
                        w.label.orderFrontRegardless();
                        w.shown = true;
                    }
                }
            });
        });
    }

    pub fn hide() {
        DispatchQueue::main().exec_async(|| {
            WINDOWS.with(|w| {
                if let Some(w) = w.borrow_mut().as_mut() {
                    w.ring.orderOut(None);
                    w.label.orderOut(None);
                    w.shown = false;
                }
            });
        });
    }

    /// Excluded from capture already: nothing to do.
    pub fn hide_for_capture() -> bool {
        false
    }
    pub fn restore_after_capture() {}
}

// ── Windows ───────────────────────────────────────────────────────────

#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Once;

    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, CreatePen, CreateSolidBrush, DeleteObject, Ellipse, EndPaint, FillRect, GetStockObject, NULL_BRUSH, PAINTSTRUCT, PS_SOLID,
        RoundRect, SelectObject, SetBkMode, SetTextColor, TRANSPARENT, TextOutW,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, HWND_TOPMOST, LWA_ALPHA, LWA_COLORKEY, MSG, RegisterClassW,
        SW_HIDE, SWP_NOACTIVATE, SWP_NOSIZE, SWP_SHOWWINDOW, SetLayeredWindowAttributes, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
        TranslateMessage, WDA_EXCLUDEFROMCAPTURE, WM_PAINT, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_EX_TRANSPARENT, WS_POPUP,
    };

    const W: i32 = 300;
    const H: i32 = 52;
    const RING: i32 = 44;
    const KEY: COLORREF = 0x00FF00FF; // magenta = transparent

    static HWND_: AtomicIsize = AtomicIsize::new(0);
    static START: Once = Once::new();

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        r as u32 | ((g as u32) << 8) | ((b as u32) << 16)
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == WM_PAINT {
            unsafe {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let dc = BeginPaint(hwnd, &mut ps);
                let key = CreateSolidBrush(KEY);
                let all = RECT { left: 0, top: 0, right: W, bottom: H };
                FillRect(dc, &all, key);
                DeleteObject(key);
                let pen = CreatePen(PS_SOLID, 3, rgb(118, 97, 255));
                let old_pen = SelectObject(dc, pen);
                let old_brush = SelectObject(dc, GetStockObject(NULL_BRUSH));
                Ellipse(dc, 3, 3, RING, RING);
                let dark = CreateSolidBrush(rgb(24, 20, 40));
                SelectObject(dc, dark);
                RoundRect(dc, RING + 4, 16, W - 2, H - 4, 14, 14);
                SetBkMode(dc, TRANSPARENT as i32);
                SetTextColor(dc, rgb(255, 255, 255));
                let text = wide(super::LABEL);
                TextOutW(dc, RING + 14, 22, text.as_ptr(), (text.len() - 1) as i32);
                SelectObject(dc, old_pen);
                SelectObject(dc, old_brush);
                DeleteObject(pen);
                DeleteObject(dark);
                EndPaint(hwnd, &ps);
            }
            return 0;
        }
        unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
    }

    fn ensure() {
        START.call_once(|| {
            std::thread::spawn(|| unsafe {
                let class = wide("MercuryOptimusOverlay");
                let hinst = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: hinst,
                    lpszClassName: class.as_ptr(),
                    ..std::mem::zeroed()
                };
                RegisterClassW(&wc);
                let hwnd = CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    class.as_ptr(),
                    class.as_ptr(),
                    WS_POPUP,
                    0,
                    0,
                    W,
                    H,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    hinst,
                    std::ptr::null(),
                );
                SetLayeredWindowAttributes(hwnd, KEY, 235, LWA_COLORKEY | LWA_ALPHA);
                SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                HWND_.store(hwnd as isize, Ordering::Relaxed);
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            });
            std::thread::sleep(std::time::Duration::from_millis(100));
        });
    }

    pub fn follow(x: i32, y: i32) {
        ensure();
        let h = HWND_.load(Ordering::Relaxed);
        if h != 0 {
            unsafe { SetWindowPos(h as HWND, HWND_TOPMOST, x - RING / 2, y - RING / 2, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW) };
        }
    }

    pub fn hide() {
        let h = HWND_.load(Ordering::Relaxed);
        if h != 0 {
            unsafe { ShowWindow(h as HWND, SW_HIDE) };
        }
    }

    pub fn hide_for_capture() -> bool {
        false
    }
    pub fn restore_after_capture() {}
}

// ── Linux (X11) ───────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod platform {
    use std::sync::Mutex;

    use x11rb::connection::Connection;
    use x11rb::protocol::xfixes::ConnectionExt as _;
    use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt, CreateGCAux, CreateWindowAux, EventMask, WindowClass};
    use x11rb::rust_connection::RustConnection;

    struct Overlay {
        conn: RustConnection,
        win: u32,
        gc: u32,
        shown: bool,
    }

    static OVERLAY: Mutex<Option<Option<Overlay>>> = Mutex::new(None);

    fn open() -> Option<Overlay> {
        if std::env::var_os("DISPLAY").is_none() {
            return None;
        }
        let (conn, screen_num) = x11rb::connect(None).ok()?;
        let screen = &conn.setup().roots[screen_num];
        let (root, black, white) = (screen.root, screen.black_pixel, screen.white_pixel);
        let win = conn.generate_id().ok()?;
        conn.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            win,
            root,
            0,
            0,
            250,
            22,
            1,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().override_redirect(1).background_pixel(0x2a2440).border_pixel(0x7661ff).event_mask(EventMask::EXPOSURE),
        )
        .ok()?;
        // Clicks go straight through to what's underneath.
        if conn.xfixes_query_version(5, 0).ok().and_then(|c| c.reply().ok()).is_some() {
            if let Ok(region) = conn.generate_id() {
                let _ = conn.xfixes_create_region(region, &[]);
                let _ = conn.xfixes_set_window_shape_region(win, x11rb::protocol::shape::SK::INPUT, 0, 0, region);
                let _ = conn.xfixes_destroy_region(region);
            }
        }
        let gc = conn.generate_id().ok()?;
        conn.create_gc(gc, win, &CreateGCAux::new().foreground(white).background(black)).ok()?;
        conn.flush().ok()?;
        Some(Overlay { conn, win, gc, shown: false })
    }

    fn with<F: FnOnce(&mut Overlay)>(f: F) {
        let mut g = OVERLAY.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = Some(open());
        }
        if let Some(Some(o)) = g.as_mut() {
            f(o);
        }
    }

    fn draw(o: &Overlay) {
        let text = b"Mercury - Optimus is driving";
        let _ = o.conn.image_text8(o.win, o.gc, 10, 15, text);
    }

    pub fn follow(x: i32, y: i32) {
        with(|o| {
            let _ = o.conn.configure_window(o.win, &ConfigureWindowAux::new().x(x + 22).y(y + 18).stack_mode(x11rb::protocol::xproto::StackMode::ABOVE));
            if !o.shown {
                let _ = o.conn.map_window(o.win);
                o.shown = true;
            }
            draw(o);
            let _ = o.conn.flush();
        });
    }

    pub fn hide() {
        with(|o| {
            if o.shown {
                let _ = o.conn.unmap_window(o.win);
                o.shown = false;
                let _ = o.conn.flush();
            }
        });
    }

    /// X11 can't keep a window out of a screenshot: hide it for the capture.
    pub fn hide_for_capture() -> bool {
        let mut was = false;
        with(|o| {
            if o.shown {
                was = true;
                let _ = o.conn.unmap_window(o.win);
                let _ = o.conn.flush();
            }
        });
        if was {
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        was
    }

    pub fn restore_after_capture() {
        with(|o| {
            let _ = o.conn.map_window(o.win);
            draw(o);
            let _ = o.conn.flush();
        });
    }
}

#[cfg(target_os = "macos")]
pub use platform::run_main_loop;
