# Release v1.5.3

## ☿ Mercury Agent v1.5.3

Ready for Mercury on your phone, Google Workspace in one command, and bots that can't be steered by what they read.

### Mercury on your phone
The native iPhone and Android apps connect to this release. They aren't in the app stores yet.
- **Real-time voice calls.** The phone gets a short-lived token from your Mercury and runs Mercury's own voice engine, so a call answers in about two seconds. Your API keys never leave your computer.
- **Calls hear you, not the room.** Background talk and noise don't count as you speaking.
- **Live dictation** types your words into the message box as you speak, with OpenAI, Deepgram or ElevenLabs.
- **Chat lists show a preview** of each chat's last message.

### Google Workspace
- **`mercury google connect`** connects Gmail, Drive and Docs.
  - It installs Google's `gws` tool, pinned and checksum-checked.
  - It signs you in to your own Google account.
  - It adds Mercury's Google Workspace skill.
  - Access is read-only unless you add `--write`.
  - `/google connect` works from any chat.
- **Sends, shares, uploads and deletes always ask you**, even under Allow All. They're refused in scheduled tasks and for bots.
- **Your Google sign-in stays out of reach** of Mercury's own tools, and Google tokens and keys are masked in command output.

### Security
- **Bots keep the full protection against planted instructions**, whatever the model. It's relaxed only in a chat you're in.
- **A bot's own tools are guarded:** scheduling runs, creating bots and messaging the fleet ask you after a bot reads outside content.
- **No laundering across the fleet.** Work passed between bots carries what the sender read.

### Also
- **A new device token is shown whole** in the terminal, with **Copy to clipboard**.
- **Bot faces are drawn properly again** in Mercury Desktop.
- **`mercury skills install --from`** accepts a SKILL.md without an `id`.
- **Windows opens links whole**, and only http and https links.

### Install
- **Desktop:** [mercuryagent.sh/download](https://mercuryagent.sh/download) · Mac: `curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh`
- **Server / CLI:** `curl -fsSL https://mercuryagent.sh/install.sh | sh` · Windows: `irm https://mercuryagent.sh/install.ps1 | iex` · npm: `npm i -g @cosmicstack/mercury-agent`
- **Already installed:** the Update button in Mercury Desktop, or `mercury upgrade`
