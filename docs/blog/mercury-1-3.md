# Mercury 1.3: an agent you can actually leave running

> Mercury 1.3's shared background runtime, bots that deliver real files and stay online, and a fleet you run from Telegram. What changed and why.

Published 2026-10-12 by Salman Qureshi. Tags: news, releases, runtime.
Canonical: https://mercuryagent.sh/blog/mercury-1-3

Mercury 1.3 is the release where we stopped adding things and started making the existing things trustworthy. Most of the work is invisible when it goes right: your terminal opens instantly, your bots are still running tomorrow morning, and closing the laptop doesn't kill anything. This post walks through what changed, and the reasoning behind the bigger decisions.

If you want the full list, the [release notes](/docs/releases/1.3.1) have every item. This is the version with opinions.

## One runtime, and the terminal is just a window

Until 1.3, typing `mercury` in a terminal could start a full copy of the agent in that terminal, even when a background copy was already running. That sounds harmless. It wasn't. Two copies meant two Telegram pollers fighting over one bot token, two schedulers firing the same routines, and bot work running on the same thread that draws your keystrokes. We wrote up the details in [We were running Mercury twice and didn't know it](/blog/we-were-running-mercury-twice).

Now there is exactly one process that owns your channels, your bots and the web dashboard. It runs as a login service on macOS, Linux and Windows. When you type `mercury`, the terminal attaches to that process. Close the terminal and nothing stops. Open it again and you're back in under a second.

Two smaller changes make this hold up in practice:

- **The login service follows the install.** If you move from npm to the standalone binary, or from stable to the dev channel, Mercury notices that the service still points at the old install and re-points it. Before this, an old daemon could keep resurrecting itself on every login and hold the web port.
- **Lag is now a number.** `/api/health` reports how long the event loop has stalled in the last ten seconds, and stalls over 250 ms are logged. "It feels slow" turns into something we can actually look at.

## Bots that do work instead of writing about work

Mercury Bots shipped in 1.3.0. After a couple of weeks of running a real fleet we looked at the journals and didn't love what we saw: routines that produced status notes about other status notes, turns that read 750,000 tokens of context to decide nothing needed doing, and finished output buried somewhere under `~/.mercury`.

So 1.3 judges a bot run by what it did, not by what it said. Every run gets an outcome computed from the tool trace: it delivered a file, it took an action, it delegated, it replied, or it did nothing. A scheduled routine that does nothing three times in a row cools down for a few hours and then resumes by itself. Bots stay online. They just stop burning tokens on busywork.

Finished work goes somewhere you can find it: `~/Documents/Mercury/<Bot name>/`, with final results at the top and work in progress under `work/`. There's a daily token budget per bot (5M by default) and per fleet, with a warning at 80%.

Fleets got real coordination too. A lead bot can hand typed tasks to several crew members at once and gets woken up once, with a summary, when they're all done. A lead's standard job can be written down as a pipeline in `bot.yaml`, so "research, draft, fact-check, package" runs without the lead having to babysit each step.

## Your fleet in your pocket

A lot of you run Mercury on a home server and talk to it from Telegram, so 1.3 makes Telegram a first-class control surface. `/bots` shows the roster with Stop, Start and Run buttons for each bot. When a bot finishes a task you asked for from your phone, the result arrives as an attached file, not a path on a machine you can't see. You can create a bot from Telegram too: describe its persona in a message, then pick its permissions, whether it works alone or leads a crew, and its budget, all with buttons.

## Node 22 and a patched terminal renderer

The npm package now requires Node.js 22. The standalone binaries carry their own runtime, so if you installed with the one-line installer, nothing changes for you. If you're on npm, `mercury upgrade` checks your Node version before it touches anything, and the package refuses to install on an older Node with a readable message instead of installing something that won't start.

We also moved the terminal UI to Ink 8 with four patches of our own. The most visible one fixes a problem where long replies stamped copies of themselves into your scrollback on every repaint. The patches live in a public fork and we're working on getting them upstream.

## The hotfixes, and what we learned from them

The 1.3 line had more point releases than we'd like, from 1.3.2 to 1.3.8 in three days. Each one fixed something real: the first-run setup could quit at its first menu, `/code` didn't work from the default launch, the Windows installer failed on stock PowerShell 5.1, and the Linux binary crashed on CPUs without AVX2. The Windows and AVX2 reports came from people who took the time to dig in and tell us exactly what they saw. Thank you.

Every one of those now has a test that would have caught it: the setup wizard runs under a real pseudo-terminal in CI, the Windows installer runs under PowerShell 5.1, and the Linux installer is tested on a CPU that pretends to lack AVX2.

## Upgrading

```bash
# standalone binary (macOS / Linux)
curl -fsSL https://mercuryagent.sh/install.sh | sh

# npm, on Node.js 22+
npm i -g @cosmicstack/mercury-agent
```

Or just run `mercury upgrade`. If you're already on the latest version it now tells you so and does nothing, which is how it should have worked from the start.

Your `~/.mercury` folder (config, memory, bots, Telegram pairing) carries over untouched. On first start, Mercury moves old bot outputs into `~/Documents/Mercury/` and re-points your login service if it needs to.

If something breaks, open an issue or find us on [Discord](https://discord.gg/5emMpMJy5J). We read everything.

The code, the issue tracker and every release live here:

https://github.com/cosmicstack-labs/mercury-agent
