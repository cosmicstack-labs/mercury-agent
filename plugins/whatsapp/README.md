# WhatsApp for Mercury

Chat with Mercury on WhatsApp. Mercury runs on a **spare number** as a
linked device, the same way WhatsApp Web connects, so no WhatsApp Business
account is needed.

> ⚠️ This uses an **unofficial, reverse-engineered protocol**
> ([whatsapp-rust](https://github.com/oxidezap/whatsapp-rust)). A WhatsApp
> update can break it, and automated use can get the number restricted or
> banned. Use a spare number you can afford to lose, **not your main one**.

## Set up

```sh
mercury plugins install whatsapp
```

Mercury then walks you through setup, one question at a time. It works the
same in a chat (`/plugins install whatsapp`) or in the dashboard:

1. **Which number will you chat from?** This is your own number, and only
   it can talk to Mercury.
2. **What can Mercury do in your chat?** General (chat only) or Extended
   (memory, files, tools).
3. **Answer your voice calls?**
4. **Link the spare number:** a pairing code you type on the spare phone,
   or a QR code to scan.

Change anything later with `/plugins whatsapp` (or `mercury plugins open
whatsapp`): pick a setting from the list, link or unlink, send a test
message, turn it off, or uninstall.

## What works

- Text both ways, with long replies split and Markdown converted to
  WhatsApp formatting.
- Files from Mercury arrive as attachments (images as photos, everything
  else as documents).
- Images, documents and voice notes you send are passed to Mercury as files.
- Approvals by reply: *1* yes, *2* no, *3* always for this chat.
- Groups are ignored unless you turn on `allowGroups`.
- If WhatsApp logs the device out, Mercury tells you on another channel.

## Voice calls

Call the spare number from your own number and talk to Mercury. Mercury can
also call you when something matters (the `call_owner` tool).

- **Key:** calls use the OpenAI provider you already set up in Mercury
  (dashboard → Providers, or `mercury doctor`). Nothing extra to configure.
  Without one, text still works, and Mercury tells you once that calls need
  an OpenAI provider.
- **Who can call:** only the owner. Other callers are declined.
- **Mid-call actions:** Mercury can look things up and act during a call,
  using its memory, tools and files.
- **Approvals:** nothing that needs your approval runs during a call
  (nobody can tap Allow), and Mercury offers to do it by message instead.
- **After the call:** you get a summary with the transcript on WhatsApp.
- **Limits:** Mercury calls you at most `maxCallsPerHour` times an hour
  (default 4), and calls are capped at `maxCallMinutes` (default 15).
- **Settings:** `voice` (default `marin`), `voiceModel` (default
  `gpt-realtime`), and `answerCalls` (on by default).
- **Privacy:** call audio goes only to OpenAI, under OpenAI's API data
  policy.

## Unlink

```sh
mercury plugins unlink whatsapp
```

Also remove "Mercury" from Linked devices on the phone if it's still listed.

## Build from source

```sh
cd plugins/whatsapp/companion
cargo build --release   # Rust 1.94+, a C compiler
node ../package.mjs target/release/mercury-wa darwin-arm64 ../dist
mercury plugins install ../dist/mercury-plugin-darwin-arm64.tgz
```
