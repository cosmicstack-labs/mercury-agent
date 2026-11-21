---
slug: the-wizard-that-quit-at-the-menu
title: "The setup wizard that quit at the first menu"
description: "A new Mercury install asked for your name, showed one menu, then quit with no error. How a one-tick race caused it, and the test that stops it returning."
authors: [mercury-eng]
tags: [engineering, postmortem]
image: ./cover.jpg
keywords: [node readline, stdin pause, raw mode, cli setup wizard, pseudo terminal test, postmortem, node.js bug]
---

Here's what a new user saw, from first install, on any platform, between versions 1.3.1 and 1.3.6:

```text
  Your name: Ada
  Agent name [Mercury]:

  Choose your mode
  Use the arrow keys, then press Enter.

  ● Mercury Cloud (hosted, no API keys needed)
  · Offline / BYOK (bring your own keys)

$
```

That `$` is the shell prompt. Mercury didn't crash and didn't print an error. It drew a menu and then simply wasn't running anymore. The exit code was 0.

{/* truncate */}

This is a write-up of what happened, because the bug is a good example of a class of problem that's easy to create in any Node.js CLI that mixes line prompts with key-by-key menus.

## Two ways to read a terminal

Mercury's setup wizard uses two kinds of input.

The name questions use Node's `readline` interface: you type a line, press Enter, and get a string back. The mode menu reads individual key presses, so it can move the highlight with the arrow keys. That needs the terminal in raw mode and a `keypress` listener on `process.stdin`.

Both read from the same stream, so they have to take turns. The question reader has to let go of stdin before the menu takes over.

## The change that introduced it

In October we fixed an older bug where pressing Ctrl+D during setup made the wizard exit silently. Part of that fix was to share one `readline` interface across all the consecutive questions, so an end-of-input during any of them would be caught and reported.

Sharing the interface raised a question: when do you close it? You don't want to close and reopen it between two questions that follow each other immediately. So after each answer, the code scheduled the close for the next turn of the event loop:

```ts
iface.question(prompt, (answer) => {
  pending = null;
  scheduleRelease(); // setImmediate(() => close())
  resolve(answer.trim());
});
```

If another question came along before then, it cancelled the scheduled close and reused the interface. That's a sensible design for a sequence of questions. The problem is what happens when the next consumer isn't a question.

## The race

Here is the exact order of events after you type your agent's name:

1. The answer resolves. A close is scheduled for the next tick.
2. The wizard moves on and opens the arrow-key menu. The menu puts the terminal in raw mode, calls `stdin.resume()`, and attaches its key listener.
3. The next tick arrives and the scheduled close runs. `readline`'s `close()` pauses its input stream, which is `process.stdin`.

Step 3 undid step 2. The menu was waiting for key presses on a stream that was no longer flowing. Nothing else was keeping Node's event loop busy at that moment: no timers, no open sockets, no pending promises tied to I/O. When the event loop has no work left, Node exits. Cleanly. With status 0.

That's why there was no error. Nothing failed. The process just ran out of things to do.

## Why it survived six releases

Every test we had passed, and that's the uncomfortable part.

The unit tests for the question reader passed because, in isolation, it did exactly what it should. The wizard's tests mocked the menu. The binary smoke test in CI ran `mercury --version`, which never reaches the wizard. And anyone on the team who already had a config file never saw the first-run path at all.

None of those tests had a real terminal in them, and this bug only exists when two readers share one.

## The fix

The fix is one line. The menu releases the shared reader synchronously, before it takes over stdin:

```ts
export async function selectWithArrowKeys(title, options, config = {}) {
  // Release the question reader now: its deferred close would otherwise
  // pause stdin after we resume it.
  closeAsk();
  readline.emitKeypressEvents(process.stdin);
  // ...raw mode, resume, keypress listener
}
```

`closeAsk()` cancels the scheduled close and closes the interface immediately. By the time the menu calls `resume()`, nothing is left that could pause the stream behind its back.

## The test that would have caught it

The part worth copying is the test. CI now runs the compiled binary through the real first-run wizard inside a pseudo-terminal. It types a name, answers the agent name prompt, waits for the mode menu, and then checks one thing: is the process still alive? Then it presses the down arrow and Enter and expects the provider question.

Run against 1.3.6, it fails at the menu. Run against 1.3.7, it passes. It runs on every pull request on Linux and macOS.

There's also a regression test at the unit level that fails if a deferred release can pause the input after an explicit close.

## Takeaways

- **If two parts of your CLI read stdin, decide the hand-off explicitly.** Don't rely on whoever closes last.
- **"Exited with code 0" can be a bug.** In Node, a process that runs out of work exits quietly. When an interactive program exits without being asked to, look for a stream that stopped flowing.
- **Test interactive paths with a real terminal.** Mocks hide the exact class of bug where two components step on each other. A pseudo-terminal test is maybe forty lines of Python and it's the only thing that would have caught this.

We're sorry to everyone whose first impression of Mercury was a menu that vanished. If you bounced off it, the current release gets you through setup, and we'd love for you to try again.
