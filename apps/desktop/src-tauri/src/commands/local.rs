//! The Mercury runtime on THIS computer: where it is, whether it is set up
//! as a service, and the per-boot attach token that lets the app talk to it
//! without a login. Mirrors src/cli/service.ts and src/web/auth.ts in the
//! runtime; keep the paths in step.

use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntime {
    pub mercury_home: String,
    pub binary_path: Option<String>,
    pub binary_version: Option<String>,
    pub port: u16,
    pub attach_token_present: bool,
    pub service_installed: bool,
    pub platform: &'static str,
}

#[derive(Serialize)]
pub struct CommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

const DEFAULT_PORT: u16 = 6174;

/// Subcommands the app is allowed to run on the user's behalf. Anything
/// else is refused; the frontend is not a shell.
const ALLOWED_SUBCOMMANDS: &[&str] = &["service", "start", "stop", "status", "devices", "setup", "upgrade", "--version"];

pub(crate) fn mercury_home() -> PathBuf {
    if let Ok(home) = env::var("MERCURY_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".mercury")
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "mercury.exe"
    } else {
        "mercury"
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// A Command that never flashes a console window on Windows.
pub(crate) fn quiet_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn find_binary(home: &Path) -> Option<PathBuf> {
    let mut candidates = vec![home.join("bin").join(binary_name())];
    if let Some(user) = dirs::home_dir() {
        candidates.push(user.join(".local").join("bin").join(binary_name()));
    }
    if !cfg!(windows) {
        candidates.push(PathBuf::from("/opt/homebrew/bin/mercury"));
        candidates.push(PathBuf::from("/usr/local/bin/mercury"));
    }
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            candidates.push(dir.join(binary_name()));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn binary_version(bin: &Path) -> Option<String> {
    let output = quiet_command(bin).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(|l| l.trim().trim_start_matches('v'))
        .find(|l| l.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.to_string())
}

/// The dashboard port: MERCURY_PORT, else `web.port` in mercury.yaml, else
/// the default. A two-level scan is enough for a key we also write.
fn web_port(home: &Path) -> u16 {
    if let Ok(raw) = env::var("MERCURY_PORT") {
        if let Ok(port) = raw.trim().parse::<u16>() {
            if port > 0 {
                return port;
            }
        }
    }
    if let Ok(yaml) = fs::read_to_string(home.join("mercury.yaml")) {
        let mut in_web = false;
        for line in yaml.lines() {
            let line = line.trim_end();
            if line.is_empty() || line.trim_start().starts_with('#') {
                continue;
            }
            let indented = line.starts_with(' ') || line.starts_with('\t');
            if !indented {
                in_web = line.trim() == "web:";
                continue;
            }
            if in_web {
                if let Some(rest) = line.trim_start().strip_prefix("port:") {
                    let value = rest.trim().trim_matches('"').trim_matches('\'');
                    if let Ok(port) = value.parse::<u16>() {
                        if port > 0 {
                            return port;
                        }
                    }
                }
            }
        }
    }
    DEFAULT_PORT
}

fn service_installed() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    if cfg!(target_os = "macos") {
        return home
            .join("Library/LaunchAgents/com.cosmicstack.mercury.plist")
            .is_file();
    }
    if cfg!(target_os = "linux") {
        return home.join(".config/systemd/user/mercury.service").is_file();
    }
    if cfg!(windows) {
        return quiet_command(Path::new("schtasks"))
            .args(["/query", "/tn", "MercuryAgent"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    false
}

#[tauri::command]
pub fn detect_local_runtime() -> LocalRuntime {
    let home = mercury_home();
    let binary = find_binary(&home);
    let version = binary.as_deref().and_then(binary_version);
    LocalRuntime {
        mercury_home: home.to_string_lossy().into_owned(),
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        binary_version: version,
        port: web_port(&home),
        attach_token_present: home.join("attach-token").is_file(),
        service_installed: service_installed(),
        platform: platform(),
    }
}

/// `GET /api/health` on loopback, from the native side. The webview cannot
/// ask directly when the runtime predates CORS support (< 1.5.0): the browser
/// hides the answer. From here we see the real thing and can tell the user
/// "found, but needs an upgrade" instead of "not running".
#[tauri::command]
pub async fn probe_local_health(port: u16) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2500))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("http://127.0.0.1:{port}/api/health"))
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("status {}", res.status()));
    }
    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// The runtime's per-boot, owner-only attach token (src/web/auth.ts). The
/// app runs as the same user, so reading it is the same trust the CLI has.
#[tauri::command]
pub fn read_attach_token() -> Option<String> {
    let token = fs::read_to_string(mercury_home().join("attach-token")).ok()?;
    let token = token.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Run the installed `mercury` with an allow-listed subcommand, e.g.
/// `["start", "--daemon"]` or `["service", "install"]`.
#[tauri::command]
pub async fn run_mercury(args: Vec<String>) -> Result<CommandOutput, String> {
    let first = args
        .first()
        .cloned()
        .ok_or_else(|| "missing subcommand".to_string())?;
    if !ALLOWED_SUBCOMMANDS.contains(&first.as_str()) {
        return Err(format!(
            "`mercury {first}` is not something Mercury Desktop runs"
        ));
    }
    if args.iter().any(|a| a.contains('\0')) {
        return Err("bad argument".to_string());
    }
    let home = mercury_home();
    let bin = find_binary(&home)
        .ok_or_else(|| "Mercury is not installed on this computer".to_string())?;

    let output = tauri::async_runtime::spawn_blocking(move || {
        quiet_command(&bin).args(&args).output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(CommandOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_web_port_from_yaml() {
        let dir = std::env::temp_dir().join(format!("mercury-desktop-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("mercury.yaml"),
            "agent:\n  name: x\nweb:\n  enabled: true\n  port: 7000\nmcp: {}\n",
        )
        .unwrap();
        env::remove_var("MERCURY_PORT");
        assert_eq!(web_port(&dir), 7000);
        fs::write(dir.join("mercury.yaml"), "web:\n  enabled: true\n").unwrap();
        assert_eq!(web_port(&dir), DEFAULT_PORT);
        fs::remove_dir_all(&dir).unwrap();
    }
}
