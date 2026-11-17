# Release v1.5.4

## ☿ Mercury Agent v1.5.4

Set up voice from your phone, and fewer approval prompts.

### Voice from any device
- **Set voice keys from your phone**, with or without Optimus: OpenAI, Gemini, ElevenLabs, Deepgram and more. Mercury checks each key before saving it. A key is never shown back to a device, only its last four characters.
- **One place for keys.** A key saved from the phone, Mercury Desktop or Optimus is the same key everywhere.

### Fewer prompts
- **Only plugin installs ask from another device.** Changing a plugin's settings, like Optimus's voice, and setting voice keys no longer ask for your approval. Both are still recorded in the audit log.

### Fixes
- **A setting changed from a phone no longer snaps back** when the plugin takes a while to restart.

### Install
- **Desktop:** [mercuryagent.sh/download](https://mercuryagent.sh/download) · Mac: `curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh`
- **Server / CLI:** `curl -fsSL https://mercuryagent.sh/install.sh | sh` · Windows: `irm https://mercuryagent.sh/install.ps1 | iex` · npm: `npm i -g @cosmicstack/mercury-agent`
- **Already installed:** the Update button in Mercury Desktop, or `mercury upgrade`
