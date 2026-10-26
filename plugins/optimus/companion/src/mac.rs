//! macOS: run the screen and input work inside Optimus.app.
//!
//! macOS charges privacy permissions (Accessibility, Screen Recording) to the
//! app that launched a process. Spawned by Mercury from a terminal, the grant
//! would go to Terminal and cover every script it runs. So the plugin process
//! builds `Optimus.app` from its own binary, signs it with a certificate made
//! on this Mac (no Apple account involved), and launches it through
//! LaunchServices, where it is its own app. The two talk over a Unix socket,
//! one JSON object per line.
//!
//! The certificate stays the same across updates, so macOS keeps the
//! permissions: a code signature's identity here is "this bundle id, signed by
//! this certificate", not the binary's hash.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};


pub const BUNDLE_ID: &str = "sh.mercuryagent.optimus";
const CERT_NAME: &str = "Mercury Optimus (local)";
const P12_PASSWORD: &str = "mercury-optimus";
const PANE_ACCESSIBILITY: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const PANE_SCREEN: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

// ── Inside Optimus.app ─────────────────────────────────────────────────

pub fn permission_report(request: bool) -> Value {
    let (mut ax, mut screen) = unsafe { (AXIsProcessTrusted(), CGPreflightScreenCaptureAccess()) };
    if request {
        if !screen {
            // Registers Optimus in the Screen Recording list and shows the system prompt once.
            screen = unsafe { CGRequestScreenCaptureAccess() };
        }
        if !ax {
            // Creating an input source with the prompt option adds Optimus to the Accessibility list.
            let _ = enigo::Enigo::new(&enigo::Settings { open_prompt_to_get_permissions: true, ..Default::default() });
            ax = unsafe { AXIsProcessTrusted() };
        }
        if !ax {
            let _ = Command::new("open").arg(PANE_ACCESSIBILITY).status();
        } else if !screen {
            let _ = Command::new("open").arg(PANE_SCREEN).status();
        }
    }
    let mark = |b: bool| if b { "✅" } else { "❌" };
    let mut text = format!(
        "macOS permissions for Optimus:\n{} Accessibility (mouse and keyboard)\n{} Screen Recording (see the screen)",
        mark(ax),
        mark(screen)
    );
    if !ax || !screen {
        text.push_str(
            "\nTo fix: System Settings → Privacy & Security, turn on \"Optimus\" under each one that's off. \
             If Screen Recording asks to quit and reopen, Optimus restarts by itself on its next use. \
             macOS asks to confirm Screen Recording again about once a month.",
        );
    }
    json!({ "ready": ax && screen, "accessibility": ax, "screenRecording": screen, "text": text })
}

/// `optimus agent --socket <path>`: run the core for one connection, then exit.
pub fn agent_main(socket: &Path) -> ! {
    let _ = fs::remove_file(socket);
    let listener = match UnixListener::bind(socket) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("optimus agent: can't listen on {}: {e}", socket.display());
            std::process::exit(1);
        }
    };
    let _ = fs::set_permissions(socket, fs::Permissions::from_mode(0o600));
    // Nobody connecting within a minute means the plugin went away.
    let _ = listener.set_nonblocking(true);
    let deadline = Instant::now() + Duration::from_secs(60);
    let stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => std::process::exit(0),
        }
    };
    let _ = stream.set_nonblocking(false);
    let _ = fs::remove_file(socket);
    let writer = std::sync::Mutex::new(stream.try_clone().expect("socket clone"));
    let mut reader = BufReader::new(stream);
    // LaunchServices started us with launchd's environment, not Mercury's: the
    // plugin sends its settings and voice keys first, over this private socket.
    let mut first = String::new();
    if reader.read_line(&mut first).is_ok() {
        if let Some(env) = serde_json::from_str::<Value>(&first).ok().and_then(|v| v.get("env").cloned()).and_then(|e| e.as_object().cloned()) {
            for (k, v) in env {
                if let Some(v) = v.as_str() {
                    // Single-threaded here: nothing else reads the environment yet.
                    unsafe { std::env::set_var(k, v) };
                }
            }
        }
    }
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
        // The plugin side closed: dropping tx ends the core.
    });
    // The core runs on a thread; the main thread belongs to AppKit (the overlay).
    std::thread::spawn(move || {
        crate::core::run(rx, move |v| {
            let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
            let _ = writeln!(w, "{v}");
        });
        std::process::exit(0);
    });
    crate::overlay::run_main_loop()
}

// ── In the plugin process ──────────────────────────────────────────────

fn data_dir() -> PathBuf {
    std::env::var_os("MERCURY_PLUGIN_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())).join(".mercury/optimus"))
}

/// Build (or refresh) Optimus.app, sign it, launch it and connect to its core.
pub fn start_agent() -> Result<UnixStream, String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    let app = dir.join("Optimus.app");
    ensure_bundle(&app, &dir)?;

    // Short path: Unix socket paths are limited to ~104 bytes.
    let socket = std::env::temp_dir().join(format!("mercury-optimus-{}.sock", std::process::id()));
    let _ = fs::remove_file(&socket);
    // LaunchServices drops our stderr: Optimus.app logs to a file next to it.
    let log_file = dir.join("optimus.log");
    if fs::metadata(&log_file).map(|m| m.len() > 2_000_000).unwrap_or(false) {
        let _ = fs::rename(&log_file, dir.join("optimus.log.1"));
    }
    let _ = fs::OpenOptions::new().create(true).append(true).open(&log_file);
    let status = Command::new("open")
        .args(["-n", "-g"])
        .arg("--stdout")
        .arg(&log_file)
        .arg("--stderr")
        .arg(&log_file)
        .arg(&app)
        .args(["--args", "agent", "--socket"])
        .arg(&socket)
        .status()
        .map_err(|e| format!("can't launch Optimus.app: {e}"))?;
    if !status.success() {
        return Err("macOS refused to launch Optimus.app".into());
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let stream = loop {
        match UnixStream::connect(&socket) {
            Ok(s) => break s,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Optimus.app didn't start: {e}")),
        }
    };
    // Mercury's environment for the core: settings, plugin info and the voice keys it was given.
    let env: serde_json::Map<String, Value> = std::env::vars()
        .filter(|(k, _)| k.starts_with("MERCURY_") || k.ends_with("_API_KEY"))
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    let mut w = stream.try_clone().map_err(|e| e.to_string())?;
    writeln!(w, "{}", json!({ "env": env })).map_err(|e| format!("Optimus.app went away: {e}"))?;
    Ok(stream)
}

fn ensure_bundle(app: &Path, dir: &Path) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = app.join("Contents/MacOS/optimus");
    let mine = fs::read(&me).map_err(|e| e.to_string())?;
    // Signing rewrites the copy, so compare against a stamp of the source binary.
    let stamp_file = dir.join("optimus-app.stamp");
    let stamp = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        mine.hash(&mut h);
        format!("{}-{:x}", env!("CARGO_PKG_VERSION"), h.finish())
    };
    let fresh = exe.exists() && fs::read_to_string(&stamp_file).map(|s| s == stamp).unwrap_or(false) && signed(app);
    if fresh {
        return Ok(());
    }
    fs::create_dir_all(exe.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&exe, &mine).map_err(|e| format!("can't write Optimus.app: {e}"))?;
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    fs::write(app.join("Contents/Info.plist"), info_plist()).map_err(|e| e.to_string())?;
    // Downloads made by Mercury aren't quarantined, but a copied browser download might be.
    let _ = Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(app).status();
    sign(app, &dir.join("signing"))?;
    fs::write(&stamp_file, stamp).map_err(|e| e.to_string())
}

fn signed(app: &Path) -> bool {
    Command::new("codesign")
        .args(["--verify", "--strict"])
        .arg(app)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn info_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>{BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Optimus</string>
  <key>CFBundleDisplayName</key><string>Optimus</string>
  <key>CFBundleExecutable</key><string>optimus</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{v}</string>
  <key>CFBundleVersion</key><string>{v}</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Optimus listens when you talk to Mercury.</string>
  <key>NSAppleEventsUsageDescription</key><string>Optimus controls apps when Mercury asks it to.</string>
</dict>
</plist>
"#,
        v = env!("CARGO_PKG_VERSION")
    )
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| format!("{:?}: {e}", cmd.get_program()))?;
    if !out.status.success() {
        return Err(format!(
            "{} failed: {}",
            cmd.get_program().to_string_lossy(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Sign the bundle with this Mac's own Optimus certificate, made once.
///
/// The identity lives in `signing/identity.p12`. For each signing it goes
/// into a throwaway keychain that is on the search list only for the
/// duration of the `codesign` call: the user's login keychain is never
/// touched and no password prompt appears.
fn sign(app: &Path, dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    let p12 = dir.join("identity.p12");
    if !p12.exists() {
        make_identity(dir, &p12)?;
    }
    let keychain = dir.join(format!("signing-{}.keychain-db", std::process::id()));
    let kc = keychain.to_string_lossy().to_string();
    let kc_pass = format!("optimus-{}", std::process::id());
    let _ = Command::new("security").args(["delete-keychain", &kc]).output();
    let original = run(Command::new("security").args(["list-keychains", "-d", "user"]))?;
    let original: Vec<String> = original.lines().map(|l| l.trim().trim_matches('"').to_string()).filter(|l| !l.is_empty()).collect();

    let result = (|| {
        run(Command::new("security").args(["create-keychain", "-p", &kc_pass, &kc]))?;
        run(Command::new("security").args(["unlock-keychain", "-p", &kc_pass, &kc]))?;
        run(Command::new("security").args(["set-keychain-settings", &kc]))?;
        run(Command::new("security")
            .args(["import"])
            .arg(&p12)
            .args(["-k", &kc, "-P", P12_PASSWORD, "-T", "/usr/bin/codesign", "-f", "pkcs12"]))?;
        run(Command::new("security").args(["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", &kc_pass, &kc]))?;
        let mut list = original.clone();
        list.push(kc.clone());
        run(Command::new("security").args(["list-keychains", "-d", "user", "-s"]).args(&list))?;
        run(Command::new("codesign")
            .args(["--force", "--sign", CERT_NAME, "--keychain", &kc, "--identifier", BUNDLE_ID])
            .arg(app))
    })();

    // Always restore the search list and remove the throwaway keychain.
    let _ = Command::new("security").args(["list-keychains", "-d", "user", "-s"]).args(&original).output();
    let _ = Command::new("security").args(["delete-keychain", &kc]).output();
    let _ = fs::remove_file(&keychain);
    result.map(|_| ()).map_err(|e| format!("couldn't sign Optimus.app: {e}"))
}

fn make_identity(dir: &Path, p12: &Path) -> Result<(), String> {
    let cnf = dir.join("cert.cnf");
    let key = dir.join("key.pem");
    let cert = dir.join("cert.pem");
    fs::write(
        &cnf,
        format!(
            "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN={CERT_NAME}\n\
             [ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n"
        ),
    )
    .map_err(|e| e.to_string())?;
    run(Command::new("/usr/bin/openssl")
        .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "36500", "-keyout"])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .arg("-config")
        .arg(&cnf))?;
    let export = |legacy: bool| {
        let mut c = Command::new("/usr/bin/openssl");
        c.arg("pkcs12").arg("-export");
        if legacy {
            c.arg("-legacy");
        }
        c.arg("-inkey").arg(&key).arg("-in").arg(&cert).arg("-out").arg(p12);
        c.args(["-passout", &format!("pass:{P12_PASSWORD}"), "-name", CERT_NAME]);
        run(&mut c)
    };
    // LibreSSL (macOS) has no -legacy flag; OpenSSL 3 needs it for macOS to read the file.
    export(false).or_else(|_| export(true))?;
    let _ = fs::set_permissions(p12, fs::Permissions::from_mode(0o600));
    let _ = fs::remove_file(&key);
    let _ = fs::remove_file(&cnf);
    Ok(())
}
