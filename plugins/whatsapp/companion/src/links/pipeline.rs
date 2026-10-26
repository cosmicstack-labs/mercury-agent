//! "My own model" calls: streaming speech-to-text → the bridge (which asks the
//! owner's Mercury model, any provider) → streaming text-to-speech.
//!
//! This link never reasons: every finished utterance goes up as UserText, and
//! the bridge answers with Say. Speech is queued in order; Cancel (barge-in)
//! stops the current utterance and drops anything queued.

use std::collections::VecDeque;

use tokio::sync::mpsc;

use super::{Brain, Link, LinkCmd, LinkConfig, LinkEvent, stt, tts};

pub async fn open(cfg: LinkConfig) -> Result<Link, String> {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<LinkCmd>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<LinkEvent>();
    let (stt_tx, mut stt_rx) = mpsc::unbounded_channel::<stt::SttEvent>();
    let audio_in = stt::start(&cfg.settings, stt_tx).await?;

    // Speech-to-text events → bridge.
    let ev = ev_tx.clone();
    tokio::spawn(async move {
        while let Some(e) = stt_rx.recv().await {
            let out = match e {
                stt::SttEvent::SpeechStarted => LinkEvent::SpeechStarted,
                stt::SttEvent::Final(t) => LinkEvent::UserText(t),
                stt::SttEvent::Closed(r) => LinkEvent::Closed(r),
            };
            if ev.send(out).is_err() { break; }
        }
    });

    let settings = cfg.settings.clone();
    tokio::spawn(async move {
        let mut queue: VecDeque<String> = VecDeque::new();
        let mut speaking: Option<tokio::task::JoinHandle<()>> = None;
        let (done_tx, mut done_rx) = mpsc::unbounded_channel::<()>();
        loop {
            // Start the next utterance when idle.
            if speaking.as_ref().map(|h| h.is_finished()).unwrap_or(true) {
                if let Some(text) = queue.pop_front() {
                    let _ = ev_tx.send(LinkEvent::ResponseStarted);
                    let _ = ev_tx.send(LinkEvent::AssistantText(text.clone()));
                    let (pcm_tx, mut pcm_rx) = mpsc::unbounded_channel::<Vec<i16>>();
                    let ev2 = ev_tx.clone();
                    let fwd = tokio::spawn(async move {
                        while let Some(p) = pcm_rx.recv().await {
                            if ev2.send(LinkEvent::Audio(p)).is_err() { break; }
                        }
                    });
                    let s = settings.clone();
                    let done = done_tx.clone();
                    let ev3 = ev_tx.clone();
                    speaking = Some(tokio::spawn(async move {
                        if let Err(e) = tts::speak(&s, &text, &pcm_tx).await {
                            crate::log(format!("voice: {e}"));
                            // A broken voice provider shouldn't leave the caller in silence forever.
                            let _ = ev3.send(LinkEvent::Closed(e));
                        }
                        drop(pcm_tx);
                        let _ = fwd.await;
                        let _ = done.send(());
                    }));
                }
            }
            tokio::select! {
                c = cmd_rx.recv() => {
                    let Some(c) = c else { break };
                    match c {
                        LinkCmd::Audio(frame) => { let _ = audio_in.send(frame); }
                        LinkCmd::Say(text) => { if !text.trim().is_empty() { queue.push_back(text); } }
                        LinkCmd::ToolResult { output, .. } => { if !output.trim().is_empty() { queue.push_back(output); } }
                        // Only reasoning models act on instructions; the bridge sends Say for us.
                        LinkCmd::Instruct(_) => {}
                        LinkCmd::Cancel => {
                            queue.clear();
                            if let Some(h) = speaking.take() {
                                h.abort();
                                let _ = ev_tx.send(LinkEvent::ResponseDone);
                            }
                        }
                    }
                }
                Some(()) = done_rx.recv() => {
                    speaking = None;
                    if queue.is_empty() { let _ = ev_tx.send(LinkEvent::ResponseDone); }
                }
            }
        }
        if let Some(h) = speaking { h.abort(); }
    });

    Ok(Link { brain: Brain::Mercury, cmd: cmd_tx, events: ev_rx })
}
