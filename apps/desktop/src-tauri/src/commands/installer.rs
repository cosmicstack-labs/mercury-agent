//! Install the Mercury runtime on this computer from a GitHub release —
//! the same steps as scripts/install.sh, done natively so the user never
//! sees a terminal:
//!
//!   1. resolve the latest runtime release tag (`/releases/latest` redirect);
//!   2. download checksums.txt, the binary for this CPU, and web.tar.gz;
//!   3. verify both SHA-256s against checksums.txt;
//!   4. extract web.tar.gz into a staging dir (no `..`, no absolute paths);
//!   5. move the binary to ~/.mercury/bin/mercury(.exe) and the `web/` dir
//!      beside it, atomically enough that a crash never leaves a half
//!      install (the old copy is kept until the new one is in place);
//!   6. clear macOS quarantine.
//!
//! Progress is emitted as `runtime-install-progress` events. The frontend
//! then runs `mercury setup --headless`, `mercury service install` and
//! `mercury start` through `run_mercury`.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};

const REPO: &str = "cosmicstack-labs/mercury-agent";
const USER_AGENT: &str = concat!("mercury-desktop/", env!("CARGO_PKG_VERSION"));
const WEB_ARCHIVE: &str = "web.tar.gz";
const CHECKSUMS: &str = "checksums.txt";
/// A release binary is ~90 MB; refuse anything absurd before writing it.
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub phase: &'static str,
    pub message: String,
    /// 0–100 when known, otherwise null.
    pub percent: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntime {
    pub version: String,
    pub binary_path: String,
}

fn emit(app: &AppHandle, phase: &'static str, message: impl Into<String>, percent: Option<u8>) {
    let _ = app.emit(
        "runtime-install-progress",
        InstallProgress { phase, message: message.into(), percent },
    );
}

/// The release asset for this machine, mirroring scripts/build-bin.cjs.
fn asset_name() -> Result<&'static str, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Ok("mercury-macos-arm64");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Ok("mercury-macos-x64");
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return Ok("mercury-linux-arm64");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        // Bun's x64 build assumes AVX2; older CPUs get the baseline build.
        if std::arch::is_x86_feature_detected!("avx2") {
            return Ok("mercury-linux-x64");
        }
        return Ok("mercury-linux-x64-baseline");
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        if std::arch::is_x86_feature_detected!("avx2") {
            return Ok("mercury-win-x64.exe");
        }
        return Ok("mercury-win-x64-baseline.exe");
    }
    #[allow(unreachable_code)]
    Err("Mercury has no prebuilt runtime for this platform".to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

/// A build made for testers installs one named release instead of the
/// latest stable one: `MERCURY_RUNTIME_TAG=mercury-dev-latest` at build time
/// points it at the rolling dev pre-release.
const PINNED_TAG: Option<&str> = option_env!("MERCURY_RUNTIME_TAG");

/// `/releases/latest` answers with a redirect to `/releases/tag/vX.Y.Z`.
async fn latest_tag() -> Result<String, String> {
    if let Some(tag) = PINNED_TAG.map(str::trim).filter(|t| !t.is_empty()) {
        return Ok(tag.to_string());
    }
    let no_redirect = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let res = no_redirect
        .get(format!("https://github.com/{REPO}/releases/latest"))
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;
    let location = res
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "GitHub did not say which release is latest".to_string())?;
    let tag = location
        .rsplit('/')
        .next()
        .filter(|t| t.starts_with('v') && t.len() > 1)
        .ok_or_else(|| format!("Unexpected release location: {location}"))?;
    Ok(tag.to_string())
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{url} answered {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

/// `checksums.txt` lines are `<sha256>  <asset>`; exactly one line per asset.
fn checksum_for(checksums: &str, asset: &str) -> Result<String, String> {
    let mut found: Vec<&str> = Vec::new();
    for line in checksums.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(hash), Some(name)) = (parts.next(), parts.next()) {
            if name == asset {
                found.push(hash);
            }
        }
    }
    match found.as_slice() {
        [hash] if hash.len() == 64 => Ok(hash.to_ascii_lowercase()),
        [] => Err(format!("checksums.txt has no entry for {asset}")),
        _ => Err(format!("checksums.txt lists {asset} more than once")),
    }
}

async fn download_verified(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_sha256: &str,
    label: &str,
) -> Result<(), String> {
    let mut res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{label}: download answered {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err(format!("{label}: release asset is unexpectedly large"));
    }
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_percent: u8 = 0;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        received += chunk.len() as u64;
        if received > MAX_DOWNLOAD_BYTES {
            return Err(format!("{label}: download exceeded the size limit"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        if let Some(ratio) = (received * 100).checked_div(total) {
            let percent = ratio.min(100) as u8;
            if percent != last_percent {
                last_percent = percent;
                emit(app, "download", format!("Downloading {label}"), Some(percent));
            }
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_sha256 {
        let _ = fs::remove_file(dest);
        return Err(format!("{label}: checksum mismatch (expected {expected_sha256}, got {actual})"));
    }
    Ok(())
}

/// Extract web.tar.gz into `stage`, refusing anything that would escape it.
fn extract_web(archive: &Path, stage: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.set_preserve_permissions(false);
    tar.set_unpack_xattrs(false);
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let unsafe_path = path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_)));
        if unsafe_path {
            return Err(format!("web.tar.gz contains an unsafe path: {}", path.display()));
        }
        // Links could point outside the stage dir; the dashboard has none.
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(format!("web.tar.gz contains a link: {}", path.display()));
        }
        entry.unpack_in(stage).map_err(|e| e.to_string())?;
    }
    let web = stage.join("web");
    if !web.is_dir() {
        return Err("web.tar.gz does not contain the required web directory".to_string());
    }
    Ok(web)
}

fn replace_dir(from: &Path, to: &Path) -> Result<(), String> {
    let old = to.with_extension("old");
    let _ = fs::remove_dir_all(&old);
    if to.exists() {
        fs::rename(to, &old).map_err(|e| format!("could not move aside {}: {e}", to.display()))?;
    }
    if let Err(e) = fs::rename(from, to) {
        // Put the old one back before reporting.
        let _ = fs::rename(&old, to);
        return Err(format!("could not install {}: {e}", to.display()));
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

fn install_binary(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(from, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    // A running Windows executable cannot be overwritten; it can be renamed.
    let old = to.with_extension("old");
    let _ = fs::remove_file(&old);
    if to.exists() {
        fs::rename(to, &old).map_err(|e| format!("could not move aside the current binary: {e}"))?;
    }
    if let Err(e) = fs::rename(from, to) {
        let _ = fs::rename(&old, to);
        return Err(format!("could not install the binary: {e}"));
    }
    let _ = fs::remove_file(&old);
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(to)
            .output();
    }
    Ok(())
}

fn read_version(bin: &Path) -> Option<String> {
    let output = super::local::quiet_command(bin).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(|l| l.trim().trim_start_matches('v'))
        .find(|l| l.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.to_string())
}

/// Download, verify and install the latest Mercury runtime into ~/.mercury/bin.
#[tauri::command]
pub async fn install_runtime(app: AppHandle) -> Result<InstalledRuntime, String> {
    let asset = asset_name()?;
    let home = super::local::mercury_home();
    let bin_dir = home.join("bin");
    let tmp = home.join("tmp").join(format!("install-{}", std::process::id()));
    fs::create_dir_all(&tmp).map_err(|e| format!("could not create {}: {e}", tmp.display()))?;
    fs::create_dir_all(&bin_dir).map_err(|e| format!("could not create {}: {e}", bin_dir.display()))?;

    let result = install_into(&app, asset, &bin_dir, &tmp).await;
    let _ = fs::remove_dir_all(&tmp);
    result
}

async fn install_into(app: &AppHandle, asset: &str, bin_dir: &Path, tmp: &Path) -> Result<InstalledRuntime, String> {
    emit(app, "resolve", "Finding the latest Mercury release", None);
    let tag = latest_tag().await?;
    let release = format!("https://github.com/{REPO}/releases/download/{tag}");
    let client = client()?;

    emit(app, "checksums", format!("Mercury {tag}: fetching checksums"), None);
    let checksums = fetch_text(&client, &format!("{release}/{CHECKSUMS}")).await?;
    let expected_binary = checksum_for(&checksums, asset)?;
    let expected_web = checksum_for(&checksums, WEB_ARCHIVE)?;

    let binary_tmp = tmp.join(asset);
    let web_tmp = tmp.join(WEB_ARCHIVE);
    download_verified(app, &client, &format!("{release}/{asset}"), &binary_tmp, &expected_binary, "the Mercury runtime").await?;
    download_verified(app, &client, &format!("{release}/{WEB_ARCHIVE}"), &web_tmp, &expected_web, "the dashboard").await?;

    emit(app, "extract", "Unpacking the dashboard", None);
    let stage = tmp.join("stage");
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let staged_web = tauri::async_runtime::spawn_blocking({
        let web_tmp = web_tmp.clone();
        let stage = stage.clone();
        move || extract_web(&web_tmp, &stage)
    })
    .await
    .map_err(|e| e.to_string())??;

    emit(app, "install", "Installing into ~/.mercury/bin", None);
    let binary_name = if cfg!(windows) { "mercury.exe" } else { "mercury" };
    let bin_path = bin_dir.join(binary_name);
    replace_dir(&staged_web, &bin_dir.join("web"))?;
    install_binary(&binary_tmp, &bin_path)?;

    let version = read_version(&bin_path).unwrap_or_else(|| tag.trim_start_matches('v').to_string());
    emit(app, "done", format!("Mercury {version} installed"), Some(100));
    Ok(InstalledRuntime { version, binary_path: bin_path.to_string_lossy().into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_exactly_one_checksum() {
        let text = "aaaa  web.tar.gz\n".to_string()
            + &format!("{}  mercury-macos-arm64\n", "b".repeat(64))
            + &format!("{}  web.tar.gz\n", "c".repeat(64));
        assert_eq!(checksum_for(&text, "mercury-macos-arm64").unwrap(), "b".repeat(64));
        assert!(checksum_for(&text, "web.tar.gz").is_err()); // listed twice
        assert!(checksum_for(&text, "nope").is_err());
    }
}
