//! Listening mode: talk to Mercury out loud at the computer.
//!
//! Press the talk key (or ask for it in chat): Optimus opens the mic and
//! speaker and a voice link (OpenAI Realtime by default, or any engine the
//! WhatsApp plugin supports). The voice chats; for anything real (the screen,
//! the web, memory, files, doing things) it asks Mercury, whose turn runs
//! with the Optimus tools in reach, and speaks the answer. Approvals are asked
//! out loud. Press the key again, or say goodbye, to stop.
//!
//! This is the WhatsApp call bridge with the computer's own audio in place of
//! a call: Mercury handles both through the same mercury/call/* messages.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::audio::{self, Audio, FRAME};
use crate::core::{Shared, log, settings, voice_enabled};
use crate::links::{self, Brain, Link, LinkCmd, LinkConfig, LinkEvent};

// Long enough for a turn that waits on the owner's approval.
const ASK_TIMEOUT: Duration = Duration::from_secs(300);

pub enum Ctl {
    /// The talk key: interrupt Mercury if it's speaking, otherwise stop listening.
    Press,
    Stop,
    /// What Mercury is doing on the screen right now, to say as it happens.
    Narrate(String),
    /// The mute key: stop (or start again) listening, without stopping any work.
    Mute,
}

pub struct SessionCtl {
    tx: mpsc::UnboundedSender<Ctl>,
    muted: Arc<std::sync::atomic::AtomicBool>,
}

impl SessionCtl {
    pub fn stop(&self) {
        let _ = self.tx.send(Ctl::Stop);
    }
    pub fn narrate(&self, line: String) {
        let _ = self.tx.send(Ctl::Narrate(line));
    }
    pub fn toggle_mute(&self) {
        let _ = self.tx.send(Ctl::Mute);
    }
    pub fn is_muted(&self) -> bool {
        self.muted.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// The talk key was pressed (or the `listen` tool called).
pub async fn press(sh: Arc<Shared>, from_tool: bool) -> Result<String, String> {
    {
        let live = sh.session.lock().unwrap();
        if let Some(s) = live.as_ref() {
            if from_tool {
                return Ok("Already listening: just talk.".into());
            }
            let _ = s.tx.send(Ctl::Press);
            return Ok(String::new());
        }
    }
    if !voice_enabled() {
        return Err("listening mode is off: choose Listening or Both in /plugins optimus".into());
    }
    let (tx, rx) = mpsc::unbounded_channel::<Ctl>();
    let muted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        // Claim the slot first, so a double press can't start two sessions.
        let mut live = sh.session.lock().unwrap();
        if live.is_some() {
            return Ok(String::new());
        }
        *live = Some(SessionCtl { tx, muted: muted.clone() });
    }
    crate::core::clear_halt();
    let call_id = format!("desk-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let problem = links::not_ready(&settings());
    let decision = sh
        .out
        .request(
            "mercury/call/incoming",
            json!({ "callId": call_id, "from": "local", "voiceReady": problem.is_none(), "voiceProblem": problem }),
            Duration::from_secs(8),
        )
        .await
        .unwrap_or_else(|e| json!({ "accept": false, "reason": e }));
    if decision.get("accept").and_then(Value::as_bool) != Some(true) {
        *sh.session.lock().unwrap() = None;
        let why = problem.unwrap_or_else(|| decision.get("reason").and_then(Value::as_str).unwrap_or("Mercury declined").to_string());
        return Err(why);
    }
    let instructions = decision.get("instructions").and_then(Value::as_str).unwrap_or("").to_string();
    let audio = match audio::open() {
        Ok(a) => a,
        Err(e) => {
            *sh.session.lock().unwrap() = None;
            let reason = format!("{e}{}", if cfg!(target_os = "macos") { " (allow Optimus under Privacy & Security → Microphone)" } else { "" });
            sh.out.notify("mercury/call/ended", json!({ "callId": call_id, "direction": "incoming", "outcome": format!("failed: {reason}"), "durationSec": 0, "transcript": [] }));
            return Err(reason);
        }
    };
    log(format!("listening ({})", audio.description));
    sh.publish_activity();
    let sh2 = sh.clone();
    tokio::spawn(async move {
        run_session(sh2.clone(), audio, rx, muted, call_id, instructions).await;
        *sh2.session.lock().unwrap() = None;
        sh2.publish_activity();
    });
    let key = sh.hotkey_label.lock().unwrap().clone();
    Ok(if key.is_empty() {
        "Listening now: talk to Mercury out loud. Say goodbye to stop.".into()
    } else {
        format!("Listening now: talk to Mercury out loud. Press {key} or say goodbye to stop.")
    })
}

fn instructions_for(instructions: &str) -> String {
    let base = "You are Mercury, the user's AI assistant, talking out loud with them at their own computer. \
        Speak naturally and briefly: one or two sentences at a time, no lists, no markdown, no URLs read aloud. \
        You can't see the screen or act yourself, and you don't know today's news or anything current: for anything on their screen \
        ('what's this?', 'what am I looking at?'), for doing things on the computer (open apps, click, type, fill a form, search), \
        for news, facts that may have changed, or the user's own things (memory, files, calendar), call ask_mercury with a clear, complete request. \
        Mercury can see and use the screen, search the web and use its tools. \
        Before a request, say two or three words at most ('On it.') and call ask_mercury straight away. \
        While Mercury works you'll get live updates of what it is doing on the screen right now: say each one in a few words, present tense \
        ('Opening Gmail', 'Selecting the junk emails'), and nothing else. Never announce something as upcoming once an update or the answer shows it's done. \
        When ask_mercury returns, say what was done or found, briefly and in the past tense. \
        Some actions need the user's approval. When you get an approval request, ask the user plainly whether to go ahead, wait for their answer, \
        then call answer_approval. Never answer an approval yourself: only the user's own words count. \
        Only say something is done when ask_mercury's answer says so; if it says something failed, couldn't be checked or was stopped, tell the user plainly. Never fill in a result yourself. \
        Links, lists and details go to the user's Mercury chat automatically; just say you've sent them. \
        When the user says goodbye or is done, say a short goodbye and call end_conversation.";
    if instructions.is_empty() { base.to_string() } else { format!("{base}\n\n{instructions}") }
}

fn tools() -> Value {
    json!([
        {
            "type": "function",
            "name": "ask_mercury",
            "description": "Ask Mercury (it sees and uses the screen, and has memory, tools and files) a question or to do something. Returns the answer to speak back.",
            "parameters": { "type": "object", "properties": { "question": { "type": "string" } }, "required": ["question"] },
        },
        { "type": "function", "name": "end_conversation", "description": "Stop listening, after saying goodbye.", "parameters": { "type": "object", "properties": {} } },
        {
            "type": "function",
            "name": "answer_approval",
            "description": "Report the user's answer to the approval you just asked them about. Only call it after they answered out loud.",
            "parameters": { "type": "object", "properties": { "approved": { "type": "boolean", "description": "true only if the user clearly said yes" } }, "required": ["approved"] },
        },
    ])
}

async fn run_session(sh: Arc<Shared>, audio: Audio, ctl: mpsc::UnboundedReceiver<Ctl>, muted: Arc<std::sync::atomic::AtomicBool>, call_id: String, instructions: String) {
    let started = Instant::now();
    let mut transcript: Vec<Value> = Vec::new();
    audio.out.chime(true);
    let engine = links::engine(&settings());
    log(format!("session {call_id} starting with {engine}"));
    let outcome = match bridge(&sh, audio, ctl, &muted, &call_id, &instructions, &mut transcript).await {
        Ok(()) => "completed".to_string(),
        Err(e) => {
            log(format!("session {call_id} ({engine}) failed: {e}"));
            format!("failed: {e}")
        }
    };
    sh.call_approvals.lock().unwrap().remove(&call_id);
    sh.call_context.lock().unwrap().remove(&call_id);
    sh.call_activity.lock().unwrap().remove(&call_id);
    sh.out.notify("mercury/call/ended", json!({
        "callId": call_id,
        "direction": "incoming",
        "outcome": outcome,
        "durationSec": started.elapsed().as_secs(),
        "transcript": transcript,
    }));
}

fn spoken_status(n: u32, doing: &str) -> String {
    if n == 1 { format!("This one takes a few seconds, I'm {doing}.") } else { format!("Still {doing}, almost there.") }
}

async fn bridge(
    sh: &Arc<Shared>,
    mut audio: Audio,
    mut ctl: mpsc::UnboundedReceiver<Ctl>,
    muted: &Arc<std::sync::atomic::AtomicBool>,
    call_id: &str,
    instructions: &str,
    transcript: &mut Vec<Value>,
) -> Result<(), String> {
    let cfg = LinkConfig { instructions: instructions_for(instructions), tools: tools(), settings: settings() };
    let mut link = links::open(cfg).await?;
    let brain = link.brain;
    let barge_in = settings().get("bargeIn").and_then(Value::as_bool).unwrap_or(false);

    match brain {
        Brain::Voice => link.send(LinkCmd::Instruct(
            "[Context, not said by the user] The user just pressed their talk key to talk to you at their computer. Say a very short hello (a few words, like 'Hey, I'm listening') and wait for them.".into(),
        )),
        Brain::Mercury => link.send(LinkCmd::Say("I'm listening.".into())),
    }

    let out = audio.out.clone();
    let mut mic = std::mem::replace(&mut audio.mic, mpsc::unbounded_channel().1);
    let pending: Arc<std::sync::Mutex<HashMap<String, (Instant, Instant, u32)>>> = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let mut responding = false;
    let (answer_tx, mut answer_rx) = mpsc::unbounded_channel::<(String, String, Instant)>();
    let mut ready_answers: VecDeque<(String, String)> = VecDeque::new();
    let mut awaiting: Option<(String, Instant)> = None;
    let mut user_said: Vec<(Instant, String)> = Vec::new();
    let mut verifying: Option<(String, String, Instant, Instant)> = None;
    let mut status_tick = tokio::time::interval(Duration::from_secs(1));
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ask_seq = 0u32;
    let silence = vec![0i16; FRAME];
    // Live narration: the newest line waits while the voice is speaking; older ones are dropped.
    let mut narration: Option<String> = None;
    let thinking_sound = settings().get("thinkingSound").and_then(Value::as_bool).unwrap_or(true);
    let mut tick = tokio::time::interval(Duration::from_millis(600));
    let mut tock = false;
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_narrated = Instant::now() - Duration::from_secs(60);

    // Silence ends the session by itself, so an open mic never streams (and bills) for nothing.
    let idle_stop = settings().get("idleStopSeconds").and_then(Value::as_f64).unwrap_or(60.0).max(0.0);
    let mut last_activity = Instant::now();
    let max_minutes = settings().get("maxSessionMinutes").and_then(Value::as_f64).unwrap_or(30.0).clamp(1.0, 240.0);
    let deadline = tokio::time::sleep(Duration::from_secs_f64(max_minutes * 60.0));
    tokio::pin!(deadline);

    let ask = |q: String, id: String, pending: &Arc<std::sync::Mutex<HashMap<String, (Instant, Instant, u32)>>>| {
        let sh2 = sh.clone();
        let tx2 = answer_tx.clone();
        let call_id2 = call_id.to_string();
        let now = Instant::now();
        pending.lock().unwrap().insert(id.clone(), (now, now, 0));
        sh.call_activity.lock().unwrap().remove(call_id);
        let pending2 = pending.clone();
        tokio::spawn(async move {
            let answer = sh2
                .out
                .request("mercury/call/ask", json!({ "callId": call_id2, "question": q }), ASK_TIMEOUT)
                .await
                .ok()
                .and_then(|v| v.get("answer").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| "Mercury didn't answer in time. It will send the answer to the chat.".into());
            pending2.lock().unwrap().remove(&id);
            let _ = tx2.send((id, answer, now));
        });
    };

    // "Stop": the screen actions and the Mercury task this session started end now.
    let stop_all = |pending: &Arc<std::sync::Mutex<HashMap<String, (Instant, Instant, u32)>>>| {
        crate::core::halt(8);
        pending.lock().unwrap().clear();
        let sh2 = sh.clone();
        let call = call_id.to_string();
        tokio::spawn(async move {
            let _ = sh2.out.request("mercury/call/stop", json!({ "callId": call }), Duration::from_secs(5)).await;
        });
        log(format!("{call_id}: stopped by the owner"));
    };
    let busy_working = |pending: &Arc<std::sync::Mutex<HashMap<String, (Instant, Instant, u32)>>>| !pending.lock().unwrap().is_empty() || sh.is_working();

    let result = loop {
        tokio::select! {
            _ = &mut deadline => break Ok(()),
            _ = tick.tick() => {
                // Soft "still working" tick while Mercury searches or acts and nobody is talking.
                if thinking_sound && !pending.lock().unwrap().is_empty() && !responding && !out.busy() && last_narrated.elapsed() > Duration::from_millis(1200) {
                    out.tick(tock);
                    tock = !tock;
                } else {
                    tock = false;
                }
            }
            c = ctl.recv() => match c {
                None | Some(Ctl::Stop) => {
                    if busy_working(&pending) { stop_all(&pending); }
                    break Ok(());
                }
                Some(Ctl::Narrate(line)) => {
                    last_narrated = Instant::now();
                    narration = Some(line);
                    if !responding && ready_answers.is_empty() {
                        speak_narration(&link, brain, &mut narration, &mut responding);
                    }
                }
                Some(Ctl::Mute) => {
                    let now = !muted.load(std::sync::atomic::Ordering::Relaxed);
                    set_muted(sh, muted, &out, now, &call_id);
                    last_activity = Instant::now();
                }
                Some(Ctl::Press) if muted.load(std::sync::atomic::Ordering::Relaxed) => {
                    // Muted: the talk key unmutes rather than stopping anything.
                    set_muted(sh, muted, &out, false, &call_id);
                    last_activity = Instant::now();
                }
                Some(Ctl::Press) => {
                    if busy_working(&pending) {
                        // While it's working, the key is the stop button: everything halts, the session stays.
                        stop_all(&pending);
                        narration = None;
                        ready_answers.clear();
                        out.clear();
                        link.send(LinkCmd::Cancel);
                        say_stopped(&link, brain);
                        responding = true;
                    } else if responding || out.recently_audible(300) {
                        // Mercury is talking: the key interrupts.
                        out.clear();
                        link.send(LinkCmd::Cancel);
                        responding = false;
                    } else {
                        break Ok(());
                    }
                }
            },
            frame = mic.recv() => {
                let Some(frame) = frame else { break Err("the microphone stopped".to_string()) };
                // Muted: nothing the owner says is sent anywhere.
                if muted.load(std::sync::atomic::Ordering::Relaxed) { continue; }
                // With speakers, the mic would hear Mercury: send silence while it talks.
                let muted = !barge_in && out.recently_audible(350);
                link.send(LinkCmd::Audio(if muted { silence.clone() } else { frame }));
            }
            Some(a) = answer_rx.recv() => {
                if a.1.starts_with("(superseded") || a.1.starts_with("(stopped") { continue; }
                narration = None; // the result supersedes anything still unsaid
                // Hold the answer against what actually happened on the screen.
                let failed: Vec<String> = sh.failures.lock().unwrap().iter().filter(|(at, _)| *at >= a.2).map(|(_, f)| f.clone()).collect();
                ready_answers.push_back((a.0, honest(brain, a.1, &failed)));
                if !responding { deliver(&link, brain, &mut ready_answers, &mut responding); }
            }
            _ = status_tick.tick() => {
                if let Some((fc, _id, _asked, until)) = verifying.clone() {
                    if Instant::now() >= until {
                        verifying = None;
                        ready_answers.push_back((fc, "Not approved: the user hasn't clearly said yes in their own words. Ask them again.".to_string()));
                    }
                }
                if !responding && !ready_answers.is_empty() {
                    deliver(&link, brain, &mut ready_answers, &mut responding);
                    continue;
                }
                if responding || out.busy() { last_activity = Instant::now(); continue; }
                if muted.load(std::sync::atomic::Ordering::Relaxed) { last_activity = Instant::now(); }
                if idle_stop > 0.0
                    && last_activity.elapsed().as_secs_f64() >= idle_stop
                    && last_narrated.elapsed().as_secs_f64() >= idle_stop
                    && pending.lock().unwrap().is_empty()
                    && ready_answers.is_empty()
                    && awaiting.is_none()
                {
                    log(format!("{call_id}: {idle_stop}s of silence, stopping"));
                    break Ok(());
                }
                if awaiting.is_none() {
                    let next = sh.call_approvals.lock().unwrap().get_mut(call_id).and_then(|l| if l.is_empty() { None } else { Some(l.remove(0)) });
                    if let Some((id, prompt)) = next {
                        awaiting = Some((id, Instant::now()));
                        match brain {
                            Brain::Voice => link.send(LinkCmd::Instruct(format!("[Approval needed, not said by the user] Mercury wants to: {prompt}. Ask the user plainly, in one or two sentences, whether to go ahead. Then wait for their answer and call answer_approval."))),
                            Brain::Mercury => link.send(LinkCmd::Say(format!("I need your go-ahead to {prompt}. Should I do it? Say yes or no."))),
                        }
                        responding = true;
                        continue;
                    }
                }
                let context = sh.call_context.lock().unwrap().remove(call_id);
                if let Some(mut notes) = context.filter(|n| !n.is_empty()) {
                    for n in notes.iter_mut() {
                        if let Some(rest) = n.strip_prefix("RESOLVED:") {
                            let (id, text) = rest.split_once(':').unwrap_or(("", rest));
                            if awaiting.as_ref().map(|(a, _)| a == id).unwrap_or(false) { awaiting = None; }
                            *n = text.to_string();
                        }
                    }
                    match brain {
                        Brain::Voice => link.send(LinkCmd::Instruct(format!("[Status update, not said by the user] {} Mention it in one short sentence.", notes.join(" ")))),
                        Brain::Mercury => link.send(LinkCmd::Say(notes.join(" "))),
                    }
                    responding = true;
                    continue;
                }
                let due = {
                    let mut p = pending.lock().unwrap();
                    let now = Instant::now();
                    p.iter_mut().find_map(|(_, (asked, last, n))| {
                        let wait = if *n == 0 { Duration::from_secs(8) } else { Duration::from_secs(14) };
                        if *n < 8 && now.duration_since(if *n == 0 { *asked } else { *last }) >= wait {
                            *last = now;
                            *n += 1;
                            Some((*n, now.duration_since(*asked).as_secs()))
                        } else { None }
                    })
                };
                if let Some((n, secs)) = due.filter(|_| last_narrated.elapsed() > Duration::from_secs(12)) {
                    let doing = sh.call_activity.lock().unwrap().get(call_id).cloned().unwrap_or_else(|| "working on it".into());
                    match brain {
                        Brain::Voice => link.send(LinkCmd::Instruct(if n == 1 {
                            format!("[Status update, not said by the user] Mercury is still {doing}. Tell the user in one short sentence that it's taking a few seconds.")
                        } else {
                            format!("[Status update, not said by the user] After {secs} seconds Mercury is still {doing}. Give one short, natural update (don't repeat yourself).")
                        })),
                        Brain::Mercury => link.send(LinkCmd::Say(spoken_status(n, &doing))),
                    }
                    responding = true;
                }
            }
            ev = link.events.recv() => {
                let Some(ev) = ev else { break Err("the voice connection ended".to_string()) };
                match ev {
                    LinkEvent::Closed(reason) => break Err(reason),
                    LinkEvent::ResponseStarted => responding = true,
                    LinkEvent::ResponseDone => {
                        responding = false;
                        if !ready_answers.is_empty() { deliver(&link, brain, &mut ready_answers, &mut responding); }
                        else if narration.is_some() { speak_narration(&link, brain, &mut narration, &mut responding); }
                    }
                    LinkEvent::Audio(pcm) => out.play(&pcm),
                    LinkEvent::SpeechStarted => {
                        last_activity = Instant::now();
                        if barge_in || !out.recently_audible(350) {
                            out.clear();
                            link.send(LinkCmd::Cancel);
                        }
                    }
                    LinkEvent::AssistantText(t) => {
                        if !t.is_empty() { transcript.push(json!({ "role": "mercury", "text": t })); }
                    }
                    LinkEvent::UserText(t) => {
                        if t.is_empty() { continue; }
                        last_activity = Instant::now();
                        transcript.push(json!({ "role": "owner", "text": t.clone() }));
                        user_said.push((Instant::now(), t.clone()));
                        if user_said.len() > 20 { user_said.remove(0); }
                        if is_mute(&t) {
                            set_muted(sh, muted, &out, true, &call_id);
                            continue;
                        }
                        if is_stop(&t) && verifying.is_none() && awaiting.is_none() {
                            // "Stop" / "cancel" / "ruko": halt everything at once.
                            stop_all(&pending);
                            narration = None;
                            ready_answers.clear();
                            out.clear();
                            link.send(LinkCmd::Cancel);
                            say_stopped(&link, brain);
                            responding = true;
                            continue;
                        }
                        if let Some((fc, id, asked_at, _)) = verifying.clone() {
                            if let Some(v) = spoken_verdict(&user_said, asked_at) {
                                verifying = None;
                                awaiting = None;
                                let o = finalize_approval(sh, call_id, &id, v).await;
                                ready_answers.push_back((fc, o));
                                if !responding { deliver(&link, brain, &mut ready_answers, &mut responding); }
                            }
                            continue;
                        }
                        if brain == Brain::Mercury {
                            if let Some((id, asked_at)) = awaiting.clone() {
                                if let Some(v) = spoken_verdict(&user_said, asked_at) {
                                    awaiting = None;
                                    finalize_approval(sh, call_id, &id, v).await;
                                    link.send(LinkCmd::Say(if v { "Okay, going ahead.".into() } else { "Okay, I won't.".into() }));
                                    continue;
                                }
                            }
                            if is_goodbye(&t) {
                                if busy_working(&pending) { stop_all(&pending); }
                                link.send(LinkCmd::Say("Okay, bye for now!".into()));
                                tokio::time::sleep(Duration::from_millis(2500)).await;
                                break Ok(());
                            }
                            ask_seq += 1;
                            transcript.push(json!({ "role": "ask_mercury", "text": t.clone() }));
                            ask(t, format!("turn-{ask_seq}"), &pending);
                        }
                    }
                    LinkEvent::ToolCall { id, name, args } => {
                        if name == "end_conversation" || name == "end_call" {
                            if busy_working(&pending) { stop_all(&pending); }
                            for _ in 0..50 {
                                if !out.busy() { break; }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                            break Ok(());
                        }
                        if name == "answer_approval" {
                            let approved = args.get("approved").and_then(Value::as_bool).unwrap_or(false);
                            match awaiting.clone() {
                                None => ready_answers.push_back((id, "No approval is waiting right now.".to_string())),
                                Some((aid, asked_at)) => match (approved, spoken_verdict(&user_said, asked_at)) {
                                    (false, _) | (true, Some(false)) => {
                                        awaiting = None;
                                        let o = finalize_approval(sh, call_id, &aid, false).await;
                                        ready_answers.push_back((id, o));
                                    }
                                    (true, Some(true)) => {
                                        awaiting = None;
                                        let o = finalize_approval(sh, call_id, &aid, true).await;
                                        ready_answers.push_back((id, o));
                                    }
                                    (true, None) => verifying = Some((id, aid, asked_at, Instant::now() + Duration::from_secs(3))),
                                },
                            }
                            if !responding { deliver(&link, brain, &mut ready_answers, &mut responding); }
                            continue;
                        }
                        if name == "ask_mercury" {
                            let q = args.get("question").and_then(Value::as_str).unwrap_or("").to_string();
                            transcript.push(json!({ "role": "ask_mercury", "text": q.clone() }));
                            ask(q, id, &pending);
                        }
                    }
                }
            }
        }
    };

    out.clear();
    out.chime(false);
    audio.drain(Duration::from_secs(1)).await;
    result
}

/// Mercury's answer, with the steps that failed during it made impossible to miss.
fn honest(brain: Brain, answer: String, failed: &[String]) -> String {
    if failed.is_empty() {
        return answer;
    }
    match brain {
        Brain::Voice => format!(
            "{answer}\n[Optimus log for this request, not part of Mercury's answer: {} step(s) failed or were stopped ({}). Unless the answer above says Mercury checked the result on the screen, don't tell the user it's done: say what didn't work and offer to try again.]",
            failed.len(),
            failed.join("; ")
        ),
        Brain::Mercury => {
            let a = answer.to_lowercase();
            let admits = ["fail", "couldn", "could not", "didn", "did not", "not able", "unable", "wasn't", "stopped"].iter().any(|w| a.contains(w));
            if admits { answer } else { format!("Heads up, some steps didn't work. {answer}") }
        }
    }
}

fn set_muted(sh: &Arc<Shared>, muted: &Arc<std::sync::atomic::AtomicBool>, out: &Arc<audio::Output>, on: bool, call_id: &str) {
    muted.store(on, std::sync::atomic::Ordering::Relaxed);
    if on { out.mute_tone() } else { out.chime(true) }
    log(format!("{call_id}: {}", if on { "muted" } else { "unmuted" }));
    sh.publish_activity();
}

/// "Mute" / "mute yourself" / "go on mute".
fn is_mute(t: &str) -> bool {
    let t = format!(" {} ", t.to_lowercase().replace(|c: char| !c.is_alphanumeric() && !c.is_whitespace() && (c as u32) < 128, " "));
    t.split_whitespace().count() <= 4 && [" mute ", " go on mute ", " mute yourself ", " mute karo "].iter().any(|w| t.contains(w)) && !t.contains(" unmute ")
}

fn say_stopped(link: &Link, brain: Brain) {
    match brain {
        Brain::Voice => link.send(LinkCmd::Instruct("[The user stopped everything, not said by the user] All of Mercury's actions have been stopped. Say only: 'Stopped.' Then wait.".into())),
        Brain::Mercury => link.send(LinkCmd::Say("Stopped.".into())),
    }
}

/// A short "stop!" / "cancel" / "ruko" / "bas": halt everything.
fn is_stop(t: &str) -> bool {
    let t = format!(" {} ", t.to_lowercase().replace(|c: char| !c.is_alphanumeric() && !c.is_whitespace() && (c as u32) < 128, " "));
    t.split_whitespace().count() <= 4
        && [" stop ", " cancel ", " halt ", " abort ", " enough ", " never mind ", " nevermind ", " ruko ", " ruk jao ", " ruk ", " bas ", " band karo ", "रुको", "रुक जाओ", "बस", "رکو", "بس"]
            .iter()
            .any(|w| t.contains(w))
        && !t.contains(" stop listening ")
}

fn is_goodbye(t: &str) -> bool {
    let t = format!(" {} ", t.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric() && !c.is_whitespace()));
    let short = t.split_whitespace().count() <= 4;
    short && [" bye ", " goodbye ", " bye bye ", " that's all ", " thats all ", " stop listening ", " khuda hafiz ", " allah hafiz ", " alvida ", "अलविदा", "خدا حافظ", "اللہ حافظ"].iter().any(|w| t.contains(w))
}

async fn finalize_approval(sh: &Arc<Shared>, call_id: &str, approval_id: &str, yes: bool) -> String {
    match sh.out.request("mercury/call/approve", json!({ "callId": call_id, "approvalId": approval_id, "approved": yes }), Duration::from_secs(10)).await {
        Ok(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => {
            if yes { "Approved. Mercury is carrying on; tell the user briefly.".into() } else { "Declined. Tell the user it won't be done.".into() }
        }
        Ok(v) => format!("That approval was already settled ({}).", v.get("reason").and_then(Value::as_str).unwrap_or("closed")),
        Err(e) => format!("Couldn't reach Mercury: {e}"),
    }
}

/// Did the user say yes (or no) out loud since the approval question?
/// Only their transcribed speech counts; the model's own reading doesn't.
pub fn spoken_verdict(said: &[(Instant, String)], since: Instant) -> Option<bool> {
    for (at, text) in said.iter().rev() {
        if *at < since { break; }
        let t = format!(" {} ", text.to_lowercase().replace(|c: char| !c.is_alphanumeric() && !c.is_whitespace() && (c as u32) < 128, " "));
        const NO: &[&str] = &[" no ", " nope ", " don't ", " dont ", " do not ", " cancel ", " stop ", " wait ", " nahi ", " nahin ", " mat ", "नहीं", "मत", "نہیں"];
        const YES: &[&str] = &[" yes ", " yeah ", " yep ", " yup ", " sure ", " ok ", " okay ", " go ahead ", " do it ", " approve", " confirm", " please do ", " haan ", " han ", " ha ji ", " ji ", " theek ", " thik ", " kar do ", " karo ", "हाँ", "हां", "ठीक", "कर दो", "ہاں", "جی", "ٹھیک"];
        if NO.iter().any(|w| t.contains(w)) { return Some(false); }
        if YES.iter().any(|w| t.contains(w)) { return Some(true); }
    }
    None
}

fn speak_narration(link: &Link, brain: Brain, pending: &mut Option<String>, responding: &mut bool) {
    if let Some(line) = pending.take() {
        match brain {
            Brain::Voice => link.send(LinkCmd::Instruct(format!(
                "[Live update, not said by the user] Mercury is doing this on the screen right now: {line}. It is in progress, not finished. Say it in a few words, present tense, and nothing else; never say the task is done because of an update."
            ))),
            Brain::Mercury => link.send(LinkCmd::Say(line)),
        }
        *responding = true;
    }
}

fn deliver(link: &Link, brain: Brain, ready: &mut VecDeque<(String, String)>, responding: &mut bool) {
    if let Some((id, answer)) = ready.pop_front() {
        match brain {
            Brain::Voice => link.send(LinkCmd::ToolResult { id, output: answer }),
            Brain::Mercury => {
                let spoken = if answer.starts_with("Approved.") { "Okay, going ahead.".to_string() }
                    else if answer.starts_with("Declined.") { "Okay, I won't.".to_string() }
                    else if answer.starts_with("Not approved:") { "Sorry, I didn't catch a yes. Should I go ahead?".to_string() }
                    else { answer };
                link.send(LinkCmd::Say(spoken));
            }
        }
        *responding = true;
    }
}

/// Turn the voice provider's close reason into something the owner can act on.
pub fn explain_close(reason: &str) -> String {
    let r = reason.to_ascii_lowercase();
    if r.contains("insufficient_quota") || r.contains("credit_balance") || r.contains("billing") {
        "your OpenAI account is out of credit. Add credit at platform.openai.com → Settings → Billing, then try again".into()
    } else if r.contains("invalid_api_key") || r.contains("unauthorized") || r.contains("401") {
        "OpenAI rejected the API key. Check the OpenAI provider in Mercury's dashboard (Providers)".into()
    } else if r.contains("model_not_found") || r.contains("does not exist") || r.contains("access") {
        format!("this OpenAI account can't use the realtime voice model ({reason}). Try another voiceModel setting")
    } else if r.contains("rate_limit") {
        "OpenAI is rate-limiting this account right now. Try again in a minute".into()
    } else if reason.is_empty() {
        "the voice model closed the session".into()
    } else {
        format!("the voice model closed the session ({reason})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_users_own_yes_counts() {
        let asked = Instant::now();
        let after = asked + Duration::from_millis(10);
        assert_eq!(spoken_verdict(&[(after, "Yes, go ahead".into())], asked), Some(true));
        assert_eq!(spoken_verdict(&[(after, "No, don't".into())], asked), Some(false));
        assert_eq!(spoken_verdict(&[(after, "what?".into())], asked), None);
        assert_eq!(spoken_verdict(&[(asked - Duration::from_secs(5), "yes".into())], asked), None);
    }

    #[test]
    fn failed_steps_are_never_hidden() {
        assert_eq!(honest(Brain::Voice, "Done.".into(), &[]), "Done.");
        assert!(honest(Brain::Voice, "I've posted it.".into(), &["act: FAILED".into()]).contains("don't tell the user it's done"));
        assert!(honest(Brain::Mercury, "I've posted it.".into(), &["act: FAILED".into()]).starts_with("Heads up"));
        assert_eq!(honest(Brain::Mercury, "The click failed.".into(), &["act: FAILED".into()]), "The click failed.");
    }

    #[test]
    fn mute_words() {
        assert!(is_mute("Mute."));
        assert!(is_mute("mute yourself"));
        assert!(!is_mute("unmute"));
        assert!(!is_mute("how do I mute notifications on my phone"));
    }

    #[test]
    fn stop_words() {
        assert!(is_stop("Stop!"));
        assert!(is_stop("cancel that"));
        assert!(is_stop("ruko"));
        assert!(!is_stop("stop listening"), "that's a goodbye, handled separately");
        assert!(!is_stop("can you stop by the store on your way home later"));
    }

    #[test]
    fn goodbyes() {
        assert!(is_goodbye("Okay, bye!"));
        assert!(is_goodbye("stop listening"));
        assert!(!is_goodbye("say bye to my brother when he calls tomorrow"));
    }
}
