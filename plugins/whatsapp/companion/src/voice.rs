//! Voice calls: WhatsApp call audio ⇄ OpenAI Realtime.
//!
//! Audio never leaves this process except to the voice provider. Mercury is
//! asked two things over the plugin connection: whether to answer a call
//! (only the owner, decided by Mercury) and, mid-call, `ask_mercury`
//! questions, which run as a normal Mercury turn whose answer is spoken back.
//!
//! WhatsApp call audio (PCM path): 16 kHz mono i16, 960-sample (60 ms) frames.
//! OpenAI Realtime: 24 kHz mono i16, base64, any chunk size.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use whatsapp_rust::async_channel;
use whatsapp_rust::prelude::*;
use whatsapp_rust::types::call::{CallAction, IncomingCall};
use whatsapp_rust::voip::CallHandle;

use crate::links::{self, Brain, Link, LinkCmd, LinkConfig, LinkEvent};
use crate::{Out, State, log, phone_of};

const FRAME: usize = 960;
const RING_TIMEOUT: Duration = Duration::from_secs(45);
// Long enough for a turn that waits on the owner's approval; Mercury itself replies
// "still working" well before this when a turn is merely slow.
const ASK_TIMEOUT: Duration = Duration::from_secs(300);

/// Outcomes of outgoing calls, keyed by call id, fed from the client event bus.
pub type CallWatchers = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<&'static str>>>>;

pub fn settings() -> Value {
    std::env::var("MERCURY_PLUGIN_SETTINGS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

fn setting_str(key: &str, default: &str) -> String {
    settings().get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(default).to_string()
}

/// Why calls can't run with the current voice settings (missing key), if anything.
pub fn voice_problem() -> Option<String> {
    links::not_ready(&settings())
}

pub fn voice_ready() -> bool {
    voice_problem().is_none()
}





/// Feed call outcomes for outgoing calls to whoever placed them.
pub async fn route_call_event(watchers: &CallWatchers, call: &IncomingCall) {
    let (id, outcome) = match &call.action {
        CallAction::Accept { call_id, .. } => (call_id.clone(), "answered"),
        CallAction::Reject { call_id, reason, .. } => (call_id.clone(), if reason.is_none() { "declined" } else { "busy" }),
        CallAction::Terminate { call_id, .. } => (call_id.clone(), "ended"),
        _ => return,
    };
    if let Some(tx) = watchers.lock().await.get(&id) {
        let _ = tx.send(outcome);
    }
}

/// An incoming offer: ask Mercury whether to answer (owner only), then bridge it.
pub async fn on_offer(st: Arc<State>, client: Arc<Client>, call: Box<IncomingCall>) {
    let CallAction::Offer { call_id, caller_pn, is_video, group_jid, .. } = &call.action else { return };
    let from = call.from.to_string();
    let from_phone = caller_pn.as_ref().and_then(phone_of).or_else(|| phone_of(&call.from));
    let call_id = call_id.clone();

    if group_jid.is_some() || settings().get("answerCalls").and_then(Value::as_bool) == Some(false) {
        let _ = client.voip().reject(&call).await;
        return;
    }
    let decision = st
        .out
        .request("mercury/call/incoming", json!({ "callId": call_id, "from": from, "fromPhone": from_phone, "video": is_video, "voiceReady": voice_ready(), "voiceProblem": voice_problem() }), Duration::from_secs(8))
        .await
        .unwrap_or_else(|e| json!({ "accept": false, "reason": e }));
    if decision.get("accept").and_then(Value::as_bool) != Some(true) {
        let _ = client.voip().reject(&call).await;
        return;
    }
    let instructions = decision.get("instructions").and_then(Value::as_str).unwrap_or("").to_string();

    let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(3);
    let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(64);
    let handle = match client.voip().accept(&call).audio(mic_rx, spk_tx).start().await {
        Ok(h) => h,
        Err(e) => {
            log(format!("accept failed: {e}"));
            st.out.notify("mercury/call/ended", json!({ "callId": call_id, "direction": "incoming", "outcome": "failed", "detail": e.to_string(), "durationSec": 0, "transcript": [] }));
            return;
        }
    };
    let opener = "The owner just called you. Greet them briefly by name if you know it, and ask how you can help.".to_string();
    run_session(st, handle, mic_tx, spk_rx, call_id, "incoming", instructions, opener).await;
}

/// The `call_owner` tool: ring the owner and, if they answer, talk.
pub async fn call_owner(st: Arc<State>, args: &Value) -> Result<String, String> {
    let reason = args.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if reason.is_empty() {
        return Err("reason is required".into());
    }
    if let Some(problem) = voice_problem() {
        return Err(format!("Can't call: {problem}."));
    }
    let owner: String = setting_str("owner", "").chars().filter(char::is_ascii_digit).collect();
    if owner.len() < 6 {
        return Err("No owner number is set. Run: mercury plugins set whatsapp owner +<number>".into());
    }
    // Rate limit: a looping task must never spam the owner with calls.
    let max_per_hour = settings().get("maxCallsPerHour").and_then(Value::as_f64).unwrap_or(4.0).max(0.0) as usize;
    {
        let mut recent = st.recent_calls.lock().await;
        let hour_ago = Instant::now() - Duration::from_secs(3600);
        recent.retain(|t| *t > hour_ago);
        if recent.len() >= max_per_hour {
            return Err(format!("Not calling: already called the owner {} times in the last hour (limit {max_per_hour}). Send a message instead.", recent.len()));
        }
        recent.push(Instant::now());
    }
    let client = st.client.lock().await.clone().ok_or("WhatsApp is not linked.")?;
    let jid: Jid = format!("{owner}@s.whatsapp.net").parse().map_err(|e| format!("bad owner number: {e}"))?;

    let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(3);
    let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(64);
    let handle = client.voip().call(&jid).audio(mic_rx, spk_tx).start().await.map_err(|e| format!("couldn't place the call: {e}"))?;
    let call_id = handle.call_id().to_string();

    let (tx, mut rx) = mpsc::unbounded_channel();
    st.call_watchers.lock().await.insert(call_id.clone(), tx);
    let outcome = tokio::time::timeout(RING_TIMEOUT, async {
        loop {
            match rx.recv().await {
                Some("answered") => return "answered",
                Some("busy") => continue, // one of their devices can't take it; others keep ringing
                Some(other) => return other,
                None => return "failed",
            }
        }
    })
    .await
    .unwrap_or("no_answer");
    st.call_watchers.lock().await.remove(&call_id);

    if outcome != "answered" {
        let _ = handle.terminate().await;
        let outcome = if outcome == "ended" { "no_answer" } else { outcome };
        st.out.notify("mercury/call/ended", json!({ "callId": call_id, "direction": "outgoing", "outcome": outcome, "reason": reason, "durationSec": 0, "transcript": [] }));
        return Ok(format!("{outcome}: the owner did not pick up. Send them a message instead."));
    }
    let briefing = st.out.request("mercury/call/briefing", json!({ "callId": call_id }), Duration::from_secs(5)).await.unwrap_or(json!({}));
    let instructions = briefing.get("instructions").and_then(Value::as_str).unwrap_or("").to_string();
    let opener = format!("You called the owner and they answered. Why you called: {reason}. Greet them, explain why you called in one or two sentences, and help with whatever they need.");
    let st2 = st.clone();
    tokio::spawn(async move { run_session(st2, handle, mic_tx, spk_rx, call_id, "outgoing", instructions, opener).await });
    Ok("answered: the owner picked up and the call is in progress. A summary will be sent when it ends.".into())
}

fn instructions_for(instructions: &str) -> String {
    let base = "You are Mercury, the user's AI assistant, talking on a WhatsApp voice call. \
        Speak naturally and briefly: one or two sentences at a time, no lists, no markdown, no URLs read aloud. \
        You don't know today's news or anything current yourself: for news, facts that may have changed, the user's own things \
        (memory, files, calendar) or doing something, call ask_mercury with a clear, complete question; Mercury searches the web and uses its tools. \
        Before calling it for anything that searches the web or reads pages, tell the user it can take a few seconds and they can stay on the line \
        (for example: 'Let me look that up, it'll take a few seconds, stay with me'). Then speak its answer in your own words. \
        If you get a status update while Mercury is still working, give the user one short, natural sentence about it so they know you're still there. \
        The user can send photos and documents in the WhatsApp chat during the call: Mercury can see them, so for 'what's in this photo?' call ask_mercury. \
        Some actions need the user's approval. When you get an approval request, ask the user plainly whether to go ahead, wait for their answer, \
        then call answer_approval. Never answer an approval yourself: only the user's own words count. \
        Mercury can send things to the user's WhatsApp chat during the call (links, lists, details): when they ask for something to be sent, \
        or say yes to an offer to send it, call ask_mercury with a request like 'send the phone links to my chat'. Never say you can't send things. \
        If the user asks you to call them back later ('call me at 9', 'call me back in an hour'), use schedule_callback right away and read back its confirmation. \
        When the user says goodbye or is done, say goodbye and call end_call.";
    if instructions.is_empty() { base.to_string() } else { format!("{base}\n\n{instructions}") }
}

fn tools() -> Value {
    json!([
        {
            "type": "function",
            "name": "ask_mercury",
            "description": "Ask Mercury (with its memory, tools and files) a question or to do something. Returns the answer to speak back.",
            "parameters": { "type": "object", "properties": { "question": { "type": "string" } }, "required": ["question"] },
        },
        { "type": "function", "name": "end_call", "description": "Hang up after saying goodbye.", "parameters": { "type": "object", "properties": {} } },
        {
            "type": "function",
            "name": "schedule_callback",
            "description": "Schedule Mercury to call the user back later. Pass the time exactly as they said it ('9pm', 'in 20 minutes', 'tomorrow 8am'); it's worked out for you. Read back the confirmation it returns.",
            "parameters": { "type": "object", "properties": {
                "when": { "type": "string", "description": "The time as the user said it" },
                "topic": { "type": "string", "description": "What to call about, in a few words" }
            }, "required": ["when"] },
        },
        {
            "type": "function",
            "name": "answer_approval",
            "description": "Report the user's answer to the approval you just asked them about. Only call it after they answered out loud.",
            "parameters": { "type": "object", "properties": { "approved": { "type": "boolean", "description": "true only if the user clearly said yes" } }, "required": ["approved"] },
        },
    ])
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    st: Arc<State>,
    handle: CallHandle,
    mic_tx: async_channel::Sender<Vec<i16>>,
    spk_rx: async_channel::Receiver<Vec<i16>>,
    call_id: String,
    direction: &'static str,
    instructions: String,
    opener: String,
) {
    let started = Instant::now();
    let transcript: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let outcome = match bridge(&st, &handle, mic_tx, spk_rx, &call_id, direction, &instructions, &opener, transcript.clone()).await {
        Ok(()) => "completed".to_string(),
        Err(e) => {
            log(format!("voice session ended with an error: {e}"));
            let _ = handle.terminate().await;
            format!("failed: {e}")
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), handle.terminate()).await;
    let t = transcript.lock().await.clone();
    st.out.notify("mercury/call/ended", json!({
        "callId": call_id,
        "direction": direction,
        "outcome": outcome,
        "durationSec": started.elapsed().as_secs(),
        "transcript": t,
    }));
}

/// Words for a pipeline voice to say where a reasoning model would get an instruction.
fn spoken_status(n: u32, doing: &str) -> String {
    if n == 1 { format!("This one takes a few seconds, I'm {doing}. Stay on the line.") } else { format!("Still {doing}, almost there.") }
}

#[allow(clippy::too_many_arguments)]
async fn bridge(
    st: &Arc<State>,
    handle: &CallHandle,
    mic_tx: async_channel::Sender<Vec<i16>>,
    spk_rx: async_channel::Receiver<Vec<i16>>,
    call_id: &str,
    direction: &str,
    instructions: &str,
    opener: &str,
    transcript: Arc<Mutex<Vec<Value>>>,
) -> Result<(), String> {
    let cfg = LinkConfig { instructions: instructions_for(instructions), tools: tools(), settings: settings() };
    let mut link = links::open(cfg).await?;
    let brain = link.brain;

    // Greeting: a reasoning model is told the situation; a pipeline voice just says hello.
    match brain {
        Brain::Voice => link.send(LinkCmd::Instruct(format!("[Call context, not spoken by the user] {opener}"))),
        Brain::Mercury => link.send(LinkCmd::Say(if direction == "outgoing" { format!("Hi, it's Mercury. {}", opener_reason(opener)) } else { "Hi, it's Mercury. How can I help?".into() })),
    }

    // Caller → voice.
    let up = link.cmd.clone();
    let uplink = tokio::spawn(async move {
        while let Ok(frame) = spk_rx.recv().await {
            if up.send(LinkCmd::Audio(frame)).is_err() { break; }
        }
    });

    // Voice → caller, paced at one 60 ms frame per tick.
    let playout: Arc<std::sync::Mutex<VecDeque<i16>>> = Arc::new(std::sync::Mutex::new(VecDeque::new()));
    let play = playout.clone();
    let pacer = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let frame: Vec<i16> = {
                let mut q = play.lock().unwrap();
                let n = q.len().min(FRAME);
                let mut f: Vec<i16> = q.drain(..n).collect();
                f.resize(FRAME, 0);
                f
            };
            if mic_tx.send(frame).await.is_err() { break; }
        }
    });

    let pending: Arc<std::sync::Mutex<HashMap<String, (Instant, Instant, u32)>>> = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let mut responding = false;
    let (answer_tx, mut answer_rx) = mpsc::unbounded_channel::<(String, String)>();
    let mut ready_answers: VecDeque<(String, String)> = VecDeque::new();
    let mut awaiting: Option<(String, Instant)> = None;
    let mut user_said: Vec<(Instant, String)> = Vec::new();
    let mut verifying: Option<(String, String, Instant, Instant)> = None;
    let mut status_tick = tokio::time::interval(Duration::from_secs(1));
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ask_seq = 0u32;

    let max_minutes = settings().get("maxCallMinutes").and_then(Value::as_f64).unwrap_or(15.0).clamp(1.0, 120.0);
    let deadline = tokio::time::sleep(Duration::from_secs_f64(max_minutes * 60.0));
    tokio::pin!(deadline);
    let ended = handle.wait_ended();
    tokio::pin!(ended);
    let mut hang_up = false;

    // Ask Mercury a question; the answer comes back on answer_tx.
    let ask = |q: String, id: String, pending: &Arc<std::sync::Mutex<HashMap<String, (Instant, Instant, u32)>>>| {
        let st2 = st.clone();
        let tx2 = answer_tx.clone();
        let call_id2 = call_id.to_string();
        let now = Instant::now();
        pending.lock().unwrap().insert(id.clone(), (now, now, 0));
        st.call_activity.lock().unwrap().remove(call_id);
        let pending2 = pending.clone();
        tokio::spawn(async move {
            let answer = st2.out.request("mercury/call/ask", json!({ "callId": call_id2, "question": q }), ASK_TIMEOUT)
                .await
                .ok()
                .and_then(|v| v.get("answer").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| "Mercury didn't answer in time. It will send the answer by message.".into());
            pending2.lock().unwrap().remove(&id);
            let _ = tx2.send((id, answer));
        });
    };

    let result = loop {
        tokio::select! {
            _ = &mut ended => break Ok(()),
            _ = &mut deadline => { hang_up = true; break Ok(()) }
            Some(a) = answer_rx.recv() => {
                // A newer question replaced this one: don't speak the stale answer.
                if a.1.starts_with("(superseded") { continue; }
                ready_answers.push_back(a);
                if !responding { deliver(&link, brain, &mut ready_answers, &mut responding); }
            }
            _ = status_tick.tick() => {
                if let Some((fc, _id, _asked, deadline)) = verifying.clone() {
                    if Instant::now() >= deadline {
                        verifying = None;
                        ready_answers.push_back((fc, "Not approved: the user hasn't clearly said yes in their own words. Ask them again, or they can reply 1 in the WhatsApp chat.".to_string()));
                    }
                }
                if !responding && !ready_answers.is_empty() {
                    deliver(&link, brain, &mut ready_answers, &mut responding);
                    continue;
                }
                if responding || !playout.lock().unwrap().is_empty() { continue; }
                if awaiting.is_none() {
                    let next = st.call_approvals.lock().unwrap().get_mut(call_id).and_then(|l| if l.is_empty() { None } else { Some(l.remove(0)) });
                    if let Some((id, prompt)) = next {
                        awaiting = Some((id, Instant::now()));
                        match brain {
                            Brain::Voice => link.send(LinkCmd::Instruct(format!("[Approval needed, not said by the user] Mercury wants to: {prompt}. Ask the user plainly, in one or two sentences, whether to go ahead. Then wait for their answer and call answer_approval. (They can also reply 1 in the WhatsApp chat.)"))),
                            Brain::Mercury => link.send(LinkCmd::Say(format!("I need your go-ahead to {prompt}. Should I do it? Say yes or no, or reply 1 in the chat."))),
                        }
                        responding = true;
                        continue;
                    }
                }
                let context = st.call_context.lock().unwrap().remove(call_id);
                if let Some(mut notes) = context.filter(|n| !n.is_empty()) {
                    for n in notes.iter_mut() {
                        if let Some(rest) = n.strip_prefix("RESOLVED:") {
                            let (id, text) = rest.split_once(':').unwrap_or(("", rest));
                            if awaiting.as_ref().map(|(a, _)| a == id).unwrap_or(false) { awaiting = None; }
                            *n = text.to_string();
                        }
                    }
                    match brain {
                        Brain::Voice => link.send(LinkCmd::Instruct(format!("[Status update, not said by the user] {} Acknowledge it in one short sentence (for example 'Got your photo, want me to take a look?'), unless they're mid-sentence.", notes.join(" ")))),
                        Brain::Mercury => link.send(LinkCmd::Say(if notes.iter().any(|n| n.contains("sent")) { "Got it, I can see what you sent. Ask me about it whenever you like.".into() } else { "Okay, noted.".into() })),
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
                if let Some((n, secs)) = due {
                    let doing = st.call_activity.lock().unwrap().get(call_id).cloned().unwrap_or_else(|| "working on it".into());
                    match brain {
                        Brain::Voice => link.send(LinkCmd::Instruct(if n == 1 {
                            format!("[Status update, not said by the user] Mercury is still {doing}. Tell the user in one short sentence that it's taking a few seconds and they can stay on the line.")
                        } else {
                            format!("[Status update, not said by the user] After {secs} seconds Mercury is still {doing}. Give the user one short, natural update (don't repeat yourself) so they know you're still there.")
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
                    }
                    LinkEvent::Audio(pcm) => playout.lock().unwrap().extend(pcm),
                    LinkEvent::SpeechStarted => {
                        playout.lock().unwrap().clear();
                        link.send(LinkCmd::Cancel);
                    }
                    LinkEvent::AssistantText(t) => {
                        if !t.is_empty() { transcript.lock().await.push(json!({ "role": "mercury", "text": t })); }
                    }
                    LinkEvent::UserText(t) => {
                        if t.is_empty() { continue; }
                        transcript.lock().await.push(json!({ "role": "owner", "text": t.clone() }));
                        user_said.push((Instant::now(), t.clone()));
                        if user_said.len() > 20 { user_said.remove(0); }
                        if let Some((fc, id, asked_at, _)) = verifying.clone() {
                            if let Some(v) = spoken_verdict(&user_said, asked_at) {
                                verifying = None;
                                awaiting = None;
                                let out = finalize_approval(st, call_id, &id, v).await;
                                ready_answers.push_back((fc, out));
                                if !responding { deliver(&link, brain, &mut ready_answers, &mut responding); }
                            }
                            continue;
                        }
                        if brain == Brain::Mercury {
                            // No model of its own: the caller's words decide approvals, everything else is a Mercury turn.
                            if let Some((id, asked_at)) = awaiting.clone() {
                                if let Some(v) = spoken_verdict(&user_said, asked_at) {
                                    awaiting = None;
                                    finalize_approval(st, call_id, &id, v).await;
                                    link.send(LinkCmd::Say(if v { "Okay, going ahead.".into() } else { "Okay, I won't.".into() }));
                                    continue;
                                }
                            }
                            if is_goodbye(&t) {
                                link.send(LinkCmd::Say("Okay, bye for now!".into()));
                                tokio::time::sleep(Duration::from_millis(2500)).await;
                                hang_up = true;
                                break Ok(());
                            }
                            ask_seq += 1;
                            transcript.lock().await.push(json!({ "role": "ask_mercury", "text": t.clone() }));
                            ask(t, format!("turn-{ask_seq}"), &pending);
                        }
                    }
                    LinkEvent::ToolCall { id, name, args } => {
                        if name == "end_call" {
                            for _ in 0..50 {
                                if playout.lock().unwrap().is_empty() { break; }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                            hang_up = true;
                            break Ok(());
                        }
                        if name == "answer_approval" {
                            let approved = args.get("approved").and_then(Value::as_bool).unwrap_or(false);
                            match awaiting.clone() {
                                None => ready_answers.push_back((id, "No approval is waiting right now.".to_string())),
                                Some((aid, asked_at)) => match (approved, spoken_verdict(&user_said, asked_at)) {
                                    (false, _) | (true, Some(false)) => {
                                        awaiting = None;
                                        let out = finalize_approval(st, call_id, &aid, false).await;
                                        ready_answers.push_back((id, out));
                                    }
                                    (true, Some(true)) => {
                                        awaiting = None;
                                        let out = finalize_approval(st, call_id, &aid, true).await;
                                        ready_answers.push_back((id, out));
                                    }
                                    (true, None) => verifying = Some((id, aid, asked_at, Instant::now() + Duration::from_secs(3))),
                                },
                            }
                            if !responding { deliver(&link, brain, &mut ready_answers, &mut responding); }
                            continue;
                        }
                        if name == "schedule_callback" {
                            let r = st.out.request("mercury/call/schedule", json!({
                                "when": args.get("when").and_then(Value::as_str).unwrap_or(""),
                                "topic": args.get("topic").and_then(Value::as_str).unwrap_or(""),
                            }), Duration::from_secs(10)).await;
                            let text = match r {
                                Ok(v) => v.get("text").and_then(Value::as_str).unwrap_or("Done.").to_string(),
                                Err(e) => format!("Couldn't schedule it: {e}"),
                            };
                            transcript.lock().await.push(json!({ "role": "ask_mercury", "text": format!("schedule a call back: {}", args.get("when").and_then(Value::as_str).unwrap_or("")) }));
                            ready_answers.push_back((id, text));
                            if !responding { deliver(&link, brain, &mut ready_answers, &mut responding); }
                            continue;
                        }
                        if name == "ask_mercury" {
                            let q = args.get("question").and_then(Value::as_str).unwrap_or("").to_string();
                            transcript.lock().await.push(json!({ "role": "ask_mercury", "text": q.clone() }));
                            ask(q, id, &pending);
                        }
                    }
                }
            }
        }
    };

    uplink.abort();
    pacer.abort();
    if hang_up {
        let _ = handle.terminate().await;
    }
    result
}

/// An outgoing call's opener carries "Why you called: …"; a pipeline voice says just the reason.
fn opener_reason(opener: &str) -> String {
    opener.split("Why you called:").nth(1).map(|r| r.split(". Greet").next().unwrap_or(r).trim().to_string()).filter(|r| !r.is_empty())
        .map(|r| format!("I'm calling because {r}"))
        .unwrap_or_else(|| "How can I help?".into())
}

fn is_goodbye(t: &str) -> bool {
    let t = format!(" {} ", t.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric() && !c.is_whitespace()));
    let short = t.split_whitespace().count() <= 4;
    short && [" bye ", " goodbye ", " bye bye ", " that's all ", " thats all ", " khuda hafiz ", " allah hafiz ", " alvida ", "अलविदा", "خدا حافظ", "اللہ حافظ"].iter().any(|w| t.contains(w))
}

async fn finalize_approval(st: &Arc<State>, call_id: &str, approval_id: &str, yes: bool) -> String {
    match st.out.request("mercury/call/approve", json!({ "callId": call_id, "approvalId": approval_id, "approved": yes }), Duration::from_secs(10)).await {
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

/// Hand Mercury's answer to the voice: a reasoning model gets it as the tool result;
/// a pipeline voice speaks it (approval bookkeeping strings become short words).
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
        "your OpenAI account is out of credit. Add credit at platform.openai.com → Settings → Billing, then call again".into()
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
        assert_eq!(spoken_verdict(&[(after, "haan kar do".into())], asked), Some(true));
        assert_eq!(spoken_verdict(&[(after, "No, don't do that".into())], asked), Some(false));
        assert_eq!(spoken_verdict(&[(after, "what did you say?".into())], asked), None);
        // Words from before the question don't count.
        assert_eq!(spoken_verdict(&[(asked - Duration::from_secs(5), "yes".into())], asked), None);
    }

    #[test]
    fn close_reasons_are_explained() {
        assert!(explain_close("insufficient_quota.credit_balance_exhausted").contains("out of credit"));
        assert!(explain_close("").contains("closed"));
    }

}
