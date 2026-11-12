# Release v1.5.2

## ☿ Mercury Agent v1.5.2

Watch your bots work live, approve things one at a time, and get complex jobs done properly. Chats run at the same time, memory keeps one copy of each thing, and text Mercury reads can't steer it.

### Getting real work done
- **Complex chat work follows Mercury Code's rules.** Once the chat makes a plan:
  - it acts instead of announcing;
  - it checks what it made before calling it done;
  - when a tool fails, it fixes the cause or asks, never quietly switching methods.
- **Commands run on Mercury's own Node.** Node tools like HyperFrames no longer fail on an older system Node.
- **A video that never rendered isn't sent as finished.** A video that's all black, or never moves, is caught before it goes out.
- **Plans keep up.** A forgotten last tick is completed. Unfinished plans show "paused" or "stopped" instead of a step stuck "in progress".
- **Skills and services you name are the ones used, for the whole chat.** "Use hyperframes" or "with ElevenLabs" sticks, and Mercury also reads skills installed for other agents (`~/.agents/skills`).
- **Voice notes say only the words.** Directions like "keep it natural" are never read aloud.

### Mercury Desktop
- **Bots, live.** A Live tab for every bot and fleet shows each run as it happens: what it was asked, every step, its reply as it writes it, and how it ended. Message any bot from there, or reply to a finished run.
- **"Needs you", one at a time.** Approvals are a card above the message box, in plain words, as a carousel when there are several.
- **A new chat that knows you.** It opens with suggestions made from what you're working on, and the cursor is ready in the message box.
- **Image batches** come as one group, with a full-screen slider.
- **Artifacts:** delete for real, see the space they take, and clean up in bulk.
- **Fewer false bot approvals.** Read-only commands in a bot's own folders no longer ask, and bot faces always have colour.

### Memory
- **One copy of each thing.** "Heer is my wife" in eleven wordings is one memory now. Copies already saved are folded once, after a backup.
- **People:** one person under several names becomes one entry, and stray words are checked before they count as people.

### Security
- **Untrusted content can't steer privileged actions.** After reading files, pages or other people's messages, actions that schedule, save, send or install need your yes. Hidden instructions are flagged, and data can't leave through a web address.
- **Strong models are asked only before data leaves.** Small, local and unknown models keep every approval.
- Far fewer false alarms on documentation about AI.

### Also
- Chats run at the same time, faster and cheaper requests, images, video, music and speech as media, and per-chat effort. The full list is in the CHANGELOG.

### Install
- **Desktop:** [mercuryagent.sh/download](https://mercuryagent.sh/download) · Mac: `curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh`
- **Server / CLI:** `curl -fsSL https://mercuryagent.sh/install.sh | sh` · Windows: `irm https://mercuryagent.sh/install.ps1 | iex` · npm: `npm i -g @cosmicstack/mercury-agent`
- **Already installed:** the Update button in Mercury Desktop, or `mercury upgrade`
