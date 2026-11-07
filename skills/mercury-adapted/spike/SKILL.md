---
name: mercury-spike
description: Run disposable experiments that answer one feasibility question before committing to a real build.
category: software-development
id: software-development/spike
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the Hermes spike workflow, itself adapted from gsd-build/get-shit-done (MIT, Lex Christopherson). No upstream text, script or asset is bundled.
license: MIT
intents: [spike this out, is this even possible, quick prototype, compare two approaches, validate a technical assumption]
tags: [prototype, feasibility, experiment, throwaway]
allowed-tools: [read_file, list_dir, create_file, write_file, run_command, delegate_task, ask_user, use_skill]
---

# Mercury Spike

Curated independent workflow, not a verified self-made procedure. A spike is disposable by design: it buys information you cannot get from reading, and it is thrown away once it has paid. For a production build use `mercury-writing-plans`; for a real bug investigation use `mercury-systematic-debugging`.

## When this is the wrong tool

- The answer is in documentation or existing code. Research it and stop; do not build anything.
- The question is "how should this be built, properly" — that is a plan, not a spike.
- The assumption is already validated. Go implement.
- The experiment would touch production data, real credentials, live billing or a service that cannot be discarded. That is not disposable; get approval for a safer probe instead.

## Approval boundaries

Creating a throwaway directory, writing scratch code and running it locally is normally within an approved build task — but confirm the target location and never write into a repository's tracked paths without saying so. Anything that installs system packages, downloads large models, calls a paid API, uses real credentials, or sends network writes beyond a documented read-only request needs the user's explicit approval first. Never point a spike at production resources, and never leave one running as a service.

## 1. Decompose into questions

Break the idea into two to five independent feasibility questions. Each question is one spike, framed so that a result is observable rather than arguable:

| # | Spike | Given / When / Then | Risk |
|---|-------|---------------------|------|
| 001 | stream-tokens | Given a socket connection, when the model streams, then first chunk arrives under 100 ms | high |
| 002a | parse-with-a | Given a multi-page PDF, when parsed with library A, then table cells survive | medium |
| 002b | parse-with-b | Given the same PDF, when parsed with library B, then table cells survive | medium |

Order by risk, highest first: there is no point prototyping the easy half when the hard half decides the project. Present the table and ask whether to build all of it, drop one, or reorder — before writing code. Skip decomposition only when the user already named the single question.

## 2. Research just enough to choose an approach

For each spike: state in two or three sentences what it is, why it matters and where the risk sits. Where a real choice between tools exists, compare candidacy, maintenance status and required system dependencies, then pick one and say why. Use `web_search` and `fetch_url` for current documentation rather than recalling versions from memory; verify what is actually installed locally with `run_command` instead of assuming a package exists.

## 3. Build it disposable

One directory per spike under an explicit, named root such as `spikes/` in the working directory. Keep it standalone: hardcoded inputs, no package machinery, no environment files, no container, no config system. Bias toward something the user can watch working, in this order: a runnable command with observable output, a single static page, one-endpoint server, or a test whose assertions name the question. A spike whose only output is a log line reading "it works" has not demonstrated anything.

Parallel comparison spikes may be fanned out with `delegate_task` when each needs genuine engineering; give every worker the absolute path, the exact question and the same acceptance framing, and require each to return its own verdict with the command it ran. Do not delegate a ten-line probe.

## 4. Verdict, with evidence

Every spike ends with a written verdict in its own README: VALIDATED, PARTIAL or INVALIDATED, plus what worked, what did not, what surprised you, and the recommendation for the real build. INVALIDATED is a successful spike — it saved the build. A PARTIAL verdict must name the constraints it works under.

Two rules keep the verdict honest: never declare success from a single happy-path run, and never report a spike as passing when the command exited non-zero, timed out, or produced output you did not read. Quote the exact command and its observable result. If the environment lacked a dependency, say the question is unanswered rather than guessing.

## 5. Clean up and hand off

Report the question, the verdict, the evidence and the location of the throwaway directory, then ask whether to delete it. Do not promote spike code into the real implementation; reimplement what you learned. Record a durable decision in the Second Brain only when the user wants the outcome preserved — the spike directory is not memory. Update `mercury-verification-before-completion` before claiming a spike "proves" anything, and state plainly that a local observation under synthetic input is not production evidence.
