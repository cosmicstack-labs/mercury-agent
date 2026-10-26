//! mercury-wa: the WhatsApp side of the Mercury WhatsApp plugin.
//!
//! Mercury starts this program and talks to it over stdio, one JSON-RPC 2.0
//! message per line: MCP (`initialize`, `tools/list`, `ping`) plus the
//! Mercury channel extension (plugin API 1.1). See
//! website/docs/reference/plugins.mdx → "Chat channels".
//!
//! This process only moves messages. Mercury decides who may talk to the
//! agent (owner and members), so nothing here filters senders.
//!
//! stdout is the protocol channel: logs go to stderr only.

mod links;
mod voice;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc, oneshot};
use whatsapp_rust::download::{DownloadLimits, MediaType};
use whatsapp_rust::media::{self, DocumentOptions, ImageOptions};
use whatsapp_rust::pair_code::PairCodeOptions;
use whatsapp_rust::prelude::*;
use whatsapp_rust::upload::UploadOptions;

const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// Writes protocol lines to stdout, in order, from any task, and keeps
/// track of our own requests to Mercury (call decisions, ask_mercury).
#[derive(Clone)]
pub struct Out {
    tx: mpsc::UnboundedSender<Value>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
}

impl Out {
    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.tx.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }
    fn reply(&self, id: &Value, result: Value) {
        let _ = self.tx.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }
    fn error(&self, id: &Value, code: i64, message: impl Into<String>) {
        let _ = self.tx.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } }));
    }
    /// A request to Mercury. Ids are strings ("wa-N") so they never collide with Mercury's numeric ids.
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(n, tx);
        let _ = self.tx.send(json!({ "jsonrpc": "2.0", "id": format!("wa-{n}"), "method": method, "params": params }));
        let r = tokio::time::timeout(timeout, rx).await;
        self.pending.lock().unwrap().remove(&n);
        match r {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => Err("Mercury went away".into()),
            Err(_) => Err(format!("{method} timed out")),
        }
    }
    fn resolve(&self, id: &str, result: Result<Value, String>) {
        let Some(n) = id.strip_prefix("wa-").and_then(|n| n.parse::<u64>().ok()) else { return };
        if let Some(tx) = self.pending.lock().unwrap().remove(&n) {
            let _ = tx.send(result);
        }
    }
    fn status(&self, state: &str, extra: Value) {
        let mut params = json!({ "state": state });
        if let (Some(p), Some(e)) = (params.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                p.insert(k.clone(), v.clone());
            }
        }
        self.notify("mercury/channel/status", params);
    }
}

pub struct State {
    data_dir: PathBuf,
    pub out: Out,
    bot: Mutex<Option<BotHandle>>,
    pub client: Mutex<Option<Arc<Client>>>,
    /// When call_owner last rang the owner (rate limit).
    pub recent_calls: Mutex<Vec<std::time::Instant>>,
    /// Outcomes of outgoing calls being placed.
    pub call_watchers: voice::CallWatchers,
    /// What Mercury is doing right now for each call's pending question (from mercury/call/progress).
    pub call_activity: std::sync::Mutex<HashMap<String, String>>,
    /// Things that happened in the chat during a call (a photo arrived), to mention at the next pause.
    pub call_context: std::sync::Mutex<HashMap<String, Vec<String>>>,
    /// Approvals Mercury needs on a call: (approval id, what it wants to do), per call.
    pub call_approvals: std::sync::Mutex<HashMap<String, Vec<(String, String)>>>,
}

pub fn log(msg: impl AsRef<str>) {
    eprintln!("[mercury-wa] {}", msg.as_ref());
}

fn db_path(dir: &Path) -> PathBuf {
    dir.join("whatsapp.db")
}

/// The user part of a phone-number JID ("15551234567@s.whatsapp.net" → "15551234567").
pub fn phone_of(jid: &Jid) -> Option<String> {
    let s = jid.to_string();
    let (user, server) = s.split_once('@')?;
    if server != "s.whatsapp.net" {
        return None;
    }
    Some(user.split(':').next().unwrap_or(user).to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let data_dir = PathBuf::from(std::env::var("MERCURY_PLUGIN_DATA_DIR").unwrap_or_else(|_| ".".into()));
    std::fs::create_dir_all(data_dir.join("media"))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(v) = rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });
    let out = Out { tx, pending: Arc::new(std::sync::Mutex::new(HashMap::new())), next_id: Arc::new(AtomicU64::new(1)) };
    let state = Arc::new(State {
        data_dir,
        out: out.clone(),
        bot: Mutex::new(None),
        client: Mutex::new(None),
        recent_calls: Mutex::new(Vec::new()),
        call_watchers: Arc::new(Mutex::new(HashMap::new())),
        call_activity: std::sync::Mutex::new(HashMap::new()),
        call_context: std::sync::Mutex::new(HashMap::new()),
        call_approvals: std::sync::Mutex::new(HashMap::new()),
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let st = state.clone();
        tokio::spawn(async move { handle(st, msg).await });
    }
    // Mercury closed stdin: we are being stopped.
    if let Some(bot) = state.bot.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), bot.shutdown()).await;
    }
    Ok(())
}

async fn handle(st: Arc<State>, msg: Value) {
    // A reply to one of our own requests.
    if msg.get("method").is_none() {
        if let Some(id) = msg.get("id").and_then(Value::as_str) {
            let result = match msg.get("error") {
                Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            st.out.resolve(id, result);
        }
        return;
    }
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let Some(id) = msg.get("id").cloned() else {
        // Notifications from Mercury.
        if method == "mercury/call/progress" {
            if let (Some(call), Some(activity)) = (params.get("callId").and_then(Value::as_str), params.get("activity").and_then(Value::as_str)) {
                st.call_activity.lock().unwrap().insert(call.to_string(), activity.chars().take(80).collect());
            }
            return;
        }
        if method == "mercury/call/approval" {
            if let (Some(call), Some(id), Some(prompt)) = (
                params.get("callId").and_then(Value::as_str),
                params.get("approvalId").and_then(Value::as_str),
                params.get("prompt").and_then(Value::as_str),
            ) {
                st.call_approvals.lock().unwrap().entry(call.to_string()).or_default().push((id.to_string(), prompt.chars().take(600).collect()));
            }
            return;
        }
        if method == "mercury/call/approval-resolved" {
            if let (Some(call), Some(id)) = (params.get("callId").and_then(Value::as_str), params.get("approvalId").and_then(Value::as_str)) {
                if let Some(list) = st.call_approvals.lock().unwrap().get_mut(call) {
                    list.retain(|(a, _)| a != id);
                }
                let via = params.get("via").and_then(Value::as_str).unwrap_or("");
                if via != "voice" {
                    let approved = params.get("decision").and_then(Value::as_str) != Some("no");
                    let note = if via == "chat" {
                        format!("RESOLVED:{id}:The owner {} that in the WhatsApp chat.", if approved { "approved" } else { "declined" })
                    } else {
                        format!("RESOLVED:{id}:Nobody answered that approval in time, so it wasn't done. Offer to try again.")
                    };
                    st.call_context.lock().unwrap().entry(call.to_string()).or_default().push(note);
                }
            }
            return;
        }
        if method == "mercury/call/context" {
            if let (Some(call), Some(text)) = (params.get("callId").and_then(Value::as_str), params.get("text").and_then(Value::as_str)) {
                st.call_context.lock().unwrap().entry(call.to_string()).or_default().push(text.chars().take(400).collect());
            }
            return;
        }
        if method == "notifications/initialized" {
            if db_path(&st.data_dir).exists() {
                // Linked before: reconnect with the saved session.
                if let Err(e) = start_bot(st.clone(), None).await {
                    st.out.status("error", json!({ "detail": format!("couldn't start: {e}") }));
                }
            } else {
                st.out.status("needs-pairing", json!({}));
            }
        }
        return;
    };
    let out = st.out.clone();
    let result: Result<Value, String> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "mercury-wa", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [
            {
                "name": "call_owner",
                "description": "Ring the owner on WhatsApp and talk to them by voice. Only the owner can be called.",
                "inputSchema": { "type": "object", "properties": { "reason": { "type": "string", "description": "Why you're calling, in one sentence" } }, "required": ["reason"] },
            },
            {
                "name": "send_to_chat",
                "description": "Send the owner a WhatsApp message (links, lists, details). Only the owner receives it.",
                "inputSchema": { "type": "object", "properties": { "text": { "type": "string", "description": "The message, with any links in full" } }, "required": ["text"] },
            },
        ] })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let result = match name {
                "call_owner" => Some(voice::call_owner(st.clone(), &args).await),
                "send_to_chat" => Some(send_to_owner(st.clone(), &args).await),
                _ => None,
            };
            match result {
                None => Err(format!("unknown tool {name}")),
                Some(r) => Ok(match r {
                    Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                }),
            }
        }
        "mercury/channel/pair" => pair(st.clone(), &params).await,
        "mercury/channel/unlink" => unlink(st.clone()).await,
        "mercury/channel/send" => send_text(st.clone(), &params).await,
        "mercury/channel/sendFile" => send_file(st.clone(), &params).await,
        "mercury/channel/typing" => typing(st.clone(), &params).await,
        _ => {
            out.error(&id, -32601, format!("Method not found: {method}"));
            return;
        }
    };
    match result {
        Ok(v) => out.reply(&id, v),
        Err(e) => out.error(&id, -32000, e),
    }
}

async fn client(st: &State) -> Result<Arc<Client>, String> {
    st.client.lock().await.clone().ok_or_else(|| "WhatsApp is not linked yet. Pair first.".to_string())
}

fn jid_param(params: &Value) -> Result<Jid, String> {
    let s = params.get("chatId").and_then(Value::as_str).ok_or("chatId is required")?;
    s.parse::<Jid>().map_err(|e| format!("bad chatId {s}: {e}"))
}

async fn pair(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let phone = params.get("phone").and_then(Value::as_str).map(|p| p.chars().filter(char::is_ascii_digit).collect::<String>());
    let method = params.get("method").and_then(Value::as_str).unwrap_or("qr");
    if method == "code" && phone.as_deref().unwrap_or("").len() < 6 {
        return Err("a pairing code needs the phone number being linked".into());
    }
    // Already connected?
    if let Some(c) = st.client.lock().await.clone() {
        if c.is_logged_in() {
            st.out.status("connected", json!({ "account": c.pn().and_then(|j| phone_of(&j)) }));
            return Ok(json!({}));
        }
    }
    // Restart linking from scratch so the requested method takes effect.
    if let Some(bot) = st.bot.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), bot.shutdown()).await;
    }
    *st.client.lock().await = None;
    remove_session(&st.data_dir);
    start_bot(st.clone(), if method == "code" { phone } else { None }).await.map_err(|e| e.to_string())?;
    Ok(json!({}))
}

/// The send_to_chat tool: a WhatsApp message to the owner (and only the owner).
async fn send_to_owner(st: Arc<State>, args: &Value) -> Result<String, String> {
    let text = args.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if text.is_empty() { return Err("text is required".into()); }
    let owner: String = voice::settings().get("owner").and_then(Value::as_str).unwrap_or("").chars().filter(char::is_ascii_digit).collect();
    if owner.len() < 6 { return Err("No owner number is set. Run: mercury plugins set whatsapp owner +<number>".into()); }
    let c = client(&st).await?;
    let to: Jid = format!("{owner}@s.whatsapp.net").parse().map_err(|e| format!("bad owner number: {e}"))?;
    let text: String = text.chars().take(4000).collect();
    c.send_text(to, text).await.map_err(|e| e.to_string())?;
    Ok("Sent to the owner's WhatsApp chat.".into())
}

fn remove_session(dir: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(dir.join(format!("whatsapp.db{suffix}")));
    }
}

async fn unlink(st: Arc<State>) -> Result<Value, String> {
    let c = st.client.lock().await.take();
    if let Some(c) = c {
        let _ = tokio::time::timeout(Duration::from_secs(10), c.logout()).await;
    }
    if let Some(bot) = st.bot.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), bot.shutdown()).await;
    }
    remove_session(&st.data_dir);
    st.out.status("logged-out", json!({ "detail": "unlinked by the owner" }));
    Ok(json!({}))
}

async fn send_text(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let c = client(&st).await?;
    let to = jid_param(params)?;
    let text = params.get("text").and_then(Value::as_str).ok_or("text is required")?;
    let sent = c.send_text(to, text).await.map_err(|e| e.to_string())?;
    Ok(json!({ "id": sent.message_id.to_string() }))
}

async fn send_file(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let c = client(&st).await?;
    let to = jid_param(params)?;
    let path = PathBuf::from(params.get("path").and_then(Value::as_str).ok_or("path is required")?);
    let caption = params.get("caption").and_then(Value::as_str).map(str::to_string);
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("can't read {}: {e}", path.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let mime = mime_of(&name);
    let is_image = mime.starts_with("image/") && mime != "image/svg+xml";
    let msg = if is_image {
        let up = c.upload(bytes, MediaType::Image, UploadOptions::default()).await.map_err(|e| e.to_string())?;
        let mut opts = ImageOptions::default().with_mimetype(mime);
        if let Some(cap) = caption {
            opts = opts.with_caption(cap);
        }
        media::image_message(up, opts)
    } else {
        let up = c.upload(bytes, MediaType::Document, UploadOptions::default()).await.map_err(|e| e.to_string())?;
        let mut opts = DocumentOptions::default().with_file_name(name).with_mimetype(mime);
        if let Some(cap) = caption {
            opts = opts.with_caption(cap);
        }
        media::document_message(up, opts)
    };
    let sent = c.send_message(to, msg).await.map_err(|e| e.to_string())?;
    Ok(json!({ "id": sent.message_id.to_string() }))
}

async fn typing(st: Arc<State>, params: &Value) -> Result<Value, String> {
    let c = client(&st).await?;
    let to = jid_param(params)?;
    let on = params.get("on").and_then(Value::as_bool).unwrap_or(true);
    let r = if on { c.chatstate().send_composing(&to).await } else { c.chatstate().send_paused(&to).await };
    r.map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn mime_of(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" => "text/html",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "ogg" | "opus" => "audio/ogg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

async fn start_bot(st: Arc<State>, phone: Option<String>) -> anyhow::Result<()> {
    let db = db_path(&st.data_dir);
    let store = SqliteStore::open(&db.to_string_lossy()).await?;
    st.out.status("starting", json!({}));

    let (o1, o2, o3, o4, o5) = (st.out.clone(), st.out.clone(), st.out.clone(), st.out.clone(), st.out.clone());
    // When linking by code, the library still issues QR codes alongside it; showing those
    // would replace the code the owner is typing, so only the code is reported.
    let code_mode = phone.is_some();
    let st_conn = st.clone();
    let st_msg = st.clone();
    let st_call = st.clone();
    let mut builder = Bot::builder()
        .with_backend(store)
        .on_qr_code(move |code, _ttl| {
            let o = o1.clone();
            async move {
                if !code_mode {
                    o.status("pairing", json!({ "qr": code }))
                }
            }
        })
        .on_pair_code(move |code, _ttl| {
            let o = o2.clone();
            async move { o.status("pairing", json!({ "pairCode": code })) }
        })
        .on_connected(move |client| {
            let st = st_conn.clone();
            async move {
                let account = client.pn().and_then(|j| phone_of(&j));
                *st.client.lock().await = Some(client);
                st.out.status("connected", json!({ "account": account }));
            }
        })
        .on_logged_out(move |lo| {
            let o = o3.clone();
            async move { o.status("logged-out", json!({ "detail": format!("{:?}", lo.reason) })) }
        })
        .on_event_for(&[EventKind::Disconnected, EventKind::TemporaryBan, EventKind::StreamReplaced, EventKind::ClientOutdated], move |ev, _client| {
            let o = o4.clone();
            async move {
                match &*ev {
                    Event::TemporaryBan(b) => o.status("error", json!({ "detail": format!("WhatsApp temporarily banned this number: {b:?}") })),
                    Event::StreamReplaced(_) => o.status("disconnected", json!({ "detail": "another WhatsApp Web session took over this link" })),
                    Event::ClientOutdated(_) => o.status("error", json!({ "detail": "WhatsApp says this client is outdated: update the plugin" })),
                    _ => o.status("disconnected", json!({ "detail": "connection lost, reconnecting" })),
                }
            }
        })
        .on_event_for(&[EventKind::IncomingCall], move |ev, client| {
            let st = st_call.clone();
            async move {
                if let Event::IncomingCall(call) = &*ev {
                    voice::route_call_event(&st.call_watchers, call).await;
                    if matches!(call.action, whatsapp_rust::types::call::CallAction::Offer { .. }) {
                        let call = call.clone();
                        tokio::spawn(async move { voice::on_offer(st, client, call).await });
                    }
                }
            }
        })
        .on_message(move |ctx| {
            let st = st_msg.clone();
            let o = o5.clone();
            async move { on_message(st, o, ctx).await }
        });
    if let Some(phone) = phone {
        builder = builder.with_pair_code(PairCodeOptions { phone_number: phone, ..Default::default() });
    }
    let bot = builder.build().await?;
    let handle = bot.spawn();
    *st.client.lock().await = None;
    *st.bot.lock().await = Some(handle);
    Ok(())
}

async fn on_message(st: Arc<State>, out: Out, ctx: MessageContext) {
    let src = &ctx.info.source;
    if src.is_from_me {
        return;
    }
    let chat = src.chat.to_string();
    let sender_phone = phone_of(&src.sender).or_else(|| src.sender_alt.as_ref().and_then(phone_of));
    let mut text = ctx.message.text_content().map(str::to_string).unwrap_or_default();
    let mut attachments = Vec::new();

    let base = ctx.message.get_base_message();
    let dir = st.data_dir.join("media");
    let id = ctx.info.id.to_string();
    let safe_id: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect();

    if let Some(m) = base.image_message.as_option() {
        if text.is_empty() {
            text = m.caption.clone().unwrap_or_default();
        }
        let r = ctx.client.download(m, DownloadLimits::default()).await.map_err(|e| e.to_string());
        save(&dir, "image", &safe_id, "jpg", r, &mut attachments).await;
    }
    if let Some(m) = base.document_message.as_option() {
        if text.is_empty() {
            text = m.caption.clone().unwrap_or_default();
        }
        let ext = m.file_name.as_deref().and_then(|n| n.rsplit('.').next()).filter(|e| e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("bin").to_string();
        let r = ctx.client.download(m, DownloadLimits::default()).await.map_err(|e| e.to_string());
        save(&dir, "document", &safe_id, &ext, r, &mut attachments).await;
    }
    if let Some(m) = base.audio_message.as_option() {
        let kind = if m.ptt == Some(true) { "voice" } else { "audio" };
        let r = ctx.client.download(m, DownloadLimits::default()).await.map_err(|e| e.to_string());
        save(&dir, kind, &safe_id, "ogg", r, &mut attachments).await;
    }

    if text.is_empty() && attachments.is_empty() {
        return;
    }
    let _ = ctx.client.mark_as_read(&src.chat, if src.is_group { Some(&src.sender) } else { None }, &[id.as_str()]).await;
    out.notify("mercury/channel/message", json!({
        "id": id,
        "chatId": chat,
        "senderId": src.sender.to_string(),
        "senderPhone": sender_phone,
        "senderName": ctx.info.push_name.to_string(),
        "isGroup": src.is_group,
        "fromMe": false,
        "text": text,
        "attachments": attachments,
        "timestamp": ctx.info.timestamp.timestamp_millis(),
    }));
}

async fn save(dir: &Path, kind: &str, id: &str, ext: &str, bytes: Result<Vec<u8>, String>, attachments: &mut Vec<Value>) {
    match bytes {
        Ok(b) if b.len() <= MAX_DOWNLOAD_BYTES => {
            let path = dir.join(format!("{kind}-{id}.{ext}"));
            match tokio::fs::write(&path, &b).await {
                Ok(()) => attachments.push(json!({ "kind": kind, "path": path.to_string_lossy() })),
                Err(e) => log(format!("couldn't save attachment: {e}")),
            }
        }
        Ok(_) => log("skipped an attachment over 50 MB"),
        Err(e) => log(format!("attachment download failed: {e}")),
    }
}
