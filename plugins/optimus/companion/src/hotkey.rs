//! The talk key: one global hotkey (e.g. "ctrl+alt+m") on every OS.
//!
//! - macOS: an event tap (needs the Accessibility permission Optimus already
//!   has). The key press is swallowed so it doesn't also type a letter.
//! - Windows: RegisterHotKey on a thread with its own message loop.
//! - Linux: an X11 key grab (X11 sessions, and XWayland apps on Wayland).

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub cmd: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hotkey {
    pub mods: Mods,
    /// Lowercase key name: a letter or digit, "space", "enter", "tab", "esc", "f1".."f12".
    pub key: String,
}

impl std::fmt::Display for Hotkey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mac = cfg!(target_os = "macos");
        let mut parts: Vec<String> = Vec::new();
        if self.mods.ctrl {
            parts.push("Control".into());
        }
        if self.mods.alt {
            parts.push(if mac { "Option".into() } else { "Alt".into() });
        }
        if self.mods.shift {
            parts.push("Shift".into());
        }
        if self.mods.cmd {
            parts.push(if mac { "Command".into() } else if cfg!(windows) { "Win".into() } else { "Super".into() });
        }
        let k = if self.key.len() == 1 { self.key.to_uppercase() } else { capitalize(&self.key) };
        parts.push(k);
        write!(f, "{}", parts.join("+"))
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

pub fn parse(spec: &str) -> Result<Hotkey, String> {
    let mut mods = Mods::default();
    let mut key: Option<String> = None;
    for part in spec.split('+').map(|p| p.trim().to_ascii_lowercase()).filter(|p| !p.is_empty()) {
        match part.as_str() {
            "ctrl" | "control" => mods.ctrl = true,
            "alt" | "option" | "opt" => mods.alt = true,
            "shift" => mods.shift = true,
            "cmd" | "command" | "super" | "win" | "meta" => mods.cmd = true,
            other => {
                if key.is_some() {
                    return Err(format!("\"{spec}\" has more than one key; use modifiers plus one key, e.g. ctrl+alt+m"));
                }
                let k = match other {
                    "return" => "enter".to_string(),
                    "escape" => "esc".to_string(),
                    "spacebar" => "space".to_string(),
                    o => o.to_string(),
                };
                let valid = (k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()))
                    || ["space", "enter", "tab", "esc"].contains(&k.as_str())
                    || k.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n));
                if !valid {
                    return Err(format!("unknown key \"{other}\" in \"{spec}\" (use a letter, digit, space, enter, tab, esc or f1–f12)"));
                }
                key = Some(k);
            }
        }
    }
    let key = key.ok_or_else(|| format!("\"{spec}\" has no key, e.g. ctrl+alt+m"))?;
    let is_f = key.starts_with('f') && key.len() > 1;
    if !is_f && !mods.ctrl && !mods.alt && !mods.cmd {
        return Err(format!("\"{spec}\" would fire while typing: add ctrl, alt or cmd (or use an F key)"));
    }
    Ok(Hotkey { mods, key })
}

/// Start listening for the hotkey; `on_press` runs on the listener thread.
/// Returns once the key is registered (or why it couldn't be).
pub fn listen(hk: Hotkey, on_press: impl Fn() + Send + 'static) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name(format!("optimus-hotkey-{}", hk.key))
        .spawn(move || platform::run(hk, on_press, tx))
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_else(|_| Err("the hotkey listener didn't start".into()))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Hotkey;
    use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};
    use core_graphics::event::{CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, EventField};
    use std::sync::atomic::{AtomicPtr, Ordering};

    unsafe extern "C" {
        fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);
    }


    fn keycode(key: &str) -> Option<i64> {
        let k = match key {
            "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5, "z" => 6, "x" => 7, "c" => 8, "v" => 9,
            "b" => 11, "q" => 12, "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17, "1" => 18, "2" => 19,
            "3" => 20, "4" => 21, "6" => 22, "5" => 23, "9" => 25, "7" => 26, "8" => 28, "0" => 29, "o" => 31,
            "u" => 32, "i" => 34, "p" => 35, "l" => 37, "j" => 38, "k" => 40, "n" => 45, "m" => 46,
            "enter" => 36, "tab" => 48, "space" => 49, "esc" => 53,
            "f1" => 122, "f2" => 120, "f3" => 99, "f4" => 118, "f5" => 96, "f6" => 97, "f7" => 98, "f8" => 100,
            "f9" => 101, "f10" => 109, "f11" => 103, "f12" => 111,
            _ => return None,
        };
        Some(k)
    }

    pub fn run(hk: Hotkey, on_press: impl Fn() + Send + 'static, ready: std::sync::mpsc::Sender<Result<(), String>>) {
        let Some(code) = keycode(&hk.key) else {
            let _ = ready.send(Err(format!("can't use {} as a key on macOS", hk.key)));
            return;
        };
        let want = hk.mods;
        // Each listener (talk, mute) has its own tap, re-enabled if macOS pauses it.
        let me = std::sync::Arc::new(AtomicPtr::<std::ffi::c_void>::new(std::ptr::null_mut()));
        let me2 = me.clone();
        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::Default,
            vec![CGEventType::KeyDown],
            move |_proxy, etype, event| {
                if matches!(etype, CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput) {
                    let t = me2.load(Ordering::Relaxed);
                    if !t.is_null() {
                        unsafe { CGEventTapEnable(t, true) };
                    }
                    return None;
                }
                if event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) != code {
                    return None;
                }
                let f = event.get_flags();
                let has = |flag: CGEventFlags| f.contains(flag);
                if has(CGEventFlags::CGEventFlagControl) != want.ctrl
                    || has(CGEventFlags::CGEventFlagAlternate) != want.alt
                    || has(CGEventFlags::CGEventFlagShift) != want.shift
                    || has(CGEventFlags::CGEventFlagCommand) != want.cmd
                {
                    return None;
                }
                if event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) == 0 {
                    on_press();
                }
                // Swallow it: the press shouldn't also type into the front app.
                event.set_type(CGEventType::Null);
                None
            },
        );
        match tap {
            Ok(tap) => unsafe {
                me.store(tap.mach_port.as_concrete_TypeRef() as *mut std::ffi::c_void, Ordering::Relaxed);
                let Ok(source) = tap.mach_port.create_runloop_source(0) else {
                    let _ = ready.send(Err("couldn't attach the hotkey listener".into()));
                    return;
                };
                CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
                tap.enable();
                let _ = ready.send(Ok(()));
                CFRunLoop::run_current();
            },
            Err(()) => {
                let _ = ready.send(Err("macOS refused the hotkey listener: allow Optimus under Privacy & Security → Accessibility".into()));
            }
        }
    }

    use core_foundation::base::TCFType;
}

#[cfg(windows)]
mod platform {
    use super::Hotkey;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, RegisterHotKey};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    fn vk(key: &str) -> Option<u32> {
        Some(match key {
            "space" => 0x20,
            "enter" => 0x0D,
            "tab" => 0x09,
            "esc" => 0x1B,
            k if k.len() == 1 => k.to_ascii_uppercase().chars().next()? as u32,
            k => 0x70 + k.strip_prefix('f')?.parse::<u32>().ok()? - 1,
        })
    }

    pub fn run(hk: Hotkey, on_press: impl Fn() + Send + 'static, ready: std::sync::mpsc::Sender<Result<(), String>>) {
        let Some(code) = vk(&hk.key) else {
            let _ = ready.send(Err(format!("can't use {} as a key", hk.key)));
            return;
        };
        let mut mods = MOD_NOREPEAT;
        if hk.mods.ctrl {
            mods |= MOD_CONTROL;
        }
        if hk.mods.alt {
            mods |= MOD_ALT;
        }
        if hk.mods.shift {
            mods |= MOD_SHIFT;
        }
        if hk.mods.cmd {
            mods |= MOD_WIN;
        }
        if unsafe { RegisterHotKey(std::ptr::null_mut(), 1, mods, code) } == 0 {
            let _ = ready.send(Err(format!("{hk} is already used by another app; pick another key in /plugins optimus")));
            return;
        }
        let _ = ready.send(Ok(()));
        let mut msg: MSG = unsafe { std::mem::zeroed() };
        while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
            if msg.message == WM_HOTKEY {
                on_press();
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::Hotkey;
    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::xproto::{ConnectionExt, GrabMode, ModMask};

    fn keysym(key: &str) -> Option<u32> {
        Some(match key {
            "space" => 0x20,
            "enter" => 0xff0d,
            "tab" => 0xff09,
            "esc" => 0xff1b,
            k if k.len() == 1 => k.chars().next()? as u32,
            k => 0xffbe + k.strip_prefix('f')?.parse::<u32>().ok()? - 1,
        })
    }

    pub fn run(hk: Hotkey, on_press: impl Fn() + Send + 'static, ready: std::sync::mpsc::Sender<Result<(), String>>) {
        let result = (|| -> Result<(x11rb::rust_connection::RustConnection, u8, u16), String> {
            let (conn, screen) = x11rb::connect(None).map_err(|e| format!("no X11 display for the hotkey ({e}); on Wayland use chat, or the listen tool"))?;
            let root = conn.setup().roots[screen].root;
            let sym = keysym(&hk.key).ok_or("unknown key")?;
            let setup = conn.setup();
            let (min, max) = (setup.min_keycode, setup.max_keycode);
            let map = conn.get_keyboard_mapping(min, max - min + 1).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
            let per = map.keysyms_per_keycode as usize;
            let code = (0..=(max - min) as usize)
                .find(|i| map.keysyms[i * per..(i + 1) * per].contains(&sym))
                .map(|i| min + i as u8)
                .ok_or("that key isn't on this keyboard")?;
            let mut mods = 0u16;
            if hk.mods.ctrl {
                mods |= u16::from(ModMask::CONTROL);
            }
            if hk.mods.alt {
                mods |= u16::from(ModMask::M1);
            }
            if hk.mods.shift {
                mods |= u16::from(ModMask::SHIFT);
            }
            if hk.mods.cmd {
                mods |= u16::from(ModMask::M4);
            }
            // Also with Caps Lock and Num Lock on.
            for extra in [0u16, u16::from(ModMask::LOCK), u16::from(ModMask::M2), u16::from(ModMask::LOCK) | u16::from(ModMask::M2)] {
                conn.grab_key(true, root, ModMask::from(mods | extra), code, GrabMode::ASYNC, GrabMode::ASYNC)
                    .map_err(|e| e.to_string())?
                    .check()
                    .map_err(|_| format!("{hk} is already used by another app; pick another key in /plugins optimus"))?;
            }
            conn.flush().map_err(|e| e.to_string())?;
            Ok((conn, code, mods))
        })();
        let (conn, code, _) = match result {
            Ok(v) => v,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let _ = ready.send(Ok(()));
        while let Ok(ev) = conn.wait_for_event() {
            if let Event::KeyPress(k) = ev {
                if k.detail == code {
                    on_press();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keys() {
        let h = parse("Ctrl+Option+M").unwrap();
        assert_eq!(h.mods, Mods { ctrl: true, alt: true, shift: false, cmd: false });
        assert_eq!(h.key, "m");
        assert_eq!(parse("f9").unwrap().key, "f9");
        assert_eq!(parse("cmd+shift+space").unwrap().key, "space");
        assert!(parse("m").is_err(), "a bare letter would fire while typing");
        assert!(parse("ctrl+a+b").is_err());
        assert!(parse("ctrl+alt").is_err());
        assert!(parse("ctrl+hyper").is_err());
    }
}
