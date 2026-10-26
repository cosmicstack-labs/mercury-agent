//! mercury-optimus: full computer control for Mercury, by chat or out loud.
//!
//! Mercury starts this program and talks to it over stdio, one JSON-RPC 2.0
//! message per line: MCP (initialize, tools/list, tools/call, ping) plus the
//! channel extension for a "desktop" channel (plugin API 1.2), which is how
//! listening mode reaches Mercury (mercury/call/*, as WhatsApp calls do).
//!
//! The work happens in the core (core.rs): inside Optimus.app on macOS, so
//! the OS permissions belong to Optimus, and on a thread of this process
//! elsewhere. This file only relays: tool calls to the core, the core's
//! requests to Mercury, and Mercury's replies and notifications back.
//!
//! Nothing runs until the owner turns on "Let Optimus control this computer"
//! in the plugin's setup. Steps that commit something go through
//! act_consequential, which Mercury asks the owner to approve.
//!
//! stdout is the protocol channel: logs go to stderr only.

mod audio;
mod core;
mod hotkey;
mod links;
#[cfg(target_os = "macos")]
mod mac;
mod motion;
mod ops;
mod overlay;
mod voice;

pub use crate::core::log;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};

type CoreSend = Box<dyn Fn(Value) -> Result<(), String> + Send>;

struct Shell {
    stdout: Mutex<std::io::Stdout>,
    core: Mutex<Option<CoreSend>>,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    next_op: AtomicU64,
}

impl Shell {
    fn to_mercury(&self, v: &Value) {
        let mut o = self.stdout.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    }

    /// A message from the core.
    fn from_core(&self, v: Value) {
        if let Some(r) = v.get("opResult") {
            let id = r["id"].as_u64().unwrap_or(0);
            let result = match (r.get("ok"), r.get("err")) {
                (Some(ok), _) => Ok(ok.clone()),
                (_, Some(e)) => Err(e.as_str().unwrap_or("failed").to_string()),
                _ => Err("bad reply from Optimus".into()),
            };
            if let Some(tx) = self.waiting.lock().unwrap().remove(&id) {
                let _ = tx.send(result);
            }
        } else if let Some(m) = v.get("mercury") {
            self.to_mercury(m);
        }
    }

    fn core_gone(&self) {
        *self.core.lock().unwrap() = None;
        for (_, tx) in self.waiting.lock().unwrap().drain() {
            let _ = tx.send(Err("Optimus restarted; try again".into()));
        }
    }

    /// Start the core if it isn't running (Optimus.app on macOS, a thread elsewhere).
    fn ensure_core(self: &Arc<Self>) -> Result<(), String> {
        let mut core = self.core.lock().unwrap();
        if core.is_some() {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            let stream = mac::start_agent()?;
            let reader = std::io::BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
            let me = self.clone();
            std::thread::spawn(move || {
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        me.from_core(v);
                    }
                }
                me.core_gone();
            });
            let writer = Mutex::new(stream);
            *core = Some(Box::new(move |v: Value| {
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                writeln!(w, "{v}").map_err(|e| format!("Optimus.app went away: {e}"))
            }));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let (tx, rx) = mpsc::channel::<Value>();
            let me = self.clone();
            std::thread::Builder::new()
                .name("optimus-core".into())
                .spawn(move || {
                    let me2 = me.clone();
                    core::run(rx, move |v| me2.from_core(v));
                    me.core_gone();
                })
                .map_err(|e| e.to_string())?;
            *core = Some(Box::new(move |v: Value| tx.send(v).map_err(|_| "Optimus stopped".to_string())));
        }
        Ok(())
    }

    fn send_core(&self, v: Value) -> Result<(), String> {
        match self.core.lock().unwrap().as_ref() {
            Some(send) => send(v),
            None => Err("Optimus isn't running".into()),
        }
    }

    /// Run one operation in the core and wait for its result.
    fn op(self: &Arc<Self>, name: &str, args: &Value, timeout: Duration) -> Result<Value, String> {
        for attempt in 0..2 {
            self.ensure_core()?;
            let id = self.next_op.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = mpsc::channel();
            self.waiting.lock().unwrap().insert(id, tx);
            if let Err(e) = self.send_core(json!({ "op": { "id": id, "name": name, "args": args } })) {
                self.waiting.lock().unwrap().remove(&id);
                self.core_gone();
                if attempt == 0 {
                    continue; // Optimus.app quit (e.g. after a permission change): start it again.
                }
                return Err(e);
            }
            return match rx.recv_timeout(timeout) {
                Ok(r) => r,
                Err(_) => {
                    self.waiting.lock().unwrap().remove(&id);
                    Err(format!("{name} took too long"))
                }
            };
        }
        Err("Optimus isn't running".into())
    }
}

fn allowed() -> bool {
    core::settings().get("allowControl").and_then(Value::as_bool).unwrap_or(false)
}

const NOT_ALLOWED: &str = "Optimus is off: the owner hasn't allowed it to control this computer yet. \
Ask them to run /plugins optimus and turn on \"Let Optimus control this computer\".";

fn action_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "actions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 60,
                "description": "Done in order. Coordinates are pixels in the latest screenshot.",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string", "enum": ["click", "double_click", "triple_click", "right_click", "middle_click", "move", "drag", "draw", "mouse_down", "mouse_up", "type", "paste", "key", "scroll", "wait"] },
                        "x": { "type": "number" },
                        "y": { "type": "number" },
                        "to_x": { "type": "number", "description": "drag: end x" },
                        "to_y": { "type": "number", "description": "drag: end y" },
                        "text": { "type": "string", "description": "type/paste: the text (with x/y, clicks there first). type is the default for everything; paste is a fallback" },
                        "points": { "type": "array", "items": { "type": "array", "items": { "type": "number" } }, "description": "draw: [[x, y], …] one freehand stroke with the button held (many points for curves)" },
                        "keys": { "type": "string", "description": "key: one key or a combo, e.g. \"enter\", \"cmd+t\", \"ctrl+shift+esc\"" },
                        "modifiers": { "type": "string", "description": "click: keys held while clicking, e.g. \"cmd\" or \"shift\"" },
                        "repeat": { "type": "integer", "minimum": 1, "maximum": 50 },
                        "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                        "amount": { "type": "integer", "minimum": 1, "maximum": 30, "description": "scroll: notches (default 3)" },
                        "seconds": { "type": "number", "minimum": 0, "maximum": 10, "description": "wait: seconds" }
                    },
                    "required": ["type"]
                }
            },
            "say": { "type": "string", "description": "A few words saying what this does, present tense ('Opening the compose box', 'Typing your post'). Spoken live when the owner is talking to you." },
            "screenshot": { "type": "boolean", "description": "Return a screenshot afterwards (default true)." },
            "settle_ms": { "type": "integer", "minimum": 0, "maximum": 5000, "description": "Wait before that screenshot (default 500)." }
        },
        "required": ["actions"]
    })
}

const TOOL_DESCRIPTIONS: [(&str, &str); 7] = [
    ("look", "See the screen: a screenshot of the display the mouse is on (or `display` N), with the active window. Use `zoom` [x0,y0,x1,y1] for a closer look at part of the last screenshot (coordinates stay in the full screenshot)."),
    ("act", "Use the mouse and keyboard like a person: click, type, paste, press keys, scroll, drag, draw freehand. Returns a fresh screenshot. Pass `actions` as a list. To write text (posts, emails, articles) click the box, then use type: it types key by key like a person, so it works in every editor (up to 3,000 characters per type action; longer text in parts). Use paste only if typing fails. \"Sent\" means the input was sent, not that it worked: check the returned screenshot, and before telling the owner a task is done, look and confirm the result. FAILED means nothing (or not everything) happened. Only for ordinary, reversible steps. Anything that submits, sends, posts, pays, buys, deletes, installs or changes settings must go through act_consequential instead. Never type passwords, card numbers or 2FA codes: ask the owner to do that part."),
    ("act_consequential", "Same as act, for the step that commits something: submit a form, send a message or email, post, pay or buy, delete, install, change a setting. The owner approves it first, so say what it will do."),
    ("open", "Open an app by name (\"Chrome\", \"Notes\", \"Freeform\"), a URL, or a file/folder path. Faster and more reliable than clicking through menus. If the app isn't installed, the reply lists what is. For drawing use Freeform (Mac), Paint (Windows) or a web canvas like https://excalidraw.com."),
    ("windows", "List open windows (app and title), front first."),
    ("permissions", "Check what the OS lets Optimus do (macOS: Accessibility and Screen Recording). With request=true, shows the system prompts and opens the right Settings page."),
    ("listen", "Start a voice conversation on this computer right now (as if the owner pressed the talk key): Mercury listens through the microphone and answers out loud. Use when the owner asks to talk instead of type."),
];

fn tools() -> Value {
    let schema = |name: &str| match name {
        "look" => json!({
            "type": "object",
            "properties": {
                "display": { "type": "integer", "minimum": 1 },
                "zoom": { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 }
            }
        }),
        "act" | "act_consequential" => action_schema(),
        "open" => json!({ "type": "object", "properties": {
            "target": { "type": "string" },
            "say": { "type": "string", "description": "A few words, spoken live in a voice session, e.g. 'Opening Gmail'" }
        }, "required": ["target"] }),
        "permissions" => json!({ "type": "object", "properties": { "request": { "type": "boolean" } } }),
        _ => json!({ "type": "object", "properties": {} }),
    };
    Value::Array(
        TOOL_DESCRIPTIONS
            .iter()
            .map(|(name, description)| json!({ "name": name, "description": description, "inputSchema": schema(name) }))
            .collect(),
    )
}

fn call_tool(shell: &Arc<Shell>, name: &str, args: &Value) -> Value {
    if name != "permissions" && !allowed() {
        return json!({ "content": [{ "type": "text", "text": NOT_ALLOWED }], "isError": true });
    }
    let op = if name == "act_consequential" { "act" } else { name };
    // Long articles are typed key by key, so act may take minutes.
    match shell.op(op, args, Duration::from_secs(if op == "act" { 310 } else { 150 })) {
        Ok(v) => {
            let mut content = vec![json!({ "type": "text", "text": v["text"].as_str().unwrap_or("Done.") })];
            if let (Some(data), Some(mime)) = (v["image"]["data"].as_str(), v["image"]["mimeType"].as_str()) {
                content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
            }
            json!({ "content": content })
        }
        Err(e) => {
            let text = if e.starts_with("FAILED") || e.starts_with("Stopped") || e.starts_with("Optimus is off") { e } else { format!("FAILED: {e}") };
            json!({ "content": [{ "type": "text", "text": text }], "isError": true })
        }
    }
}

/// `mercury/channel/*` requests: the desktop has no chat of its own.
fn channel_request(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "mercury/channel/sendFile" => {
            // A file Mercury made during a voice session: show it.
            let path = params["path"].as_str().unwrap_or("");
            let opened = if cfg!(target_os = "macos") {
                std::process::Command::new("open").args(["-R", path]).status()
            } else if cfg!(windows) {
                std::process::Command::new("explorer").arg(format!("/select,{path}")).status()
            } else {
                std::process::Command::new("xdg-open").arg(path).status()
            };
            opened.map(|_| json!({})).map_err(|e| e.to_string())
        }
        "mercury/channel/send" | "mercury/channel/typing" => Ok(json!({})),
        other => Err(format!("Optimus has no {other}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // linux/mercury-optimus.sh runs this to check that every library loads.
    if args.get(1).map(String::as_str) == Some("--probe") {
        return;
    }
    #[cfg(target_os = "linux")]
    restore_library_path();
    if args.get(1).map(String::as_str) == Some("agent") {
        #[cfg(target_os = "macos")]
        {
            let socket = args.iter().position(|a| a == "--socket").and_then(|i| args.get(i + 1)).expect("--socket <path>");
            mac::agent_main(std::path::Path::new(socket));
        }
        #[cfg(not(target_os = "macos"))]
        {
            eprintln!("agent mode is macOS-only");
            std::process::exit(2);
        }
    }

    let shell = Arc::new(Shell {
        stdout: Mutex::new(std::io::stdout()),
        core: Mutex::new(None),
        waiting: Mutex::new(HashMap::new()),
        next_op: AtomicU64::new(1),
    });
    let reply = |shell: &Shell, id: &Value, r: Result<Value, String>| {
        shell.to_mercury(&match r {
            Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": e } }),
        });
    };

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let id = msg.get("id").cloned();

        // Replies to the core's requests, and Mercury's notifications for it.
        if method.is_empty() || id.is_none() {
            if method == "notifications/initialized" {
                if allowed() {
                    // Start now: the talk key, and macOS permission prompts if any are missing.
                    let sh = shell.clone();
                    std::thread::spawn(move || match sh.op("permissions", &json!({ "request": true }), Duration::from_secs(60)) {
                        Ok(r) => log(r["text"].as_str().unwrap_or("").replace('\n', " | ")),
                        Err(e) => log(e),
                    });
                } else {
                    shell.to_mercury(&json!({ "jsonrpc": "2.0", "method": "mercury/channel/status", "params": {
                        "state": "connected", "account": "this computer", "detail": "Off until you allow it in /plugins optimus."
                    }}));
                }
                continue;
            }
            let _ = shell.send_core(json!({ "mercury": msg }));
            continue;
        }
        let id = id.unwrap();
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        match method.as_str() {
            "initialize" => reply(&shell, &id, Ok(json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "mercury-optimus", "version": env!("CARGO_PKG_VERSION") }
            }))),
            "ping" => reply(&shell, &id, Ok(json!({}))),
            "tools/list" => reply(&shell, &id, Ok(json!({ "tools": tools() }))),
            "tools/call" => {
                // Off the reader thread, so pings and replies keep flowing during long actions.
                let sh = shell.clone();
                std::thread::spawn(move || {
                    let name = params["name"].as_str().unwrap_or("");
                    let result = call_tool(&sh, name, &params["arguments"]);
                    reply(&sh, &id, Ok(result));
                });
            }
            m if m.starts_with("mercury/channel/") => reply(&shell, &id, channel_request(m, &params)),
            _ => reply(&shell, &id, Err(format!("unknown method {method}"))),
        }
    }
    let _ = shell.send_core(json!({ "quit": true }));
    std::thread::sleep(Duration::from_millis(300));
}

/// The Linux launcher may point LD_LIBRARY_PATH at the libraries bundled with
/// the plugin. They're loaded by now, so put the owner's own value back before
/// any app Optimus opens inherits it.
#[cfg(target_os = "linux")]
fn restore_library_path() {
    let Some(original) = std::env::var_os("OPTIMUS_SYSTEM_LD_LIBRARY_PATH") else { return };
    // SAFETY: called first thing in main, before any other thread exists.
    unsafe {
        if std::env::var_os("OPTIMUS_LD_LIBRARY_PATH_SET").is_some() {
            std::env::set_var("LD_LIBRARY_PATH", original);
        } else {
            std::env::remove_var("LD_LIBRARY_PATH");
        }
        std::env::remove_var("OPTIMUS_SYSTEM_LD_LIBRARY_PATH");
        std::env::remove_var("OPTIMUS_LD_LIBRARY_PATH_SET");
    }
}
