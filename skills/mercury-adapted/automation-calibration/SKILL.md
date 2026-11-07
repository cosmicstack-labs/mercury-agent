---
name: mercury-automation-calibration
description: Keep an automation's recurring topology as small as its value loop, with controls on the edges that carry real risk.
category: automation
id: automation/automation-calibration
version: 0.1.0
author: Mercury
attribution: Independently rewritten from the Hermes automation-architecture-calibration workflow.
license: MIT
intents: [this automation is getting too complex, right-size my cron setup, is this agent graph overbuilt, simplify this pipeline design]
tags: [automation, architecture, cron, right-sizing, review]
allowed-tools: [read_file, list_dir, create_file, ask_user, use_skill]
---

# Mercury Automation Calibration

Curated independent workflow, not a verified self-made procedure. It exists to stop analysis depth and reviewer gates from turning a small automaton into a certification platform. For the mechanics of scheduling on this platform use `mercury-scheduled-task-operations`.

## Core rule

Analysis depth and runtime topology are independent. A thorough review may use several lenses, tests and reviewers. The deployed system should contain only the recurring components needed to produce value and guard the named high-impact edges.

This is not a lever for weakening controls on money movement, compliance evidence, customer promises, destructive writes, security decisions or outbound sends. It compresses controls onto the right edges; it does not remove required approval boundaries.

## Procedure

### 1. State the value loop in one sentence

```text
input -> useful automatic work -> verified output -> future use
```

If that sentence cannot be written plainly, do not add components yet. If it contains the word "and" more than twice, you may be holding two automations.

### 2. Freeze a topology budget before planning

State the maximum justified number of each recurring element: jobs, helpers, queues, services and human approval points. Count steady state separately from one-time work — migration scripts, snapshots, evaluation artifacts and cutover evidence are not recurring components and should not inflate the design.

### 3. Separate three layers

- **Value loop:** the irreducible steps that produce the output.
- **Guards:** checks that stop a named, evidenced failure with real cost. Each guard names the failure it prevents and what it does when triggered.
- **Instrumentation:** logs, metrics and reports. Useful, but never a substitute for a guard, and never the product.

Any component that fits none of the three is a candidate for deletion, not documentation.

### 4. Map risk to edges, not to stages

For each edge where the system touches the world — reading a source, writing a file, sending a message, spending money, changing configuration — state the worst credible outcome and the control that covers it. Controls concentrated at one approval gate in front of a batch of sends are cheaper and stronger than a gate at every internal step. A step that only transforms data in memory needs correctness tests, not a human gate.

### 5. Challenge each reviewer's addition

When a review proposes another evaluator, queue, manifest or gate, ask three questions: which value-loop step does it protect, which failure did we actually observe, and what does it cost per run in tokens, latency and operator attention? An addition that cannot answer all three is deferred, with the reason recorded. Do not adopt a control because a checklist mentioned it.

### 6. Reconcile safety with a simple operator experience

The operator should be able to answer, without reading code: what runs, when, what it produces, how I know it worked, and how I stop it. If a design cannot be explained that way, simplify the design, not the explanation.

## Signals you have overbuilt

- More manifests, receipts or gate documents than recurring jobs.
- A component whose only consumer is another component's audit trail.
- Evaluation infrastructure that has never changed a decision.
- Any job whose failure is silent because it was buried under retries and notifications.
- A reviewer loop that keeps adding jobs to satisfy the previous review.

## Signals you have underbuilt

- An automation that writes, sends or spends without a named approval boundary.
- No way to tell whether the last run actually succeeded.
- No documented stop path.
- Hidden coupling: two jobs that must run in order but are scheduled independently.

## Output

Report the one-sentence value loop, the topology budget against the actual component count, the risk-to-edge table, and every component recommended for removal or deferral with its reason. Then state what remains unverified — a design review cannot establish that a live schedule fired, that a delivery arrived, or that a guard works under real load. Record durable design decisions in the Second Brain rather than in files the next run must rediscover.
