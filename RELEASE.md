# Release v1.5.1

## ☿ Mercury Agent v1.5.1

Reading aloud and voice typing now use the voice you chose, Gemini included, and the Optimus update button tells you what it did.

### Speech
- **Your voice choice counts everywhere.** Reading a reply aloud, voice typing and voice notes from Telegram or WhatsApp use the voice service chosen in Settings → Voice when it has a key. A fresh install with only a Gemini key no longer asks for an OpenAI key.
- **Gemini speaks and listens.** Gemini reads replies aloud (about 4 seconds for a sentence) and transcribes what you say, with the same key Optimus uses. A Gemini model that's busy or retired falls through to the next one.
- **The "needs a speech service" notice** points to Voice settings and names every option (Gemini, OpenAI, Deepgram, ElevenLabs) instead of an "Add OpenAI key" button.

### Mercury Desktop
- **"Update Optimus" says what happened** on the microphone & permissions card: updated, no newer version yet, or why it failed. It used to spin for a second and show nothing.

### Plugins
- **Optimus 0.5.1 is in the catalog** (a plugin-only update, works with Mercury 1.3.9 and newer): the microphone picker, live voice-level test, off switch and permission checks on Mercury Desktop's Optimus page. Update it under Plugins → Optimus.

### Install
- **Desktop:** [mercuryagent.sh/download](https://mercuryagent.sh/download) · Mac: `curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh`
- **Server / CLI:** `curl -fsSL https://mercuryagent.sh/install.sh | sh` · Windows: `irm https://mercuryagent.sh/install.ps1 | iex` · npm: `npm i -g @cosmicstack/mercury-agent`
- **Already installed:** the Update button in Mercury Desktop, or `mercury upgrade`
