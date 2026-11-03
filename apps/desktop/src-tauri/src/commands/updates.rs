//! Updates for Mercury Desktop itself, and the signed update manifest
//! (UPDATES.md).
//!
//!  - `updates_manifest`: fetch `manifest.json` + `.sig`, verify the minisign
//!    signature with the updater's public key (the one in tauri.conf.json:
//!    one key signs packages and the manifest), refuse a manifest older than
//!    one already seen (replay), cache it for six hours. Unverified → the UI
//!    ignores everything that would force or announce.
//!  - `desktop_update_check` / `_download` / `_install`: the Tauri updater
//!    finds the release; the download is ours, because the plugin's starts
//!    from zero every time. Ours resumes (HTTP Range + If-Range on the ETag),
//!    retries with back-off, notices a stalled connection, keeps the bytes in
//!    the cache folder across restarts, and only marks a package ready after
//!    its signature checks out (a bad one is deleted so the next try is clean).
//!  - A ready package installs when the user says so, or when they quit
//!    (on by default, like most editors).

use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const USER_AGENT: &str = concat!("mercury-desktop/", env!("CARGO_PKG_VERSION"));
const MANIFEST_URLS: [&str; 2] = [
    "https://mercuryagent.sh/updates/manifest.json",
    "https://raw.githubusercontent.com/cosmicstack-labs/mercury-agent/main/website/static/updates/manifest.json",
];
const MANIFEST_TTL_MS: u64 = 6 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES: usize = 512 * 1024;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
const ATTEMPTS: u32 = 5;
/// No byte for this long = the connection is dead; reconnect and resume.
const STALL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct UpdaterState {
    update: Mutex<Option<Update>>,
    downloading: AtomicBool,
    /// "Cancel" on a running download: it stops and keeps its bytes (it resumes next time).
    cancel: AtomicBool,
    install_on_quit: AtomicBool,
}

impl UpdaterState {
    pub fn new() -> Self {
        let s = Self::default();
        s.install_on_quit.store(true, Ordering::Relaxed);
        s
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

/* ── the manifest ─────────────────────────────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestResult {
    manifest: Option<Value>,
    verified: bool,
    checked_at: Option<u64>,
    error: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ManifestCache {
    text: Option<String>,
    sig: Option<String>,
    checked_at: u64,
    /// The newest `issuedAt` ever accepted: an older manifest is a replay.
    highest_issued_at: Option<String>,
}

fn updates_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("updates");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_cache(app: &AppHandle) -> ManifestCache {
    updates_data_dir(app)
        .ok()
        .and_then(|d| fs::read_to_string(d.join("manifest-cache.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_cache(app: &AppHandle, cache: &ManifestCache) {
    if let Ok(dir) = updates_data_dir(app) {
        if let Ok(text) = serde_json::to_string(cache) {
            let tmp = dir.join("manifest-cache.json.tmp");
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(tmp, dir.join("manifest-cache.json"));
            }
        }
    }
}

/// The updater's public key from tauri.conf.json (base64 of the minisign `.pub` text).
fn updater_pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(str::to_string)
        .filter(|k| !k.trim().is_empty())
}

fn b64_text(s: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("bad base64: {e}"))?;
    String::from_utf8(bytes).map_err(|_| "not text".to_string())
}

/// `sig` is what `tauri signer sign` writes: base64 of the `.minisig` text.
pub fn verify_minisign(pubkey_b64: &str, data: &[u8], sig_b64: &str) -> Result<(), String> {
    let pk = minisign_verify::PublicKey::decode(&b64_text(pubkey_b64)?).map_err(|e| format!("public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(&b64_text(sig_b64)?).map_err(|e| format!("signature: {e}"))?;
    pk.verify(data, &sig, false).map_err(|e| format!("signature does not match: {e}"))
}

fn issued_at(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text).ok()?.get("issuedAt")?.as_str().map(str::to_string)
}

/// RFC 3339 timestamps in UTC ("…Z") compare as strings; anything else is treated as unknown.
fn older(a: &str, b: &str) -> bool {
    a.ends_with('Z') && b.ends_with('Z') && a < b
}

async fn fetch_limited(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = client.get(url).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{url} answered {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("manifest too large".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "manifest is not text".into())
}

fn result_from(pubkey: Option<&str>, text: Option<&str>, sig: Option<&str>, checked_at: u64, error: Option<String>) -> ManifestResult {
    let Some(text) = text else {
        return ManifestResult { manifest: None, verified: false, checked_at: (checked_at > 0).then_some(checked_at), error };
    };
    let verified = match (pubkey, sig) {
        (Some(pk), Some(sig)) => verify_minisign(pk, text.as_bytes(), sig).is_ok(),
        _ => false,
    };
    ManifestResult {
        manifest: serde_json::from_str(text).ok(),
        verified,
        checked_at: Some(checked_at),
        error,
    }
}

#[tauri::command]
pub async fn updates_manifest(app: AppHandle, force: bool) -> Result<ManifestResult, String> {
    let pubkey = updater_pubkey(&app);
    let mut cache = read_cache(&app);
    if !force && cache.text.is_some() && now_ms().saturating_sub(cache.checked_at) < MANIFEST_TTL_MS {
        return Ok(result_from(pubkey.as_deref(), cache.text.as_deref(), cache.sig.as_deref(), cache.checked_at, None));
    }

    let client = http()?;
    let mut last_error: Option<String> = None;
    for url in MANIFEST_URLS {
        let text = match fetch_limited(&client, url).await {
            Ok(t) => t,
            Err(e) => { last_error = Some(e); continue; }
        };
        let sig = match fetch_limited(&client, &format!("{url}.sig")).await {
            Ok(s) => s,
            Err(e) => { last_error = Some(format!("no signature: {e}")); continue; }
        };
        let Some(pk) = pubkey.as_deref() else {
            last_error = Some("this build has no update key".into());
            break;
        };
        if let Err(e) = verify_minisign(pk, text.as_bytes(), &sig) {
            // A mirror serving a bad file must not hide a good one.
            last_error = Some(e);
            continue;
        }
        let issued = issued_at(&text);
        if let (Some(new), Some(seen)) = (issued.as_deref(), cache.highest_issued_at.as_deref()) {
            if older(new, seen) {
                last_error = Some("the manifest served is older than one already seen".into());
                continue;
            }
        }
        cache.text = Some(text);
        cache.sig = Some(sig);
        cache.checked_at = now_ms();
        if issued.is_some() {
            cache.highest_issued_at = issued;
        }
        write_cache(&app, &cache);
        return Ok(result_from(pubkey.as_deref(), cache.text.as_deref(), cache.sig.as_deref(), cache.checked_at, None));
    }
    // Offline or refused: what we had (still verified on its own merits), and why.
    Ok(result_from(pubkey.as_deref(), cache.text.as_deref(), cache.sig.as_deref(), cache.checked_at, last_error))
}

/* ── the desktop's own update ─────────────────────────────────── */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    date: Option<String>,
    notes: Option<String>,
    /// Downloaded and verified: installing is a restart away.
    ready: bool,
    /// Bytes already on disk from an earlier, interrupted download.
    partial_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    phase: &'static str,
    version: String,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<f64>,
    bytes_per_sec: Option<f64>,
    attempt: u32,
    message: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartMeta {
    url: String,
    etag: Option<String>,
    total: Option<u64>,
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Only characters a version has; never a path.
fn safe_version(v: &str) -> String {
    v.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')).collect()
}

fn part_path(dir: &Path, v: &str) -> PathBuf { dir.join(format!("{}.part", safe_version(v))) }
fn meta_path(dir: &Path, v: &str) -> PathBuf { dir.join(format!("{}.part.json", safe_version(v))) }
fn ready_path(dir: &Path, v: &str) -> PathBuf { dir.join(format!("{}.ready", safe_version(v))) }
fn pending_path(dir: &Path) -> PathBuf { dir.join("pending.json") }

/// Keep only the files of `keep` (or nothing).
fn clean_other_versions(dir: &Path, keep: Option<&str>) {
    let keep = keep.map(safe_version);
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == "pending.json" { continue; }
        let mine = keep.as_deref().is_some_and(|k| name == format!("{k}.part") || name == format!("{k}.part.json") || name == format!("{k}.ready"));
        if !mine { let _ = fs::remove_file(e.path()); }
    }
}

fn info_of(update: &Update, dir: &Path) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.map(|d| d.to_string()),
        notes: update.body.clone(),
        ready: ready_path(dir, &update.version).exists(),
        partial_bytes: fs::metadata(part_path(dir, &update.version)).map(|m| m.len()).unwrap_or(0),
    }
}

/// The update found last, or the one found before a restart (its manifest was kept).
fn current_update(app: &AppHandle, state: &UpdaterState) -> Option<Update> {
    if let Some(u) = state.update.lock().ok().and_then(|g| g.clone()) {
        return Some(u);
    }
    let dir = cache_dir(app).ok()?;
    let raw: Value = serde_json::from_str(&fs::read_to_string(pending_path(&dir)).ok()?).ok()?;
    let update = app.updater().ok()?.restore_update(raw).ok().flatten()?;
    if let Ok(mut g) = state.update.lock() { *g = Some(update.clone()); }
    Some(update)
}

#[tauri::command]
pub async fn desktop_update_check(app: AppHandle, state: State<'_, UpdaterState>) -> Result<Option<UpdateInfo>, String> {
    let dir = cache_dir(&app)?;
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    match found {
        Some(update) => {
            let _ = fs::write(pending_path(&dir), serde_json::to_string(&update.raw_json).unwrap_or_default());
            clean_other_versions(&dir, Some(&update.version));
            let info = info_of(&update, &dir);
            if let Ok(mut g) = state.update.lock() { *g = Some(update); }
            Ok(Some(info))
        }
        None => {
            // Up to date (or the release was pulled): nothing to keep.
            let _ = fs::remove_file(pending_path(&dir));
            clean_other_versions(&dir, None);
            if let Ok(mut g) = state.update.lock() { *g = None; }
            Ok(None)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateStatus {
    current_version: String,
    pending: Option<UpdateInfo>,
    downloading: bool,
    install_on_quit: bool,
}

#[tauri::command]
pub fn desktop_update_status(app: AppHandle, state: State<'_, UpdaterState>) -> Result<DesktopUpdateStatus, String> {
    let dir = cache_dir(&app)?;
    let current = app.package_info().version.to_string();
    let pending = current_update(&app, &state).filter(|u| u.version != current).map(|u| info_of(&u, &dir));
    Ok(DesktopUpdateStatus {
        current_version: current,
        pending,
        downloading: state.downloading.load(Ordering::Relaxed),
        install_on_quit: state.install_on_quit.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub fn desktop_update_set_install_on_quit(state: State<'_, UpdaterState>, enabled: bool) {
    state.install_on_quit.store(enabled, Ordering::Relaxed);
}

struct Emitting<'a> {
    app: &'a AppHandle,
    version: String,
    attempt: u32,
}

impl Emitting<'_> {
    fn send(&self, phase: &'static str, downloaded: u64, total: Option<u64>, bps: Option<f64>, message: impl Into<String>) {
        let percent = total.filter(|t| *t > 0).map(|t| (downloaded as f64 / t as f64 * 100.0).min(100.0));
        let _ = self.app.emit(
            "desktop-update-progress",
            DownloadProgress { phase, version: self.version.clone(), downloaded, total, percent, bytes_per_sec: bps, attempt: self.attempt, message: message.into() },
        );
    }
}

enum Fail {
    /// Worth another try (network, 5xx, stall).
    Retry(String),
    /// Won't get better by retrying (404, too large, disk).
    Stop(String),
    /// The user cancelled.
    Cancelled,
}

/// `Content-Range: bytes 100-999/1000` → 1000.
fn total_from_content_range(v: &str) -> Option<u64> {
    v.rsplit('/').next()?.trim().parse().ok()
}

/// One attempt: continue from what's on disk when the server allows it.
async fn fetch_once(client: &reqwest::Client, url: &str, dir: &Path, version: &str, em: &Emitting<'_>, cancel: &AtomicBool) -> Result<(), Fail> {
    let part = part_path(dir, version);
    let meta_file = meta_path(dir, version);
    let mut meta: PartMeta = fs::read_to_string(&meta_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if meta.url != url {
        // Another URL (a re-published release): the old bytes aren't this file's.
        have = 0;
        let _ = fs::remove_file(&part);
        meta = PartMeta { url: url.to_string(), ..Default::default() };
    }
    if have > 0 && meta.total == Some(have) {
        return Ok(());
    }

    let mut req = client.get(url).header(reqwest::header::ACCEPT, "application/octet-stream");
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        // If the file changed since, the server sends all of it (200) instead of a mismatched tail.
        if let Some(etag) = meta.etag.as_deref() {
            req = req.header(reqwest::header::IF_RANGE, etag);
        }
    }
    let mut res = req.send().await.map_err(|e| Fail::Retry(format!("couldn't connect: {e}")))?;
    let status = res.status();
    let append = match status.as_u16() {
        206 => true,
        200 => false,
        416 if have > 0 => {
            // We already have every byte (or the file shrank): start over cleanly next time.
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&meta_file);
            return Err(Fail::Retry("the download restarts from the beginning".into()));
        }
        408 | 429 | 500..=599 => return Err(Fail::Retry(format!("the server answered {status}"))),
        _ => return Err(Fail::Stop(format!("the server answered {status}"))),
    };
    let headers = res.headers().clone();
    let etag = headers.get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    let total = if append {
        headers.get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(total_from_content_range)
    } else {
        res.content_length()
    };
    if total.is_some_and(|t| t > MAX_PACKAGE_BYTES) {
        return Err(Fail::Stop("the update is unexpectedly large".into()));
    }
    meta.etag = etag.or(meta.etag);
    meta.total = total.or(meta.total);
    let _ = fs::write(&meta_file, serde_json::to_string(&meta).unwrap_or_default());

    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&part)
        .map_err(|e| Fail::Stop(format!("can't write the download: {e}")))?;
    let mut done = if append { have } else { 0 };
    let started = Instant::now();
    let start_bytes = done;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        let chunk = match tokio::time::timeout(STALL, res.chunk()).await {
            Err(_) => return Err(Fail::Retry("the connection stalled".into())),
            Ok(Err(e)) => return Err(Fail::Retry(format!("the connection dropped: {e}"))),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(c))) => c,
        };
        if cancel.load(Ordering::Relaxed) {
            let _ = file.flush();
            return Err(Fail::Cancelled);
        }
        file.write_all(&chunk).map_err(|e| Fail::Stop(format!("can't write the download (disk full?): {e}")))?;
        done += chunk.len() as u64;
        if done > MAX_PACKAGE_BYTES {
            return Err(Fail::Stop("the update is unexpectedly large".into()));
        }
        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = Instant::now();
            let secs = started.elapsed().as_secs_f64();
            let bps = (secs > 0.5).then(|| (done - start_bytes) as f64 / secs);
            em.send("downloading", done, meta.total, bps, "Downloading");
        }
    }
    file.flush().map_err(|e| Fail::Stop(e.to_string()))?;
    if let Some(t) = meta.total {
        if done < t {
            return Err(Fail::Retry("the download ended early".into()));
        }
    }
    meta.total = Some(done);
    let _ = fs::write(&meta_file, serde_json::to_string(&meta).unwrap_or_default());
    Ok(())
}

/// The error a cancelled download returns (the app shows no error for it).
const CANCELLED: &str = "Download cancelled.";

/// Stop a running download. Its bytes stay: "Resume download" continues from there.
#[tauri::command]
pub fn desktop_update_cancel(state: State<'_, UpdaterState>) {
    if state.downloading.load(Ordering::Relaxed) {
        state.cancel.store(true, Ordering::Relaxed);
    }
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::Relaxed); }
}

#[tauri::command]
pub async fn desktop_update_download(app: AppHandle, state: State<'_, UpdaterState>) -> Result<UpdateInfo, String> {
    let update = current_update(&app, &state).ok_or("No update to download. Check for updates first.")?;
    let dir = cache_dir(&app)?;
    if ready_path(&dir, &update.version).exists() {
        return Ok(info_of(&update, &dir));
    }
    if state.downloading.swap(true, Ordering::Relaxed) {
        return Err("Already downloading.".into());
    }
    let _busy = Busy(&state.downloading);
    state.cancel.store(false, Ordering::Relaxed);
    let client = http()?;
    let url = update.download_url.to_string();
    let mut em = Emitting { app: &app, version: update.version.clone(), attempt: 1 };
    em.send("downloading", fs::metadata(part_path(&dir, &update.version)).map(|m| m.len()).unwrap_or(0), None, None, "Starting the download");

    let mut last = String::new();
    let mut ok = false;
    for attempt in 1..=ATTEMPTS {
        em.attempt = attempt;
        match fetch_once(&client, &url, &dir, &update.version, &em, &state.cancel).await {
            Ok(()) => { ok = true; break; }
            Err(Fail::Cancelled) => {
                let have = fs::metadata(part_path(&dir, &update.version)).map(|m| m.len()).unwrap_or(0);
                em.send("cancelled", have, None, None, "Download cancelled");
                return Err(CANCELLED.into());
            }
            Err(Fail::Stop(e)) => { last = e; break; }
            Err(Fail::Retry(e)) => {
                last = e;
                if attempt == ATTEMPTS { break; }
                let wait = Duration::from_secs((2u64 << attempt).min(30));
                let have = fs::metadata(part_path(&dir, &update.version)).map(|m| m.len()).unwrap_or(0);
                em.send("retrying", have, None, None, format!("{last}. Trying again in {} s (attempt {} of {ATTEMPTS})", wait.as_secs(), attempt + 1));
                tokio::time::sleep(wait).await;
                if state.cancel.load(Ordering::Relaxed) {
                    em.send("cancelled", have, None, None, "Download cancelled");
                    return Err(CANCELLED.into());
                }
            }
        }
    }
    if !ok {
        let have = fs::metadata(part_path(&dir, &update.version)).map(|m| m.len()).unwrap_or(0);
        em.send("error", have, None, None, last.clone());
        return Err(if have > 0 { format!("Download paused: {last}. It continues from here next time.") } else { format!("Download failed: {last}.") });
    }

    em.send("verifying", 0, None, None, "Checking the signature");
    let part = part_path(&dir, &update.version);
    let bytes = fs::read(&part).map_err(|e| e.to_string())?;
    if let Err(e) = update.verify(&bytes) {
        // Never keep (or resume) bytes that don't match: the next try starts clean.
        let _ = fs::remove_file(&part);
        let _ = fs::remove_file(meta_path(&dir, &update.version));
        let msg = format!("The download didn't match its signature and was deleted ({e}). Try again.");
        em.send("error", 0, None, None, msg.clone());
        return Err(msg);
    }
    fs::rename(&part, ready_path(&dir, &update.version)).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(meta_path(&dir, &update.version));
    em.send("ready", bytes.len() as u64, Some(bytes.len() as u64), None, "Ready to install");
    Ok(info_of(&update, &dir))
}

fn install_ready(app: &AppHandle, state: &UpdaterState, restart_after: bool) -> Result<(), String> {
    let update = current_update(app, state).ok_or("No update is ready.")?;
    let dir = cache_dir(app)?;
    let ready = ready_path(&dir, &update.version);
    let bytes = fs::read(&ready).map_err(|_| "The update isn't downloaded yet.".to_string())?;
    // `install` verifies again: a package changed on disk is refused.
    let update = update.restart_after_install(restart_after);
    if let Err(e) = update.install(&bytes) {
        let _ = fs::remove_file(&ready);
        return Err(format!("Installing failed: {e}. The package was removed; it downloads again next time."));
    }
    let _ = fs::remove_file(&ready);
    let _ = fs::remove_file(pending_path(&dir));
    Ok(())
}

#[tauri::command]
pub fn desktop_update_install(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    install_ready(&app, &state, true)?;
    // Windows has exited into the installer by now; macOS and Linux relaunch.
    app.restart();
}

/// Quitting with a downloaded update installs it, unless turned off.
pub fn install_on_quit(app: &AppHandle) {
    let Some(state) = app.try_state::<UpdaterState>() else { return };
    if !state.install_on_quit.load(Ordering::Relaxed) || state.downloading.load(Ordering::Relaxed) {
        return;
    }
    let Some(update) = current_update(app, &state) else { return };
    let Ok(dir) = cache_dir(app) else { return };
    if !ready_path(&dir, &update.version).exists() {
        return;
    }
    if let Err(e) = install_ready(app, &state, false) {
        log::warn!("install on quit: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_total() {
        assert_eq!(total_from_content_range("bytes 100-999/1000"), Some(1000));
        assert_eq!(total_from_content_range("bytes 0-0/*"), None);
    }

    #[test]
    fn versions_never_become_paths() {
        assert_eq!(safe_version("../../etc/passwd"), "....etcpasswd");
        assert_eq!(safe_version("0.2.0-beta.1"), "0.2.0-beta.1");
    }

    #[test]
    fn replay_order() {
        assert!(older("2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z"));
        assert!(!older("2026-11-03T00:00:00Z", "2026-11-03T00:00:00Z"));
        assert!(!older("garbage", "2026-11-03T00:00:00Z"));
    }

    #[test]
    fn cleans_other_versions_only() {
        let dir = std::env::temp_dir().join(format!("mercury-upd-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        for f in ["0.2.0.part", "0.2.0.part.json", "0.1.9.ready", "pending.json"] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        clean_other_versions(&dir, Some("0.2.0"));
        assert!(dir.join("0.2.0.part").exists());
        assert!(dir.join("0.2.0.part.json").exists());
        assert!(!dir.join("0.1.9.ready").exists());
        assert!(dir.join("pending.json").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_a_bad_signature() {
        let conf: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let key = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert!(verify_minisign(key, b"hello", "bm90IGEgc2lnbmF0dXJl").is_err());
    }

    #[test]
    fn verifies_a_manifest_signed_with_the_update_key() {
        let conf: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let key = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        let data = include_bytes!("testdata/manifest.json");
        let sig = include_str!("testdata/manifest.json.sig");
        assert!(verify_minisign(key, data, sig).is_ok());
        // One byte changed: refused.
        let mut tampered = data.to_vec();
        tampered[2] ^= 1;
        assert!(verify_minisign(key, &tampered, sig).is_err());
    }
}
