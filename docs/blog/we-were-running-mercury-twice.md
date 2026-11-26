# We were running Mercury twice and didn't know it

> Typing felt sluggish everywhere. The cause was a second full copy of the agent, started quietly by the launcher. How we found it and fixed it.

Published 2026-10-14 by Salman Qureshi. Tags: engineering, postmortem, runtime.
Canonical: https://mercuryagent.sh/blog/we-were-running-mercury-twice

A few days after shipping the always-on bots, I noticed Mercury felt heavy when I typed. Not broken. Just a beat behind, the way a remote shell feels on bad Wi-Fi. Then people started saying the same thing about the dev build on their own machines, which ruled out my laptop as the problem.

The obvious suspect was the terminal UI. We had just moved to a new version of Ink, our renderer, and added our own patches on top. Renderers are where input lag usually lives. So that's where I started, and that's where I was wrong.

## Measuring before guessing

The first thing I did was take the renderer out of the argument. I wrote a benchmark that mounts the real terminal UI in a virtual terminal, loads a 100-message conversation and a 14-bot roster, and types 60 characters, timing each one from key press to the frame that shows it.

The median was about 3 ms per keystroke. The worst was around 20 ms. Each frame wrote roughly 74 bytes to the terminal. Then I ran it again with a bot streaming its reasoning into the UI a hundred times a second, and it barely moved: about 6 ms.

That's not a renderer you can feel. Whatever was eating the latency, it wasn't drawing the screen.

## The process list told the story

So I stopped benchmarking and looked at what was actually running.

There were two Mercury processes doing real work. One was the background daemon I expected. The other was the terminal session itself, and it had used about four times as much CPU as the daemon. A terminal client should use almost nothing. This one was doing a lot.

The daemon's error log had the second clue: nine copies of the same Telegram error in a single day.

```
409 Conflict: terminated by other getUpdates request
```

Telegram returns that when two programs poll the same bot token at once. There is no way to get it with one process.

## How we ended up with two

The launcher had a branch that looked reasonable in isolation. When you typed `mercury` and no background daemon was running, it did two things in a row: start the daemon, then start the agent in the foreground.

```ts
autoDaemonize();
await runAgent();
```

The intent was to make sure Mercury kept running after you closed the terminal, while still giving you a chat right away. The effect was two complete runtimes. Both built a bot manager on the same queue. Both connected to Telegram. Both registered the same scheduled routines. And the foreground copy ran every bot turn, every tool call and every context compaction on the same thread that renders your keystrokes.

For months this didn't matter much, because bots were mostly idle. Then we made them always-on. The foreground copy suddenly had real work to do, on the worst possible thread, and typing started to lag on every machine that took that path. Which was every machine, because it ran on the first `mercury` after any reboot.

On my own laptop it was worse. An old install from npm was still registered as the login service and held the web port. Every launch failed to connect to the new daemon, decided the runtime was unhealthy, and took the "start everything" path again.

## Why we didn't just make it faster

You can imagine a smaller fix: keep the second copy but stop it from polling Telegram, or move bot work to a worker thread. Each of those would have removed one symptom and left the actual problem in place, which is that two programs both believed they were Mercury.

The fix we shipped is a rule instead: **one process owns the runtime, and the terminal attaches to it.**

- Launching `mercury` starts the daemon if needed and then attaches to it. The terminal never becomes a second runtime unless no daemon can run on that platform (Android under Termux is the one case).
- If a foreground process does start beside a live daemon, for example to open Mercury Code, it runs as a terminal for the main agent only. It doesn't register channels, doesn't create a bot manager, doesn't bind the web port, and doesn't replay scheduled work.
- Attaching is instant. The daemon now binds its web listener first, before channels and bots finish starting, and answers a lightweight health check with its process ID. If something else owns the port, you get one sentence saying which process it is instead of a 30-second wait followed by a pointless restart.

## Making lag measurable

The part I'm happiest with is small. Mercury now measures its own event loop. `/api/health` reports the 99th-percentile and worst stall over the last ten seconds, and any stall longer than 250 ms is logged with a warning.

We spent days on this bug partly because "it feels slow" isn't evidence. Now it is. If a bot turn ever does something synchronous that holds the main thread, the daemon's log will say so, with a number.

## What we got wrong, and what we changed

The honest version: the double runtime existed for a long time and we never noticed, because nothing measured it and the symptom only appeared once the workload changed. The tests passed because each runtime, on its own, worked.

So the fix came with a few guards that would have caught it:

- A contract test asserts the launcher never starts the daemon and then a second runtime.
- The login service is checked against the running install on every launch and re-pointed if it drifted.
- Merges now wait for the entire CI run, not just the checks that happen to have reported so far.

If you're building something that runs in the background and has a terminal front end, the takeaway is the same one we learned: decide which process is the program, and make everything else a client. It's much easier than working out, later, which of two programs is the real one.
