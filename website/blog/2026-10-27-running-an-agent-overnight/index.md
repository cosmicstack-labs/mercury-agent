---
slug: running-an-agent-overnight
title: "Running an agent overnight: what breaks first"
description: "We read Mercury's scheduler and budget code and reproduced one behaviour, to find what fails during long unattended runs: skipped tasks, quiet errors, overlapping jobs and budget stops."
authors: [tashiriskhan]
tags: [runtime, engineering]
image: ./cover.jpg
keywords: [run ai agent overnight, unattended ai agent, ai agent scheduler failures, cron ai agent, ai agent token budget, long running agent]
draft: false
---

Most overnight agent failures are quiet. The agent doesn't crash. A job just doesn't run, or runs twice, and nobody is told. This post looks at where that happens in Mercury's scheduler and budget code.

{/* truncate */}

An agent that works when you watch it is a different product from one you leave running. When you're watching, you catch the stuck tool call and the wrong turn. Overnight, nobody catches them. This post covers what we found in Mercury's scheduler and budget code when we asked where an unattended run would fail first.

**Code snapshot:** Based on Mercury 1.3.9, commit `c969d77` on `main`, as of October 27, 2026. Line references are to that commit.

**Evidence levels.** Each finding is labelled:

- **[Reproduced]**: we ran the behaviour and observed it.
- **[Confirmed from code]**: we traced the code path but did not run it end to end.
- **[Code-based hypothesis]**: the code suggests it; we have not tested it.

### Delayed tasks due during downtime are skipped [Confirmed from code]

Delayed tasks are saved to `schedules.yaml` in Mercury's home directory, with an `executeAt` time. On startup, `restorePersistedTasks` in `src/core/scheduler.ts` checks each one. If `executeAt` has already passed, it logs `Delayed task already expired, skipping` and does not run it.

For example, a delayed task due at 02:40, during a restart at 02:50, will not fire. A task due at 03:00 during the same restart will.

Cron tasks are re-registered on startup. We found no catch-up logic in the scheduler, so firings that fall inside a downtime window are not replayed. Different features behave differently; bot routines go through their own governor, described below.

**What to do:** Use cron for recurring work. For one-off work that must run, check the log for `already expired` after every restart.

### Some scheduler errors are logged but not sent to you [Confirmed from code]

This claim is narrow. The scheduler's own error handlers only log:

- In `addTask`, a throwing handler logs `Scheduled task error`. Nothing else happens.
- In `startHeartbeat`, a failing heartbeat logs `Heartbeat error`.
- In `addDelayedTask`, a failing delayed task logs `Delayed task error`.

Ordinary scheduled prompts take a different route. `handleScheduledTask` in `src/core/agent.ts` catches its own errors and logs `Scheduled task execution failed`. So for ordinary tasks, the scheduler's `Scheduled task error` path is usually not the one that fires. It fires for bot routines, where an error from enqueueing is not caught.

Successful output is separate. A scheduled task's result goes back through its source channel like any other reply. We did not check whether a failure inside the agent loop is sent to the channel, so treat a missing result as unknown, not as success.

**What to do:** Don't rely on error logs for overnight work. Have each task send a short end-of-run message. If it doesn't arrive, assume the run did not finish.

### A delayed task leaves the schedule file once its prompt is handed off [Confirmed from code]

In `addDelayedTask`, a `finally` block removes the task from `schedules.yaml` when its handler returns, even if the handler threw. For ordinary tasks, `handleScheduledTask` does not throw, so the removal happens once the prompt has been queued.

The queued prompt is not lost on that basis alone. Accepted jobs are persisted in the work ledger, and on startup `recoverInterrupted()` re-queues the ones that were queued or interrupted (`src/core/agent.ts`). We have not tested a restart in the middle of a run.

### Long runs may overlap [Reproduced at the scheduler level; queued inside the agent]

Each cron task is registered with `cron.schedule` and an async handler. The scheduler keeps no in-flight flag per task ID. We reproduced this pattern with node-cron 3.0.3, the version Mercury pins: a job firing every second, with a handler that takes 3.5 seconds, reached four concurrent runs within eight seconds.

Inside Mercury, the effect is different. Scheduled prompts go onto the agent's message queue, which processes one message at a time. Overlapping firings for a main-agent task therefore wait in line rather than running in parallel. [Confirmed from code; not run end to end.] Each queued firing still costs budget when it runs.

Bot routines are different. The bot governor skips a tick when the bot is busy or the last run was too recent (`busy`, `too_soon`). [Confirmed from code.]

**What to do:** Until overlap is tested on your own setup, avoid non-idempotent jobs (ones that write files, send messages, or spend money) with intervals shorter than their expected run time.

### Budget stops can be silent for unattended jobs [Confirmed from code]

Mercury tracks daily token use in `src/utils/tokens.ts`. The total is saved to `token-usage.json` and resets when the date changes, so a restart does not reset it. `isOverBudget()` is checked in `handleMessage` in `src/core/agent.ts`, before the agent loop runs.

Scheduled prompts are not exempt. They enter the same queue and reach the same check, so a scheduled job is stopped by the same daily budget as chat.

What differs is who hears about it:

- A chat message gets a budget notice. On the CLI, it gets an override prompt.
- A scheduled job with a source channel gets the same notice on that channel.
- A scheduled job with no source channel (`internal`) gets nothing. The check returns without sending a message.

We traced this in the code but did not run it: we did not set a one-request budget and fire a job. To confirm on your install, set a low budget, fire one scheduled job with a source channel and one without, and check what each sends and logs.

**What to do:** Keep daily headroom for the overnight run. Give unattended jobs a source channel so the notice reaches you. Check `/budget` in the morning.

## A checklist before you leave it running

- Recurring work is on cron, not one-off delays.
- Each overnight task sends an end-of-run message. No message means unknown.
- Non-idempotent jobs don't run on intervals shorter than their expected run time.
- The daily budget covers the overnight run with headroom.
- Unattended jobs have a source channel, so budget notices reach you.
- You've checked the log for `already expired` after the last restart.
- You know what the agent does when a tool call hangs, and you've tested it.

## Recovery is not replay

Mercury can recover after a restart. Accepted jobs that were queued or interrupted are re-queued from the work ledger. That does not mean every scheduled run is replayed. Firings during downtime are skipped, and expired delayed tasks are not run. Recovery covers work that was accepted. It does not cover work that never reached the ledger.

## What still breaks

Scheduler reliability tells you a job ran. It doesn't tell you the job did the right thing. A tool that returns success with bad data, or a task that does the wrong thing correctly, passes every check above. An overnight run needs both: a schedule that fires, and a task that is correct when it does. We'll report the open tests here as we run them.
