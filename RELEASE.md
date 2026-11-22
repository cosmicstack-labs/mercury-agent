# Release v1.5.5

## ☿ Mercury Agent v1.5.5

Devices sign in with a device token, Mercury asks you for what only you can do, and bots use fewer tokens.

### Devices sign in with a device token
- **Password sign-in from other devices is now off by default.** To connect a phone, Mercury Desktop or a browser on another computer, make a token on the computer Mercury runs on: `/server token <name>` (or `mercury devices add <name>`), and paste it in. Devices already signed in keep working. Turn password sign-in back on with `/server password on`.
- **`/server` is easier:** add allowed addresses by typing them, copying a token closes the token screen, and in Mercury Desktop `/server` opens its own Remote access window.

### Mercury asks you for what only you can do
- **CAPTCHAs, codes, a step on a website:** Mercury sends it to every chat you've connected (Telegram, WhatsApp, Signal, Discord, Slack), Mercury Desktop and your phones, with the image, and waits. Reply from any of them; every chat is told when it's done.
- **Plugins can ask you too,** and can use any vision model you've set up (Plugin API 1.3).

### Bots
- **Auto mode:** bots no longer wait for approvals. Reversible actions go ahead, anything that can't be undone is refused.
- **Fewer tokens:** prompt caching in bot runs, fewer steps, and a wrap-up instead of running past the budget.

### Also new
- **Mercury can ring and notify your phone** (`call_owner`, `notify_owner`, scheduled calls).
- **Any to PDF** is a built-in skill.
- **Live dictation** in Mercury Desktop's message box.

### Install
- **Desktop:** [mercuryagent.sh/download](https://mercuryagent.sh/download) · Mac: `curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh`
- **Server / CLI:** `curl -fsSL https://mercuryagent.sh/install.sh | sh` · Windows: `irm https://mercuryagent.sh/install.ps1 | iex` · npm: `npm i -g @cosmicstack/mercury-agent`
- **Already installed:** the Update button in Mercury Desktop, or `mercury upgrade`
