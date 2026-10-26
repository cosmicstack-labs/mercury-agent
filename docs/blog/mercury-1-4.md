# Mercury 1.4: plugins, WhatsApp calls, and an agent at your desk

> Mercury 1.4 adds isolated plugins and two official ones: WhatsApp chat with voice calls both ways, and Optimus, which sees your screen and uses your mouse.

Published 2026-10-23 by Salman Qureshi. Tags: news, releases, product.
Canonical: https://mercuryagent.sh/blog/mercury-1-4

Mercury 1.4, which we are calling Pluggy Mercury, is out. It adds a plugin system, and two official plugins built on it. The WhatsApp plugin lets you chat with Mercury and talk to it by voice call: you can call it, and it can call you. Optimus lets Mercury use your computer. It looks at the screen, moves the pointer and types the way a person does, and you can drive it by chat or by pressing a key and talking.

This is the first stable release since 1.3.8. The [release notes](/docs/releases/1.4.0) have the full list. This post is about why we built it this way.

## Why plugins

WhatsApp calling needs a WhatsApp protocol stack, a realtime audio pipeline and a handful of voice providers. Computer control needs screen capture, synthetic input and, on macOS, its own signed app bundle. Many people who run Mercury want neither. Putting both into the single Mercury binary would have made the download bigger for everyone and put more native code into every install.

So we wrote down a rule in [ADR-025](https://github.com/cosmicstack-labs/mercury-agent/blob/main/DECISIONS.md): features only some people want ship as plugins, and a bad plugin must never take Mercury down with it. The work started in [#203](https://github.com/cosmicstack-labs/mercury-agent/issues/203).

You manage plugins from any chat:

```text
/plugins install whatsapp
/plugins disable whatsapp
/plugins update
/plugins rollback whatsapp
/plugins uninstall whatsapp
```

The same commands work in a shell as `mercury plugins ...`, and in the dashboard under Configure, then Plugins. The catalog lives at `https://mercuryagent.sh/plugins/catalog.json`. Every entry pins a version to a SHA-256 checksum, and Mercury checks the download against it before installing anything.

## How a plugin is kept at arm's length

Both official plugins are out-of-process. Each is a separate Rust program that Mercury starts and talks to over stdio using MCP, plus a small channel extension for chat and voice. That boundary does most of the work:

- **A crash is the plugin's problem.** Mercury restarts it. After five failures in a row, or too many crashes, the plugin is turned off and you get a message saying why.
- **It gets only what it declared.** The manifest lists the network hosts a plugin may reach and the secrets it may read. Install shows you that list before you confirm. A plugin that controls the computer carries a new `permissions.desktop` flag, and `/plugins info` shows it as a warning.
- **It can't widen access.** For a chat channel, Mercury decides who gets through, not the plugin. Unknown numbers are dropped before they reach the agent.
- **Changes are reversible.** The previous version is kept, so `/plugins rollback` brings it back with its old settings. If Mercury fails to start twice right after a plugin change, it turns that plugin off. `mercury start --safe-mode` starts with every plugin off.

Plugins also borrow Mercury's own AI providers. If you already set up OpenAI in Mercury, both plugins' voice features use that key. You don't paste it again. Keys a plugin needs for itself, such as a Gemini or Deepgram key, are stored with Mercury's keys and shared with any other plugin that declares them.

The plugin menu took two rounds. In the first version, the main settings sat behind a "Change a setting" entry, the voice section forced you through every field, yes/no questions didn't say what each answer meant, and picking a voice engine didn't lead you to the key it needed. Now `/plugins whatsapp` lists every setting with its current value. A yes/no setting says what each answer does ("On: Mercury picks up when you call it"). Change the voice engine to Gemini and Mercury asks for the Gemini key straight away. Every question has a way back.

The plugin API is now at 1.2. The main addition is that a tool can return images to the model, which Optimus needs for screenshots. The images go to the model with that one tool result and are never written to chat history, logs or memory. The [author guide](/docs/reference/plugins) covers the rest.

## WhatsApp: it can call you, or listen to you on the go

The WhatsApp plugin runs Mercury on a spare number as a linked device, the same way WhatsApp Web connects. You chat with it from your own number. One warning up front: this uses an unofficial, reverse-engineered protocol. A WhatsApp update can break it, and automated use can get a number restricted. Link a number you can afford to lose, not your main one.

Text works the way you'd expect. Photos and PDFs you send are passed to the model if it accepts them, and voice notes are transcribed with your OpenAI provider. Two access levels decide how much Mercury can do in the chat. General, the default, is conversation only, with no tools, files or memory. Extended is the full agent.

Calls are where it gets useful. You can ring the spare number while you're out and ask Mercury to look something up, check on a task, or draft a reply. It can also ring you. Say "call me at 9pm about the deploy" in any chat, or on a call. The time is parsed in code, not by a model, and confirmed back to you as an exact time. If you miss the call, it tries once more five minutes later and then sends a message. "Call me when it's done" means it does the work first and then calls. Mercury won't call more than four times an hour by default, so a task stuck in a loop can't keep ringing your phone.

During a call, Mercury uses its tools as usual and keeps you posted while it works. Anything that needs approval is asked out loud and posted in the chat at the same moment, and whichever answer arrives first wins. A spoken yes only counts if your own transcribed words say yes, and it never turns into "always". Mercury doesn't read links aloud. It sends them to the chat and tells you it did.

OpenAI Realtime is the default voice engine, and the one we recommend for the best calls. Gemini Live, Grok Voice, ElevenLabs, Azure, Qwen-Omni, or your own Mercury model with separate speech-to-text and text-to-speech providers all work too. Setup only asks about the engine if you don't have an OpenAI provider already.

The full setup is in the [WhatsApp docs](/docs/integrations/whatsapp).

## Optimus: Mercury at your desk

Optimus is the big one. You ask, and Mercury does it on your screen, in whatever app you use.

**How it sees.** The `look` tool takes a screenshot of the display the mouse is on, scaled to fit 1280 by 800, and can zoom into part of it. Screenshots are taken only when Mercury looks or acts. Nothing captures in the background.

**How it acts.** We wanted you to be able to follow what it's doing. In the default Natural pace, the pointer glides along a gentle curve, scrolling arrives in small steps, and text is typed key by key with an uneven rhythm. Typing key by key means it works in every editor, and paste is only a fallback. While it drives, a ring and the label "Mercury is driving" follow the pointer. On macOS and Windows that overlay is excluded from capture, so it never shows up in Optimus's own screenshots.

**How it stays honest.** This was the hardest part. The logs from one early build showed 29 `act` calls rejected because the model sent its steps in a shape Optimus couldn't read. Nothing happened on screen, and Mercury reported success anyway. Optimus now reads steps in every shape we've seen models send. Every step reports "Sent", meaning the input reached the screen, not "done", and returns a fresh screenshot. Failures start with FAILED. Mercury is told to look again and confirm the result before it says a task is finished. Optimus also records every step that failed or was stopped. In a voice session, the answer is checked against that record before you hear it, so a failed task is reported as failed.

**How you stay in control.**

- Optimus does nothing until you turn on "Control this computer" in setup.
- Ordinary, reversible steps run straight away. The step that submits, sends, posts, pays, deletes, installs or changes a setting goes through a separate tool that needs your approval.
- Move the mouse while it works and it stops at the next step and hands control back.
- It's told never to type passwords, card numbers or 2FA codes. It asks you to do that part.

Press the talk key (`ctrl+alt+m` by default, Control+Option+M on a Mac), hear a chime, and talk. Mercury answers out loud and narrates each step as it happens. A quiet tick-tock plays while it works. Say "stop", or press the talk key while it's working, and every action halts at once. The mute key (`ctrl+alt+shift+m`) stops listening without stopping the work, and nothing you say is sent while muted. After 60 seconds of silence with nothing running, the mic closes by itself. The terminal status bar shows when Optimus is listening, working or muted. Voice settings are shared with the WhatsApp plugin, so a key you added there works here too.

Optimus runs on macOS, Windows and Linux, and no Apple Developer ID is involved. On macOS, privacy permissions are charged to the app that launched a process, so if Optimus ran under your terminal, the grant would cover every script that terminal runs. Instead, Optimus builds its own `Optimus.app` and signs it with a certificate made on your Mac. You grant it Accessibility, Screen Recording and Microphone once, and because the certificate stays the same, the grants survive updates. On Windows there's nothing to grant, though windows running as administrator can't be controlled. On Linux, X11 gets full control. Wayland is limited for now: input and the talk key reach only XWayland apps.

The [Optimus docs](/docs/integrations/optimus) cover every setting and permission.

## The rest of 1.4

- A built-in `web_search` tool, free and keyless. In testing, asking for the news on a WhatsApp call made zero tool calls, partly because Mercury had no search tool to call.
- Mercury always knows it comes from Cosmic Stack.
- The dashboard model picker shows plain-language names, every local Ollama model and ChatGPT Plus/Pro plan models, and has a reasoning picker.
- Fixes for ChatGPT OAuth turns failing after a tool call, memory search failing on long messages, and the dashboard on the Windows standalone binary (found and fixed by @farena-ai in #189). The 1.3.9 fix, where `mercury doctor` restarts the daemon when your configuration changed, is folded in.

## Upgrading

```bash
# npm
npm install -g @cosmicstack/mercury-agent@1.4.0
mercury restart

# standalone binary: rerun the installer, or
mercury upgrade
```

Then install what you want:

```text
/plugins install whatsapp
/plugins install optimus
```

Your `~/.mercury` folder carries over untouched. If something breaks, open an issue or find us on [Discord](https://discord.gg/5emMpMJy5J).

https://github.com/cosmicstack-labs/mercury-agent
