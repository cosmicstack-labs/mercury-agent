# Optimus

Mercury uses your computer like a person: it sees the screen, moves the mouse, types, and opens apps, on macOS, Windows and Linux. Use it by chat, or out loud with a talk key.

## Setup

```
mercury plugins install optimus
```

Setup asks:

1. **Let Optimus control this computer?** Nothing works until you say yes.
2. **How do you want to talk to Optimus?** Chat, Listening, or Both (recommended).
3. **Key to start and stop talking** (default `ctrl+alt+m`: Control+Option+M on a Mac).
4. **Who listens and speaks?** OpenAI is used automatically when Mercury has an OpenAI key; otherwise pick Gemini, Grok, ElevenLabs, Azure, Qwen, or your own Mercury model with Deepgram/Cartesia/etc. Keys you added for the WhatsApp plugin work here too.

Change any of it later in `/plugins optimus`.

- **macOS:** Optimus builds `Optimus.app` in its data folder and signs it with a certificate made on your Mac (no Apple account involved), then asks for two permissions in System Settings → Privacy & Security: **Accessibility** (mouse and keyboard) and **Screen Recording** (seeing the screen). The permissions survive updates. macOS asks you to confirm Screen Recording again about once a month.
- **Windows:** nothing to grant. Windows running as administrator (Task Manager, installers) can't be controlled yet.
- **Linux:** works fully on X11. On Wayland, screenshots go through the desktop's screen-sharing prompt, and input and the talk key reach only X11 apps for now (use chat, or the `listen` tool).

## Talking to it

- **Chat:** ask Mercury in any chat (TUI, dashboard, WhatsApp, Telegram): "look at my screen", "open Safari and search for…".
- **Listening:** press the talk key (you hear a rising chime), talk, and Mercury answers out loud while it works on your screen, saying each step as it happens. A soft tick means it's still working.
- **The talk key:** while Optimus is working it's the **stop button** (everything halts, you keep talking); while Mercury is speaking it interrupts; when all is quiet it ends the session (falling chime).
- **Mute:** Control+Option+Shift+M (or say "mute") stops listening while Mercury keeps working and talking; nothing you say is sent. Press it again, or the talk key, to unmute. The status bar shows 🔇.
- **Saying "stop"** ("cancel", "ruko", "bas") halts every action and the task at once; **"bye"** does the same and ends the session. Silence for 60 seconds ends it too.
- Links and details go to your Mercury chat. Approvals are asked out loud.
- With speakers, the mic is muted while Mercury talks so it doesn't hear itself. With headphones, turn on "I use headphones" in `/plugins optimus` → 🎙 Voice to interrupt just by talking.
- macOS asks once for the **Microphone** for Optimus.

## What it can do

| Tool | What it does |
| --- | --- |
| `look` | Screenshot of the display the mouse is on (or display N), with an optional zoom |
| `act` | Click, double-click, right-click, drag, type, key combos, scroll, wait; returns a fresh screenshot |
| `act_consequential` | The same, for steps that submit, send, pay, delete, install or change settings: you approve first |
| `open` | Open an app by name, a URL, or a file |
| `windows` | List open windows |
| `permissions` | Check (and request) the OS permissions |
| `listen` | Start a voice conversation from chat ("let's talk") |

## Safety

- Off until you allow it in setup.
- Anything that commits something goes through Mercury's approval prompt.
- Move the mouse while Optimus is working and it stops, handing control back.
- It never types passwords, card numbers or 2FA codes: it asks you to.
- Screenshots go to the model for the current step only; they are not saved in chat history or logs.

## Build

```
cd plugins/optimus/companion && cargo build --release
node plugins/optimus/package.mjs companion/target/release/mercury-optimus darwin-arm64 dist
```

Linux needs `libxcb1-dev libxrandr-dev libdbus-1-dev libpipewire-0.3-dev libwayland-dev libegl-dev libgbm-dev libasound2-dev clang` to build.
